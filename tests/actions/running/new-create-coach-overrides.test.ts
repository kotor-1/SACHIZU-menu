import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { saveMenuRunningContext, findRunningMenuItem } from "@/infra/repositories/running-item-repository";
import { resetDb } from "../../helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { editRunningItemAction, planRunningItemAction } = await import("@/actions/running-actions");

type ContextInput = { ageBand?: "U12" | "U15" | "U18"; maturity?: "PRE" | "CIRCA" | "UNKNOWN"; coachAssignedAdvanced?: boolean };

function contextObject(input: ContextInput = {}) {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "対象グループ",
      members: [
        {
          ageBandOverride: input.ageBand ?? "U15",
          maturity: {
            status: input.maturity ?? "PRE",
            confidence: input.maturity === "UNKNOWN" ? "LOW" : "HIGH",
            method: input.maturity === "UNKNOWN" ? "NONE" : "COACH_OBSERVATION",
            assessedAt: input.maturity === "UNKNOWN" ? null : "2026-09-01",
          },
          trainingAge: { structuredSprintYears: input.coachAssignedAdvanced ? 5 : 3, ...(input.coachAssignedAdvanced ? { coachAssignedTier: "ADVANCED" } : {}) },
          primaryEvent: "400m",
        },
      ],
      allowAdvancedMethods: true,
    },
    plannedDate: "2026-09-20",
    plannedAt: "2026-09-20T16:00:00+09:00",
    availableMinutes: 90,
  };
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((entry) => fd.append(key, entry));
    else fd.set(key, value);
  }
  return fd;
}

async function makeMenu(context: ContextInput = {}) {
  const menu = await prisma.menuTemplate.create({
    data: { name: "Running override", blocks: { create: { name: "主運動", sortOrder: 0 } } },
    include: { blocks: true },
  });
  await saveMenuRunningContext(menu.id, JSON.stringify(contextObject(context)));
  return { menu, block: menu.blocks[0]! };
}

const reason = "コーチが個別の状況を確認して今回の実施を判断しました";

function planFields(method: string, templateId: string, extra: Record<string, string | string[]> = {}) {
  return { method, templateId, positionPreference: "", ...extra };
}

async function create(menuId: string, blockId: string, fields: Record<string, string | string[]>) {
  return planRunningItemAction(menuId, blockId, null, form(fields));
}

beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());
beforeEach(resetDb);

describe("new-item formal eligibility overrides", () => {
  it("PRE SES は正確な Rule ID・理由・二段階確認で MANUAL/review として作成され、成功履歴を保存する", async () => {
    const autoContext = await makeMenu();
    const autoResult = await create(
      autoContext.menu.id,
      autoContext.block.id,
      planFields("SPRINT_ENDURANCE_SHORT", "SES_80", {
        eligibilityOverrideRuleIds: ["ELIG_SES_PRE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(autoResult.ok, JSON.stringify(autoResult)).toBe(true);
    if (!autoResult.ok) throw new Error("unreachable");
    const autoSaved = await findRunningMenuItem(autoResult.data.id);
    if (autoSaved?.status !== "VALID") throw new Error("auto item not valid");
    expect(autoSaved.prescription.repsPerSet.value * autoSaved.prescription.sets.value).toBe(2);

    const { menu, block } = await makeMenu();
    const initial = await create(menu.id, block.id, planFields("SPRINT_ENDURANCE_SHORT", "SES_80"));
    expect(initial).toMatchObject({ ok: false, kind: "PLAN_INELIGIBLE" });
    if (initial.ok || initial.kind !== "PLAN_INELIGIBLE") throw new Error("unreachable");
    expect(initial.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ ruleIdInternal: "ELIG_SES_PRE", overrideAllowed: true })]));

    const result = await create(
      menu.id,
      block.id,
      planFields("SPRINT_ENDURANCE_SHORT", "SES_80", {
        eligibilityOverrideRuleIds: ["ELIG_SES_PRE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
        coachEditsJson: JSON.stringify([{ field: "totalReps", value: 3, unit: "reps" }]),
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid");
    expect(saved.prescription.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ELIGIBILITY_OVERRIDDEN", severity: "REQUIRE_COACH_REVIEW" })]));
    expect(saved.prescription.rationale).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ELIGIBILITY", params: { mode: "OVERRIDDEN", review: 1 } })]));
    expect(saved.provenance.overrides).toEqual([
      expect.objectContaining({ target: { kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" }, reason, confirmedTwice: true }),
    ]);
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "totalReps", to: 3, at: expect.any(String) }),
    ]);
    expect(saved.prescription.repsPerSet.origin).toBe("COACH");
    expect(saved.provenance.coachEdits[0]).not.toHaveProperty("from");
    expect(saved.provenance.generatedBy.createdByCoach).toBe(true);

    const initialTotalReps = saved.prescription.repsPerSet.value * saved.prescription.sets.value;
    expect(initialTotalReps).toBe(3);
    const replanned = await editRunningItemAction(menu.id, null, form({
      itemId: result.data.id,
      field: "repRestS",
      value: String(saved.prescription.rest.repRestS.value),
    }));
    expect(replanned.ok, JSON.stringify(replanned)).toBe(true);
    const afterReplan = await findRunningMenuItem(result.data.id);
    if (afterReplan?.status !== "VALID") throw new Error("item not valid after replan");
    expect(afterReplan.prescription.repsPerSet.value * afterReplan.prescription.sets.value).toBe(initialTotalReps);
    expect(afterReplan.provenance.coachEdits.filter((edit) => edit.field === "totalReps")).toEqual([
      expect.objectContaining({ field: "totalReps", to: 3 }),
    ]);
    expect(afterReplan.provenance.overrides).toEqual([
      expect.objectContaining({ target: { kind: "ELIGIBILITY", ruleId: "ELIG_SES_PRE" }, reason, confirmedTwice: true }),
    ]);
  });

  it("通常の新規作成でも成功した coachEdits を同じ provenance へ保存する", async () => {
    const { menu, block } = await makeMenu({ ageBand: "U18", maturity: "CIRCA" });
    const result = await create(
      menu.id,
      block.id,
      planFields("SPRINT_ENDURANCE_SHORT", "SES_80", {
        coachEditsJson: JSON.stringify([{ field: "totalReps", value: 3, unit: "reps" }]),
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid");
    expect(saved.provenance.overrides).toEqual([]);
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "totalReps", to: 3, at: expect.any(String) }),
    ]);
    expect(saved.prescription.repsPerSet.value * saved.prescription.sets.value).toBe(3);
    const replanned = await editRunningItemAction(menu.id, null, form({
      itemId: result.data.id,
      field: "repRestS",
      value: String(saved.prescription.rest.repRestS.value),
    }));
    expect(replanned.ok, JSON.stringify(replanned)).toBe(true);
    const afterReplan = await findRunningMenuItem(result.data.id);
    if (afterReplan?.status !== "VALID") throw new Error("item not valid after replan");
    expect(afterReplan.prescription.repsPerSet.value * afterReplan.prescription.sets.value).toBe(3);
  });

  it("ACC_BLOCK_20 の固定距離と同じ入力は COACH origin ではなく履歴にも保存しない", async () => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields("ACCELERATION", "ACC_BLOCK_20", {
        coachEditsJson: JSON.stringify([{ field: "repDistanceM", value: 20, unit: "m" }]),
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid");
    expect(saved.prescription.rep).toMatchObject({
      kind: "DISTANCE",
      distanceM: { value: 20, origin: "TEMPLATE_FIXED" },
    });
    expect(saved.provenance.coachEdits.some((edit) => edit.field === "repDistanceM")).toBe(false);
  });

  it("mixed create stores only materialized coach edits and does not restore a fixed-value no-op on replan", async () => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields("ACCELERATION", "ACC_BLOCK_20", {
        coachEditsJson: JSON.stringify([
          { field: "repDistanceM", value: 20, unit: "m" },
          { field: "repRestS", value: 150, unit: "s" },
        ]),
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid");
    expect(saved.prescription.rep).toMatchObject({ kind: "DISTANCE", distanceM: { value: 20, origin: "TEMPLATE_FIXED" } });
    expect(saved.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "COACH" });
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", to: 150 }),
    ]);

    const replanned = await editRunningItemAction(menu.id, null, form({
      itemId: result.data.id,
      field: "repRestS",
      value: "180",
    }));
    expect(replanned.ok, JSON.stringify(replanned)).toBe(true);
    const afterReplan = await findRunningMenuItem(result.data.id);
    if (afterReplan?.status !== "VALID") throw new Error("item not valid after replan");
    expect(afterReplan.prescription.rep).toMatchObject({ kind: "DISTANCE", distanceM: { value: 20, origin: "TEMPLATE_FIXED" } });
    expect(afterReplan.provenance.coachEdits.some((edit) => edit.field === "repDistanceM")).toBe(false);
    expect(afterReplan.provenance.coachEdits.filter((edit) => edit.field === "repRestS")).toEqual([
      expect.objectContaining({ field: "repRestS", to: 150 }),
      expect.objectContaining({ field: "repRestS", from: 150, to: 180 }),
    ]);
  });

  it("subsequent direct edit of a fixed field does not add false coach history or duplicate prior coach edits", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(
      menu.id,
      block.id,
      planFields("ACCELERATION", "ACC_BLOCK_20", {
        coachEditsJson: JSON.stringify([{ field: "repRestS", value: 150, unit: "s" }]),
      }),
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const result = await editRunningItemAction(menu.id, null, form({
      itemId: created.data.id,
      field: "repDistanceM",
      value: "20",
    }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid after fixed-value edit");
    expect(saved.prescription.rep).toMatchObject({ kind: "DISTANCE", distanceM: { value: 20, origin: "TEMPLATE_FIXED" } });
    expect(saved.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "COACH" });
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", to: 150 }),
    ]);
    expect(saved.provenance.coachEdits.some((edit) => edit.field === "repDistanceM")).toBe(false);
  });

  it("subsequent mixed edit persists only the changed field materialized by the current request", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(
      menu.id,
      block.id,
      planFields("ACCELERATION", "ACC_BLOCK_20", {
        coachEditsJson: JSON.stringify([{ field: "repRestS", value: 150, unit: "s" }]),
      }),
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const result = await editRunningItemAction(menu.id, null, form({
      itemId: created.data.id,
      fieldEditsJson: JSON.stringify([
        { field: "repDistanceM", value: 20 },
        { field: "repRestS", value: 180 },
      ]),
    }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid after mixed edit");
    expect(saved.prescription.rep).toMatchObject({ kind: "DISTANCE", distanceM: { value: 20, origin: "TEMPLATE_FIXED" } });
    expect(saved.prescription.rest.repRestS).toMatchObject({ value: 180, origin: "COACH" });
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", to: 150 }),
      expect.objectContaining({ field: "repRestS", from: 150, to: 180 }),
    ]);
    expect(saved.provenance.coachEdits.some((edit) => edit.field === "repDistanceM")).toBe(false);
  });

  it("same-value coach edit replans without adding a no-op history entry", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(
      menu.id,
      block.id,
      planFields("ACCELERATION", "ACC_BLOCK_20", {
        coachEditsJson: JSON.stringify([{ field: "repRestS", value: 150, unit: "s" }]),
      }),
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const result = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "150" }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid after no-op edit");
    expect(saved.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "COACH" });
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", to: 150 }),
    ]);
  });

  it("同値でも ENGINE_POSITIONED から COACH へ権限を移した履歴を保存し、replan と後続変更を保持する", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(menu.id, block.id, planFields("ACCELERATION", "ACC_BLOCK_20"));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    const before = await findRunningMenuItem(created.data.id);
    if (before?.status !== "VALID") throw new Error("item not valid before authority adoption");
    expect(before.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "ENGINE_POSITIONED" });

    const adopted = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "150" }));
    expect(adopted.ok, JSON.stringify(adopted)).toBe(true);
    const afterAdoption = await findRunningMenuItem(created.data.id);
    if (afterAdoption?.status !== "VALID") throw new Error("item not valid after authority adoption");
    expect(afterAdoption.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "COACH" });
    expect(afterAdoption.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", from: 150, to: 150 }),
    ]);

    // A later replan with no rest request restores the saved coach value and must not duplicate its adoption history.
    const replanned = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repDistanceM", value: "20" }));
    expect(replanned.ok, JSON.stringify(replanned)).toBe(true);
    const afterReplan = await findRunningMenuItem(created.data.id);
    if (afterReplan?.status !== "VALID") throw new Error("item not valid after replan");
    expect(afterReplan.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "COACH" });
    expect(afterReplan.provenance.coachEdits).toHaveLength(1);

    const changed = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "180" }));
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const afterChange = await findRunningMenuItem(created.data.id);
    if (afterChange?.status !== "VALID") throw new Error("item not valid after subsequent numeric edit");
    expect(afterChange.prescription.rest.repRestS).toMatchObject({ value: 180, origin: "COACH" });
    expect(afterChange.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", from: 150, to: 150 }),
      expect.objectContaining({ field: "repRestS", from: 150, to: 180 }),
    ]);
  });

  it("ENGINE_POSITIONED から異なる COACH 値へ移る履歴は一件だけ保存する", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(menu.id, block.id, planFields("ACCELERATION", "ACC_BLOCK_20"));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const result = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repRestS", value: "180" }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid after engine-to-coach change");
    expect(saved.prescription.rest.repRestS).toMatchObject({ value: 180, origin: "COACH" });
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", from: 150, to: 180 }),
    ]);
  });

  it("同一Actionの混在入力では固定距離を除き同値の rest authority adoption だけを記録する", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(menu.id, block.id, planFields("ACCELERATION", "ACC_BLOCK_20"));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const result = await editRunningItemAction(menu.id, null, form({
      itemId: created.data.id,
      fieldEditsJson: JSON.stringify([
        { field: "repDistanceM", value: 20 },
        { field: "repRestS", value: 150 },
      ]),
    }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const saved = await findRunningMenuItem(created.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid after mixed authority adoption");
    expect(saved.prescription.rep).toMatchObject({ kind: "DISTANCE", distanceM: { value: 20, origin: "TEMPLATE_FIXED" } });
    expect(saved.prescription.rest.repRestS).toMatchObject({ value: 150, origin: "COACH" });
    expect(saved.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "repRestS", from: 150, to: 150 }),
    ]);
    expect(saved.provenance.coachEdits.some((edit) => edit.field === "repDistanceM")).toBe(false);
  });

  it("rejects a different value for a fixed field without changing item or provenance", async () => {
    const { menu, block } = await makeMenu();
    const created = await create(menu.id, block.id, planFields("ACCELERATION", "ACC_BLOCK_20"));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    const before = await findRunningMenuItem(created.data.id);
    if (before?.status !== "VALID") throw new Error("item not valid before edit");

    const result = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "repDistanceM", value: "25" }));
    expect(result).toMatchObject({ ok: false, kind: "PLAN_BLOCKED" });
    const after = await findRunningMenuItem(created.data.id);
    if (after?.status !== "VALID") throw new Error("item not valid after rejected edit");
    expect(after.prescription).toEqual(before.prescription);
    expect(after.provenance).toEqual(before.provenance);
  });

  it("PRE RS MODERATE は正確な既存 override で作成できる", async () => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields("RESISTED_SPRINT", "RS_SLED_MODERATE", {
        eligibilityOverrideRuleIds: ["ELIG_RS_MODERATE_PRE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid");
    expect(saved.prescription.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ELIGIBILITY_OVERRIDDEN", severity: "REQUIRE_COACH_REVIEW" })]));
    expect(saved.provenance.overrides).toEqual([
      expect.objectContaining({ target: { kind: "ELIGIBILITY", ruleId: "ELIG_RS_MODERATE_PRE" }, confirmedTwice: true }),
    ]);
  });

  it.each([
    ["unknown", "SPRINT_ENDURANCE_SHORT", "SES_100", "DOES_NOT_EXIST"],
    ["nonblocking", "ACCELERATION", "ACC_BLOCK_20", "ELIG_SES_PRE"],
    ["mismatched blocker", "SPRINT_ENDURANCE_SHORT", "SES_100", "ELIG_RS_MODERATE_PRE"],
  ])("rejects %s Rule IDs that are not the current blocking Rule ID", async (_label, method, templateId, ruleId) => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields(method, templateId, {
        eligibilityOverrideRuleIds: [ruleId],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("rejects a matching but non-overridable blocker (LONG FULL PRE)", async () => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", {
        eligibilityOverrideRuleIds: ["ELIG_LONG_FULL_PRE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it.each([
    ["LONG INCOMPLETE PRE", "LONG_SPRINT_RACE_SPECIFIC", "LSR_300_PLUS_100", "ELIG_LONG_INCOMPLETE_PRE"],
    ["RS HEAVY PRE", "RESISTED_SPRINT", "RS_SLED_HEAVY", "ELIG_RS_HEAVY_PRE"],
    ["U15 Assisted constraint", "ASSISTED_SPRINT", "AS_TOWING", "CONSTRAINT_U15_ASSISTED_NONOVERRIDABLE"],
  ])("new-item override cannot bypass %s", async (_label, method, templateId, ruleId) => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields(method, templateId, {
        eligibilityOverrideRuleIds: [ruleId],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it.each([
    ["short reason", { eligibilityOverrideReason: "短い" }],
    ["missing second confirmation", { eligibilityOverrideReason: reason, eligibilityOverrideFirstConfirmation: "true" }],
    ["false confirmation", { eligibilityOverrideReason: reason, eligibilityOverrideFirstConfirmation: "true", eligibilityOverrideSecondConfirmation: "false" }],
  ])("rejects %s without saving an override", async (_label, extra) => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields("SPRINT_ENDURANCE_SHORT", "SES_100", { eligibilityOverrideRuleIds: ["ELIG_SES_PRE"], ...extra }),
    );
    expect(result).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    expect(await prisma.menuItem.count()).toBe(0);
  });
});

describe("new-item TI constraints remain intact", () => {
  it("U12 PRE TI stays blocked by the independent non-overridable age constraint", async () => {
    const { menu, block } = await makeMenu({ ageBand: "U12", maturity: "PRE" });
    const result = await create(
      menu.id,
      block.id,
      planFields("TEMPO_INTENSIVE", "TI_COACH_DEFINED", {
        eligibilityOverrideRuleIds: ["ELIG_TI_ALL_PRE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result).toMatchObject({ ok: false, kind: "PLAN_INELIGIBLE" });
    if (result.ok || result.kind !== "PLAN_INELIGIBLE") throw new Error("unreachable");
    expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ ruleIdInternal: "CONSTRAINT_U12_HARD", overrideAllowed: false })]));
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("TI_VITTORI_SE keeps its missing DEVELOPMENTAL envelope after the PRE eligibility override", async () => {
    const { menu, block } = await makeMenu();
    const result = await create(
      menu.id,
      block.id,
      planFields("TEMPO_INTENSIVE", "TI_VITTORI_SE", {
        eligibilityOverrideRuleIds: ["ELIG_TI_ALL_PRE", "ADVANCED_ONLY:TI_VITTORI_SE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, kind: "PLAN_BLOCKED" });
    if (result.ok || result.kind !== "PLAN_BLOCKED") throw new Error("unreachable");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ developerCode: "ENVELOPE_INFEASIBLE" })]));
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("forged PRE TI override with coach dose inputs still rejects the group create for missing measured reference", async () => {
    const { menu, block } = await makeMenu();
    const coachEdits = [
      { field: "repDistanceM", value: 150, unit: "m" },
      { field: "repsPerSet", value: 3, unit: "reps" },
      { field: "sets", value: 1, unit: "sets" },
      { field: "repRestS", value: 180, unit: "s" },
      { field: "intensityPercent", value: 85, unit: "percent" },
    ];
    const result = await create(
      menu.id,
      block.id,
      planFields("TEMPO_INTENSIVE", "TI_COACH_DEFINED", {
        eligibilityOverrideRuleIds: ["ELIG_TI_ALL_PRE"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
        coachEditsJson: JSON.stringify(coachEdits),
      }),
    );
    expect(result).toMatchObject({ ok: false, kind: "PLAN_INELIGIBLE" });
    if (result.ok || result.kind !== "PLAN_INELIGIBLE") throw new Error("unreachable");
    expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ developerCode: "REFERENCE_UNAVAILABLE", overrideAllowed: false })]));
    expect(await prisma.menuItem.count()).toBe(0);
  });
});

describe("generic new-item plumbing preserves existing LONG FULL overrides", () => {
  it("CIRCA LONG FULL can still use its existing formal RuleSet override", async () => {
    const { menu, block } = await makeMenu({ ageBand: "U18", maturity: "CIRCA", coachAssignedAdvanced: true });
    const result = await create(
      menu.id,
      block.id,
      planFields("LONG_SPRINT_RACE_SPECIFIC", "LSR_SPECIAL_ENDURANCE_I", {
        coachReferenceJson: JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 25 }] }),
        coachEditsJson: JSON.stringify([{ field: "totalReps", value: 1, unit: "reps" }]),
        eligibilityOverrideRuleIds: ["ELIG_LONG_FULL_CIRCA"],
        eligibilityOverrideReason: reason,
        eligibilityOverrideFirstConfirmation: "true",
        eligibilityOverrideSecondConfirmation: "true",
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const saved = await findRunningMenuItem(result.data.id);
    if (saved?.status !== "VALID") throw new Error("item not valid");
    expect(saved.prescription.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ELIGIBILITY_OVERRIDDEN" })]));
    expect(saved.provenance.overrides).toEqual([
      expect.objectContaining({ target: { kind: "ELIGIBILITY", ruleId: "ELIG_LONG_FULL_CIRCA" }, reason, confirmedTwice: true }),
    ]);
  });
});

describe("EVENT_APPROACH coach-entered distance provenance", () => {
  const targetSplit = JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 20, targetTimeS: 3 }] });

  it("approachDistanceM は初回保存・replan・後続変更まで coach-entered source と履歴を保つ", async () => {
    const { menu, block } = await makeMenu({ ageBand: "U18", maturity: "CIRCA", coachAssignedAdvanced: true });
    const created = await create(
      menu.id,
      block.id,
      planFields("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", {
        coachReferenceJson: targetSplit,
        coachEditsJson: JSON.stringify([{ field: "approachDistanceM", value: 30, unit: "m" }]),
      }),
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("unreachable");

    const initial = await findRunningMenuItem(created.data.id);
    if (initial?.status !== "VALID") throw new Error("EVENT_APPROACH item not valid after create");
    expect(initial.prescription.rep).toMatchObject({
      kind: "ATTEMPTS",
      approachDistanceM: { value: 30, unit: "m", source: "COACH_ENTERED" },
    });
    expect(initial.prescription.rationale).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "COACH_MANUAL_INPUT", params: { field: "approachDistanceM" } }),
    ]));
    expect(initial.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "approachDistanceM", to: 30, at: expect.any(String) }),
    ]);

    // Replan through the existing coach-reference edit path without requesting an approach edit.
    const replanned = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, coachReferenceJson: targetSplit }));
    expect(replanned.ok, JSON.stringify(replanned)).toBe(true);
    const afterReplan = await findRunningMenuItem(created.data.id);
    if (afterReplan?.status !== "VALID") throw new Error("EVENT_APPROACH item not valid after replan");
    expect(afterReplan.prescription.rep).toMatchObject({ kind: "ATTEMPTS", approachDistanceM: { value: 30, source: "COACH_ENTERED" } });
    expect(afterReplan.provenance.coachEdits).toHaveLength(1);

    const changed = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "approachDistanceM", value: "35" }));
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    const afterChange = await findRunningMenuItem(created.data.id);
    if (afterChange?.status !== "VALID") throw new Error("EVENT_APPROACH item not valid after edit");
    expect(afterChange.prescription.rep).toMatchObject({ kind: "ATTEMPTS", approachDistanceM: { value: 35, source: "COACH_ENTERED" } });
    expect(afterChange.provenance.coachEdits).toEqual([
      expect.objectContaining({ field: "approachDistanceM", to: 30 }),
      expect.objectContaining({ field: "approachDistanceM", from: 30, to: 35 }),
    ]);

    const sameValue = await editRunningItemAction(menu.id, null, form({ itemId: created.data.id, field: "approachDistanceM", value: "35" }));
    expect(sameValue.ok, JSON.stringify(sameValue)).toBe(true);
    const afterSameValue = await findRunningMenuItem(created.data.id);
    if (afterSameValue?.status !== "VALID") throw new Error("EVENT_APPROACH item not valid after same-value edit");
    expect(afterSameValue.provenance.coachEdits).toHaveLength(2);
    expect(afterSameValue.prescription.rep).toMatchObject({ kind: "ATTEMPTS", approachDistanceM: { value: 35, source: "COACH_ENTERED" } });
  });
});
