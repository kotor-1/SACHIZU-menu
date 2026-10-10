import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { verifyRunningIntentClaims, type RunningIntentClaims } from "@/application/running-menu/intent";
import { parseRunningMenuEnvelope, presentRunningMenuSnapshot } from "@/application/running-menu/persistence";
import { saveRunningMenuPreview } from "@/actions/_running-menu-save-service";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { prisma } from "@/infra/db/prisma";
import { findMenu, updateMenuItem } from "@/infra/repositories/menu-repository";
import { issueRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import { makeExercise, resetDb } from "../helpers";

const KEY = "running-preview-test-secret-with-more-than-32-bytes";
const priorKey = process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;

beforeEach(async () => {
  process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = KEY;
  await resetDb();
});
afterAll(() => {
  if (priorKey === undefined) delete process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
  else process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = priorKey;
});

function makeDraft(options: { event?: "100m" | "200m"; light?: boolean; exerciseIds?: string[] } = {}) {
  const event = options.event ?? "100m";
  const requestText = `${event === "100m" ? "中学生" : "高校生"}${event}選手、今日のメニューを作って${options.light ? "。軽めに" : ""}`;
  const claims: RunningIntentClaims = {
    runningRequested: true,
    event: { value: event, sourceText: `${event}選手` },
    ageGroup: { value: event === "100m" ? "JUNIOR_HIGH" : "HIGH_SCHOOL", sourceText: event === "100m" ? "中学生" : "高校生" },
    explicitDistances: [],
    distancePreference: null,
    loadReductionRequested: options.light ? { value: true, sourceText: "軽めに" } : null,
    fatigueState: null,
    purpose: null,
    intensityPreference: null,
    competitionDays: null,
    availableTimeSeconds: null,
    humanExplicitReps: null,
    humanExplicitRestSeconds: null,
    exerciseIds: options.exerciseIds ?? [],
  };
  const verified = verifyRunningIntentClaims(requestText, claims, options.exerciseIds ?? []);
  if (!verified.ok) throw new Error(verified.reason);
  const context = {};
  const running = createRunningMenuPreview(verified.intent, context, requestText);
  if (running?.status !== "READY") throw new Error(running?.status ?? "NO_RUNNING");
  const previewToken = issueRunningMenuPreviewToken({ ownerId: DEFAULT_OWNER_ID, requestText, context, intent: verified.intent, prescription: running.prescription }, KEY);
  return {
    previewToken, previewPolicyVersion: RUNNING_POLICY_VERSION, previewPolicyHash: RUNNING_POLICY_HASH,
    requestText, context, previewPrescription: running.prescription, menuName: "走メニュー", manualBlocks: [],
  };
}

describe("Running policy MenuItem save and reload", () => {
  it.each([
    ["100m", false, 60, 4, 240],
    ["200m", false, 120, 3, 900],
    ["100m", true, 60, 3, 240],
  ] as const)("revalidates %s light=%s, saves and reloads %im / %i / %is", async (event, light, distance, reps, rest) => {
    const result = await saveRunningMenuPreview(makeDraft({ event, light }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    const item = menu?.blocks[0]?.items[0];
    expect(item).toMatchObject({ prescriptionKind: "RUNNING_POLICY", exerciseId: null, runningMethod: null, sessionTemplateId: null, ruleSetVersion: null, ruleSetContentHash: null });
    const snapshot = parseRunningMenuEnvelope(item!.prescriptionKind, item!.prescriptionJson);
    expect(snapshot?.prescription).toMatchObject({ distanceMeters: distance, totalReps: reps, repRestSeconds: rest, setReps: null });
    expect(presentRunningMenuSnapshot(item!.prescriptionKind, item!.prescriptionJson)).toMatchObject({ status: "OK", title: `${distance}m × ${reps}本`, restText: `1本ごとの休憩 ${rest / 60}分` });
  });

  it("saves reviewed Exercise and Running together and keeps ordinary Exercise rows", async () => {
    const exercise = await makeExercise({ name: "ドリル" });
    const result = await saveRunningMenuPreview(makeDraft({ exerciseIds: [exercise.id] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    expect(menu?.blocks.flatMap((block) => block.items).map((item) => item.prescriptionKind)).toEqual(["RUNNING_POLICY", "LEGACY"]);
    expect(menu?.blocks[1]?.items[0]?.exercise?.name).toBe("ドリル");
  });

  it("keeps manually added Composer items in the same save transaction", async () => {
    const result = await saveRunningMenuPreview({ ...makeDraft(), manualBlocks: [{
      name: "補強", items: [{ exerciseId: null, displayName: "体幹", sets: 2, reps: 10,
        distanceMeters: null, durationSeconds: null, restSeconds: null, intensityPercent: null,
        loadKg: null, note: null }],
    }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    expect(menu?.blocks.map((block) => block.name)).toEqual(["走", "補強"]);
    expect(menu?.blocks[1]?.items[0]).toMatchObject({ prescriptionKind: "LEGACY", displayName: "体幹", sets: 2, reps: 10 });
  });

  it("keeps saved Running numbers out of the generic legacy edit path", async () => {
    const result = await saveRunningMenuPreview(makeDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const menu = await findMenu(result.menuId);
    const itemId = menu!.blocks[0]!.items[0]!.id;
    await expect(updateMenuItem(itemId, {
      exerciseId: null, displayName: "走", sets: 1, reps: 9, distanceMeters: 60,
      durationSeconds: null, restSeconds: 30, intensityPercent: null, loadKg: null, note: null,
    })).rejects.toThrow("汎用の項目編集では変更できません");
  });

  it("rejects client numeric edits and stale policy metadata before writing", async () => {
    const draft = makeDraft();
    expect(await saveRunningMenuPreview({ ...draft, previewPrescription: { ...draft.previewPrescription, totalReps: 9 } })).toMatchObject({ ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" });
    expect(await saveRunningMenuPreview({ ...draft, previewPrescription: { ...draft.previewPrescription, repRestSeconds: 30 } })).toMatchObject({ ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" });
    expect(await saveRunningMenuPreview({ ...draft, previewPolicyVersion: "wrong" })).toMatchObject({ ok: false, code: "POLICY_MISMATCH" });
    expect(await saveRunningMenuPreview({ ...draft, previewPolicyHash: "0".repeat(64) })).toMatchObject({ ok: false, code: "POLICY_MISMATCH" });
    expect(await saveRunningMenuPreview({ ...draft, requestText: "changed" })).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("does not save an explicit 80m review result", async () => {
    const text = "中学生100m選手、今日は80mをやりたい";
    const claims: RunningIntentClaims = {
      runningRequested: true, event: { value: "100m", sourceText: "100m選手" }, ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" },
      explicitDistances: [{ value: 80, sourceText: "80mをやりたい" }], distancePreference: null,
      loadReductionRequested: null, fatigueState: null, purpose: null, intensityPreference: null, competitionDays: null, availableTimeSeconds: null,
      humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
    };
    const verified = verifyRunningIntentClaims(text, claims, []);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(createRunningMenuPreview(verified.intent, {}, text)).toMatchObject({ status: "COACH_REVIEW_REQUIRED" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("rolls back Running and Exercise when a later insert fails", async () => {
    const exercise = await makeExercise({ name: "ドリル" });
    await prisma.$executeRawUnsafe("CREATE TRIGGER fail_exercise_menu_item BEFORE INSERT ON MenuItem WHEN NEW.displayName = 'ドリル' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    try {
      expect(await saveRunningMenuPreview(makeDraft({ exerciseIds: [exercise.id] }))).toMatchObject({ ok: false, code: "SAVE_FAILED" });
      expect(await prisma.menuTemplate.count()).toBe(0);
      expect(await prisma.menuItem.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER fail_exercise_menu_item");
    }
  });
});
