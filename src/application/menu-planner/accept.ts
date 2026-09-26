/**
 * [R12-A3A] Signed preview accept token の発行と、accept 時の stale 再検証（§18.6 [R12-A1] の application phase）。
 *
 * この module が担うのは **orchestration だけ**:
 *   発行: A2 の決定論的 preview を作る → 「コーチが見たもの」を claim に閉じる → HMAC-SHA256 で署名する
 *   検証: token を署名検証 → 期限 → owner → **authoritative context を再読込して A2 を再実行** →
 *         contextFingerprint / materializationDigest を比較 → fresh か STALE_PREVIEW か
 *
 * 守る不変条件（§18.6 / §18.7）:
 *   - **DB write 0**: preview / token / session の row を作らない。read だけ。
 *   - `PREVIEW_ACCEPT_AUTHORITY = SERVER_RECOMPUTE`: token 内の数値は保存 authority ではない。
 *     保存できるのは accept 時の fresh な再計算結果だけ。ここでは再計算結果を server-only で返す。
 *   - `STALE_PREVIEW_BEHAVIOR = REJECT`: 不一致なら **全体を拒否**する。silent recalculation をしない。
 *   - token へ載せる proposal は sanitize 済みのみ。raw provider output / raw prompt / health data /
 *     raw RuleSet object / Prisma model は載せない（`src/domain/menu-planner/accept-token.ts` の claim 型で閉じる）。
 *   - signature 比較は `timingSafeEqual`（`src/infra/security/hmac-token.ts`）。期待値・実値・例外は外へ出さない。
 *   - clock は注入（domain は時計を読まない）。TTL は application configuration input で、domain の定数にしない。
 *   - token / payload / secret を log しない。
 *
 * Server-only。`src/application/**` は eslint の import 制限を受けないが、client component から import しないこと
 * （repo に `server-only` package は無く、境界は prose convention。`src/application/menu-planner/binding.ts` と同じ）。
 */
import {
  canonicalizeMenuPlannerAcceptClaims,
  evaluatePreviewAcceptFreshness,
  isMenuPlannerAcceptClaimsExpired,
  menuPlannerAcceptClaimsSchema,
  MENU_PLANNER_ACCEPT_TOKEN_SCHEMA_VERSION,
  type MenuPlannerAcceptClaims,
} from "@/domain/menu-planner/accept-token";
import { MENU_PLANNER_PREVIEW_SCHEMA_VERSION, canonicalStringify } from "@/domain/menu-planner/preview";
import type { MenuPlannerDraftMaterialization } from "@/domain/menu-planner/draft";
import type { AiPlannerProposal } from "@/domain/menu-planner";
import type { RuleSetStatus } from "@/domain/running/rules/schema";
import type { MenuPlannerPreview } from "@/presentation/menu-planner/preview";
import {
  HMAC_TOKEN_MAX_LENGTH,
  assertUsableSigningKey,
  signHmacToken,
  verifyHmacToken,
  type HmacSigningKey,
} from "@/infra/security/hmac-token";
import { buildMenuPlannerDraftIdentityDigest } from "@/infra/repositories/menu-planner-draft-repository";
import {
  buildMenuPlannerPreviewForRevalidation,
  type BuildMenuPlannerPreviewInput,
  type MenuPlannerPreviewError,
} from "./preview";
import type { PrismaDbClient } from "@/infra/db/prisma";

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/** A3A の rejection kind。§18.6 が名指しする `STALE_PREVIEW` を含む 3 種。 */
export const MENU_PLANNER_ACCEPT_ERROR_KINDS = ["INVALID_INPUT", "STALE_PREVIEW", "PLANNING_REJECTED"] as const;
export type MenuPlannerAcceptErrorKind = (typeof MENU_PLANNER_ACCEPT_ERROR_KINDS)[number];

/**
 * A3A 自身が発行する code。再計算で planner が失敗した場合は既存 A2 の code をそのまま通す
 * （似た code を新設しない。§18.6 の taxonomy を再利用する）。
 */
export const MENU_PLANNER_ACCEPT_ERROR_CODES = [
  "ACCEPT_INPUT_INVALID",
  "ACCEPT_TOKEN_MALFORMED",
  "ACCEPT_TOKEN_SIGNATURE_INVALID",
  "ACCEPT_TOKEN_OWNER_MISMATCH",
  "ACCEPT_TOKEN_EXPIRED",
  "CONTEXT_BINDING_STALE",
  "MATERIALIZATION_STALE",
] as const;
export type MenuPlannerAcceptErrorCode = (typeof MENU_PLANNER_ACCEPT_ERROR_CODES)[number];

export type MenuPlannerAcceptError = {
  kind: MenuPlannerAcceptErrorKind;
  /** `MENU_PLANNER_ACCEPT_ERROR_CODES` のいずれか、または再計算時に planner が返した既存 code。 */
  code: string;
  message: string;
};

function acceptError(kind: MenuPlannerAcceptErrorKind, code: string, message: string): MenuPlannerAcceptError {
  return { kind, code, message };
}

/**
 * token の形式そのものが不正なときの文言。期待値・実値・crypto 例外・署名の差分は一切出さない。
 * 「形式不正」と「署名不一致」で code と文言は分ける（server 側の診断のため）が、**どの code でも文言は固定**
 * であり、失敗のたびに詳細が増えることはない。
 */
function tokenInvalidError(): MenuPlannerAcceptError {
  return acceptError("INVALID_INPUT", "ACCEPT_TOKEN_MALFORMED", "プレビューの確認情報を読み取れません。もう一度プレビューを作成してください。");
}

// ---------------------------------------------------------------------------
// Dependencies（server composition が注入する。source code に secret を固定しない）
// ---------------------------------------------------------------------------

export type MenuPlannerAcceptDependencies = {
  /**
   * HMAC-SHA256 の署名鍵。**server-only**。
   * source へ固定値を書かない・default fallback を持たない（空/短すぎる鍵は署名前に fail closed）。
   */
  signingKey: HmacSigningKey;
  /** 注入 clock。テストは固定 clock を渡す。 */
  now: () => Date;
  /**
   * token の有効期間（ms）。**application configuration input** であり domain rule ではない
   * （正式仕様に TTL の数値が無いため、実装側で固定しない）。
   */
  tokenTtlMs: number;
  /**
   * previewId / targetMenuId を作る server identity generator。
   * **random identity は contextFingerprint / materializationDigest へ混ぜない**（digest 入力型に存在しない）。
   */
  generateId: () => string;
};

/**
 * composition 時点の異常（鍵・TTL・注入の欠落）は **throw して fail closed** する。
 * client 入力の問題ではないため、user-facing な error taxonomy には載せない（Server Action 側は起動時に検証する）。
 */
function assertDependencies(deps: MenuPlannerAcceptDependencies): void {
  assertUsableSigningKey(deps.signingKey);
  if (!Number.isFinite(deps.tokenTtlMs) || deps.tokenTtlMs <= 0) {
    throw new RangeError("tokenTtlMs must be a positive finite number");
  }
  if (typeof deps.generateId !== "function" || typeof deps.now !== "function") {
    throw new TypeError("now and generateId must be injected");
  }
}

/**
 * 1 回の操作で clock を **1 度だけ**読む。Invalid Date は compose 異常なので throw する。
 * `isExpired` は `NaN >= x` が false になるため、ここで弾かないと期限 gate が黙って消える（fail open）。
 * 発行側・検証側で同じ関数を使い、対称性を保つ。
 */
function resolveNow(deps: MenuPlannerAcceptDependencies): Date {
  const now = deps.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("now() must return a valid Date");
  }
  return now;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export type IssueMenuPlannerSignedPreviewInput = {
  /** authenticated principal から渡す trusted input（client body の ownerId を authority にしない）。 */
  ownerId: string;
  contextMenuTemplateId: string;
  menuName: string;
  intent: unknown;
  proposal: unknown;
  /**
   * Server-internal revision lineage input. When present, this must come from
   * a verified prior accept-token claim; it is never part of a client request.
   */
  trustedTargetMenuId?: string;
  /**
   * [R12 unified composer] `contextMenuTemplateId` が inline sentinel のときの running context。
   * claim には載せない（contextFingerprint だけが binding する）。
   */
  inlineRunningContextJson?: string;
};

/** client へ返してよい部分だけ。token は opaque な文字列として扱う。 */
export type SignedMenuPlannerPreview = {
  preview: MenuPlannerPreview;
  /** saveable でない preview には **発行しない**（null）。使えない token を捏造しない。 */
  acceptToken: string | null;
};

export type IssueMenuPlannerSignedPreviewResult =
  | { ok: true; signed: SignedMenuPlannerPreview }
  | { ok: false; error: MenuPlannerAcceptError };

/**
 * A2 の error を A3A の 3 kind へ畳む（code はそのまま通して診断性を保つ）。
 *
 * `atAccept` の違いが重要:
 *   - **発行時**: proposal は client から来た未検証の入力なので、A2 の `INVALID_INPUT` / `AI_OUTPUT_INVALID` は
 *     INVALID_INPUT として返すのが正しい。
 *   - **accept 時**: proposal は既に発行時に検証済みで、token の署名で保護されている。再計算が
 *     current catalog/domain validation だけで失敗した場合は、発行後の authoritative context mutation と
 *     provenance を特定できるため STALE_PREVIEW へ map する。それ以外の planner/context failure は
 *     PLANNING_REJECTED のままにし、予期しない例外を stale として握り潰さない。
 *     どちらにせよ **何も保存しない**。
 */
function fromPlannerError(error: MenuPlannerPreviewError, atAccept: boolean): MenuPlannerAcceptError {
  if (
    atAccept &&
    [
      // The signed token proves that this replay input was saveable at issue
      // time. These failures therefore mean that the current authoritative
      // context no longer supports that previously valid preview.
      "CONTEXT_MENU_UNAVAILABLE",
      "RUNNING_CONTEXT_UNAVAILABLE",
      "PLANNED_DATE_UNAVAILABLE",
      "MENU_PHASE_INVALID",
      "PHASE_CONSTRAINT_UNSATISFIED",
      "AVAILABLE_TIME_CONSTRAINT_UNSATISFIED",
      "AUTHORITATIVE_CATALOG_INVALID",
      "AUTHORITATIVE_CONTEXT_INVALID",
      "PLANNED_AT_INVALID",
      "PROPOSAL_CATALOG_INVALID",
      "EXERCISE_CATALOG_BINDING_INVALID",
    ].includes(error.code)
  ) {
    return acceptError("STALE_PREVIEW", "CONTEXT_BINDING_STALE", "プレビュー後に参照カタログが変わったため、このプレビューは保存できません。もう一度プレビューを作成してください。");
  }
  if (atAccept || error.kind === "PLANNING_REJECTED") {
    return acceptError("PLANNING_REJECTED", error.code, error.message);
  }
  return acceptError("INVALID_INPUT", error.code, error.message);
}

/**
 * A2 の preview を作り、saveable なときだけ accept token を発行する。
 * preview 自体は常に返す（acceptToken は null になりうる）。
 */
export async function issueMenuPlannerSignedPreview(
  input: IssueMenuPlannerSignedPreviewInput,
  deps: MenuPlannerAcceptDependencies,
): Promise<IssueMenuPlannerSignedPreviewResult> {
  assertDependencies(deps);

  const previewResult = await buildMenuPlannerPreviewForRevalidation({
    schemaVersion: MENU_PLANNER_PREVIEW_SCHEMA_VERSION,
    ownerId: input.ownerId,
    contextMenuTemplateId: input.contextMenuTemplateId,
    menuName: input.menuName,
    // A2 の入口が strict schema で再検証するため、ここでは unknown のまま渡す
    // （`intent` は runtime では `z.unknown()`、`proposal` は型も unknown）。
    intent: input.intent as BuildMenuPlannerPreviewInput["intent"],
    proposal: input.proposal,
    ...(input.inlineRunningContextJson !== undefined ? { inlineRunningContextJson: input.inlineRunningContextJson } : {}),
  });
  if (!previewResult.ok) return { ok: false, error: fromPlannerError(previewResult.error, false) };

  const { preview, revalidation } = previewResult;

  // 保存できない preview に token を発行しない（MANUAL_INPUT_REQUIRED / REJECTED / blocking finding）。
  // 使えない token を捏造しない。
  if (!preview.canSave) {
    return { ok: true, signed: { preview, acceptToken: null } };
  }

  const issuedAt = resolveNow(deps);

  if (revalidation.draft === null) {
    return { ok: false, error: acceptError("PLANNING_REJECTED", "DETERMINISTIC_PLANNING_FAILED", "決定論的なプレビューを生成できません。") };
  }

  // A fresh generate starts a new logical draft lineage. A revision, however,
  // carries forward the target identity from the already verified prior token.
  // Keep this input in the issuer before deriving the signed draft identity so
  // every target-bound claim remains internally consistent.
  const targetMenuId = input.trustedTargetMenuId ?? deps.generateId();

  const rawClaims: MenuPlannerAcceptClaims = {
    schemaVersion: MENU_PLANNER_ACCEPT_TOKEN_SCHEMA_VERSION,
    previewId: deps.generateId(),
    targetMenuId,
    ownerId: input.ownerId,
    contextMenuTemplateId: input.contextMenuTemplateId,
    menuName: revalidation.menuName,
    constraints: revalidation.constraints,
    requestDigest: revalidation.requestDigest,
    proposal: revalidation.sanitizedProposal,
    reasonSanitized: revalidation.reasonSanitized,
    contextFingerprint: preview.binding.contextFingerprint,
    materializationDigest: preview.binding.materializationDigest,
    savedDraftIdentityDigest: buildMenuPlannerDraftIdentityDigest({
      ...revalidation.draft,
      ownerId: input.ownerId,
      targetMenuId,
    }),
    ruleSet: revalidation.ruleSet,
    planner: revalidation.planner,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + deps.tokenTtlMs).toISOString(),
  };

  // claim 自体の整合（strict schema + expiresAt > issuedAt）を署名前に検査する。
  const parsedClaims = menuPlannerAcceptClaimsSchema.safeParse(rawClaims);
  if (!parsedClaims.success) {
    return { ok: false, error: acceptError("INVALID_INPUT", "ACCEPT_INPUT_INVALID", "プレビューを発行できません。") };
  }

  const acceptToken = signHmacToken(canonicalStringify(canonicalizeMenuPlannerAcceptClaims(parsedClaims.data)), deps.signingKey);
  // 検証側の上限と必ず整合させる（検証不能な token を発行しない）。schema 合法な payload では到達しない。
  if (acceptToken.length > HMAC_TOKEN_MAX_LENGTH) {
    return {
      ok: false,
      error: acceptError("INVALID_INPUT", "ACCEPT_INPUT_INVALID", "プレビューが大きすぎるため確認情報を発行できません。項目数を減らしてください。"),
    };
  }
  // server-only な revalidation source は claims を作るためだけに使い、結果には載せない
  // （client へ渡す理由が無く、A3B の保存は accept 側の再計算 material を使う）。
  return { ok: true, signed: { preview, acceptToken } };
}

// ---------------------------------------------------------------------------
// Revalidate
// ---------------------------------------------------------------------------

export type RevalidateMenuPlannerAcceptInput = {
  token: string;
  /** trusted caller（将来は Server Action が authenticated principal から渡す）。 */
  ownerId: string;
  /**
   * [R12 unified composer] inline context source の token を保存するときだけ client が再送する running context。
   * authority ではない：再計算した contextFingerprint が署名済み fingerprint と一致しなければ STALE で拒否される。
   */
  inlineRunningContextJson?: string;
};

/**
 * accept 時の **server-only** 再計算 material。A3B の atomic save がこの値だけを使う。
 * client へ返してはいけない。
 */
export type MenuPlannerAcceptMaterialization = {
  /** 発行時に server が採番した identity。A3B はこの targetMenuId で MenuTemplate を作る（double-submit foundation）。 */
  previewId: string;
  targetMenuId: string;
  contextFingerprint: string;
  materializationDigest: string;
  ruleSet: { version: string; contentHash: string; status: RuleSetStatus };
  sanitizedProposal: AiPlannerProposal;
  /** fresh replayからのみ作られる、A3B transaction write用のserver-only material。 */
  draft: MenuPlannerDraftMaterialization;
};

export type RevalidateMenuPlannerAcceptResult =
  | { ok: true; preview: MenuPlannerPreview; materialization: MenuPlannerAcceptMaterialization }
  | { ok: false; error: MenuPlannerAcceptError };

export type VerifiedMenuPlannerAccept = {
  claims: MenuPlannerAcceptClaims;
  ownerId: string;
  now: Date;
};

/** DB不要のtoken検証境界。A3Bはこの結果をtransaction内のtarget checkへ渡す。 */
export function verifyMenuPlannerAcceptToken(
  input: RevalidateMenuPlannerAcceptInput,
  deps: MenuPlannerAcceptDependencies,
): { ok: true; verified: VerifiedMenuPlannerAccept } | { ok: false; error: MenuPlannerAcceptError } {
  assertDependencies(deps);
  const now = resolveNow(deps);

  // 1. signature（期待値・実値は出さない）
  const verified = verifyHmacToken(input.token, deps.signingKey);
  if (!verified.ok) {
    return {
      ok: false,
      error:
        verified.kind === "SIGNATURE_MISMATCH"
          ? acceptError("INVALID_INPUT", "ACCEPT_TOKEN_SIGNATURE_INVALID", "プレビューの確認情報を検証できません。もう一度プレビューを作成してください。")
          : tokenInvalidError(),
    };
  }

  // 2. payload（JSON → strict claim schema。未知 claim は silent strip せず落とす）
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(verified.payload);
  } catch {
    return { ok: false, error: tokenInvalidError() };
  }
  const claimsResult = menuPlannerAcceptClaimsSchema.safeParse(parsedJson);
  if (!claimsResult.success) return { ok: false, error: tokenInvalidError() };
  const claims = claimsResult.data;

  // 3. 期限（valid signature + expired は STALE_PREVIEW。INVALID_INPUT と混同しない）
  if (isMenuPlannerAcceptClaimsExpired(claims, now)) {
    return {
      ok: false,
      error: acceptError("STALE_PREVIEW", "ACCEPT_TOKEN_EXPIRED", "プレビューの有効期限が切れました。もう一度プレビューを作成してください。"),
    };
  }

  // 4. owner binding（他 owner の context を再読込しない）
  if (claims.ownerId !== input.ownerId) {
    return {
      ok: false,
      error: acceptError("INVALID_INPUT", "ACCEPT_TOKEN_OWNER_MISMATCH", "プレビューの確認情報を検証できません。もう一度プレビューを作成してください。"),
    };
  }

  return { ok: true, verified: { claims, ownerId: input.ownerId, now } };
}

/**
 * 検証済みtokenを使い、authoritative contextをtransaction clientから再読込してA2を再実行する。
 * A3Bはこの関数を同一transaction内で呼ぶため、revalidateとwriteの間にTOCTOU gapを作らない。
 */
export async function revalidateVerifiedMenuPlannerAccept(
  verified: VerifiedMenuPlannerAccept,
  options: { db?: PrismaDbClient; inlineRunningContextJson?: string } = {},
): Promise<RevalidateMenuPlannerAcceptResult> {
  const { claims } = verified;
  const { inlineRunningContextJson, ...previewOptions } = options;
  // authoritative recompute。token の数値ではなく、server が読み直した context から A2 を再実行する。
  const recomputed = await buildMenuPlannerPreviewForRevalidation({
    schemaVersion: MENU_PLANNER_PREVIEW_SCHEMA_VERSION,
    ownerId: verified.ownerId,
    contextMenuTemplateId: claims.contextMenuTemplateId,
    menuName: claims.menuName,
    constraints: claims.constraints,
    proposal: claims.proposal,
    ...(inlineRunningContextJson !== undefined ? { inlineRunningContextJson } : {}),
    // 発行時に確定した sanitizer の判定を replay する（token の proposal は sanitize 済みのため、
    // そのまま再 sanitize すると AI_REASON_SANITIZED が消えて digest が一致しなくなる）。
  }, { requestDigest: claims.requestDigest, reasonSanitized: claims.reasonSanitized }, previewOptions);
  if (!recomputed.ok) {
    return { ok: false, error: fromPlannerError(recomputed.error, true) };
  }

  // 6. stale gate（両方必須）
  const freshness = evaluatePreviewAcceptFreshness({
    signedContextFingerprint: claims.contextFingerprint,
    signedMaterializationDigest: claims.materializationDigest,
    recomputedContextFingerprint: recomputed.preview.binding.contextFingerprint,
    recomputedMaterializationDigest: recomputed.preview.binding.materializationDigest,
  });
  if (!freshness.fresh) {
    // 何も保存しない。全体を拒否し、コーチに再プレビューを求める（silent recalculation 禁止）。
    const contextStale = freshness.mismatchedGates.includes("CONTEXT_FINGERPRINT");
    return {
      ok: false,
      error: contextStale
        ? acceptError("STALE_PREVIEW", "CONTEXT_BINDING_STALE", "参照している条件が変わったため、このプレビューは保存できません。もう一度プレビューを作成してください。")
        : acceptError("STALE_PREVIEW", "MATERIALIZATION_STALE", "プレビュー後に内容が変わったため、このプレビューは保存できません。もう一度プレビューを作成してください。"),
    };
  }

  // A signed acceptToken can only be issued for canSave=true. Keep this guard
  // fail-closed for impossible/tampered internal states instead of fabricating
  // a write materialization for an unsaveable replay.
  if (recomputed.revalidation.draft === null) {
    return {
      ok: false,
      error: acceptError("PLANNING_REJECTED", "DETERMINISTIC_PLANNING_FAILED", "決定論的なプレビューを生成できません。"),
    };
  }

  return {
    ok: true,
    preview: recomputed.preview,
    materialization: {
      previewId: claims.previewId,
      targetMenuId: claims.targetMenuId,
      contextFingerprint: recomputed.preview.binding.contextFingerprint,
      materializationDigest: recomputed.preview.binding.materializationDigest,
      ruleSet: recomputed.revalidation.ruleSet,
      sanitizedProposal: recomputed.revalidation.sanitizedProposal,
      draft: recomputed.revalidation.draft,
    },
  };
}

/**
 * tokenを検証し、authoritative contextを再読込してA2を再実行し、bindingの一致を判定する。
 * 通常のA3A caller向けwrapper。A3Bは同じ処理のverified variantをtransaction内で使う。
 */
export async function revalidateMenuPlannerAccept(
  input: RevalidateMenuPlannerAcceptInput,
  deps: MenuPlannerAcceptDependencies,
): Promise<RevalidateMenuPlannerAcceptResult> {
  const verified = verifyMenuPlannerAcceptToken(input, deps);
  if (!verified.ok) return verified;
  return revalidateVerifiedMenuPlannerAccept(
    verified.verified,
    input.inlineRunningContextJson !== undefined ? { inlineRunningContextJson: input.inlineRunningContextJson } : {},
  );
}
