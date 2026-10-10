import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../helpers";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { planRunningPrescription } from "@/domain/running-policy/engine";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { parseRunningMenuEnvelope, serializeRunningMenuEnvelope, presentRunningMenuSnapshot } from "@/application/running-menu/persistence";
import { parseRunningSessionSnapshot, runningSessionSourceFingerprint } from "@/application/running-session/snapshot";
import { editRunningPolicyMenuItem, runningCoachEditSourceFingerprint } from "@/actions/_running-coach-edit-service";
import { findMenu } from "@/infra/repositories/menu-repository";
import { createSessionFromMenu, findSession } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";
import { verifyRunningIntentClaims, type RunningIntentClaims } from "@/application/running-menu/intent";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { issueRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import { saveRunningMenuPreview } from "@/actions/_running-menu-save-service";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { editRunningPolicyMenuItemAction } = await import("@/actions/running-coach-edit-actions");
beforeEach(resetDb);

async function saved(options: { event?: "100m" | "200m"; age?: "JUNIOR_HIGH" | "HIGH_SCHOOL"; light?: boolean; distance?: number } = {}) {
  const event = options.event ?? "100m";
  const ageGroup = options.age ?? "HIGH_SCHOOL";
  const result = planRunningPrescription({ event, ageGroup, humanExplicitDistances: options.distance ? [options.distance] : [], loadReductionRequested: options.light ?? false });
  if (result.status !== "READY") throw new Error(result.status);
  const p = result.prescription;
  const menu = await prisma.menuTemplate.create({ data: {
    ownerId: DEFAULT_OWNER_ID, name: "Coach Edit 練習", status: "DRAFT",
    blocks: { create: { name: "走", sortOrder: 0, items: { create: {
      sortOrder: 0, displayName: "走", prescriptionKind: "RUNNING_POLICY",
      prescriptionJson: serializeRunningMenuEnvelope(p),
      provenanceJson: JSON.stringify({
        schemaVersion: 1, source: "SIGNED_RUNNING_PREVIEW", requestDigest: "0".repeat(64),
        intent: { event: { value: event }, ageGroup: { value: ageGroup }, loadReductionRequested: options.light ? { value: true } : null, fatigueState: null, availableTimeSeconds: null }, context: {},
      }),
      distanceMeters: p.distanceMeters, reps: p.totalReps, sets: p.sets,
      restSeconds: p.repRestSeconds, setRestSeconds: p.setRestSeconds,
    } } } },
  } });
  const item = (await findMenu(menu.id))!.blocks[0]!.items[0]!;
  return { menu, item, p };
}

async function editItem(menuId: string, itemId: string, edit: Record<string, unknown>, fingerprint?: string) {
  const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } });
  return editRunningPolicyMenuItem({
    menuId, itemId, expectedFingerprint: fingerprint ?? runningCoachEditSourceFingerprint(item),
    edit: edit as Parameters<typeof editRunningPolicyMenuItem>[0]["edit"],
  });
}

async function sessionFrom(menuId: string) {
  const menu = (await findMenu(menuId))!;
  const input = sessionFromMenuSchema.parse({ menuTemplateId: menuId, date: "2026-09-30" });
  return createSessionFromMenu(input, undefined, runningSessionSourceFingerprint(menu));
}

describe("server validated Running Coach Edit lifecycle", () => {
  it("upgrades v1 to v2, snapshots final values and keeps Session immutable after a later Menu edit", async () => {
    const { menu, item } = await saved();
    const edited = await editItem(menu.id, item.id, { totalReps: 5, repRestSeconds: 300 });
    expect(edited.ok).toBe(true);
    const reloaded = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloaded).toMatchObject({ distanceMeters: 60, reps: 5, restSeconds: 300 });
    expect(parseRunningMenuEnvelope(reloaded.prescriptionKind, reloaded.prescriptionJson)).toMatchObject({ schemaVersion: 2, basePrescription: { totalReps: 4 }, finalPrescription: { totalReps: 5, repRestSeconds: 300 } });
    expect(presentRunningMenuSnapshot(reloaded.prescriptionKind, reloaded.prescriptionJson)).toMatchObject({ title: "60m × 5本", coachEdited: true });
    const session = await sessionFrom(menu.id);
    const sessionItem = (await findSession(session.id))!.items[0]!;
    expect(parseRunningSessionSnapshot(sessionItem.prescriptionKind, sessionItem.plannedPrescriptionJson)).toMatchObject({ snapshotSchemaVersion: 2, origin: "COACH_EDITED", prescription: { distanceMeters: 60, totalReps: 5, repRestSeconds: 300 } });
    expect(parseRunningSessionSnapshot(sessionItem.prescriptionKind, sessionItem.plannedPrescriptionJson)).toMatchObject({ coachEditProvenance: { edited: true, edits: expect.arrayContaining([expect.objectContaining({ field: "totalReps", actorClass: "COACH" })]) } });
    expect(await editItem(menu.id, item.id, { totalReps: 3, repRestSeconds: 180 })).toMatchObject({ ok: true });
    const historical = (await findSession(session.id))!.items[0]!;
    expect(parseRunningSessionSnapshot(historical.prescriptionKind, historical.plannedPrescriptionJson)).toMatchObject({ prescription: { totalReps: 5, repRestSeconds: 300 } });
  });

  it("replans explicit distance edits and preserves Phase E", async () => {
    const normal = await saved();
    expect(await editItem(normal.menu.id, normal.item.id, { distanceMeters: 50 })).toMatchObject({ ok: true });
    expect(await prisma.menuItem.findUnique({ where: { id: normal.item.id } })).toMatchObject({ distanceMeters: 50, reps: 4, restSeconds: 240 });
    const light = await saved({ light: true });
    expect(await editItem(light.menu.id, light.item.id, { distanceMeters: 50 })).toMatchObject({ ok: true });
    expect(await prisma.menuItem.findUnique({ where: { id: light.item.id } })).toMatchObject({ distanceMeters: 50, reps: 3, restSeconds: 240 });
  });

  it("rejects outside-range, unsupported distance and the junior high age gate without writing", async () => {
    const normal = await saved();
    const original = normal.item.prescriptionJson;
    expect(await editItem(normal.menu.id, normal.item.id, { totalReps: 6 })).toEqual({ ok: false, code: "RANGE_OUTSIDE" });
    expect(await editItem(normal.menu.id, normal.item.id, { repRestSeconds: 60 })).toEqual({ ok: false, code: "RANGE_OUTSIDE" });
    expect(await editItem(normal.menu.id, normal.item.id, { distanceMeters: 80 })).toEqual({ ok: false, code: "DISTANCE_REVIEW_REQUIRED" });
    expect((await prisma.menuItem.findUnique({ where: { id: normal.item.id } }))?.prescriptionJson).toBe(original);
    const junior = await saved({ age: "JUNIOR_HIGH" });
    expect(await editItem(junior.menu.id, junior.item.id, { distanceMeters: 200 })).toEqual({ ok: false, code: "DISTANCE_REVIEW_REQUIRED" });
  });

  it("rejects stale fingerprints and direct client numeric tampering", async () => {
    const { menu, item } = await saved();
    const fingerprint = runningCoachEditSourceFingerprint(item);
    await prisma.menuItem.update({ where: { id: item.id }, data: { note: "変更" } });
    expect(await editItem(menu.id, item.id, { totalReps: 5 }, fingerprint)).toEqual({ ok: false, code: "STALE_ITEM" });
    const current = runningCoachEditSourceFingerprint(await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } }));
    expect(await editRunningPolicyMenuItemAction({ menuId: menu.id, itemId: item.id, expectedFingerprint: current, edit: { totalReps: 9 } })).toEqual({ ok: false, code: "RANGE_OUTSIDE" });
    expect(await editRunningPolicyMenuItemAction({ menuId: menu.id, itemId: item.id, expectedFingerprint: fingerprint, edit: { generatedReps: 5 } })).toEqual({ ok: false, code: "INVALID_INPUT" });
  });

  it("stores target time, instruction and coach-only split without old Method fields", async () => {
    const { menu, item } = await saved({ distance: 30 });
    const outcome = await editItem(menu.id, item.id, {
      coachTargetTimeRange: { minSeconds: 4.2, maxSeconds: 4.4 },
      executionInstructionText: "フォームを保って", setReps: [3, 2], setRestSeconds: 600,
    });
    expect(outcome.ok).toBe(true);
    const row = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row).toMatchObject({ runningMethod: null, sessionTemplateId: null, ruleSetVersion: null, sets: 2, setRestSeconds: 600 });
    const parsed = parseRunningMenuEnvelope(row.prescriptionKind, row.prescriptionJson);
    expect(parsed).toMatchObject({ schemaVersion: 2, finalPrescription: { setReps: [3, 2], minimumKnownRestSeconds: 1140, coachTargetTimeRange: { minSeconds: 4.2, maxSeconds: 4.4 } } });
    const session = await sessionFrom(menu.id);
    expect(parseRunningSessionSnapshot("RUNNING_POLICY", (await findSession(session.id))!.items[0]!.plannedPrescriptionJson)).toMatchObject({ snapshotSchemaVersion: 2, prescription: { setReps: [3, 2] } });
  });

  it("does not let the legacy Running edit action mutate a new Running item", async () => {
    const { menu, item } = await saved();
    const previousFlag = process.env.RUNNING_V2_UI_ENABLED;
    process.env.RUNNING_V2_UI_ENABLED = "true";
    try {
      const { editRunningItemAction } = await import("@/actions/running-actions");
      const form = new FormData();
      form.set("itemId", item.id);
      form.set("field", "repsPerSet");
      form.set("value", "5");
      const result = await editRunningItemAction(menu.id, null, form);
      expect(result.ok).toBe(false);
      expect((await prisma.menuItem.findUnique({ where: { id: item.id } }))?.prescriptionJson).toBe(item.prescriptionJson);
    } finally {
      if (previousFlag === undefined) delete process.env.RUNNING_V2_UI_ENABLED;
      else process.env.RUNNING_V2_UI_ENABLED = previousFlag;
    }
  });

  it("rejects a corrupt Coach Edit envelope before creating any Session rows", async () => {
    const { menu, item } = await saved();
    expect(await editItem(menu.id, item.id, { totalReps: 5, repRestSeconds: 300 })).toMatchObject({ ok: true });
    const row = await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    const corrupt = JSON.parse(row.prescriptionJson!) as { finalPrescription: { totalReps: number } };
    corrupt.finalPrescription.totalReps = 9;
    await prisma.menuItem.update({ where: { id: item.id }, data: { prescriptionJson: JSON.stringify(corrupt) } });
    await expect(sessionFrom(menu.id)).rejects.toMatchObject({ code: "INVALID_MENU_ITEM" });
    expect(await prisma.trainingSession.count()).toBe(0);
    expect(await prisma.sessionItem.count()).toBe(0);
  });

  it("saves a signed Composer coach edit as v2 and rejects a mismatched preview final", async () => {
    const priorKey = process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
    process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = "running-coach-edit-secret-with-more-than-32-bytes";
    try {
      const requestText = "中学生100m選手、今日のメニューを作って";
      const claims: RunningIntentClaims = {
        runningRequested: true, event: { value: "100m", sourceText: "100m選手" },
        ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" }, explicitDistances: [],
        distancePreference: null, loadReductionRequested: null, fatigueState: null,
        purpose: null, intensityPreference: null, competitionDays: null,
        availableTimeSeconds: null, humanExplicitReps: null, humanExplicitRestSeconds: null, exerciseIds: [],
      };
      const verified = verifyRunningIntentClaims(requestText, claims, []);
      if (!verified.ok) throw new Error(verified.reason);
      const preview = createRunningMenuPreview(verified.intent, {}, requestText);
      if (preview?.status !== "READY") throw new Error(preview?.status ?? "NO_RUNNING");
      const token = issueRunningMenuPreviewToken({ ownerId: DEFAULT_OWNER_ID, requestText, context: {}, intent: verified.intent, prescription: preview.prescription }, process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET);
      const { previewRunningCoachEditAction } = await import("@/actions/running-coach-preview-actions");
      const base = {
        previewToken: token, previewPolicyVersion: RUNNING_POLICY_VERSION,
        previewPolicyHash: RUNNING_POLICY_HASH, requestText, context: {}, previewPrescription: preview.prescription,
      };
      const candidate = await previewRunningCoachEditAction({ ...base, coachEdit: { totalReps: 5, repRestSeconds: 300 } });
      expect(candidate.ok).toBe(true);
      if (!candidate.ok) return;
      expect(await saveRunningMenuPreview({ ...base, menuName: "走練習", manualBlocks: [], coachEdit: { totalReps: 5, repRestSeconds: 300 }, previewFinalFingerprint: "f".repeat(64) })).toEqual({ ok: false, code: "ENGINE_RECOMPUTE_MISMATCH" });
      const savedResult = await saveRunningMenuPreview({ ...base, menuName: "走練習", manualBlocks: [], coachEdit: { totalReps: 5, repRestSeconds: 300 }, previewFinalFingerprint: candidate.finalFingerprint });
      expect(savedResult.ok).toBe(true);
      if (!savedResult.ok) return;
      const row = (await findMenu(savedResult.menuId))!.blocks[0]!.items[0]!;
      expect(row).toMatchObject({ distanceMeters: 60, reps: 5, restSeconds: 300 });
      expect(parseRunningMenuEnvelope(row.prescriptionKind, row.prescriptionJson)?.schemaVersion).toBe(2);
      const session = await sessionFrom(savedResult.menuId);
      expect(parseRunningSessionSnapshot("RUNNING_POLICY", (await findSession(session.id))!.items[0]!.plannedPrescriptionJson)).toMatchObject({ snapshotSchemaVersion: 2, prescription: { totalReps: 5, repRestSeconds: 300 } });
    } finally {
      if (priorKey === undefined) delete process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
      else process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = priorKey;
    }
  });
});
