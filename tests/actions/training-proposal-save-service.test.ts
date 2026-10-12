import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { saveTrainingProposal, evaluateTrainingRunningEdit } from "@/actions/_training-proposal-save-service";
import { DEFAULT_TRAINING_CONDITIONS, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { trainingProposalSavedStateSchema, type TrainingItemAnnotation } from "@/domain/training-proposal/contracts";
import { parseConfirmedCompositionContext } from "@/domain/menu-composition/saved-context";
import { type ComposerCatalogExercise, type EditableComposition } from "@/domain/menu-composition/contracts";
import { exerciseVideoGuidanceSchema } from "@/domain/exercise/video-guidance";
import { buildStructuredRunningPreview } from "@/application/training-proposal/running";
import { issueTrainingProposalToken, verifyTrainingProposalToken, type TrainingProposalClaims } from "@/infra/training-proposal/preview-token";
import { parseRunningMenuEnvelope, finalRunningMenuPrescription } from "@/application/running-menu/persistence";
import { prisma } from "@/infra/db/prisma";
import { findMenu } from "@/infra/repositories/menu-repository";
import { createSessionFromMenu, findSession } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { resetDb } from "../helpers";
import { catalogFixture, COMPOSITION_TEST_KEY } from "../fixtures/menu-composition";

beforeEach(resetDb);

function conditions(goal: TrainingConditions["primaryGoal"] = "STRENGTH"): TrainingConditions {
  const value = structuredClone(DEFAULT_TRAINING_CONDITIONS);
  value.goals = [goal]; value.primaryGoal = goal;
  value.environment = { ...value.environment, straightMeters: 120, surface: "TRACK", flatSafe: true, trafficFree: true, obstacleFree: true };
  value.athlete = { ...value.athlete, ageYears: 17, experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "POST", supervised: true, familiarWithSprint: true };
  value.condition = { ...value.condition, fatigue: 2, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, competitionDays: 14 };
  return value;
}

const annotation: TrainingItemAnnotation = { intensity: "姿勢を保てる軽い強度", stage: 0,
  family: "STRENGTH:WHOLE_BODY:STATIONARY", relationship: "COMBINABLE", alternativeGroup: null };
function tokenInput(claims: TrainingProposalClaims) {
  return { ownerId: claims.ownerId, menuId: claims.menuId, conditions: claims.conditions, proposal: claims.proposal,
    annotations: claims.annotations, runningPrescription: claims.runningPrescription, runningStatusReason: claims.runningStatusReason,
    allowedExerciseIds: claims.allowedExerciseIds, messages: claims.messages, quality: claims.quality, revision: claims.revision };
}

async function draft(withRunning = false) {
  const rows = await Promise.all(["体幹姿勢保持", "腹部姿勢保持"].map(name => prisma.exercise.create({ data: {
    ownerId: DEFAULT_OWNER_ID, name, category: "CORE", metricType: "REPS", difficulty: 1,
    description: "床に仰向けになり、体幹の姿勢を保ちながら片側ずつ動かす。", status: "REVIEWED",
  } })));
  const guidance = exerciseVideoGuidanceSchema.parse({ executionSummary: "片側ずつ体幹の姿勢を保つ", movementPattern: "静止姿勢から片側を動かす",
    countingUnit: "PER_SIDE", bilateralCounting: "片側を終えてから反対側へ移る", typicalStructure: "片側の規定回数の後に反対側",
    equipment: [], setup: null, keyCues: [], commonErrors: [], doseObservations: [],
    sourceVideoId: "offline-owned-source", analysisVersion: "offline-fixture", videoAnalysisStatus: "COACH_REVIEWED",
    analyzedAt: "2026-10-12T00:00:00.000Z", coachReviewedAt: "2026-10-12T01:00:00.000Z" });
  const catalog: ComposerCatalogExercise[] = rows.map(row => catalogFixture({ ...row, videoGuidance: guidance,
    tags: [], events: ["SPRINT"], targets: ["TECHNIQUE"], purposes: ["POSTURE"] }));
  const composition: EditableComposition = { blocks: [
    { id: "movement", name: "動きづくり", items: [] },
    { id: "running", name: "走練習", items: withRunning ? [{ id: "run", type: "RUNNING_POLICY", plannedNote: "Engineの基準" }] : [] },
    { id: "strength", name: "補強トレーニング", items: rows.map((row, index) => ({ id: `item-${index}`, type: "CATALOG_EXERCISE",
      exerciseId: row.id, displayName: row.name, plannedSets: 2, plannedReps: 6, plannedDurationSeconds: null,
      plannedDistanceMeters: null, plannedRestSeconds: 30, executionInstruction: "左右各6回。片側を終えてから反対側へ移る。",
      plannedNote: "左右を合計した数に置き換えない", reason: "体幹の姿勢保持" })) },
  ] };
  const c = conditions(withRunning ? "ACCEL" : "STRENGTH");
  const run = buildStructuredRunningPreview(c).running;
  if (withRunning && run?.status !== "READY") throw new Error("RUNNING_FIXTURE_NOT_READY");
  const annotations = { "item-0": { ...annotation }, "item-1": { ...annotation } };
  const claimInput = { ownerId: DEFAULT_OWNER_ID, menuId: randomUUID(), conditions: c, proposal: composition, annotations,
    runningPrescription: run?.status === "READY" ? run.prescription : null, runningStatusReason: null,
    allowedExerciseIds: rows.map(row => row.id), messages: ["テスト用の候補。実Luna生成ではありません。"], quality: "READY" as const, revision: null };
  const previewToken = issueTrainingProposalToken(claimInput, COMPOSITION_TEST_KEY);
  const input = { previewToken, menuName: "採用した提案", composition: structuredClone(composition), annotations: structuredClone(annotations),
    selectedItemIds: ["item-0"], runningPrescription: claimInput.runningPrescription };
  const deps = { db: prisma, ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY, catalog: async () => catalog };
  return { rows, catalog, input, deps, claimInput, claims: verifyTrainingProposalToken(previewToken, COMPOSITION_TEST_KEY)! };
}

describe("training proposal selection persistence", () => {
  it("persists only adopted items while retaining all candidates, conditions, intensities and per-side counting", async () => {
    const d = await draft();
    const result = await saveTrainingProposal(d.input, d.deps);
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
    const menu = (await findMenu(result.menuId))!;
    expect(menu.blocks).toHaveLength(1);
    expect(menu.blocks[0].name).toBe("補強トレーニング");
    expect(menu.blocks[0].items).toHaveLength(1);
    expect(menu.blocks[0].items[0]).toMatchObject({ exerciseId: d.rows[0].id, sets: 2, reps: 6, restSeconds: 30 });
    expect(menu.blocks[0].items[0].note).toContain("左右各6回");
    expect(menu.blocks[0].items[0].note).toContain(`強度：${annotation.intensity}`);
    const state = parseConfirmedCompositionContext(menu.runningContextJson)!.trainingProposal!;
    expect(state.composition).toEqual(d.input.composition);
    expect(state.selectedItemIds).toEqual(["item-0"]);
    expect(state.annotations).toEqual(d.input.annotations);
    expect(state.conditions).toEqual(d.claimInput.conditions);
    expect(menu.runningContextJson).not.toContain("requestedTimeSeconds");
    expect(menu.runningContextJson).not.toContain("durationPlan");
  });

  it("saves edited dose and selection on the same menu, leaves old Session snapshots fixed, and rejects stale re-edits", async () => {
    const d = await draft();
    const first = await saveTrainingProposal(d.input, d.deps);
    if (!first.ok) throw new Error(first.code);
    const session = await createSessionFromMenu(sessionFromMenuSchema.parse({ menuTemplateId: first.menuId, date: "2026-10-12" }));
    const before = (await findSession(session.id))!.items;
    expect(before).toHaveLength(1); expect(before[0].exerciseNameSnapshot).toBe(d.rows[0].name);
    const original = (await findMenu(first.menuId))!;
    const state = parseConfirmedCompositionContext(original.runningContextJson)!.trainingProposal!;
    const edited = structuredClone(d.input);
    edited.selectedItemIds = ["item-1"];
    const item = edited.composition.blocks[2].items[1];
    if (item.type !== "CATALOG_EXERCISE") throw new Error("fixture");
    item.plannedReps = 8; item.plannedSets = 1; item.plannedRestSeconds = 45;
    item.executionInstruction = "左右各8回。片側を終えてから反対側へ移る。";
    item.plannedNote = "編集して採用";
    edited.previewToken = issueTrainingProposalToken({ ...tokenInput(d.claims), revision: state.revision }, COMPOSITION_TEST_KEY);
    expect(await saveTrainingProposal(edited, d.deps)).toMatchObject({ ok: true, menuId: first.menuId, alreadySaved: false });
    expect(await saveTrainingProposal(edited, d.deps)).toMatchObject({ ok: true, alreadySaved: true });
    const after = (await findMenu(first.menuId))!;
    expect(after.blocks.flatMap(block => block.items)).toHaveLength(1);
    expect(after.blocks[0].items[0]).toMatchObject({ exerciseId: d.rows[1].id, reps: 8, sets: 1, restSeconds: 45 });
    expect((await findSession(session.id))!.items).toEqual(before);
    expect(await saveTrainingProposal({ ...edited, menuName: "古い画面から変更" }, d.deps)).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
    expect(await prisma.menuTemplate.count()).toBe(1);
  });

  it("allows an eligible replacement/addition within signed catalog authority", async () => {
    const d = await draft();
    const replacement = structuredClone(d.input.composition.blocks[2].items[1]);
    replacement.id = "replacement-item";
    d.input.composition.blocks[2].items.push(replacement);
    const annotations = { ...d.input.annotations, [replacement.id]: { ...annotation } };
    const saved = await saveTrainingProposal({ ...d.input, annotations, selectedItemIds: [replacement.id] }, d.deps);
    expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.code);
    expect((await findMenu(saved.menuId))!.blocks[0].items[0].exerciseId).toBe(d.rows[1].id);
  });

  it("rejects empty, unknown or duplicated selection and forged/foreign/expired tokens before writing", async () => {
    const d = await draft();
    for (const selectedItemIds of [[], ["missing"], ["item-0", "item-0"]]) expect((await saveTrainingProposal({ ...d.input, selectedItemIds }, d.deps)).ok).toBe(false);
    for (const previewToken of ["forged" + d.input.previewToken,
      issueTrainingProposalToken({ ...d.claimInput, ownerId: "other-owner" }, COMPOSITION_TEST_KEY),
      issueTrainingProposalToken(d.claimInput, COMPOSITION_TEST_KEY, Date.now() - 3 * 60 * 60 * 1000)]) {
      expect(await saveTrainingProposal({ ...d.input, previewToken }, d.deps)).toMatchObject({ ok: false, code: "STALE_PREVIEW" });
    }
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("rejects condition/time injection and inconsistent side counts, while preserving the database", async () => {
    const d = await draft();
    expect(await saveTrainingProposal({ ...d.input, conditions: { ...d.claimInput.conditions, environment: { straightMeters: 999 } } }, d.deps)).toMatchObject({ ok: false, code: "INVALID_PLAN" });
    expect(await saveTrainingProposal({ ...d.input, durationPlan: { requestedTimeSeconds: 5400 } }, d.deps)).toMatchObject({ ok: false, code: "INVALID_PLAN" });
    const item = d.input.composition.blocks[2].items[0];
    if (item.type !== "CATALOG_EXERCISE") throw new Error("fixture");
    item.plannedReps = 12;
    expect(await saveTrainingProposal(d.input, d.deps)).toMatchObject({ ok: false, code: "DOSE_COUNT_MISMATCH" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("rechecks adopted exercise ownership/status inside the transaction without blocking on an unselected archived alternative", async () => {
    const d = await draft();
    await prisma.exercise.update({ where: { id: d.rows[1].id }, data: { status: "ARCHIVED" } });
    d.catalog[1].status = "ARCHIVED";
    expect((await saveTrainingProposal(d.input, d.deps)).ok).toBe(true);
    const other = await draft();
    // The injected catalog is deliberately stale: the transaction must query current DB authority.
    await prisma.exercise.update({ where: { id: other.rows[0].id }, data: { ownerId: "other-owner" } });
    expect(await saveTrainingProposal(other.input, other.deps)).toMatchObject({ ok: false, code: "INVALID_EXERCISE" });
  });

  it("rechecks environment eligibility and edited dose quality, not just signed exercise membership", async () => {
    const d = await draft();
    d.catalog[0].description = "壁に手をついて姿勢を保つ。";
    expect(await saveTrainingProposal(d.input, d.deps)).toMatchObject({ ok: false, code: "EXERCISE_INELIGIBLE" });
    d.catalog[0].description = "床に仰向けで姿勢を保つ。";
    const item = d.input.composition.blocks[2].items[0];
    if (item.type !== "CATALOG_EXERCISE") throw new Error("fixture");
    item.plannedSets = 20;
    expect(await saveTrainingProposal(d.input, d.deps)).toMatchObject({ ok: false, code: "DOSE_REQUIRES_COACH_REVIEW" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("keeps the three proposal section semantics and rejects conversion to a fake Running marker", async () => {
    const d = await draft();
    d.input.composition.blocks[0].name = "自由なセッション";
    expect(await saveTrainingProposal(d.input, d.deps)).toMatchObject({ ok: false, code: "THREE_SECTIONS_REQUIRED" });
    d.input.composition.blocks[0].name = "動きづくり";
    d.input.composition.blocks[2].items[0] = { id: "item-0", type: "RUNNING_POLICY", plannedNote: "" };
    expect(await saveTrainingProposal(d.input, d.deps)).toMatchObject({ ok: false, code: "CANDIDATE_TAMPER" });
  });

  it("stores the exact Engine prescription only when Running is adopted and never substitutes another dose", async () => {
    const d = await draft(true);
    const saved = await saveTrainingProposal({ ...d.input, selectedItemIds: ["run"] }, d.deps);
    expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.code);
    const menu = (await findMenu(saved.menuId))!;
    expect(menu.blocks.flatMap(block => block.items)).toHaveLength(1);
    const item = menu.blocks[0].items[0];
    const envelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson)!;
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.prescription).toEqual(d.input.runningPrescription);
    const next = await draft(true);
    const withoutRunning = await saveTrainingProposal(next.input, next.deps);
    if (!withoutRunning.ok) throw new Error(withoutRunning.code);
    expect((await findMenu(withoutRunning.menuId))!.blocks.flatMap(block => block.items).every(row => row.prescriptionKind === "LEGACY")).toBe(true);
  });

  it("rejects Running echo tampering or a signed prescription that does not match the selected conditions", async () => {
    const d = await draft(true);
    expect(await saveTrainingProposal({ ...d.input, runningPrescription: { ...d.input.runningPrescription!, totalReps: 99 } }, d.deps)).toMatchObject({ ok: false, code: "RUNNING_TAMPER" });
    const shortSpace = structuredClone(d.claimInput.conditions); shortSpace.environment.straightMeters = 5;
    const changedToken = issueTrainingProposalToken({ ...d.claimInput, conditions: shortSpace }, COMPOSITION_TEST_KEY);
    expect(await saveTrainingProposal({ ...d.input, previewToken: changedToken }, d.deps)).toMatchObject({ ok: false, code: "RUNNING_AUTHORITY" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("retains conservative Coach Edit audit while keeping the saved Engine base unchanged", async () => {
    const d = await draft(true);
    const coachEdit = { totalReps: 3, repRestSeconds: 240 };
    const assessed = evaluateTrainingRunningEdit(d.claims, coachEdit);
    expect(assessed.ok).toBe(true); if (!assessed.ok) throw new Error(assessed.code);
    expect(assessed.finalPrescription).toMatchObject(coachEdit);
    const saved = await saveTrainingProposal({ ...d.input, selectedItemIds: ["run"], coachEdit }, d.deps);
    expect(saved.ok).toBe(true); if (!saved.ok) throw new Error(saved.code);
    const menu = (await findMenu(saved.menuId))!;
    const item = menu.blocks[0].items[0];
    const envelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson)!;
    expect(envelope.schemaVersion).toBe(2); expect(finalRunningMenuPrescription(envelope)).toMatchObject(coachEdit);
    const state = trainingProposalSavedStateSchema.parse(parseConfirmedCompositionContext(menu.runningContextJson)!.trainingProposal);
    expect(state.runningPrescription).toEqual(d.input.runningPrescription); expect(state.coachEdit).toEqual(coachEdit);
  });

  it("rejects increases, shorter rest, changed distance/target/instructions and permits no safety overrides", async () => {
    const d = await draft(true);
    for (const coachEdit of [{ totalReps: 5 }, { repRestSeconds: 30 }, { distanceMeters: 100 },
      { executionInstructionText: "もっと速く走る" }, { coachTargetTimeSeconds: 1 }, { setReps: [2, 2] }]) {
      expect(evaluateTrainingRunningEdit(d.claims, coachEdit)).toMatchObject({ ok: false, code: "COACH_EDIT_SAFETY" });
      expect(await saveTrainingProposal({ ...d.input, selectedItemIds: ["run"], coachEdit }, d.deps)).toMatchObject({ ok: false, code: "COACH_EDIT_SAFETY" });
    }
    expect(await prisma.menuTemplate.count()).toBe(0);
  });
});
