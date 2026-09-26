import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [R12-A2.1] planner へ渡された PlanRequest を直接観測するための spy。
 * A2 は AI 専用の権限・条件を一切足していないこと（actor / readiness / coachEdits / overrides /
 * coachReference / confirmedFindingCodes）を、生成物ではなく入力そのもので確認する。
 */
const plannerRequests = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/domain/running/planning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/running/planning")>();
  return {
    ...actual,
    planRunningPrescriptionWithRuleSet: (request: unknown, resolved: unknown) => {
      plannerRequests.push(request as Record<string, unknown>);
      return (actual.planRunningPrescriptionWithRuleSet as (a: unknown, b: unknown) => unknown)(request, resolved);
    },
  };
});

/** [R12-A2.1] PREVIEW_DB_WRITES = 0 を row 比較ではなく write verb の call count で直接確認する。 */
const dbOps = vi.hoisted(() => [] as string[]);
const WRITE_ACTIONS = vi.hoisted(
  () =>
    new Set([
      "create",
      "createMany",
      "createManyAndReturn",
      "update",
      "updateMany",
      "updateManyAndReturn",
      "delete",
      "deleteMany",
      "upsert",
      "executeRaw",
      "executeRawUnsafe",
    ]),
);
vi.mock("@/infra/db/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/infra/db/prisma")>();
  const real = actual.prisma as unknown as Record<string, unknown>;
  const wrapDelegate = (name: string, delegate: unknown) =>
    new Proxy(delegate as object, {
      get(target, prop) {
        const fn = Reflect.get(target, prop);
        if (typeof fn === "function") {
          return (...args: unknown[]) => {
            if (typeof prop === "string") dbOps.push(WRITE_ACTIONS.has(prop) ? `WRITE:${name}.${prop}` : `${name}.${prop}`);
            return (fn as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return fn;
      },
    });
  const proxy = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === "string" && !prop.startsWith("$") && !prop.startsWith("_") && value !== null && typeof value === "object") {
        return wrapDelegate(prop, value);
      }
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      return value;
    },
  });
  return { ...actual, prisma: proxy };
});

import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { buildMenuPlannerPreview, type BuildMenuPlannerPreviewInput } from "@/application/menu-planner/preview";
import { makeExercise as makeExerciseBase, resetDb } from "../helpers";

const makeExercise = (overrides: Parameters<typeof makeExerciseBase>[0] = {}) =>
  makeExerciseBase({ category: "WARM_UP", ...overrides });

function runningContext(availableMinutes = 90) {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "短距離ブロック",
      members: [
        {
          ageBandOverride: "U18",
          maturity: {
            status: "POST",
            confidence: "HIGH",
            method: "COACH_OBSERVATION",
            assessedAt: "2026-09-01",
          },
          trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
          primaryEvent: "400m",
        },
      ],
      allowAdvancedMethods: true,
    },
    plannedDate: "2026-09-20",
    plannedAt: "2026-09-20T16:00:00+09:00",
    availableMinutes,
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  const { requestText, ...constraintOverrides } = overrides;
  return {
    schemaVersion: 1,
    requestText: typeof requestText === "string" ? requestText : "短距離の練習メニューを作成",
    constraints: {
      phase: "PREPARATION",
      targetEvents: [],
      purposes: [],
      availableMinutes: null,
      equipment: null,
      preferredExerciseIds: [],
      excludedExerciseIds: [],
      ...constraintOverrides,
    },
  };
}

function exerciseProposal(exerciseId: string, blockName = "ドリル", reason = "動作の質を整えるため") {
  return {
    kind: "EXERCISE" as const,
    proposal: { blockName, exerciseId, reason },
  };
}

function runningProposal(
  blockName = "主運動",
  templateId = "ACC_BLOCK_20",
  reason = "加速の質を確認するため",
) {
  return {
    kind: "RUNNING" as const,
    proposal: {
      blockName,
      method: "ACCELERATION" as const,
      templateId,
      positionPreference: null,
      reason,
    },
  };
}

function proposal(items: readonly unknown[]) {
  return { schemaVersion: 1, items: [...items], question: null };
}

async function createContextMenu(sourceExerciseId: string, availableMinutes = 90) {
  return prisma.menuTemplate.create({
    data: {
      ownerId: DEFAULT_OWNER_ID,
      name: "参照メニュー",
      phase: "PREPARATION",
      status: "DRAFT",
      runningContextJson: JSON.stringify(runningContext(availableMinutes)),
      blocks: {
        create: {
          name: "既存ブロック",
          sortOrder: 0,
          items: {
            create: {
              exerciseId: sourceExerciseId,
              displayName: "既存の表示名",
              sortOrder: 0,
              sets: 2,
              distanceMeters: 20,
              note: "source stays unchanged",
            },
          },
        },
      },
    },
    include: { blocks: { include: { items: true } } },
  });
}

async function build(menuId: string, rawProposal: unknown, overrides: Record<string, unknown> = {}) {
  const input: BuildMenuPlannerPreviewInput = {
    schemaVersion: 1,
    ownerId: DEFAULT_OWNER_ID,
    contextMenuTemplateId: menuId,
    menuName: "  コーチ作成メニュー  ",
    intent: intent(overrides) as BuildMenuPlannerPreviewInput["intent"],
    proposal: rawProposal,
  };
  return buildMenuPlannerPreview(input);
}

beforeEach(resetDb);

describe("R12-A2 deterministic MenuPlannerPreview application", () => {
  it("materializes a reviewed Exercise through the existing deterministic prescription", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const exercise = await makeExercise({ name: "権威カタログのドリル", defaultDistanceMeters: 30 });
    const menu = await createContextMenu(sourceExercise.id);

    const result = await build(menu.id, proposal([exerciseProposal(exercise.id)]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const item = result.preview.blocks[0]!.items[0]!;
    expect(result.preview.menuName).toBe("コーチ作成メニュー");
    expect(result.preview.statusOnSave).toBe("DRAFT");
    expect(item.selection).toEqual({ kind: "EXERCISE", exerciseId: exercise.id });
    expect(item.title).toBe("権威カタログのドリル");
    expect(item.state).toBe("READY");
    expect(item.dose?.kind).toBe("LEGACY");
    if (item.dose?.kind !== "LEGACY") throw new Error("legacy dose expected");
    expect(item.dose.prescription.distanceMeters).toBe(30);
    expect(item.engineRationale.length).toBeGreaterThan(0);
    expect(item.aiReason).toBe("動作の質を整えるため");
    expect(result.preview.aggregation.status).toBe("EVALUATED");
    expect(result.preview.canSave).toBe(true);
  });

  it("uses the Running v2 planner and keeps AI actor restrictions server-side", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    const result = await build(menu.id, proposal([runningProposal()]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const item = result.preview.blocks[0]!.items[0]!;
    expect(item.selection).toEqual({ kind: "RUNNING", method: "ACCELERATION", templateId: "ACC_BLOCK_20" });
    expect(item.state).toBe("READY");
    expect(item.dose?.kind).toBe("RUNNING_V2");
    expect(item.engineRationale.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.preview)).not.toContain("coachEdits");
    expect(JSON.stringify(result.preview)).not.toContain("confirmedFindingCodes");
    expect(JSON.stringify(result.preview)).not.toContain("acceptedByCoachAt");
    expect(result.preview.ruleSet.status).toBe("ACTIVE");
  });

  it("preserves ordered mixed items and creates contiguous block groups", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const firstExercise = await makeExercise({ name: "最初のドリル" });
    const secondExercise = await makeExercise({ name: "最後のドリル" });
    const menu = await createContextMenu(sourceExercise.id);

    const result = await build(menu.id, proposal([
      exerciseProposal(firstExercise.id, "準備"),
      runningProposal("主運動"),
      exerciseProposal(secondExercise.id, "整理"),
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.preview.blocks.map((block) => block.title)).toEqual(["準備", "主運動", "整理"]);
    expect(result.preview.blocks.flatMap((block) => block.items.map((item) => item.title))).toEqual([
      "最初のドリル",
      expect.any(String),
      "最後のドリル",
    ]);
    expect(result.preview.blocks.flatMap((block) => block.items.map((item) => item.selection.kind))).toEqual([
      "EXERCISE",
      "RUNNING",
      "EXERCISE",
    ]);
    expect(new Set(result.preview.blocks.flatMap((block) => block.items.map((item) => item.itemKey))).size).toBe(3);
    expect(result.preview.aggregation.status).toBe("EVALUATED");
  });

  it("rejects excluded and Running-classified Exercise selections", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const excluded = await makeExercise({ name: "除外種目" });
    const runningClassified = await makeExercise({ name: "走種目", category: "SPRINT" });
    const menu = await createContextMenu(sourceExercise.id);

    const excludedResult = await build(menu.id, proposal([exerciseProposal(excluded.id)]), {
      excludedExerciseIds: [excluded.id],
    });
    expect(excludedResult.ok).toBe(true);
    if (!excludedResult.ok) throw new Error(JSON.stringify(excludedResult));
    expect(excludedResult.preview.blocks[0]!.items[0]!.state).toBe("REJECTED");
    expect(excludedResult.preview.canSave).toBe(false);

    const runningResult = await build(menu.id, proposal([exerciseProposal(runningClassified.id)]));
    expect(runningResult.ok).toBe(true);
    if (!runningResult.ok) throw new Error(JSON.stringify(runningResult));
    expect(runningResult.preview.blocks[0]!.items[0]!.state).toBe("REJECTED");
    expect(runningResult.preview.canSave).toBe(false);
  });

  it("does not let request text, block names, or AI reasons become prescription numbers", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const exercise = await makeExercise({ name: "決定論的ドリル", defaultDistanceMeters: 30 });
    const menu = await createContextMenu(sourceExercise.id);
    const numericReason = exerciseProposal(exercise.id, "主運動 100m", "100m、5本、90%、rest 5min");

    const numericTextResult = await build(
      menu.id,
      proposal([numericReason]),
      { requestText: "100mを5本、90%、rest 5minで作って" },
    );
    expect(numericTextResult.ok).toBe(true);
    if (!numericTextResult.ok) throw new Error(JSON.stringify(numericTextResult));
    const item = numericTextResult.preview.blocks[0]!.items[0]!;
    expect(item.dose?.kind).toBe("LEGACY");
    if (item.dose?.kind !== "LEGACY") throw new Error("legacy dose expected");
    expect(item.dose.prescription.distanceMeters).toBe(30);
    expect(item.aiReason).toBeNull();

    const unknownNumericField = {
      schemaVersion: 1,
      items: [{ ...exerciseProposal(exercise.id), proposal: { ...exerciseProposal(exercise.id).proposal, distanceMeters: 100 } }],
      question: null,
    };
    const invalid = await build(menu.id, unknownNumericField);
    expect(invalid).toEqual({
      ok: false,
      error: { kind: "AI_OUTPUT_INVALID", code: "PROPOSAL_SCHEMA_INVALID", message: "AI提案の形式を確認できません。" },
    });
  });

  it("proves preview execution does not mutate the source menu or menu rows", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const exercise = await makeExercise({ name: "プレビュー種目" });
    const menu = await createContextMenu(sourceExercise.id);
    const before = await prisma.menuTemplate.findUnique({
      where: { id: menu.id },
      include: { blocks: { include: { items: true } } },
    });
    const beforeCounts = await Promise.all([
      prisma.menuTemplate.count(),
      prisma.menuBlock.count(),
      prisma.menuItem.count(),
      prisma.exercise.count(),
    ]);

    const result = await build(menu.id, proposal([exerciseProposal(exercise.id), runningProposal("主運動")]));
    expect(result.ok).toBe(true);

    const after = await prisma.menuTemplate.findUnique({
      where: { id: menu.id },
      include: { blocks: { include: { items: true } } },
    });
    const afterCounts = await Promise.all([
      prisma.menuTemplate.count(),
      prisma.menuBlock.count(),
      prisma.menuItem.count(),
      prisma.exercise.count(),
    ]);
    expect(afterCounts).toEqual(beforeCounts);
    expect(after).toEqual(before);
  });

  it("fails closed for an owner mismatch and an archived context source", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const exercise = await makeExercise({ name: "カタログ種目" });
    const otherOwnerExercise = await prisma.exercise.create({
      data: { ownerId: "another-owner", name: "別owner種目", category: "DRILL", metricType: "DISTANCE", status: "REVIEWED" },
    });
    const menu = await createContextMenu(sourceExercise.id);

    const wrongExerciseOwner = await build(menu.id, proposal([exerciseProposal(otherOwnerExercise.id)]));
    expect(wrongExerciseOwner).toEqual({
      ok: false,
      error: { kind: "AI_OUTPUT_INVALID", code: "PROPOSAL_CATALOG_INVALID", message: "AI提案に現在のカタログにない選択が含まれています。" },
    });

    const invalidOwnerInput = await buildMenuPlannerPreview({
      schemaVersion: 1,
      ownerId: "another-owner",
      contextMenuTemplateId: menu.id,
      menuName: "menu",
      intent: intent() as BuildMenuPlannerPreviewInput["intent"],
      proposal: proposal([exerciseProposal(exercise.id)]),
    });
    expect(invalidOwnerInput).toEqual({
      ok: false,
      error: { kind: "PLANNING_REJECTED", code: "CONTEXT_MENU_UNAVAILABLE", message: "計画の参照メニューを確認できません。" },
    });

    await prisma.menuTemplate.update({ where: { id: menu.id }, data: { status: "ARCHIVED" } });
    const archived = await build(menu.id, proposal([exerciseProposal(exercise.id)]));
    expect(archived).toEqual({
      ok: false,
      error: { kind: "PLANNING_REJECTED", code: "CONTEXT_MENU_UNAVAILABLE", message: "計画の参照メニューを確認できません。" },
    });
  });
});

// ---------------------------------------------------------------------------
// [R12-A2.1] B1: multi-item planning の order-independence
// ---------------------------------------------------------------------------

function runningItem(method: string, templateId: string, blockName = "主運動") {
  return {
    kind: "RUNNING" as const,
    proposal: { blockName, method, templateId, positionPreference: null, reason: "狙いを満たすため" },
  };
}

function permute<T>(arr: readonly T[]): T[][] {
  if (arr.length <= 1) return [[...arr]];
  const out: T[][] = [];
  for (let index = 0; index < arr.length; index += 1) {
    const rest = [...arr.slice(0, index), ...arr.slice(index + 1)];
    for (const tail of permute(rest)) out.push([arr[index]!, ...tail]);
  }
  return out;
}

/** proposal の並び順に依存しない「選択 → state」の写像。 */
function selectionStates(result: Awaited<ReturnType<typeof build>>): Record<string, string> {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const map: Record<string, string> = {};
  for (const block of result.preview.blocks) {
    for (const item of block.items) {
      const key =
        item.selection.kind === "RUNNING"
          ? `RUNNING:${item.selection.method}:${item.selection.templateId}`
          : `EXERCISE:${item.selection.exerciseId}`;
      map[key] = item.state;
    }
  }
  return map;
}

describe("R12-A2.1 multi-item order-independence", () => {
  it("ACCELERATION 3件は 6 順列すべてで selection ごとの state が一致する（availableMinutes=30）", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id, 30);
    const items = [
      runningItem("ACCELERATION", "ACC_BLOCK_20"),
      runningItem("ACCELERATION", "ACC_BLOCK_30"),
      runningItem("ACCELERATION", "ACC_BLOCK_40"),
    ];

    const permutations = permute(items);
    expect(permutations).toHaveLength(6);

    const results: Record<string, string>[] = [];
    for (const permutation of permutations) {
      const result = await build(menu.id, proposal(permutation));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      results.push(selectionStates(result));
    }

    // 同一 item 集合 → 同一 per-selection state（並び順は presentation order として保持される）。
    for (const map of results) expect(map).toEqual(results[0]);
    // 3件で合計が上限を超える場合、後方の 1 件だけを落とすのではなく全件が同じ判定になる。
    expect(Object.values(results[0]!).every((state) => state === results[0]![Object.keys(results[0]!)[0]!])).toBe(true);
  });

  it("ACCELERATION 4件は 24 順列すべてで selection ごとの state が一致する", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id, 30);
    const items = [
      runningItem("ACCELERATION", "ACC_BLOCK_20"),
      runningItem("ACCELERATION", "ACC_BLOCK_30"),
      runningItem("ACCELERATION", "ACC_BLOCK_40"),
      runningItem("ACCELERATION", "ACC_CROUCH_20"),
    ];

    const permutations = permute(items);
    expect(permutations).toHaveLength(24);

    let baseline: Record<string, string> | null = null;
    for (const permutation of permutations) {
      const result = await build(menu.id, proposal(permutation));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const map = selectionStates(result);
      baseline ??= map;
      expect(map).toEqual(baseline);
      expect(result.preview.blocks.flatMap((block) => block.items)).toHaveLength(4);
    }
  });

  it("収まるメニューは並び順に関わらず全件 READY のまま saveable である", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id, 300);
    const items = [
      runningItem("STRIDE", "ST_RELAXED", "流し"),
      runningItem("STRIDE", "ST_BETWEEN_SETS", "流し"),
      runningItem("STRIDE", "ST_WARMUP", "流し"),
    ];

    for (const permutation of permute(items)) {
      const result = await build(menu.id, proposal(permutation));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      expect(selectionStates(result)).toEqual({
        "RUNNING:STRIDE:ST_RELAXED": "READY",
        "RUNNING:STRIDE:ST_BETWEEN_SETS": "READY",
        "RUNNING:STRIDE:ST_WARMUP": "READY",
      });
      expect(result.preview.canSave).toBe(true);
    }
  });

  it("RUNNING/EXERCISE 混在でも item state とメニュー集計が並び順に依存しない", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const drill = await makeExercise({ name: "混在ドリル", defaultDistanceMeters: 40 });
    const menu = await createContextMenu(sourceExercise.id, 60);
    // blockName は A1 契約上「閉じたブロックは再出現できない」ため全 item で揃える
    // （並べ替えの検証対象は item 順であって block 構成ではない）。
    const items = [
      exerciseProposal(drill.id, "主運動"),
      runningItem("ACCELERATION", "ACC_BLOCK_20"),
      runningItem("TEMPO_EXTENSIVE", "TE_300"),
    ];

    /** 集計の「意味」だけを比較する（内部配列の並びは digest 側が拘束する。ここでは順序を正規化する）。 */
    function aggregationSemantics(result: Awaited<ReturnType<typeof build>>) {
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const aggregation = result.preview.aggregation;
      if (aggregation.status !== "EVALUATED") return { status: aggregation.status };
      return {
        status: aggregation.status,
        totals: Object.fromEntries(aggregation.totals.map((total) => [total.label, total.valueLabel])),
        findingCodes: aggregation.findings.map((finding) => finding.developerCode).sort(),
        severities: aggregation.findings.flatMap((finding) => finding.severitiesInternal).sort(),
      };
    }

    const summaries: string[] = [];
    for (const permutation of permute(items)) {
      const result = await build(menu.id, proposal(permutation));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      summaries.push(
        JSON.stringify({
          // key の挿入順（= proposal order）を落として、選択と state の対応だけを比較する。
          states: Object.fromEntries(Object.entries(selectionStates(result)).sort()),
          aggregation: aggregationSemantics(result),
          canSave: result.preview.canSave,
        }),
      );
      // item の並び順は proposal order のまま保持される。
      expect(result.preview.blocks.flatMap((block) => block.items)).toHaveLength(3);
    }
    expect(new Set(summaries).size).toBe(1);
  });

  it("proposal の並び替えでは materializationDigest は変わり contextFingerprint は変わらない", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id, 300);
    const forward = await build(menu.id, proposal([
      runningItem("STRIDE", "ST_RELAXED", "流し"),
      runningItem("STRIDE", "ST_WARMUP", "流し"),
    ]));
    const reverse = await build(menu.id, proposal([
      runningItem("STRIDE", "ST_WARMUP", "流し"),
      runningItem("STRIDE", "ST_RELAXED", "流し"),
    ]));
    expect(forward.ok && reverse.ok).toBe(true);
    if (!forward.ok || !reverse.ok) throw new Error("preview failed");
    expect(forward.preview.binding.contextFingerprint).toBe(reverse.preview.binding.contextFingerprint);
    expect(forward.preview.binding.materializationDigest).not.toBe(reverse.preview.binding.materializationDigest);
  });
});

// ---------------------------------------------------------------------------
// [R12-A2.1] engine contract の直接検証（B2 / missing tests）
// ---------------------------------------------------------------------------

describe("R12-A2.1 engine contract", () => {
  it("AI_PLANNER の PlanRequest は AI 専用に緩められていない（spy で入力そのものを確認）", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    plannerRequests.length = 0;
    const result = await build(menu.id, proposal([
      runningItem("ACCELERATION", "ACC_BLOCK_20"),
      runningItem("TEMPO_EXTENSIVE", "TE_300"),
    ]));
    expect(result.ok).toBe(true);
    // candidate pass と final pass で 2 回ずつ = 4 回。
    expect(plannerRequests.length).toBe(4);

    for (const request of plannerRequests) {
      expect((request.actor as { kind: string }).kind).toBe("AI_PLANNER");
      expect(request.readiness).toBeNull();
      expect(request.coachEdits).toEqual([]);
      expect(request.overrides).toEqual([]);
      expect(request.coachReference).toBeNull();
      expect(request.confirmedFindingCodes).toEqual([]);
      // AI は自分自身を otherItems に含めない（二重計上しない）。
      const selection = request.selection as { method: string; templateId: string };
      const otherItems = (request.menuContext as { otherItems: { kind: string; prescription?: { method: string; templateId: string } }[] }).otherItems;
      expect(otherItems.some((other) => other.kind === "RUNNING_V2" && other.prescription?.templateId === selection.templateId)).toBe(false);
    }

    // final pass（後半 2 件）は他方の candidate を otherItems に含む＝prefix 依存ではない。
    const finalPass = plannerRequests.slice(2);
    expect(finalPass).toHaveLength(2);
    for (const request of finalPass) {
      const otherItems = (request.menuContext as { otherItems: { kind: string }[] }).otherItems;
      expect(otherItems.some((other) => other.kind === "RUNNING_V2")).toBe(true);
    }
  });

  it("BLOCK_AUTOGEN は READY にならず canSave も false のまま（ACC_BLOCK_10）", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    const result = await build(menu.id, proposal([runningItem("ACCELERATION", "ACC_BLOCK_10")]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const item = result.preview.blocks[0]!.items[0]!;
    expect(item.state).not.toBe("READY");
    expect(item.state).toBe("REJECTED");
    expect(result.preview.canSave).toBe(false);
    const blocking = item.findings.filter((f) =>
      f.severitiesInternal.some((severity) => severity === "BLOCK_AUTOGEN"),
    );
    expect(blocking.map((f) => f.developerCode)).toContain("ENVELOPE_INFEASIBLE");
  });

  it("INELIGIBLE の理由が engine の意味のまま Preview に残る（SES_80 / AS_TOWING）", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    const ses80 = await build(menu.id, proposal([runningItem("SPRINT_ENDURANCE_SHORT", "SES_80")]));
    expect(ses80.ok).toBe(true);
    if (!ses80.ok) throw new Error(JSON.stringify(ses80.error));
    const sesItem = ses80.preview.blocks[0]!.items[0]!;
    expect(sesItem.state).toBe("REJECTED");
    expect(ses80.preview.canSave).toBe(false);
    expect(sesItem.eligibilityReasons.map((reason) => reason.developerCode)).toContain(
      "LOW_CONFIDENCE_HIGH_METABOLIC_AUTOGEN_BLOCKED",
    );
    // Coach が読める説明が付いている（コードだけで終わらせない）。
    for (const reason of sesItem.eligibilityReasons) expect(reason.message.length).toBeGreaterThan(0);
    // engine の overrideAllowed をそのまま写す（code から推測しない）。
    expect(sesItem.eligibilityReasons[0]!.overrideAllowed).toBe(false);

    const asTowing = await build(menu.id, proposal([runningItem("ASSISTED_SPRINT", "AS_TOWING")]));
    expect(asTowing.ok).toBe(true);
    if (!asTowing.ok) throw new Error(JSON.stringify(asTowing.error));
    const asItem = asTowing.preview.blocks[0]!.items[0]!;
    expect(asItem.state).toBe("REJECTED");
    const conditionReason = asItem.eligibilityReasons.find(
      (reason) => reason.developerCode === "ELIGIBILITY_CONDITIONS_UNMET",
    );
    expect(conditionReason).toBeDefined();
    // ruleId も engine の値を保持する（表示層で作り直さない）。
    expect(conditionReason!.ruleIdInternal).toBe("ELIG_ASSISTED_ALL_POST");
  });

  it("substitutes / confirmationRequired は engine の契約どおりに運ばれる", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    const result = await build(menu.id, proposal([
      runningItem("SPRINT_ENDURANCE_SHORT", "SES_80"),
      runningItem("ASSISTED_SPRINT", "AS_TOWING"),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    for (const item of result.preview.blocks.flatMap((block) => block.items)) {
      // A1 の凍結契約で readiness = null（事前計画）。readiness 判断由来の substitute は
      // そもそも生成されないため、この経路では substitutes は空配列になる（捏造しない）。
      expect(item.substitutes).toEqual([]);
      // 確認要求はエンジンが要求したときだけ載る。AI の承認として扱わない（空なら空のまま）。
      expect(item.confirmationRequiredCodes).toEqual([]);
    }
  });

  it("Load history が planner へ渡り、変更が Preview に反映される", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    plannerRequests.length = 0;
    const before = await build(menu.id, proposal([runningItem("ACCELERATION", "ACC_BLOCK_20")]));
    expect(before.ok).toBe(true);
    const historyBefore = (plannerRequests[0]!.history ?? null) as { events: unknown[] } | null;

    const session = await prisma.trainingSession.create({
      data: { ownerId: DEFAULT_OWNER_ID, date: new Date("2026-09-18T10:00:00.000Z"), title: "直前練習", status: "COMPLETED" },
    });
    await prisma.sessionItem.create({
      data: {
        trainingSessionId: session.id,
        exerciseNameSnapshot: "加速走",
        blockNameSnapshot: "主運動",
        sortOrder: 0,
        prescriptionKind: "LEGACY",
        done: true,
        plannedSets: 5,
        plannedDistanceMeters: 30,
        plannedRestSeconds: 300,
      },
    });

    plannerRequests.length = 0;
    const after = await build(menu.id, proposal([runningItem("ACCELERATION", "ACC_BLOCK_20")]));
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error("preview failed");
    const historyAfter = (plannerRequests[0]!.history ?? null) as { events: unknown[] } | null;

    // 単に fingerprint が変わるだけでなく、planner の入力そのものに履歴が入る。
    expect(historyAfter).not.toBeNull();
    expect((historyAfter?.events.length ?? 0) > (historyBefore?.events.length ?? 0)).toBe(true);
    expect(after.preview.binding.contextFingerprint).not.toBe(before.preview.binding.contextFingerprint);
  });

  it("aggregation は totals / findings / acceptance に実際に効く", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const tightMenu = await createContextMenu(sourceExercise.id, 30);
    const wideMenu = await createContextMenu(sourceExercise.id, 300);

    const tight = await build(tightMenu.id, proposal([
      runningItem("ACCELERATION", "ACC_BLOCK_20"),
      runningItem("ACCELERATION", "ACC_BLOCK_30"),
      runningItem("ACCELERATION", "ACC_BLOCK_40"),
    ]));
    expect(tight.ok).toBe(true);
    if (!tight.ok) throw new Error(JSON.stringify(tight.error));
    expect(tight.preview.aggregation.status).toBe("EVALUATED");
    // 合計が上限を超える 3 件では、engine が session 集計で全 item の自動作成を止める。
    // その AGG_* は menu 集計 DTO ではなく **各 item の Finding** に載る（READY な item が 0 件のため
    // menu 集計は空になる）。判定は並び順に依存しない。
    for (const item of tight.preview.blocks.flatMap((block) => block.items)) {
      expect(item.state).toBe("REJECTED");
      expect(item.findings.some((f) => f.developerCode.startsWith("AGG_"))).toBe(true);
      expect(
        item.findings.some((f) => f.severitiesInternal.some((severity) => severity === "BLOCK_AUTOGEN")),
      ).toBe(true);
    }
    expect(tight.preview.canSave).toBe(false);

    const wide = await build(wideMenu.id, proposal([
      runningItem("STRIDE", "ST_RELAXED", "流し"),
      runningItem("STRIDE", "ST_WARMUP", "流し"),
    ]));
    expect(wide.ok).toBe(true);
    if (!wide.ok) throw new Error(JSON.stringify(wide.error));
    if (wide.preview.aggregation.status !== "EVALUATED") throw new Error("aggregation not evaluated");
    const flowTotal = wide.preview.aggregation.totals.find((total) => total.label === "流しの距離");
    expect(flowTotal).toBeDefined();
    expect(flowTotal!.valueLabel).not.toBe("0m");
    // 上限内なので自動作成を止める severity は付かない（WARN の注記までは許容する）。
    expect(
      wide.preview.aggregation.findings.filter((f) =>
        f.severitiesInternal.some((severity) => severity === "BLOCK" || severity === "BLOCK_AUTOGEN"),
      ),
    ).toEqual([]);
    expect(wide.preview.canSave).toBe(true);
    expect(wide.preview.blocks.flatMap((block) => block.items).map((i) => i.state)).toEqual(["READY", "READY"]);
  });

  it("status != REVIEWED の Exercise は application entry で拒否される", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);

    for (const status of ["DRAFT", "ARCHIVED"]) {
      const rejected = await prisma.exercise.create({
        data: {
          ownerId: DEFAULT_OWNER_ID,
          name: `未レビュー-${status}`,
          category: "DRILL",
          metricType: "DISTANCE",
          status,
          defaultDistanceMeters: 30,
        },
      });
      const result = await build(menu.id, proposal([exerciseProposal(rejected.id)]));
      expect(result).toEqual({
        ok: false,
        error: {
          kind: "AI_OUTPUT_INVALID",
          code: "PROPOSAL_CATALOG_INVALID",
          message: "AI提案に現在のカタログにない選択が含まれています。",
        },
      });
    }
  });

  it("器具が未確定な Exercise は MANUAL_INPUT_REQUIRED になり save できない", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const menu = await createContextMenu(sourceExercise.id);
    // 器具タグを持たない Exercise + 「登録済みの器具は無い」という明示制約。
    // 「器具不要」と推定せず、コーチの確認を要求する。
    const noEquipmentTag = await makeExercise({ name: "器具タグなし種目", defaultDistanceMeters: 30 });

    const result = await build(menu.id, proposal([exerciseProposal(noEquipmentTag.id)]), {
      equipment: { availableTagIds: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const item = result.preview.blocks[0]!.items[0]!;
    expect(item.state).toBe("MANUAL_INPUT_REQUIRED");
    expect(item.findings.map((f) => f.developerCode)).toContain("EQUIPMENT_CONSTRAINT_UNDETERMINED");
    expect(result.preview.canSave).toBe(false);
  });

  it("preview 実行中に write verb が 1 度も呼ばれない（row 比較ではなく call count）", async () => {
    const sourceExercise = await makeExercise({ name: "参照用種目" });
    const drill = await makeExercise({ name: "書込ゼロ用ドリル", defaultDistanceMeters: 30 });
    const menu = await createContextMenu(sourceExercise.id);

    dbOps.length = 0;
    const result = await build(menu.id, proposal([
      exerciseProposal(drill.id),
      runningItem("ACCELERATION", "ACC_BLOCK_20"),
      runningItem("STRIDE", "ST_RELAXED", "整理"),
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));

    expect(dbOps.length).toBeGreaterThan(0);
    expect(dbOps.filter((op) => op.startsWith("WRITE:"))).toEqual([]);
    // MenuTemplate / MenuBlock / MenuItem / Exercise への書込みが無いことを delegate 名でも確認する。
    expect(dbOps.filter((op) => /WRITE:(menuTemplate|menuBlock|menuItem|exercise)\./.test(op))).toEqual([]);
  });
});
