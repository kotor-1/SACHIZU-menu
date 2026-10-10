import { describe, expect, it } from "vitest";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { RUNNING_INTERPRETER_VERSION, verifyPrimarySemanticIntentV2, type RunningSemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";
import { canonicalStringify } from "@/domain/shared/canonical-json";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { signHmacToken } from "@/infra/security/hmac-token";
import { verifyRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import { verifyRunningIntentClaims, type RunningIntentClaims } from "@/application/running-menu/intent";

function makeIntent(claims: RunningSemanticIntentV2["claims"], unsupportedIntents: RunningSemanticIntentV2["unsupportedIntents"] = []): RunningSemanticIntentV2 {
  return { interpreterVersion: RUNNING_INTERPRETER_VERSION, requestKind: "RUNNING", claims, corrections: [], unsupportedIntents, ambiguity: null, exerciseIds: [] };
}
function claim(field: RunningSemanticIntentV2["claims"][number]["field"], value: string | number | boolean, sourceText: string, extra: Partial<RunningSemanticIntentV2["claims"][number]> = {}): RunningSemanticIntentV2["claims"][number] {
  return { field, value, sourceText, numericParts: [], polarity: "AFFIRMED", temporalScope: "CURRENT", status: "ACTIVE", ...extra };
}

describe("purpose-aware intent boundary", () => {
  it("does not reinterpret unrelated claim quotes as purpose or intensity", () => {
    const quote = "高校生です。加速力向上と低強度の練習を希望";
    const verified = verifyPrimarySemanticIntentV2(quote, makeIntent([claim("AGE_GROUP", "HIGH_SCHOOL", quote)]), []);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.engineIntent.purpose).toBeNull();
    expect(verified.engineIntent.intensityPreference).toBeNull();
  });
  it("preserves direct purpose and applies the specific fail-closed policy gate", () => {
    const quote = "加速力向上を目的に";
    const result = verifyPrimarySemanticIntentV2(quote, makeIntent([claim("PURPOSE", "ACCEL", quote)]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineIntent.purpose).toMatchObject({ value: "ACCEL", sourceText: quote });
    expect(createRunningMenuPreview(result.engineIntent, {}, quote)).toMatchObject({ status: "NEEDS_POLICY", reason: "ACCEL_PURPOSE_NOT_APPROVED" });
  });

  it.each([
    ["ゴール前まで速さを保つ", "SPEED_ENDURANCE", "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED"],
    ["出だしを速くしたい", "ACCEL", "ACCEL_PURPOSE_NOT_APPROVED"],
    ["トップスピードを上げたい", "MAX_SPEED", "MAX_SPEED_PURPOSE_NOT_APPROVED"],
    ["速いペースを長く維持したい", "SPEED_ENDURANCE", "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED"],
    ["走りの土台を作りたい", "BASIC", "BASIC_PURPOSE_NOT_APPROVED"],
    ["大会に向けてコンディションを整えたい", "PRECOMP", "PRECOMP_PURPOSE_NOT_APPROVED"],
    ["疲労を抜いて回復したい", "RECOVERY", "RECOVERY_PURPOSE_NOT_APPROVED"],
  ] as const)("accepts a grounded semantic purpose paraphrase: %s", (quote, purpose, reason) => {
    const result = verifyPrimarySemanticIntentV2(quote, makeIntent([claim("PURPOSE", purpose, quote)]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineIntent.purpose?.value).toBe(purpose);
    expect(createRunningMenuPreview(result.engineIntent, {}, quote)).toMatchObject({ status: "NEEDS_POLICY", reason });
  });

  it("uses grounded legacy unsupported quotes only as a policy gate", () => {
    const quote = "スピード持久力向上を目的にメニューを作って";
    const result = verifyPrimarySemanticIntentV2(quote, makeIntent([], [{ meaning: "目的", sourceText: quote }]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineIntent.purpose).toMatchObject({ value: "SPEED_ENDURANCE", sourceText: quote });
    expect(createRunningMenuPreview(result.engineIntent, {}, quote)).toMatchObject({ status: "NEEDS_POLICY", reason: "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED" });
  });

  it.each([
    ["小学生です。加速力向上を目的に練習したい", "ELEMENTARY", "加速力向上を目的に", "ELEMENTARY_POLICY_NOT_APPROVED"],
    ["高校生です。スピード持久力向上を目的に練習したい", "HIGH_SCHOOL", "スピード持久力向上を目的に", "SPEED_ENDURANCE_PURPOSE_NOT_APPROVED"],
    ["中学生です。大会前日なので疲労を残さない調整をしたい", "JUNIOR_HIGH", "大会前日なので疲労を残さない調整をしたい", "PRECOMP_PURPOSE_NOT_APPROVED"],
    ["小学生です。基礎的な走能力向上を目的に練習したい", "ELEMENTARY", "基礎的な走能力向上を目的に", "ELEMENTARY_POLICY_NOT_APPROVED"],
    ["低強度の練習を45分行いたい", "HIGH_SCHOOL", "低強度の練習を45分行いたい", "LOW_INTENSITY_NOT_APPROVED"],
  ] as const)("routes recorded request to a gate: %s", (text, age, quote, reason) => {
    const result = verifyPrimarySemanticIntentV2(text, makeIntent([], [{ meaning: "未対応の目的または強度", sourceText: quote }]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const engine = createRunningMenuPreview(result.engineIntent, { ageGroup: age }, text);
    expect(engine).toMatchObject({ status: "NEEDS_POLICY", reason });
  });

  it("does not resurrect negated, past, or superseded purpose claims", () => {
    const negated = "加速力向上ではなく基礎走力を希望";
    const result = verifyPrimarySemanticIntentV2(negated, makeIntent([
      claim("PURPOSE", "ACCEL", "加速力向上ではなく", { polarity: "NEGATED" }),
    ]), []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.engineIntent.purpose).toBeNull();

    const past = "以前は加速力向上が目標だった";
    const notCurrent = verifyPrimarySemanticIntentV2(past, makeIntent([
      claim("PURPOSE", "ACCEL", past, { temporalScope: "PAST" }),
    ], [{ meaning: "以前の目的", sourceText: past }]), []);
    expect(notCurrent.ok).toBe(true);
    if (notCurrent.ok) expect(notCurrent.engineIntent.purpose).toBeNull();

    const corrected = "以前は加速力向上を目指したが、今は最高速度向上を目指す";
    const oldQuote = "以前は加速力向上を目指した";
    const newQuote = "最高速度向上を目指す";
    const correction = makeIntent([
      claim("PURPOSE", "ACCEL", oldQuote, { status: "SUPERSEDED", temporalScope: "PAST" }),
      claim("PURPOSE", "MAX_SPEED", newQuote),
    ], [{ meaning: "変更前の目的", sourceText: oldQuote }]);
    correction.corrections = [{ supersededClaimIndex: 0, finalClaimIndex: 1, sourceText: corrected }];
    const correctedResult = verifyPrimarySemanticIntentV2(corrected, correction, []);
    expect(correctedResult.ok).toBe(true);
    if (correctedResult.ok) expect(correctedResult.engineIntent.purpose).toMatchObject({ value: "MAX_SPEED", sourceText: newQuote });
  });

  it("keeps low intensity distinct from volume reduction", () => {
    const quote = "低強度の練習を希望";
    const result = verifyPrimarySemanticIntentV2(quote, makeIntent([claim("INTENSITY_PREFERENCE", "LOW", quote)]), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engineIntent).toMatchObject({ intensityPreference: { value: "LOW" }, loadReductionRequested: null });
    expect(createRunningMenuPreview(result.engineIntent, {}, quote)).toMatchObject({ status: "NEEDS_POLICY", reason: "LOW_INTENSITY_NOT_APPROVED" });
  });

  it("fails closed if the legacy intent path drops a stated purpose or intensity", () => {
    const base: RunningIntentClaims = {
      runningRequested: true, event: null, ageGroup: null, explicitDistances: [], distancePreference: null,
      loadReductionRequested: null, fatigueState: null, purpose: null, intensityPreference: null,
      competitionDays: null, availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
    };
    expect(verifyRunningIntentClaims("最高速度向上を目的にしたい", base, [])).toMatchObject({ ok: false, reason: "MISSING_RUNNING_PURPOSE" });
    expect(verifyRunningIntentClaims("低強度の練習を希望", base, [])).toMatchObject({ ok: false, reason: "MISSING_INTENSITY_PREFERENCE" });
  });

  it("rejects old signed preview tokens that omit purpose claims", () => {
    const key = "purpose-aware-preview-token-test-key-32-bytes";
    const oldToken = signHmacToken(canonicalStringify({
      kind: "RUNNING_MENU_PREVIEW", schemaVersion: 1, ownerId: "owner", menuId: "00000000-0000-4000-8000-000000000001",
      issuedAtMs: 100, expiresAtMs: 200, policyVersion: RUNNING_POLICY_VERSION, policyHash: RUNNING_POLICY_HASH,
      requestText: "加速力向上を目的に", context: {}, intent: {
        runningRequested: true, event: null, ageGroup: null, explicitDistances: [], distancePreference: null,
        loadReductionRequested: null, fatigueState: null, availableTimeSeconds: null,
        humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
      }, prescriptionFingerprint: "a".repeat(64),
    }), key);
    expect(verifyRunningMenuPreviewToken(oldToken, key, 150)).toBeNull();
  });
});
