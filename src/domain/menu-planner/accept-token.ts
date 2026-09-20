/**
 * Running v2 / MenuPlanner — signed preview accept token の **claim contract**（§18.6 [R12-A1] の application phase）。
 *
 * ここに置くのは「token に何を載せてよいか」の pure な型と schema、そして payload bytes を決める
 * canonicalizer だけ。HMAC も secret も node:crypto も持たない（署名の実装は `src/infra/security/` の責務。
 * §1.6 の import boundary と同じ考え方）。
 *
 * **token は tamper-evident であって confidential ではない。** payload は base64url であり暗号化ではないため、
 * token を持つ者は claim を読める。したがって claim には「client が元々持っている情報」と
 * 「client に見えてよい identity / hash」だけを載せる（secret・health data・raw provider output は載せない）。
 * §18.6 が要求するのは DB 無しでの tamper / stale 検出であり、秘匿ではない。
 *
 * token の意味（§18.6）:
 *   - preview 時に server が「コーチが見たもの」を確定し、accept 時に同じ binding が再現できるかを検査する。
 *   - DB へは何も保存しない（preview / token / session いずれの row も作らない）。
 *   - signature は *what coach reviewed* を証明するものであり、保存する数値の authority ではない。
 *     保存できるのは accept 時の fresh な server 再計算だけ（`PREVIEW_ACCEPT_AUTHORITY = SERVER_RECOMPUTE`）。
 *
 * token に **載せてはいけないもの**（§18.6 / §18.8）:
 *   raw coach prompt / raw AI response / chain-of-thought / health data / birthDate / sexForNorms /
 *   raw subject・history・Competition 行 / API key・signing key / raw RuleSet object / Evidence objects /
 *   Prisma model / stack trace。
 * したがって claim は「sanitize 済み proposal + constraints + requestDigest + identity + binding hash」に閉じる。
 */
import { z } from "zod";

import { ruleSetStatusSchema } from "@/domain/running/rules/schema";
import {
  aiPlannerProposalSchema,
  menuPlannerIntentRequestSchema,
  type AiPlannerProposal,
  type MenuPlannerIntentRequest,
} from "./contracts";

/** claim payload の版。token 形式を変えるときはここを上げる（literal なので旧版は parse で落ちる）。 */
export const MENU_PLANNER_ACCEPT_TOKEN_SCHEMA_VERSION = 1 as const;

/** stored / previewId / targetMenuId など server 生成 identity の形。 */
const acceptIdentitySchema = z.string().trim().min(1).max(128);

/** SHA-256 hex（A2 の contextFingerprint / materializationDigest と同じ表現）。 */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * A1 の public intent schema から constraints 部分だけを取り出した claim schema。
 * replay では raw requestText を要求しないが、constraints の validation / strictness は A2 と共有する。
 * `innerType()` は top-level cross-field refinement のない object schema を返すため、preferred/excluded の
 * 関係だけは token claim 側でも明示的に再検査する。
 */
export const menuPlannerAcceptConstraintsSchema = menuPlannerIntentRequestSchema
  .innerType()
  .shape.constraints
  .superRefine((constraints, context) => {
    const excluded = new Set(constraints.excludedExerciseIds);
    for (const [index, id] of constraints.preferredExerciseIds.entries()) {
      if (excluded.has(id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "An exercise cannot be both preferred and excluded.",
          path: ["preferredExerciseIds", index],
        });
      }
    }
  });

/**
 * 日時は常に UTC ISO（`toISOString()` 形式）へ正規化する。
 * payload bytes を入力表記（`+09:00` / `Z` / ミリ秒有無）に依存させないため、parse 時点で畳む。
 */
const canonicalIsoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/** preview を作った RuleSet の同一性。RuleSet object は載せない（版・内容 hash・status だけ）。 */
const acceptRuleSetIdentitySchema = z
  .object({
    version: z.string().trim().min(1).max(64),
    contentHash: z.string().trim().min(1).max(128),
    status: ruleSetStatusSchema,
  })
  .strict();

/**
 * preview を生成した planner の identity。engine / policy の版と、
 * provenance に載る provider・model・requestId（いずれも server 生成で client input ではない）。
 */
const acceptPlannerIdentitySchema = z
  .object({
    policyId: z.string().trim().min(1).max(64),
    previewSchemaVersion: z.number().int().positive(),
    engineId: z.string().trim().min(1).max(64),
    runningEngineId: z.string().trim().min(1).max(64),
    legacyEngineId: z.string().trim().min(1).max(64),
    provider: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(64),
    requestId: z.string().trim().min(1).max(64),
  })
  .strict();

/**
 * accept token の claim。`.strict()` なので未知 claim は silent strip されず parse が落ちる（§「unknown field rejects」）。
 */
export const menuPlannerAcceptClaimsSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_ACCEPT_TOKEN_SCHEMA_VERSION),
    /** server 生成。accept lineage の identity。 */
    previewId: acceptIdentitySchema,
    /** A1 の double-submit foundation。A3B が同じ targetMenuId で MenuTemplate を作る。 */
    targetMenuId: acceptIdentitySchema,
    /** token の持ち主。trusted caller の ownerId と exact 一致を要求する。 */
    ownerId: acceptIdentitySchema,
    /** 参照メニュー（authoritative re-read の入口）。 */
    contextMenuTemplateId: z.string().trim().min(1).max(64),
    /** accept 時に client が差し替えられない（変更したければ re-preview）。 */
    menuName: z.string().trim().min(1).max(120),
    /** A2 の決定論的再計算に必要な safe structured constraints。raw requestText は載せない。 */
    constraints: menuPlannerAcceptConstraintsSchema,
    /** canonical serialized MenuPlannerIntentRequest の SHA-256。binding/lineage 専用で authority ではない。 */
    requestDigest: sha256HexSchema,
    /** strict-validated → catalog-validated → reason-sanitized 済みの proposal だけを載せる。 */
    proposal: aiPlannerProposalSchema,
    /**
     * item 順の「AI reason が sanitize された」判定（token の proposal と同じ長さ・同じ順）。
     * sanitize 済みの reason をもう一度 sanitizer に通すと判定が false に戻って findings が消え、
     * materializationDigest が一致しなくなるため、**判定そのもの**を binding して accept 時に replay する。
     * 生の reason（sanitize 前の文字列）は載せない。
     */
    reasonSanitized: z.array(z.boolean()).min(1).max(20),
    /** preview 時の authoritative context binding。 */
    contextFingerprint: sha256HexSchema,
    /** preview 時の canonical display result。 */
    materializationDigest: sha256HexSchema,
    ruleSet: acceptRuleSetIdentitySchema,
    planner: acceptPlannerIdentitySchema,
    issuedAt: canonicalIsoDateTimeSchema,
    expiresAt: canonicalIsoDateTimeSchema,
  })
  .strict()
  .superRefine((claims, context) => {
    if (claims.reasonSanitized.length !== claims.proposal.items.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reasonSanitized の長さは proposal の item 数と一致する必要があります",
        path: ["reasonSanitized"],
      });
    }
    if (new Date(claims.expiresAt).getTime() <= new Date(claims.issuedAt).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expiresAt は issuedAt より後である必要があります",
        path: ["expiresAt"],
      });
    }
  });

export type MenuPlannerAcceptClaims = z.infer<typeof menuPlannerAcceptClaimsSchema>;

/**
 * claim → payload bytes を決める canonical object。
 *
 * `canonicalStringify` は与えられた object の key を lexical sort するため、この関数を通す目的は
 * **載せる claim の集合を明示的に閉じる**ことにある（余計な field が混ざったまま署名されるのを防ぐ）。
 * 日時は schema で UTC 正規化済み、proposal / intent は canonicalize 済みを前提とする。
 */
export function canonicalizeMenuPlannerAcceptClaims(claims: MenuPlannerAcceptClaims): unknown {
  return {
    schemaVersion: claims.schemaVersion,
    previewId: claims.previewId,
    targetMenuId: claims.targetMenuId,
    ownerId: claims.ownerId,
    contextMenuTemplateId: claims.contextMenuTemplateId,
    menuName: claims.menuName,
    constraints: claims.constraints,
    requestDigest: claims.requestDigest,
    proposal: claims.proposal,
    reasonSanitized: claims.reasonSanitized,
    contextFingerprint: claims.contextFingerprint,
    materializationDigest: claims.materializationDigest,
    ruleSet: {
      version: claims.ruleSet.version,
      contentHash: claims.ruleSet.contentHash,
      status: claims.ruleSet.status,
    },
    planner: {
      policyId: claims.planner.policyId,
      previewSchemaVersion: claims.planner.previewSchemaVersion,
      engineId: claims.planner.engineId,
      runningEngineId: claims.planner.runningEngineId,
      legacyEngineId: claims.planner.legacyEngineId,
      provider: claims.planner.provider,
      model: claims.planner.model,
      requestId: claims.planner.requestId,
    },
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
}

/**
 * 期限判定。`now < expiresAt` の間だけ有効で、境界（`now === expiresAt`）は **期限切れ**として扱う。
 * 判定は signature 検証後にだけ行う（tampered token の期限を先に信じない）。
 */
export function isMenuPlannerAcceptClaimsExpired(claims: MenuPlannerAcceptClaims, now: Date): boolean {
  return now.getTime() >= new Date(claims.expiresAt).getTime();
}

/** 型の再輸出（application 層が domain の型を 1 経路で参照できるように）。 */
export type { AiPlannerProposal, MenuPlannerIntentRequest };

// ---------------------------------------------------------------------------
// Freshness（§18.6: preview の binding と accept 時の再計算結果の一致判定）
// ---------------------------------------------------------------------------

/** 一致しなかった gate。両方必須なので、片方だけ一致しても fresh にはならない。 */
export const PREVIEW_ACCEPT_BINDING_GATES = ["CONTEXT_FINGERPRINT", "MATERIALIZATION_DIGEST"] as const;
export type PreviewAcceptBindingGate = (typeof PREVIEW_ACCEPT_BINDING_GATES)[number];

export type PreviewAcceptFreshnessInput = {
  /** token に署名されていた値。 */
  signedContextFingerprint: string;
  signedMaterializationDigest: string;
  /** accept 時に server が再計算した値。 */
  recomputedContextFingerprint: string;
  recomputedMaterializationDigest: string;
};

export type PreviewAcceptFreshnessResult =
  | { fresh: true }
  | { fresh: false; mismatchedGates: PreviewAcceptBindingGate[] };

/**
 * §18.6 の stale gate。**必ず両方**を要求する。
 *   - contextFingerprint は authoritative context（Exercise catalog / RuleSet identity / subject / history /
 *     competition / source menu / planning date）の同一性。
 *   - materializationDigest は canonical display result（順序・処方・provenance・findings・sanitized reason）の同一性。
 *   片方だけ一致しても fresh としない（context 不変でも materialization semantics は変わりうるし、
 *   materialization が同じでも context が stale なら別メニューになる）。
 *
 * 純粋関数。clock も IO も持たない。
 */
export function evaluatePreviewAcceptFreshness(
  input: PreviewAcceptFreshnessInput,
): PreviewAcceptFreshnessResult {
  const mismatchedGates: PreviewAcceptBindingGate[] = [];
  if (input.signedContextFingerprint !== input.recomputedContextFingerprint) {
    mismatchedGates.push("CONTEXT_FINGERPRINT");
  }
  if (input.signedMaterializationDigest !== input.recomputedMaterializationDigest) {
    mismatchedGates.push("MATERIALIZATION_DIGEST");
  }
  return mismatchedGates.length === 0 ? { fresh: true } : { fresh: false, mismatchedGates };
}
