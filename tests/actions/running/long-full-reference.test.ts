/**
 * R10-B4A.2 — LONG FULL の Coach reference（TARGET_SPLIT）contract。
 *
 * formal spec: LONG は RACE_PACE / TARGET_SPLIT / SAME_DISTANCE_BEST のいずれかが必要で fallback は無い。
 * GROUP（記録を持たない）に対しては、コーチが目標スプリットを手入力する経路だけが R10 の完了条件を満たす。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { resetDb } from "../../helpers";
import { findRunningMenuItem, saveMenuRunningContext } from "@/infra/repositories/running-item-repository";
import * as loader from "@/domain/running/rules/loader";
import { getRuleSet } from "@/domain/running/rules/loader";
import { rawKeyLeaks } from "../../presentation/running/helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const { planRunningItemAction, editRunningItemAction, overrideRunningItemAction, recalculateWithActiveRuleSetAction } = await import(
  "@/actions/running-actions"
);

const SPLIT_JSON = JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38 }] });

function contextObject() {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "400mグループ",
      members: [
        {
          ageBandOverride: "U18",
          maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: "2026-09-01" },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
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
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

beforeEach(() => vi.stubEnv("RUNNING_V2_UI_ENABLED", "true"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
beforeEach(resetDb);

async function makeMenu() {
  const menu = await prisma.menuTemplate.create({ data: { name: "400m", blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } });
  await saveMenuRunningContext(menu.id, JSON.stringify(contextObject()));
  return { menu, block: menu.blocks[0]! };
}

async function planLongFull(menuId: string, blockId: string, extra: Record<string, string | string[]> = {}) {
  return planRunningItemAction(
    menuId,
    blockId,
    null,
    form({ method: "LONG_SPRINT_RACE_SPECIFIC", templateId: "LSR_SPECIAL_ENDURANCE_I", positionPreference: "", ...extra }),
  );
}

async function saved(itemId: string) {
  const s = await findRunningMenuItem(itemId);
  if (s?.status !== "VALID") throw new Error(`item not valid: ${JSON.stringify(s)}`);
  return s;
}

const EXACT_SEGMENTS = [{ distanceM: 300, targetS: { lower: 38, upper: 38, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } }];

describe("R10-B4A.2: gap の再現（基準が無い LONG FULL）", () => {
  it("LONG FULL 適格の GROUP でも、強度の基準が無ければ PLAN_INELIGIBLE（REFERENCE_UNAVAILABLE）。目標スプリットを入力できる Method であることを結果で示す", async () => {
    const { menu, block } = await makeMenu();
    const result = await planLongFull(menu.id, block.id);
    expect(result).toMatchObject({ ok: false, kind: "PLAN_INELIGIBLE", acceptsCoachTargetSplit: true });
    if (result.ok || result.kind !== "PLAN_INELIGIBLE") throw new Error("unreachable");
    expect(result.reasons.map((r) => r.developerCode)).toEqual(["REFERENCE_UNAVAILABLE"]);
    expect(result.reasons[0]!.message).toBe("この練習には強度の基準（コーチが入力する目標スプリットや、選手の記録など）が必要です。");
    expect(rawKeyLeaks(result.message)).toEqual([]);
    expect(rawKeyLeaks(result.reasons[0]!.message)).toEqual([]);
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("目標スプリットを受け付けない Method では acceptsCoachTargetSplit=false（UI が誤って入力欄を出さない）", async () => {
    const { menu, block } = await makeMenu();
    // TEMPO_INTENSIVE は MEASURED_VMAX / SAME_DISTANCE_BEST のみ（GROUP は記録を持たないので INELIGIBLE）
    const result = await planRunningItemAction(menu.id, block.id, null, form({ method: "TEMPO_INTENSIVE", templateId: "TI_VITTORI_SE", positionPreference: "" }));
    expect(result).toMatchObject({ ok: false, kind: "PLAN_INELIGIBLE", acceptsCoachTargetSplit: false });
  });
});

describe("R10-B4A.2: Coach TARGET_SPLIT で LONG FULL を追加できる", () => {
  it("GROUP + コーチ入力の目標スプリットで保存できる。参照は exact に保存し、GROUP へ自動の目標タイムは作らない", async () => {
    const { menu, block } = await makeMenu();
    const result = await planLongFull(menu.id, block.id, { coachReferenceJson: SPLIT_JSON });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const item = await saved(result.data.id);
    expect(item.prescription.method).toBe("LONG_SPRINT_RACE_SPECIFIC");
    expect(item.prescription.templateId).toBe("LSR_SPECIAL_ENDURANCE_I");
    expect(item.prescription.recoveryStructure).toBe("FULL");
    expect(item.prescription.stopPolicyId).toBe("SP_LSR_FULL");
    // コーチが入力した値をそのまま snapshot（中央値・推定値を作らない）
    expect(item.prescription.intensity.reference).toEqual({ kind: "TARGET_SPLIT", segments: EXACT_SEGMENTS });
    // GROUP では個別の目標タイムを生成しない（reference の保存とは別）
    expect(item.prescription.intensity.target).toBeNull();
    // 実測記録として扱わない
    expect(item.prescription.confidence.inputData).not.toBe("HIGH");
    expect(JSON.stringify(item.prescription.intensity.reference)).not.toMatch(/mark|SAME_DISTANCE_BEST|vmax/i);

    // Provenance: 参照の種類だけを記録し、区間の数値は複製しない
    expect(item.provenance.inputsDigest.referenceKinds).toEqual(["TARGET_SPLIT"]);
    expect(JSON.stringify(item.provenance.inputsDigest)).not.toMatch(/segments|targetS|distanceM/);
    expect(item.provenance.generatedBy.createdByCoach).toBe(true);
    // 二重保存しない（planningControls は positionPreference だけ）
    expect(item.prescription.planningControls).toEqual({ positionPreference: null });
  });

  it("目標スプリットを受け付けない Method に渡したら、参照を無視せず明示的に拒否する", async () => {
    const { menu, block } = await makeMenu();
    const result = await planRunningItemAction(
      menu.id,
      block.id,
      null,
      form({ method: "ACCELERATION", templateId: "ACC_BLOCK_30", positionPreference: "", coachReferenceJson: SPLIT_JSON }),
    );
    expect(result).toMatchObject({ ok: false, kind: "PLAN_BLOCKED" });
    if (result.ok || result.kind !== "PLAN_BLOCKED") throw new Error("unreachable");
    expect(result.findings.some((f) => f.message === "入力した強度の基準は、この練習の型では使えません。")).toBe(true);
    expect(rawKeyLeaks(result.findings.map((f) => f.message).join(" "))).toEqual([]);
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("入力の形式が不正なら保存しない（JSON 不正・0以下・区間なし・余分なキー）", async () => {
    const { menu, block } = await makeMenu();
    for (const raw of [
      "{壊れたJSON",
      JSON.stringify({ kind: "TARGET_SPLIT", segments: [] }),
      JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 0, targetTimeS: 38 }] }),
      JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: -1 }] }),
      JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 38, confidence: "HIGH" }] }),
      JSON.stringify({ kind: "RACE_PACE", event: "400m", targetTimeS: 50 }),
    ]) {
      const result = await planLongFull(menu.id, block.id, { coachReferenceJson: raw });
      expect(result, raw).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
    }
    expect(await prisma.menuItem.count()).toBe(0);
  });
});

describe("R10-B4A.2: 保存済み TARGET_SPLIT の維持と更新", () => {
  async function longFullItem() {
    const { menu, block } = await makeMenu();
    const created = await planLongFull(menu.id, block.id, { coachReferenceJson: SPLIT_JSON });
    if (!created.ok) throw new Error(`plan failed: ${JSON.stringify(created)}`);
    return { menu, block, itemId: created.data.id };
  }

  it("通常の数値編集では、保存済みの目標スプリットを exact に維持する", async () => {
    const { menu, itemId } = await longFullItem();
    const result = await editRunningItemAction(menu.id, null, form({ itemId, field: "repRestS", value: "1200" }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const item = await saved(itemId);
    expect(item.prescription.rest.repRestS.value).toBe(1200);
    expect(item.prescription.intensity.reference).toEqual({ kind: "TARGET_SPLIT", segments: EXACT_SEGMENTS });
  });

  it("目標スプリットだけを更新できる（新しい exact 値で再計画し、EnvelopeField の編集履歴には偽装しない）", async () => {
    const { menu, itemId } = await longFullItem();
    const updated = JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 350, targetTimeS: 45 }] });
    const result = await editRunningItemAction(menu.id, null, form({ itemId, coachReferenceJson: updated }));
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const item = await saved(itemId);
    expect(item.prescription.intensity.reference).toEqual({
      kind: "TARGET_SPLIT",
      segments: [{ distanceM: 350, targetS: { lower: 45, upper: 45, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } }],
    });
    expect(item.provenance.coachEdits).toEqual([]);
    expect(item.provenance.inputsDigest.referenceKinds).toEqual(["TARGET_SPLIT"]);
  });

  it("数値編集と目標スプリットの更新を同時に送れる", async () => {
    const { menu, itemId } = await longFullItem();
    const updated = JSON.stringify({ kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetTimeS: 37 }] });
    const result = await editRunningItemAction(menu.id, null, form({ itemId, field: "repRestS", value: "1100", coachReferenceJson: updated }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const item = await saved(itemId);
    expect(item.prescription.rest.repRestS.value).toBe(1100);
    if (item.prescription.intensity.reference.kind !== "TARGET_SPLIT") throw new Error("unreachable");
    expect(item.prescription.intensity.reference.segments[0]!.targetS).toMatchObject({ lower: 37, upper: 37 });
    expect(item.provenance.coachEdits.map((e) => e.field)).toEqual(["repRestS"]);
  });

  it("項目も目標スプリットも指定しない編集は入力エラー", async () => {
    const { menu, itemId } = await longFullItem();
    expect(await editRunningItemAction(menu.id, null, form({ itemId }))).toMatchObject({ ok: false, kind: "INVALID_INPUT" });
  });

  it("override 後の再計画でも目標スプリットを維持する（override は基準の確認ではない）", async () => {
    const { menu, itemId } = await longFullItem();
    const before = await saved(itemId);
    const result = await overrideRunningItemAction(
      menu.id,
      null,
      form({
        itemId,
        targetKind: "FIELD",
        field: "repRestS",
        layer: "COACH_EDITABLE",
        newValue: String(before.prescription.rest.repRestS.value + 60),
        reason: "当日の回復を長めに取るためのコーチ判断",
        confirmedTwice: "false",
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await saved(itemId)).prescription.intensity.reference).toEqual({ kind: "TARGET_SPLIT", segments: EXACT_SEGMENTS });
  });

  it("現行ルールでの再計算でも、保存済みの目標スプリットを計画入力として再利用する", async () => {
    const { menu, itemId } = await longFullItem();
    const result = await recalculateWithActiveRuleSetAction(menu.id, null, form({ itemId }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await saved(itemId)).prescription.intensity.reference).toEqual({ kind: "TARGET_SPLIT", segments: EXACT_SEGMENTS });
  });

  it("新しい RuleSet が TARGET_SPLIT を許さなくなったら fail closed（別の基準へ黙って変換しない）", async () => {
    const { menu, itemId } = await longFullItem();
    const before = await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } });

    const modified = structuredClone(getRuleSet("rs-2026.09.0")!);
    for (const m of modified.methods) {
      if (m.method === "LONG_SPRINT_RACE_SPECIFIC") {
        m.allowedIntensityReferences = m.allowedIntensityReferences.filter((k) => k !== "TARGET_SPLIT");
      }
    }
    vi.spyOn(loader, "getActiveRuleSet").mockReturnValue({ ruleSet: modified, contentHash: "hash-modified", isDraftFallback: false });

    const result = await recalculateWithActiveRuleSetAction(menu.id, null, form({ itemId }));
    expect(result).toMatchObject({ ok: false, kind: "PLAN_BLOCKED" });
    if (result.ok || result.kind !== "PLAN_BLOCKED") throw new Error("unreachable");
    expect(result.findings.some((f) => f.message === "入力した強度の基準は、この練習の型では使えません。")).toBe(true);
    // 保存済みの内容は書き換わっていない
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } })).prescriptionJson).toBe(before.prescriptionJson);
  });
});

describe("R10-B4A.2: R10 完了条件の4種をコーチ操作から保存できる", () => {
  it("ACC / MV / STRIDE / LONG FULL（目標スプリット付き）", async () => {
    const { menu, block } = await makeMenu();
    const cases: { name: string; fields: Record<string, string> }[] = [
      { name: "ACC", fields: { method: "ACCELERATION", templateId: "ACC_BLOCK_30", positionPreference: "" } },
      { name: "MV", fields: { method: "MAX_VELOCITY", templateId: "MV_FLY20", positionPreference: "" } },
      { name: "STRIDE", fields: { method: "STRIDE", templateId: "ST_RELAXED", positionPreference: "" } },
      {
        name: "LONG FULL",
        fields: { method: "LONG_SPRINT_RACE_SPECIFIC", templateId: "LSR_SPECIAL_ENDURANCE_I", positionPreference: "", coachReferenceJson: SPLIT_JSON },
      },
    ];
    const savedMethods: string[] = [];
    for (const c of cases) {
      const result = await planRunningItemAction(menu.id, block.id, null, form(c.fields));
      expect(result.ok, `${c.name}: ${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      savedMethods.push((await saved(result.data.id)).prescription.method);
    }
    expect(savedMethods).toEqual(["ACCELERATION", "MAX_VELOCITY", "STRIDE", "LONG_SPRINT_RACE_SPECIFIC"]);
    expect(await prisma.menuItem.count({ where: { prescriptionKind: "RUNNING_V2" } })).toBe(4);
  });
});
