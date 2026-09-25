"use server";

/**
 * Running Prescription Engine v2 — R10-B1 Server Actions（UI 未接続）。
 *
 * 既存 Action の3ステップ規約（検証 → repository/service → revalidatePath）に合わせる。
 * 実際の context 組み立て・RuleSet 解決・plan 実行・保存は `_running-plan-service.ts` に委譲し、
 * ここでは「入力検証」「service 呼び出し」「エラーの日本語化」「再検証」だけを行う（§26）。
 *
 * feature flag（`RUNNING_V2_UI_ENABLED`）が OFF のときは、この Action すべてを拒否する
 * （§3・§4）。legacy Action（`menu-actions.ts`）はこのフラグの影響を受けない。
 *
 * [R10-B4A] Action contract の確定:
 *   - 4つの処方 Action は `confirmedFindingCodes[]`（REQUIRE_CONFIRMATION の明示確認。code 単位）を受け取る。
 *     service が**現在の入力で plan を再実行した結果**に対して照合し、不足なら CONFIRMATION_REQUIRED、
 *     現在の結果に無い code が含まれていれば CONFIRMATION_STATE_STALE を返す（保存しない）。
 *   - override は `confirmedTwice` を**必須の明示入力**として受け取り、そのまま domain の CoachOverride schema に渡す
 *     （どの target で二重確認が必要かをここに複製しない。未入力を true / false に補わない）。
 *   - 失敗結果は `kind` 付きの discriminated union。Finding / 不適格理由は B3 の presentation mapper で日本語化して返す
 *     （Finding code・enum を message に出さない。code は内部 payload としてだけ持つ）。
 */
import { plausibilityReviewsJsonSchema } from "./_plausibility-review-input";
import type { PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FieldErrors } from "@/domain/shared/result";
import { optionalText, requiredText } from "@/domain/shared/zod-helpers";
import { parseForm } from "@/lib/form";
import { isRunningV2UiEnabled } from "@/lib/feature-flags";
import { RUNNING_TRAINING_METHODS, type Finding } from "@/domain/running";
import { envelopeFieldSchema } from "@/domain/running/rules/schema";
import { coachFieldEditSchema, findingCodeSchema } from "@/domain/running/planning/schema";
import { coachManualReferenceInputSchema, toCoachReferenceInput } from "@/domain/running/planning/coachReference";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { runningMenuContextSchema } from "@/domain/running/persistence/menuContext";
import { findMenuRunningContext, saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import type { EligibilityReasonPresentationDto, FindingPresentationDto } from "@/presentation/running/dto";
import { presentEligibilityReasons } from "@/presentation/running/eligibility";
import { presentFindings } from "@/presentation/running/findings";
import {
  RunningActionError,
  editRunningItem,
  overrideRunningItem,
  planNewRunningItem,
  recalculateRunningItem,
  type RunningActionRejection,
} from "./_running-plan-service";

// ---------------------------------------------------------------------------
// 結果の型（[R10-B4A] discriminated union）
// ---------------------------------------------------------------------------

export type RunningActionFailure =
  /** 入力の形式が正しくない（fieldErrors は日本語）。 */
  | { ok: false; kind: "INVALID_INPUT"; message: string; fieldErrors?: FieldErrors }
  /** 対象が無い・flag OFF・版を確認できない等（安全な日本語メッセージだけ）。 */
  | { ok: false; kind: "REJECTED"; message: string }
  /** 現在の plan 結果に、明示確認が必要な Finding がある（または確認が足りない）。 */
  | { ok: false; kind: "CONFIRMATION_REQUIRED"; message: string; requiredFindingCodes: string[]; findings: FindingPresentationDto[] }
  /** 現在の plan 結果に存在しない Finding の確認が送られた（以前の結果の確認）。再確認が必要。 */
  | { ok: false; kind: "CONFIRMATION_STATE_STALE"; message: string; requiredFindingCodes: string[]; findings: FindingPresentationDto[] }
  /**
   * この対象・条件では選べない（理由は B3 の message registry で日本語化）。
   * [R10-B4A.2] `acceptsCoachTargetSplit`: この Method の RuleSet がコーチ入力の目標スプリットを受け付けるか（UI の案内用）。
   */
  | {
      ok: false;
      kind: "PLAN_INELIGIBLE";
      message: string;
      reasons: EligibilityReasonPresentationDto[];
      findings: FindingPresentationDto[];
      acceptsCoachTargetSplit: boolean;
    }
  /** 計画できない（BLOCK 等）。 */
  | { ok: false; kind: "PLAN_BLOCKED"; message: string; findings: FindingPresentationDto[]; reviewIssues?: PlausibilityIssue[]; reviewError?: "REVIEW_REQUIRED" | "REVIEW_INVALID" };

export type RunningActionResult<T> = { ok: true; data: T; message?: string } | RunningActionFailure;

// ---------------------------------------------------------------------------
// feature flag ゲート
// ---------------------------------------------------------------------------

const FLAG_OFF_MESSAGE = "この機能はまだ有効になっていません。";

function requireFlagOn(): RunningActionFailure | null {
  return isRunningV2UiEnabled() ? null : { ok: false, kind: "REJECTED", message: FLAG_OFF_MESSAGE };
}

function invalidInput(result: { message: string; fieldErrors?: FieldErrors }): RunningActionFailure {
  return { ok: false, kind: "INVALID_INPUT", message: result.message, fieldErrors: result.fieldErrors };
}

// ---------------------------------------------------------------------------
// エラーの日本語化（enum コードをそのままユーザーへ返さない）
// ---------------------------------------------------------------------------

const OVERRIDE_INPUT_FIELD_MESSAGES: Record<string, string> = {
  confirmedTwice: "この例外設定には、2段階の確認が必要です。",
  reason: "理由を見直してください。",
  newValue: "値を見直してください。",
  target: "例外設定の対象を見直してください。",
  eligibilityOverrideRuleIds: "現在の計画で解除可能な条件を選んでください。",
};

function rejectionMessageJa(rejection: RunningActionRejection): string {
  switch (rejection.code) {
    case "MENU_NOT_FOUND":
      return "メニューが見つかりません。";
    case "BLOCK_NOT_FOUND":
      return "ブロックが見つかりません。";
    case "ITEM_NOT_FOUND":
      return "項目が見つかりません。";
    case "ITEM_NOT_RUNNING_V2":
      return "この項目は走トレーニング（RUNNING_V2）の処方ではありません。";
    case "RUNNING_CONTEXT_MISSING":
      return "このメニューには対象グループ・計画日の設定がありません。先に設定してください。";
    case "RUNNING_CONTEXT_INVALID":
      return "このメニューの対象グループ・計画日の設定を読み込めません。";
    case "PLANNED_DATE_REQUIRED":
      return "計画日が設定されていません。先に計画日を設定してください（当日で自動的に代用しません）。";
    case "RULESET_VERSION_NOT_FOUND":
    case "RULESET_IDENTITY_MISMATCH":
      return "保存されている処方の版情報を確認できません。サポートにお問い合わせください。";
    case "REPLAN_INPUT_SNAPSHOT_MISSING":
      return "この処方は再計算に必要な情報（旧バージョン）を持っていないため、この操作はできません。";
    case "COACH_EDIT_FIELD_NOT_SUPPORTED":
      return "この値は他の値から決まる合計・制約の値のため、直接は変更できません。";
    case "PLAN_INELIGIBLE":
      return "この選手・条件ではこの方式を選べません。";
    case "PLAN_BLOCKED":
      return "入力内容を計画できませんでした。値を見直してください。";
    case "CONFIRMATION_REQUIRED":
      return "保存する前に確認が必要な内容があります。内容を確認したうえで、もう一度保存してください。";
    case "CONFIRMATION_STATE_STALE":
      return "計算結果が変わったため、確認をやり直してください。";
    case "OVERRIDE_INPUT_INVALID":
      return "例外設定の内容を確認してください。";
    case "OVERRIDE_TARGET_INVALID":
      return "現在の計画結果で実際に確認された、解除可能な条件を選んでください。";
    case "OVERRIDE_HISTORY_UNCONFIRMED":
      return "以前の例外設定に確認の記録が無いため、この操作はできません。例外設定をやり直してください。";
    case "PERSISTENCE_INVALID":
      return "保存できる内容ではありませんでした。";
  }
}

function toRunningActionFailure(e: unknown): RunningActionFailure {
  if (!(e instanceof RunningActionError)) return { ok: false, kind: "REJECTED", message: "保存に失敗しました。" };
  const rejection = e.rejection;
  const message = rejectionMessageJa(rejection);
  switch (rejection.code) {
    case "CONFIRMATION_REQUIRED":
    case "CONFIRMATION_STATE_STALE":
      return {
        ok: false,
        kind: rejection.code,
        message,
        requiredFindingCodes: [...rejection.requiredFindingCodes],
        findings: presentFindings(rejection.findings),
      };
    case "PLAN_INELIGIBLE":
      return {
        ok: false,
        kind: "PLAN_INELIGIBLE",
        message,
        reasons: presentEligibilityReasons(rejection.reasons),
        findings: presentFindings(rejection.findings),
        acceptsCoachTargetSplit: rejection.acceptsCoachTargetSplit,
      };
    case "PLAN_BLOCKED":
      return { ok: false, kind: "PLAN_BLOCKED", message, findings: presentFindings(rejection.findings), reviewIssues: rejection.reviewIssues, reviewError: rejection.reviewError };
    case "OVERRIDE_INPUT_INVALID": {
      const fieldErrors: FieldErrors = {};
      for (const path of rejection.paths) {
        const text = OVERRIDE_INPUT_FIELD_MESSAGES[path] ?? "入力内容を見直してください。";
        (fieldErrors[path in OVERRIDE_INPUT_FIELD_MESSAGES ? path : "_form"] ??= []).push(text);
      }
      return { ok: false, kind: "INVALID_INPUT", message, fieldErrors };
    }
    case "OVERRIDE_TARGET_INVALID":
      return { ok: false, kind: "INVALID_INPUT", message, fieldErrors: { eligibilityOverrideRuleIds: [OVERRIDE_INPUT_FIELD_MESSAGES.eligibilityOverrideRuleIds!] } };
    default:
      return { ok: false, kind: "REJECTED", message };
  }
}

// ---------------------------------------------------------------------------
// 共通入力: confirmedFindingCodes（[R10-B4A]）
// ---------------------------------------------------------------------------

/** FormData の `confirmedFindingCodes` は `getAll()` で読む（複数値）。空なら確認なし。 */
const CONFIRMED_FINDING_CODES_KEY = "confirmedFindingCodes";
const confirmedFindingCodesSchema = z
  .array(findingCodeSchema)
  .max(50)
  .transform((codes) => [...new Set(codes)]);

// ---------------------------------------------------------------------------
// 共通入力: coachReferenceJson（[R10-B4A.2]）
// ---------------------------------------------------------------------------

/**
 * コーチが手入力した強度の基準（R10-B4A.2 では TARGET_SPLIT のみ）。`coachReferenceJson` に
 * `{"kind":"TARGET_SPLIT","segments":[{"distanceM":300,"targetTimeS":38}]}` の strict JSON で受け取り、domain の
 * `toCoachReferenceInput()` で正式な IntensityReference に正規化する。未送信・空文字は「基準の入力なし」。
 * RuleSet version・evidence・confidence はユーザー入力から受け取らない。どの Method で使えるかは domain が検証する。
 */
const coachReferenceJsonSchema = z
  .string()
  .max(10000)
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return null;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "目標スプリットの形式が正しくありません" });
      return z.NEVER;
    }
    const parsed = coachManualReferenceInputSchema.safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "目標スプリットは、区間ごとに0より大きい距離と目標タイムを入力してください" });
      return z.NEVER;
    }
    return toCoachReferenceInput(parsed.data);
  });

// ---------------------------------------------------------------------------
// planRunningItemAction（§28）
// ---------------------------------------------------------------------------

const planRunningItemSchema = z.object({
  fieldOverridesJson: z.string().max(30000).optional().transform((raw, ctx) => {
    if (!raw?.trim()) return [];
    try {
      const parsed = z.array(z.object({ field: envelopeFieldSchema, layer: z.enum(["COACH_EDITABLE", "HARD_SAFETY"]),
        newValue: z.number().finite(), reason: z.string().trim().min(10).max(1000), confirmedTwice: z.boolean(),
      }).strict()).max(25).safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch { /* Safe form error below. */ }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "例外設定の対象・理由・確認を見直してください" });
    return z.NEVER;
  }),
  method: z.enum(RUNNING_TRAINING_METHODS),
  templateId: requiredText("テンプレート", 64),
  positionPreference: z.union([z.enum(["LOWER", "MIDDLE"]), z.literal("")]).transform((v) => (v === "" ? null : v)),
  confirmedFindingCodes: confirmedFindingCodesSchema,
  plausibilityReviewsJson: plausibilityReviewsJsonSchema,
  coachReferenceJson: coachReferenceJsonSchema,
  eligibilityOverrideRuleIds: z.array(z.string().trim().min(1).max(120)).max(20),
  eligibilityOverrideReason: z.string().max(1000).optional().transform((value) => (value ?? "").trim() || null),
  eligibilityOverrideFirstConfirmation: z.enum(["true", "false"]).optional().transform((value) => (value === undefined ? undefined : value === "true")),
  eligibilityOverrideSecondConfirmation: z.enum(["true", "false"]).optional().transform((value) => (value === undefined ? undefined : value === "true")),
  coachEditsJson: z
    .string()
    .max(10000)
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === "") return [];
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "コーチ入力の形式が正しくありません" });
        return z.NEVER;
      }
      const parsed = z.array(coachFieldEditSchema).max(25).safeParse(json);
      if (!parsed.success) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "コーチ入力の数値と単位を確認してください" });
        return z.NEVER;
      }
      return parsed.data;
    }),
});

/**
 * [§28] コーチから受け取るのは method / templateId / positionPreference / 確認済み Finding code（と対象の menu/block、
 * 既存 `addMenuItemAction` と同じく bind 済みの引数として渡す）だけ。RuleSet version・confidence・
 * evidenceIds・数値の権限はユーザー入力から一切受け取らない（すべて service が保存済みデータと
 * domain engine から決める）。
 */
export type PlanRunningItemResult = { id: string; sessionFindings: Finding[]; sessionFindingViews: FindingPresentationDto[] };

export async function planRunningItemAction(
  menuId: string,
  blockId: string,
  _prev: RunningActionResult<PlanRunningItemResult> | null,
  formData: FormData,
): Promise<RunningActionResult<PlanRunningItemResult>> {
  const flagOff = requireFlagOn();
  if (flagOff) return flagOff;

  const parsed = parseForm(planRunningItemSchema, formData, [CONFIRMED_FINDING_CODES_KEY, "eligibilityOverrideRuleIds"]);
  if (!parsed.ok) return invalidInput(parsed.result as { message: string; fieldErrors?: FieldErrors });

  let result: PlanRunningItemResult;
  try {
    const {
      coachReferenceJson,
      fieldOverridesJson,
      plausibilityReviewsJson,
      coachEditsJson,
      eligibilityOverrideFirstConfirmation,
      eligibilityOverrideSecondConfirmation,
      ...rest
    } = parsed.data;
    const eligibilityOverrideConfirmedTwice =
      eligibilityOverrideFirstConfirmation === undefined || eligibilityOverrideSecondConfirmation === undefined
        ? undefined
        : eligibilityOverrideFirstConfirmation && eligibilityOverrideSecondConfirmation;
    const created = await planNewRunningItem({
      menuId,
      blockId,
      ...rest,
      coachReference: coachReferenceJson,
      fieldOverrides: fieldOverridesJson,
      plausibilityReviewRequests: plausibilityReviewsJson,
      coachEdits: coachEditsJson,
      eligibilityOverrideConfirmedTwice,
    });
    result = { id: created.item.id, sessionFindings: created.sessionFindings, sessionFindingViews: presentFindings(created.sessionFindings) };
  } catch (e) {
    return toRunningActionFailure(e);
  }

  revalidatePath(`/menus/${menuId}`);
  return { ok: true, data: result, message: "追加しました" };
}

// ---------------------------------------------------------------------------
// editRunningItemAction（§31/§32）
// ---------------------------------------------------------------------------

const fieldEditsJsonSchema = z
  .string()
  .max(10000)
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === "") return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "コーチ入力の形式が正しくありません" });
      return z.NEVER;
    }
    const parsed = z
      .array(z.object({ field: coachFieldEditSchema.shape.field, value: z.number().finite() }).strict())
      .min(1)
      .max(25)
      .safeParse(json);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "コーチ入力の数値を確認してください" });
      return z.NEVER;
    }
    if (new Set(parsed.data.map((edit) => edit.field)).size !== parsed.data.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "同じ項目を複数回指定できません" });
      return z.NEVER;
    }
    return parsed.data;
  });

const editRunningItemSchema = z
  .object({
    itemId: requiredText("項目", 64),
    field: z.union([coachFieldEditSchema.shape.field, z.literal("")]).optional(),
    value: z.union([z.coerce.number().finite(), z.literal("")]).optional(),
    /** 複数項目を一回の同一Planで更新するAction用。通常の編集UIは従来のfield/valueを使う。 */
    fieldEditsJson: fieldEditsJsonSchema,
    confirmedFindingCodes: confirmedFindingCodesSchema,
  plausibilityReviewsJson: plausibilityReviewsJsonSchema,
    /** [R10-B4A.2] 強度の基準（目標スプリット）の明示更新。未送信なら保存済みの基準をそのまま使う。 */
    coachReferenceJson: coachReferenceJsonSchema,
  })
  .transform((v, ctx) => {
    const hasField = v.field !== undefined && v.field !== "";
    const hasValue = v.value !== undefined && v.value !== "";
    const hasFieldEdits = v.fieldEditsJson !== undefined;
    if (hasField !== hasValue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "変更する項目と値を指定してください", path: [hasField ? "value" : "field"] });
      return z.NEVER;
    }
    if (hasField && hasFieldEdits) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "編集形式はどちらか一方を指定してください", path: ["fieldEditsJson"] });
      return z.NEVER;
    }
    if (!hasField && !hasFieldEdits && v.coachReferenceJson === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "変更する項目と値、または目標スプリットを指定してください", path: ["field"] });
      return z.NEVER;
    }
    return {
      itemId: v.itemId,
      confirmedFindingCodes: v.confirmedFindingCodes,
      plausibilityReviewRequests: v.plausibilityReviewsJson,
      ...(hasField
        ? { fieldEdits: [{ field: v.field as z.infer<typeof coachFieldEditSchema.shape.field>, value: v.value as number }] }
        : hasFieldEdits
          ? { fieldEdits: v.fieldEditsJson }
          : {}),
      ...(v.coachReferenceJson !== null ? { coachReference: v.coachReferenceJson } : {}),
    };
  });

/**
 * [§31/§32] 対象は RUNNING_V2 のみ（LEGACY は reject。service 側で判定）。
 * coachEditable かどうか・hard safety を超えていないかは domain の再計画自体が検証する
 * （ここで数値の安全規則を複製しない）。[R10-B4A] aggregate 型の field は直接 edit しない（service が拒否）。
 */
export type RunningReplanResult = { sessionFindings: Finding[]; sessionFindingViews: FindingPresentationDto[] };

export async function editRunningItemAction(
  menuId: string,
  _prev: RunningActionResult<RunningReplanResult> | null,
  formData: FormData,
): Promise<RunningActionResult<RunningReplanResult>> {
  const flagOff = requireFlagOn();
  if (flagOff) return flagOff;

  const parsed = parseForm(editRunningItemSchema, formData, [CONFIRMED_FINDING_CODES_KEY]);
  if (!parsed.ok) return invalidInput(parsed.result as { message: string; fieldErrors?: FieldErrors });

  let sessionFindings: Finding[];
  try {
    sessionFindings = (await editRunningItem(parsed.data)).sessionFindings;
  } catch (e) {
    return toRunningActionFailure(e);
  }

  revalidatePath(`/menus/${menuId}`);
  return { ok: true, data: { sessionFindings, sessionFindingViews: presentFindings(sessionFindings) }, message: "保存しました" };
}

// ---------------------------------------------------------------------------
// overrideRunningItemAction（§33）
// ---------------------------------------------------------------------------

const overrideTargetFormSchema = z
  .object({
    itemId: requiredText("項目", 64),
    targetKind: z.enum(["ELIGIBILITY", "READINESS", "FIELD"]),
    ruleId: optionalText(120),
    readinessAction: z.union([z.literal("CANCEL_HIGH_INTENSITY"), z.literal("")]).optional(),
    field: z.union([envelopeFieldSchema, z.literal("")]).optional(),
    layer: z.union([z.enum(["COACH_EDITABLE", "HARD_SAFETY"]), z.literal("")]).optional(),
    newValue: z
      .union([z.coerce.number().finite(), z.literal("")])
      .optional()
      .transform((v) => (v === "" || v === undefined ? undefined : v)),
    reason: requiredText("理由", 1000).pipe(z.string().min(10, "理由は10文字以上必要です")),
    /**
     * [R10-B4A] 二重確認の状態。**明示的な "true" / "false" だけ**を受け付け、未送信・空文字は入力エラーにする
     * （未入力を true に昇格させない・false に丸めない）。どの target で true が必要かは domain schema が決める。
     */
    confirmedTwice: z.enum(["true", "false"], { errorMap: () => ({ message: "確認の状態を指定してください" }) }).transform((v) => v === "true"),
    confirmedFindingCodes: confirmedFindingCodesSchema,
  plausibilityReviewsJson: plausibilityReviewsJsonSchema,
  })
  .transform((v, ctx) => {
    const common = { plausibilityReviewRequests: v.plausibilityReviewsJson, itemId: v.itemId, reason: v.reason, confirmedTwice: v.confirmedTwice, confirmedFindingCodes: v.confirmedFindingCodes };
    if (v.targetKind === "ELIGIBILITY") {
      if (!v.ruleId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "対象の規則を選んでください", path: ["ruleId"] });
        return z.NEVER;
      }
      return { ...common, newValue: undefined, target: { kind: "ELIGIBILITY" as const, ruleId: v.ruleId } };
    }
    if (v.targetKind === "READINESS") {
      if (v.readinessAction !== "CANCEL_HIGH_INTENSITY") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "対象の readiness action を選んでください", path: ["readinessAction"] });
        return z.NEVER;
      }
      return { ...common, newValue: undefined, target: { kind: "READINESS" as const, action: "CANCEL_HIGH_INTENSITY" as const } };
    }
    if (!v.field || !v.layer) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "対象の項目と範囲（coachEditable / hardSafety）を選んでください", path: ["field"] });
      return z.NEVER;
    }
    if (v.newValue === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "新しい値を入力してください", path: ["newValue"] });
      return z.NEVER;
    }
    return { ...common, newValue: v.newValue, target: { kind: "FIELD" as const, field: v.field, layer: v.layer } };
  });

/**
 * [§33] CoachActor 必須（service 側で `getCoachActorForServer()` から生成する。ここでは生成しない）。
 * reason の最小文字数・ELIGIBILITY / HARD_SAFETY の confirmedTwice 要件は domain の
 * `coachOverrideSchema` が検証する（Action 側で数値安全規則・二重確認の要否を複製しない）。
 */
export async function overrideRunningItemAction(
  menuId: string,
  _prev: RunningActionResult<RunningReplanResult> | null,
  formData: FormData,
): Promise<RunningActionResult<RunningReplanResult>> {
  const flagOff = requireFlagOn();
  if (flagOff) return flagOff;

  const parsed = parseForm(overrideTargetFormSchema, formData, [CONFIRMED_FINDING_CODES_KEY]);
  if (!parsed.ok) return invalidInput(parsed.result as { message: string; fieldErrors?: FieldErrors });

  let sessionFindings: Finding[];
  try {
    sessionFindings = (await overrideRunningItem(parsed.data)).sessionFindings;
  } catch (e) {
    return toRunningActionFailure(e);
  }

  revalidatePath(`/menus/${menuId}`);
  return { ok: true, data: { sessionFindings, sessionFindingViews: presentFindings(sessionFindings) }, message: "保存しました" };
}

// ---------------------------------------------------------------------------
// recalculateWithActiveRuleSetAction（§35）
// ---------------------------------------------------------------------------

const recalculateSchema = z.object({ itemId: requiredText("項目", 64), confirmedFindingCodes: confirmedFindingCodesSchema, plausibilityReviewsJson: plausibilityReviewsJsonSchema });

/**
 * [§35] 明示ボタン用。この Action だけが active RuleSet（`RunningMenuContext.plannedDate` 基準）へ
 * 更新する。override は自動で引き継がない（service 側で drop する）ため、その旨をメッセージへ含める。
 * [R10-B4A] 以前の Finding 確認も引き継がない（新しい RuleSet の結果で必要なら再確認）。
 */
export async function recalculateWithActiveRuleSetAction(
  menuId: string,
  _prev: RunningActionResult<RunningReplanResult> | null,
  formData: FormData,
): Promise<RunningActionResult<RunningReplanResult>> {
  const flagOff = requireFlagOn();
  if (flagOff) return flagOff;

  const parsed = parseForm(recalculateSchema, formData, [CONFIRMED_FINDING_CODES_KEY]);
  if (!parsed.ok) return invalidInput(parsed.result as { message: string; fieldErrors?: FieldErrors });

  let sessionFindings: Finding[];
  let overridesDropped = false;
  try {
    const result = await recalculateRunningItem({ ...parsed.data, plausibilityReviewRequests: parsed.data.plausibilityReviewsJson });
    sessionFindings = result.sessionFindings;
    overridesDropped = result.overridesDropped;
  } catch (e) {
    return toRunningActionFailure(e);
  }

  revalidatePath(`/menus/${menuId}`);
  return {
    ok: true,
    data: { sessionFindings, sessionFindingViews: presentFindings(sessionFindings) },
    message: overridesDropped
      ? "現行ルールで再計算しました。以前の override は引き継いでいません。必要な場合はコーチが確認のうえ再設定してください。"
      : "現行ルールで再計算しました。",
  };
}

// ---------------------------------------------------------------------------
// updateRunningMenuContextAction（[R10-B4A]）
// ---------------------------------------------------------------------------

const runningContextFormSchema = z.object({ runningContext: requiredText("対象グループ・計画日の設定", 20000) });

/**
 * [R10-B4A] メニューの対象グループ・計画日（`MenuTemplate.runningContextJson`）を保存する。
 *
 * - 入力は `runningContext`（JSON 文字列）1つ。受け付ける形は**実装済みの `runningMenuContextSchema` そのもの**
 *   （`.strict()`）で、ここで新しい field を増やさない。痛み・睡眠・性別・生年月日などの健康 / 個人情報のキーは
 *   schema より先に拒否する（R9 の健康情報キー検査）。
 * - `plannedDate` / `plannedAt` はコーチが明示した値だけを保存する（当日などで補わない。null もそのまま保存）。
 * - 保存する文字列は検証済みの値を canonical に serialize したもの（repository は受け取った文字列をそのまま保存する）。
 * - `allowAdvancedMethods` はコーチ操作のこの Action だけで変更する（AI 経路はこの Action を使わない）。
 */
export async function updateRunningMenuContextAction(
  menuId: string,
  _prev: RunningActionResult<{ menuId: string }> | null,
  formData: FormData,
): Promise<RunningActionResult<{ menuId: string }>> {
  const flagOff = requireFlagOn();
  if (flagOff) return flagOff;

  const form = parseForm(runningContextFormSchema, formData);
  if (!form.ok) return invalidInput(form.result as { message: string; fieldErrors?: FieldErrors });

  const parsed = parseJsonColumn(form.data.runningContext, runningMenuContextSchema, { rejectHealthKeys: true });
  if (!parsed.ok) {
    return {
      ok: false,
      kind: "INVALID_INPUT",
      message:
        parsed.reason === "HEALTH_DATA_PRESENT"
          ? "痛み・体調・生年月日などの健康情報や個人情報は、メニューの設定に保存できません。"
          : "対象グループ・計画日の設定の内容を確認してください。",
    };
  }

  try {
    const existing = await findMenuRunningContext(menuId);
    if (existing === null) return { ok: false, kind: "REJECTED", message: "メニューが見つかりません。" };
    await saveMenuRunningContext(menuId, JSON.stringify(parsed.value));
  } catch {
    return { ok: false, kind: "REJECTED", message: "保存に失敗しました。" };
  }

  revalidatePath(`/menus/${menuId}`);
  return { ok: true, data: { menuId }, message: "保存しました" };
}
