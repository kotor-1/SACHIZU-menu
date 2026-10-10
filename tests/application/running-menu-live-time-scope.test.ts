import { describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";
import { verifyPrimarySemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { compositionSchema } from "@/domain/menu-composition/contracts";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import { hasSessionTimeBasis } from "@/application/running-menu/session-time-scope";
import { verifyMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import recorded from "../fixtures/running-menu-live-time-scope.json";
import { catalogFixture, catalogPlan } from "../fixtures/menu-composition";

describe("recorded interpreter replay with an offline fixture composer (not live composer evidence)", () => {
  it.each(recorded.cases)("replays recorded interpretation and composes non-running work with signed unprescribed Running: $id", async row => {
    const verified = verifyPrimarySemanticIntentV2(row.requestText, row.interpretation, []);
    if (!verified.ok) throw new Error(`Recorded interpretation rejected: ${row.id}`);
    const running = createRunningMenuPreview(verified.engineIntent, {}, row.requestText);
    if (!running || running.status === "READY") throw new Error(`Expected policy/input hold: ${row.id}`);
    const expectedPending = { reasonCode: running.reason, reasonMessage: running.message };
    const composerInput = vi.fn<(input: MenuComposerInput) => void>();
    const compose = vi.fn(async (input: MenuComposerInput) => {
      composerInput(input);
      return { ok: true as const, value: compositionSchema.parse({ blocks: [{ name: "補強", items: [catalogPlan()] }] }) };
    });
    const result = await generateComposedMenu({ requestText: row.requestText, context: {} }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [catalogFixture()], compose,
      interpret: async () => ({ ok: true, intent: verified.engineIntent, running, exercises: [],
        unsupportedIntents: verified.interpretation.unsupportedIntents.map(item => item.meaning), persistable: false, previewToken: null }),
    });
    expect(compose).toHaveBeenCalledTimes(1);
    expect(composerInput).toHaveBeenCalledWith(expect.objectContaining({ runningPrescription: null, unprescribedRunning: expectedPending }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(`Expected editable placeholder: ${row.id}`);
    expect(result.preview).toMatchObject({ runningPrescription: null, runningToken: null,
      unprescribedRunning: expectedPending });
    const pending = result.preview.composition.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING");
    expect(pending).toMatchObject({ type: "UNPRESCRIBED_RUNNING", plannedSets: null, plannedReps: null,
      plannedDistanceMeters: null, plannedRestSeconds: null, plannedDurationSeconds: null, plannedIntensityPercent: null,
      ...expectedPending });
    expect(result.preview.composition.blocks.flatMap(block => block.items).filter(item => item.type === "RUNNING_POLICY")).toHaveLength(0);
    const claims = verifyMenuCompositionToken(result.preview.previewToken, COMPOSITION_TEST_KEY);
    expect(claims).toMatchObject({ unprescribedRunning: expectedPending, runningPrescription: null, runningToken: null });
    expect(claims?.proposal.blocks.flatMap(block => block.items).find(item => item.type === "UNPRESCRIBED_RUNNING")).toEqual(pending);
  });
  it.each([
    ["小学5年生の100m選手です。加速力向上を目的に、走練習とドリル・補強を組み合わせた60分の練習メニューを作ってください。", "60分"],
    ["高校生の100m選手です。スピード持久力向上を目的に、走練習とドリル・補強を組み合わせた90分の練習メニューを作ってください。", "90分"],
    ["中学生です。大会前日なので疲労を残さない調整をしたいです。40分の練習メニューを作ってください。", "40分"],
    ["小学生の初心者です。基礎的な走能力向上を目的に、60分の練習メニューを作ってください。", "60"],
  ])("recognizes a duration attached to a requested practice menu", (source, raw) => {
    expect(hasSessionTimeBasis(source, [raw])).toBe(true);
  });

  it("recognizes an explicitly session-level low-intensity practice duration", () => {
    const source = "低強度の練習を45分行いたいです。";
    expect(hasSessionTimeBasis(source, ["45"])).toBe(true);
  });

  it.each([
    ["プランク30秒", ["30秒"]],
    ["この種目を45分行いたい", ["45分"]],
    ["30秒休んで", ["30秒"]],
    ["大会まであと40日", ["40日"]],
    ["30分程度", ["30分"]],
    ["30の練習メニューを作ってください", ["30"]],
    ["低強度の練習を45行いたい", ["45"]],
  ])("does not treat item/rest/competition/ambiguous quantities as session time: %s", (source, raw) => {
    expect(hasSessionTimeBasis(source, raw)).toBe(false);
  });

  it("verifies the five recorded Luna interpretations and applies only the existing Engine policy", () => {
    const expected = {
      grade5_acceleration_60: ["NEEDS_INPUT", "SCIENCE_CONTEXT_REQUIRED"],
      highschool_speed_endurance_90: ["NEEDS_INPUT", "SCIENCE_CONTEXT_REQUIRED"],
      junior_precompetition_40: ["NEEDS_INPUT", "SCIENCE_CONTEXT_REQUIRED"],
      elementary_beginner_60: ["NEEDS_INPUT", "SCIENCE_CONTEXT_REQUIRED"],
      strong_fatigue_low_45: ["NEEDS_INPUT", "SCIENCE_CONTEXT_REQUIRED"],
    } as const;

    expect(recorded.cases).toHaveLength(5);
    for (const row of recorded.cases) {
      const verified = verifyPrimarySemanticIntentV2(row.requestText, row.interpretation, []);
      expect(verified, row.id).toMatchObject({ ok: true });
      if (!verified.ok) throw new Error(`Recorded interpretation rejected: ${row.id}`);
      const available = verified.engineIntent.availableTimeSeconds;
      expect(available?.value, row.id).toBe({ grade5_acceleration_60: 3600, highschool_speed_endurance_90: 5400, junior_precompetition_40: 2400, elementary_beginner_60: 3600, strong_fatigue_low_45: 2700 }[row.id]);
      const preview = createRunningMenuPreview(verified.engineIntent, {}, row.requestText);
      expect(preview?.status, row.id).toBe(expected[row.id as keyof typeof expected][0]);
      if (preview && preview.status !== "READY") {
        expect(preview.reason, row.id).toBe(expected[row.id as keyof typeof expected][1]);
      }
    }
  });
});
