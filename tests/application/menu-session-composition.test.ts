import { describe, expect, it, vi } from "vitest";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { compositionSchema, editableComposition, validateComposition, type ComposerCatalogExercise, type MenuComposition } from "@/domain/menu-composition/contracts";
import { calculateMenuDuration } from "@/domain/menu-composition/duration";
import { proposedDurationPlan } from "@/application/menu-composition/planning";
import { runningMenuPrescriptionSchema } from "@/application/running-menu/persistence";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { catalogFixture, catalogPlan, interpretedFixture, COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";
import actualLuna from "../fixtures/menu-time-luna-20261012.json";
import sessionDraft from "../fixtures/menu-session-offline-draft.json";
import previousDraft from "../fixtures/menu-time-offline-revision.json";

const requestText = "高校生の100mです。来週末の試合に向けて少し疲労をためたいです。今は10が一番疲労が強いとしたら1です。";
const proposal: MenuComposition = {
  sessionPlan: { blocks: [{ name: "姿勢の準備", phase: "WARM_UP", purpose: "登録動作で体幹の姿勢を確認する", allocatedSeconds: 120 }],
    timeBudgetReasoning: "登録候補は1件のみ。90分の全体構成には不足するため残りを水増ししない。" },
  blocks: [{ name: "姿勢の準備", phase: "WARM_UP", allocatedSeconds: 120, items: [catalogPlan()] }],
};

describe("whole-session composition context and outline", () => {
  it("passes duration, original wishes and verified facts together before one composition stage", async () => {
    const interpreted = interpretedFixture(false);
    interpreted.intent.event = { value: "100m", sourceText: "100m", sourceType: "USER_TEXT" };
    interpreted.intent.ageGroup = { value: "HIGH_SCHOOL", sourceText: "高校生", sourceType: "USER_TEXT" };
    interpreted.unsupportedIntents = ["少し疲労をためたい", "今の疲労は10段階で1"];
    const frozen = structuredClone(interpreted);
    const compose = vi.fn<(input: MenuComposerInput) => Promise<{ ok: true; value: MenuComposition }>>()
      .mockResolvedValue({ ok: true, value: proposal });
    const result = await generateComposedMenu({ requestText, context: { availableTimeSeconds: 5400, science: { experience: "BEGINNER" } } }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [catalogFixture()],
      interpret: async () => interpreted, compose,
    });
    expect(result.ok).toBe(true);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose.mock.calls[0][0]).toMatchObject({ requestText,
      context: { event: "100m", ageGroup: "HIGH_SCHOOL", availableTimeSeconds: 5400, science: { experience: "BEGINNER" } },
      unsupportedIntents: interpreted.unsupportedIntents,
      sessionBrief: { requestedTimeSeconds: 5400, target: { event: "100m", ageGroup: "HIGH_SCHOOL" },
        explicitAthleteContext: { experience: "BEGINNER" },
        verifiedIntent: { fatigueState: null, competitionDays: null, purpose: null } },
    });
    const brief = compose.mock.calls[0][0].sessionBrief!;
    expect(brief.rolesToConsider.find(row => row.role === "SUPPORT")?.candidateIds).toEqual(["exercise-a"]);
    expect(brief.rolesToConsider.find(row => row.role === "CLOSING")?.candidateIds).toEqual([]);
    expect(interpreted).toEqual(frozen); // No inferred 9-day date or new fatigue policy.
  });

  it.each(["name", "phase", "allocatedSeconds", "length"])("rejects a final menu that diverges from its outline: %s", field => {
    const mismatched = structuredClone(proposal);
    if (field === "name") mismatched.blocks[0].name = "別の構成";
    if (field === "phase") mismatched.blocks[0].phase = "COOL_DOWN";
    if (field === "allocatedSeconds") mismatched.blocks[0].allocatedSeconds = 5400;
    if (field === "length") mismatched.blocks.push(mismatched.blocks[0]);
    expect(validateComposition(mismatched, { catalog: [catalogFixture()], ownerId: DEFAULT_OWNER_ID, requestText, runningAvailable: false }))
      .toEqual({ ok: false, code: "SESSION_PLAN_MISMATCH" });
  });

  it("accepts a matching outline without adding it as a second editable prescription", async () => {
    const result = await generateComposedMenu({ requestText, context: { availableTimeSeconds: 5400 } }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => [catalogFixture()],
      interpret: async () => interpretedFixture(false), compose: async () => ({ ok: true, value: proposal }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.composition.blocks).toHaveLength(1);
    expect(result.preview.composition.blocks[0].items).toHaveLength(1);
    expect(result.preview.durationPlan?.blocks[0].allocatedSeconds).toBe(120);
  });

  it("keeps the historical five-item response readable as an incomplete legacy proposal", () => {
    const legacy = compositionSchema.parse(actualLuna);
    expect(legacy.sessionPlan).toBeUndefined();
    expect(legacy.blocks.flatMap(block => block.items)).toHaveLength(5);
    expect(legacy.blocks.every(block => block.allocatedSeconds === null)).toBe(true);
  });
});

describe("offline full-session example (authored response, not a live generation)", () => {
  const catalog = sessionDraft.catalog as ComposerCatalogExercise[];
  const running = runningMenuPrescriptionSchema.parse(sessionDraft.runningPrescription);
  it("uses registered movements in a natural sequence with editable quantities and unchanged running", () => {
    const validated = validateComposition(sessionDraft.composition, { catalog, ownerId: DEFAULT_OWNER_ID,
      requestText, runningAvailable: true });
    expect(validated.ok).toBe(true);
    const proposal = compositionSchema.parse(sessionDraft.composition);
    expect(proposal.blocks.map(block => block.phase)).toEqual(["WARM_UP", "DRILLS_STRENGTH", "RUNNING", "DRILLS_STRENGTH", "COOL_DOWN"]);
    const exercises = proposal.blocks.flatMap(block => block.items).filter(item => item.type === "CATALOG_EXERCISE");
    expect(exercises).toHaveLength(9);
    expect(new Set(exercises.map(item => item.exerciseId)).size).toBe(exercises.length);
    expect(exercises.every(item => item.plannedSets !== null && item.plannedRestSeconds !== null
      && [item.plannedReps, item.plannedDurationSeconds, item.plannedDistanceMeters].filter(value => value !== null).length === 1)).toBe(true);
    expect(sessionDraft.runningPrescription).toEqual(previousDraft.runningPrescription);
    expect(exercises.find(item => item.displayName.startsWith("ニー・トゥ・エルボー")))
      .toMatchObject({ plannedReps: 10, plannedSets: 1 });
    for (const oldItem of compositionSchema.parse(previousDraft.composition).blocks.flatMap(block => block.items)) {
      if (oldItem.type !== "CATALOG_EXERCISE") continue;
      const next = exercises.find(item => item.exerciseId === oldItem.exerciseId)!;
      for (const key of ["plannedSets", "plannedReps", "plannedDurationSeconds", "plannedDistanceMeters"] as const) {
        expect(next[key]).toBe(oldItem[key]); // Time request never inflates existing workload.
      }
    }
  });

  it("keeps 53 minutes unallocated instead of presenting a whole-session draft as a completed 90 minutes", () => {
    const proposal = compositionSchema.parse(sessionDraft.composition);
    let id = 0;
    const composition = editableComposition(proposal, () => `session-${++id}`);
    const plan = proposedDurationPlan(proposal, composition, running);
    const summary = calculateMenuDuration(composition, running, 5400, plan);
    expect(summary).toMatchObject({ plannedTotalSeconds: 2220, remainingSeconds: 3180,
      status: "UNDERALLOCATED", planningStatus: "NEEDS_REVIEW", physicalDurationExact: false });
    expect(summary.planIssues.map(issue => issue.code)).toEqual(["TARGET_MISMATCH"]);
    expect(summary.knownMinimumSeconds).toBe(925); // Fixed rest720 + drill rest120 + timed85; estimated tempos excluded.
    expect(proposal.overview?.approach).toContain("53分は未配分");
    expect(proposal.overview?.objective).toContain("少し疲労をためたい");
    expect(proposal.sessionPlan?.timeBudgetReasoning).toContain("数値化する方針は未定");
    const edited = composition.blocks[0].items[0];
    if (edited.type !== "CATALOG_EXERCISE") throw new Error("fixture");
    edited.plannedDistanceMeters = 30;
    expect(calculateMenuDuration(composition, running, 5400, plan).planIssues)
      .toContainEqual(expect.objectContaining({ code: "STALE_BASIS" }));
  });
});
