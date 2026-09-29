import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb, makeExercise } from "../helpers";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { planRunningPrescription } from "@/domain/running-policy/engine";
import { RUNNING_POLICY_HASH, RUNNING_POLICY_VERSION } from "@/domain/running-policy/policy";
import { serializeRunningMenuEnvelope } from "@/application/running-menu/persistence";
import { createRunningMenuPreview } from "@/application/running-menu/preview";
import { verifyRunningIntentClaims, type RunningIntentClaims } from "@/application/running-menu/intent";
import { issueRunningMenuPreviewToken } from "@/infra/running-menu/preview-token";
import { saveRunningMenuPreview } from "@/actions/_running-menu-save-service";
import {
  RUNNING_SESSION_SNAPSHOT_SCHEMA_VERSION,
  RunningSessionSnapshotError,
  parseRunningSessionSnapshot,
  presentRunningSessionSnapshot,
  runningSessionSourceFingerprint,
} from "@/application/running-session/snapshot";
import { findMenu } from "@/infra/repositories/menu-repository";
import { createSessionFromMenu, findSession } from "@/infra/repositories/session-repository";
import { sessionFromMenuSchema } from "@/domain/session/schema";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); }) }));
const { createSessionFromMenuAction } = await import("@/actions/session-actions");

beforeEach(resetDb);

async function savedMenu(options: { event?: "100m" | "200m"; light?: boolean; distance?: number; exercise?: boolean; manual?: boolean } = {}) {
  const result = planRunningPrescription({
    event: options.event ?? "100m",
    ageGroup: "HIGH_SCHOOL",
    humanExplicitDistances: options.distance ? [options.distance] : [],
    loadReductionRequested: options.light ?? false,
  });
  if (result.status !== "READY") throw new Error(result.status);
  const p = result.prescription;
  const exercise = options.exercise ? await makeExercise({ name: "ドリル" }) : null;
  const menu = await prisma.menuTemplate.create({
    data: {
      ownerId: DEFAULT_OWNER_ID, name: "走メニュー", status: "DRAFT",
      blocks: { create: [{
        name: "走", sortOrder: 0,
        items: { create: [{
          sortOrder: 0, displayName: "走", prescriptionKind: "RUNNING_POLICY",
          prescriptionJson: serializeRunningMenuEnvelope(p),
          provenanceJson: JSON.stringify({ schemaVersion: 1, source: "SIGNED_RUNNING_PREVIEW", requestDigest: "0".repeat(64), intent: {}, context: {} }),
          distanceMeters: p.distanceMeters, reps: p.totalReps, sets: p.sets,
          restSeconds: p.repRestSeconds, setRestSeconds: p.setRestSeconds,
        }] },
      }, ...(exercise ? [{ name: "ドリル", sortOrder: 1, items: { create: [{ exerciseId: exercise.id, sortOrder: 0 }] } }] : []),
      ...(options.manual ? [{ name: "補強", sortOrder: 2, items: { create: [{ displayName: "体幹", sets: 2, reps: 10, sortOrder: 0 }] } }] : [])] },
    },
  });
  return { menu, p };
}

async function createFromCurrentMenu(menuId: string) {
  const menu = await findMenu(menuId);
  if (!menu) throw new Error("menu missing");
  const input = sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-30" });
  return createSessionFromMenu(input, undefined, runningSessionSourceFingerprint(menu));
}

describe("saved Running Menu to immutable Session snapshot", () => {
  it("connects the actual Composer save contract to Session creation and reload", async () => {
    const previousKey = process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
    process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = "running-session-test-secret-with-more-than-32-bytes";
    try {
      const requestText = "中学生100m選手、今日のメニューを作って";
      const claims: RunningIntentClaims = {
        runningRequested: true,
        event: { value: "100m", sourceText: "100m選手" },
        ageGroup: { value: "JUNIOR_HIGH", sourceText: "中学生" },
        explicitDistances: [], distancePreference: null, loadReductionRequested: null,
        fatigueState: null, availableTimeSeconds: null, humanExplicitReps: null,
        humanExplicitRestSeconds: null, exerciseIds: [],
      };
      const verified = verifyRunningIntentClaims(requestText, claims, []);
      if (!verified.ok) throw new Error(verified.reason);
      const context = {};
      const preview = createRunningMenuPreview(verified.intent, context, requestText);
      if (preview?.status !== "READY") throw new Error(preview?.status ?? "NO_RUNNING");
      const previewToken = issueRunningMenuPreviewToken({
        ownerId: DEFAULT_OWNER_ID, requestText, context, intent: verified.intent,
        prescription: preview.prescription,
      }, process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET);
      const saved = await saveRunningMenuPreview({
        previewToken, previewPolicyVersion: RUNNING_POLICY_VERSION,
        previewPolicyHash: RUNNING_POLICY_HASH, requestText, context,
        previewPrescription: preview.prescription, menuName: "100m練習", manualBlocks: [],
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      const session = await createFromCurrentMenu(saved.menuId);
      const item = (await findSession(session.id))!.items[0]!;
      expect(parseRunningSessionSnapshot(item.prescriptionKind, item.plannedPrescriptionJson)?.prescription)
        .toMatchObject({ distanceMeters: 60, totalReps: 4, repRestSeconds: 240 });
    } finally {
      if (previousKey === undefined) delete process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET;
      else process.env.MENU_PLANNER_ACCEPT_TOKEN_SECRET = previousKey;
    }
  });

  it.each([
    ["100m", false, 60, 4, 240],
    ["200m", false, 120, 3, 900],
    ["100m", true, 60, 3, 240],
  ] as const)("snapshots %s light=%s without replanning", async (event, light, distance, reps, rest) => {
    const { menu } = await savedMenu({ event, light });
    const session = await createFromCurrentMenu(menu.id);
    const row = (await findSession(session.id))!.items[0]!;
    expect(row).toMatchObject({ prescriptionKind: "RUNNING_POLICY", plannedDistanceMeters: distance, plannedReps: reps, plannedRestSeconds: rest, runningMethod: null, sessionTemplateId: null, ruleSetVersion: null, ruleSetContentHash: null, loadCategory: null });
    const snapshot = parseRunningSessionSnapshot(row.prescriptionKind, row.plannedPrescriptionJson);
    expect(snapshot).toMatchObject({ kind: "RUNNING_POLICY_SNAPSHOT", snapshotSchemaVersion: RUNNING_SESSION_SNAPSHOT_SCHEMA_VERSION, sourcePersistenceSchemaVersion: 1, policyVersion: "rp-2026.09.0", prescription: { distanceMeters: distance, totalReps: reps, repRestSeconds: rest, setReps: null } });
    expect(presentRunningSessionSnapshot(row.prescriptionKind, row.plannedPrescriptionJson)).toMatchObject({ status: "OK", title: `${distance}m × ${reps}本`, restText: `1本ごとの休憩 ${rest / 60}分` });
  });

  it("stores one-rep distance without a fictitious rest", async () => {
    const { menu } = await savedMenu({ distance: 250 });
    const session = await createFromCurrentMenu(menu.id);
    const row = (await findSession(session.id))!.items[0]!;
    expect(presentRunningSessionSnapshot(row.prescriptionKind, row.plannedPrescriptionJson)).toMatchObject({ status: "OK", title: "250m × 1本", restText: null });
  });

  it("creates Running, Exercise and manual snapshots atomically", async () => {
    const { menu } = await savedMenu({ exercise: true, manual: true });
    const session = await createFromCurrentMenu(menu.id);
    const rows = (await findSession(session.id))!.items;
    expect(rows.map((row) => row.prescriptionKind)).toEqual(["RUNNING_POLICY", "LEGACY", "LEGACY"]);
    expect(rows.map((row) => row.exerciseNameSnapshot)).toEqual(["60m × 4本", "ドリル", "体幹"]);
  });

  it("refuses a corrupt Running item and creates no partial Session", async () => {
    const { menu } = await savedMenu({ exercise: true });
    const item = (await findMenu(menu.id))!.blocks[0]!.items[0]!;
    await prisma.menuItem.update({ where: { id: item.id }, data: { reps: 9 } });
    await expect(createFromCurrentMenu(menu.id)).rejects.toMatchObject({ code: "INVALID_MENU_ITEM" });
    expect(await prisma.trainingSession.count()).toBe(0);
    expect(await prisma.sessionItem.count()).toBe(0);
  });

  it("keeps Session values after Menu edit, source deletion, and hypothetical current-policy drift", async () => {
    const { menu } = await savedMenu();
    const session = await createFromCurrentMenu(menu.id);
    const original = (await findSession(session.id))!.items[0]!.plannedPrescriptionJson;
    const item = (await findMenu(menu.id))!.blocks[0]!.items[0]!;
    await prisma.menuItem.update({ where: { id: item.id }, data: { reps: 3 } });
    expect((await findSession(session.id))!.items[0]!.plannedPrescriptionJson).toBe(original);
    await prisma.menuTemplate.delete({ where: { id: menu.id } });
    const historical = (await findSession(session.id))!.items[0]!;
    expect(parseRunningSessionSnapshot(historical.prescriptionKind, historical.plannedPrescriptionJson)?.prescription).toMatchObject({ distanceMeters: 60, totalReps: 4, repRestSeconds: 240 });
    const hypotheticalCurrentPolicy = { version: "rp-2026.10.0", defaultReps: 3 };
    expect(hypotheticalCurrentPolicy.defaultReps).toBe(3);
    expect(presentRunningSessionSnapshot(historical.prescriptionKind, historical.plannedPrescriptionJson)).toMatchObject({ status: "OK", title: "60m × 4本" });
  });

  it("rejects old fingerprints and requires one for direct repository calls", async () => {
    const { menu } = await savedMenu();
    const oldFingerprint = runningSessionSourceFingerprint((await findMenu(menu.id))!);
    await prisma.menuItem.update({ where: { id: (await findMenu(menu.id))!.blocks[0]!.items[0]!.id }, data: { note: "変更" } });
    const input = sessionFromMenuSchema.parse({ menuTemplateId: menu.id, date: "2026-09-30" });
    await expect(createSessionFromMenu(input, undefined, oldFingerprint)).rejects.toMatchObject({ code: "STALE_MENU_FOR_SESSION" });
    await expect(createSessionFromMenu(input)).rejects.toBeInstanceOf(RunningSessionSnapshotError);
    expect(await prisma.trainingSession.count()).toBe(0);
    await expect(createFromCurrentMenu(menu.id)).resolves.toMatchObject({ sourceMenuTemplateId: menu.id });
  });

  it("uses DB values and ignores forged client numeric fields at the direct action", async () => {
    const { menu } = await savedMenu();
    const fingerprint = runningSessionSourceFingerprint((await findMenu(menu.id))!);
    const form = new FormData();
    form.set("menuTemplateId", menu.id);
    form.set("date", "2026-09-30");
    form.set("runningSourceFingerprint", fingerprint);
    form.set("distanceMeters", "300");
    form.set("reps", "99");
    form.set("restSeconds", "1");
    await expect(createSessionFromMenuAction(null, form)).rejects.toThrow(/^NEXT_REDIRECT:/u);
    const rows = await prisma.sessionItem.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ plannedDistanceMeters: 60, plannedReps: 4, plannedRestSeconds: 240 });
  });

  it("rejects unsupported and corrupt Menu envelopes and corrupt Session snapshots", async () => {
    const { menu } = await savedMenu();
    const item = (await findMenu(menu.id))!.blocks[0]!.items[0]!;
    const original = JSON.parse(item.prescriptionJson!);
    await prisma.menuItem.update({ where: { id: item.id }, data: { prescriptionJson: JSON.stringify({ ...original, schemaVersion: 99 }) } });
    await expect(createFromCurrentMenu(menu.id)).rejects.toMatchObject({ code: "INVALID_MENU_ITEM" });
    await prisma.menuItem.update({ where: { id: item.id }, data: { prescriptionJson: JSON.stringify({ ...original, prescription: { ...original.prescription, sets: 2, setReps: [3, 2], setRestSeconds: 600 } }) } });
    await expect(createFromCurrentMenu(menu.id)).rejects.toMatchObject({ code: "INVALID_MENU_ITEM" });
    await prisma.menuItem.update({ where: { id: item.id }, data: { prescriptionJson: item.prescriptionJson, provenanceJson: "{}" } });
    await expect(createFromCurrentMenu(menu.id)).rejects.toMatchObject({ code: "INVALID_MENU_ITEM" });
    await prisma.menuItem.update({ where: { id: item.id }, data: { provenanceJson: item.provenanceJson } });
    await prisma.menuItem.update({ where: { id: item.id }, data: { intensityPercent: 90 } });
    await expect(createFromCurrentMenu(menu.id)).rejects.toMatchObject({ code: "INVALID_MENU_ITEM" });
    await prisma.menuItem.update({ where: { id: item.id }, data: { intensityPercent: null } });
    await prisma.menuItem.update({ where: { id: item.id }, data: { prescriptionJson: JSON.stringify({ ...original, policyVersion: "rp-future", prescription: { ...original.prescription, policyVersion: "rp-future" } }) } });
    await expect(createFromCurrentMenu(menu.id)).rejects.toMatchObject({ code: "UNSUPPORTED_POLICY" });
    expect(await prisma.trainingSession.count()).toBe(0);
    const old = await savedMenu({ event: "200m" });
    const session = await createFromCurrentMenu(old.menu.id);
    const row = (await findSession(session.id))!.items[0]!;
    const changed = JSON.parse(row.plannedPrescriptionJson!);
    changed.prescription.totalReps = 9;
    expect(parseRunningSessionSnapshot(row.prescriptionKind, JSON.stringify(changed))).toBeNull();
  });
});
