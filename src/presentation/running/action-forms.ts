/**
 * Running Prescription Engine v2 — [R10-B4B] presentation のリクエスト → Server Action の FormData。
 *
 * 純粋関数だけ。Server Action を import しない（呼ぶのは client component の側）。
 *
 * 守ること:
 *   - Action の入力名（`itemId` / `field` / `value` / `confirmedFindingCodes` …）をここに集約し、
 *     コンポーネント側に文字列を散らさない。
 *   - `confirmedFindingCodes` は**複数値**として append する（Action は `getAll()` で読む）。
 *   - 値をここで補完・丸めしない（数値の検証は domain、確認の要否は Action が決める）。
 *   - `confirmedTwice` は必ず明示的に "true" / "false" を送る（未送信にしない）。
 */
import type { PlausibilityReviewRequest } from "@/domain/running/types/plausibilityReview";
import type {
  RunningCoachReferenceEditRequest,
  RunningFieldEditRequest,
  RunningOverrideRequest,
  RunningRecalculateRequest,
  RunningTemplateSelection,
} from "./dto";

export const CONFIRMED_FINDING_CODES_FIELD = "confirmedFindingCodes";
export const PLAUSIBILITY_REVIEWS_FIELD = "plausibilityReviewsJson";

function withCodes(form: FormData, codes: readonly string[]): FormData {
  for (const code of codes) form.append(CONFIRMED_FINDING_CODES_FIELD, code);
  return form;
}

/** [OPEN20 F4] 承認済み review リクエストを JSON 文字列として載せる（無ければ何もしない）。 */
function withReviews(form: FormData, reviews: readonly PlausibilityReviewRequest[] | undefined): FormData {
  if (reviews !== undefined && reviews.length > 0) form.set(PLAUSIBILITY_REVIEWS_FIELD, JSON.stringify(reviews));
  return form;
}

export function fieldEditFormData(request: RunningFieldEditRequest): FormData {
  const form = new FormData();
  form.set("itemId", request.itemId);
  form.set("field", request.field);
  form.set("value", String(request.value));
  return withReviews(withCodes(form, request.confirmedFindingCodes), request.plausibilityReviewRequests);
}

export function coachReferenceEditFormData(request: RunningCoachReferenceEditRequest): FormData {
  const form = new FormData();
  form.set("itemId", request.itemId);
  form.set("coachReferenceJson", JSON.stringify(request.coachReference));
  return withReviews(withCodes(form, request.confirmedFindingCodes), request.plausibilityReviewRequests);
}

export function overrideFormData(request: RunningOverrideRequest): FormData {
  const form = new FormData();
  form.set("itemId", request.itemId);
  form.set("targetKind", request.kind);
  form.set("reason", request.reason);
  form.set("confirmedTwice", request.confirmedTwice ? "true" : "false");
  if (request.kind === "FIELD") {
    form.set("field", request.field);
    form.set("layer", request.layer);
    form.set("newValue", String(request.newValue));
  } else {
    form.set("ruleId", request.ruleId);
  }
  return withReviews(withCodes(form, request.confirmedFindingCodes), request.plausibilityReviewRequests);
}

export function recalculateFormData(request: RunningRecalculateRequest): FormData {
  const form = new FormData();
  form.set("itemId", request.itemId);
  return withReviews(withCodes(form, request.confirmedFindingCodes), request.plausibilityReviewRequests);
}

export type PlanRunningItemFormInput = {
  selection: RunningTemplateSelection;
  positionPreference: "LOWER" | "MIDDLE" | null;
  confirmedFindingCodes: readonly string[];
  /** [R10-B4A.2] コーチ入力の目標スプリット（送らないときは null）。 */
  coachReferenceJson: string | null;
  eligibilityOverrideRuleIds?: readonly string[];
  eligibilityOverrideReason?: string;
  eligibilityOverrideFirstConfirmation?: boolean;
  eligibilityOverrideSecondConfirmation?: boolean;
  coachEdits?: readonly { field: string; value: number; unit: string }[];
  /** [OPEN20 F4] 現在の review issue に対する承認（無ければ省略）。 */
  plausibilityReviewRequests?: readonly PlausibilityReviewRequest[];
};

export function planRunningItemFormData(input: PlanRunningItemFormInput): FormData {
  const form = new FormData();
  form.set("method", input.selection.method);
  form.set("templateId", input.selection.templateId);
  form.set("positionPreference", input.positionPreference ?? "");
  if (input.coachReferenceJson !== null) form.set("coachReferenceJson", input.coachReferenceJson);
  for (const ruleId of input.eligibilityOverrideRuleIds ?? []) form.append("eligibilityOverrideRuleIds", ruleId);
  if ((input.eligibilityOverrideRuleIds?.length ?? 0) > 0) {
    form.set("eligibilityOverrideReason", input.eligibilityOverrideReason ?? "");
    if (input.eligibilityOverrideFirstConfirmation !== undefined) {
      form.set("eligibilityOverrideFirstConfirmation", input.eligibilityOverrideFirstConfirmation ? "true" : "false");
    }
    if (input.eligibilityOverrideSecondConfirmation !== undefined) {
      form.set("eligibilityOverrideSecondConfirmation", input.eligibilityOverrideSecondConfirmation ? "true" : "false");
    }
  }
  if ((input.coachEdits?.length ?? 0) > 0) form.set("coachEditsJson", JSON.stringify(input.coachEdits));
  return withReviews(withCodes(form, input.confirmedFindingCodes), input.plausibilityReviewRequests);
}

export function runningContextFormData(json: string): FormData {
  const form = new FormData();
  form.set("runningContext", json);
  return form;
}
