/**
 * [R12 unified composer] 統合メニュー Composer の保存 / 保存前 dry-run（実 DB・実 Running Engine）。
 *
 * 固定すること:
 *   - AI 生成（inline context source）の時点では MenuTemplate を作らない。
 *   - 保存時、メニュー名はコーチが入力した名前になる（token の生成時名称ではない）。
 *   - 順序・削除・差し替え・追加・notes・RUNNING_V2 の処方調整が 1 transaction で保存される。
 *   - RUNNING_V2 の調整は既存 running edit Action の検証（hard safety 等）を通る。bypass できない。
 *   - dry-run は何も残さない。どの段階で失敗しても partial menu は残らない。
 *   - inline context の差し替え（改ざん）は署名済み fingerprint と一致せず STALE で拒否される。
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { issueMenuPlannerSignedPreview } from "@/application/menu-planner/accept";
import { MENU_PLANNER_INLINE_CONTEXT_SOURCE_ID } from "@/domain/menu-planner";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import { prisma } from "@/infra/db/prisma";
import { findMenu } from "@/infra/repositories/menu-repository";
import { commitComposedMenu, dryRunComposedMenu, type ComposerDraftInput } from "@/actions/_menu-composer-service";
import { makeExercise, resetDb } from "../helpers";

const KEY = "composer-test-signing-key-0123456789-abcdef";

function runningContext(label = "短距離ブロック") {
  return {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label,
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
    availableMinutes: 180,
  };
}

const CONTEXT_JSON = JSON.stringify(runningContext());

function intent() {
  return {
    schemaVersion: 1,
    requestText: "最大速度を中心に。最後に補強を少し。",
    constraints: { phase: null, targetEvents: [], purposes: [], availableMinutes: null, equipment: null, preferredExerciseIds: [], excludedExerciseIds: [] },
  };
}

function proposal(warmUpId: string, strengthId: string) {
  return {
    schemaVersion: 1,
    items: [
      { kind: "EXERCISE", proposal: { blockName: "ウォームアップ", exerciseId: warmUpId, reason: "動作を整えるため" } },
      { kind: "EXERCISE", proposal: { blockName: "ウォームアップ", exerciseId: strengthId, reason: "姿勢を整えるため" } },
      {
        kind: "RUNNING",
        proposal: { blockName: "主運動", method: "ACCELERATION", templateId: "ACC_BLOCK_20", positionPreference: null, reason: "加速の質を確認するため" },
      },
    ],
    question: null,
  };
}

async function setup() {
  const warmUp = await makeExercise({ name: "Aスキップ", category: "WARM_UP" });
  const strength = await makeExercise({ name: "プランク", category: "WARM_UP" });
  const replacement = await makeExercise({ name: "ミニハードル走", category: "WARM_UP" });
  const added = await makeExercise({ name: "腹筋", category: "WARM_UP" });
  const issued = await issueMenuPlannerSignedPreview(
    {
      ownerId: DEFAULT_OWNER_ID,
      contextMenuTemplateId: MENU_PLANNER_INLINE_CONTEXT_SOURCE_ID,
      inlineRunningContextJson: CONTEXT_JSON,
      menuName: "AIが付けた名前",
      intent: intent(),
      proposal: proposal(warmUp.id, strength.id),
    },
    { signingKey: KEY, now: () => new Date(), tokenTtlMs: 60 * 60 * 1000, generateId: () => randomUUID() },
  );
  if (!issued.ok) throw new Error(`issue failed: ${JSON.stringify(issued.error)}`);
  if (issued.signed.acceptToken === null) throw new Error("preview not saveable");
  return { warmUp, strength, replacement, added, preview: issued.signed.preview, token: issued.signed.acceptToken };
}

function blockIndexOf(preview: Awaited<ReturnType<typeof setup>>["preview"], title: string): number {
  const index = preview.blocks.findIndex((b) => b.title === title);
  if (index < 0) throw new Error(`block ${title} not found in ${preview.blocks.map((b) => b.title).join(",")}`);
  return index;
}

function manual(exerciseId: string, extra: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "MANUAL" as const,
    values: { exerciseId, displayName: null, sets: 3, reps: 10, distanceMeters: null, durationSeconds: null, restSeconds: 60, intensityPercent: null, loadKg: null, note: null, ...extra },
  };
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("RUNNING_V2_UI_ENABLED", "true");
  vi.stubEnv("MENU_PLANNER_ACCEPT_TOKEN_SECRET", KEY);
});
afterEach(() => vi.unstubAllEnvs());

describe("R12 unified composer: AI 生成（inline context source）", () => {
  it("参照メニュー無しで署名済み preview を作れる。生成の時点では何も保存しない", async () => {
    const { preview, token } = await setup();
    expect(token.length).toBeGreaterThan(0);
    expect(preview.blocks.map((b) => b.title)).toEqual(expect.arrayContaining(["ウォームアップ", "主運動"]));
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("inline source なのに context が無い / 参照メニューなのに inline context がある入力は拒否する", async () => {
    const warmUp = await makeExercise({ name: "Aスキップ", category: "WARM_UP" });
    const deps = { signingKey: KEY, now: () => new Date(), tokenTtlMs: 60_000, generateId: () => randomUUID() };
    const base = { ownerId: DEFAULT_OWNER_ID, menuName: "x", intent: intent(), proposal: proposal(warmUp.id, warmUp.id) };
    const missing = await issueMenuPlannerSignedPreview({ ...base, contextMenuTemplateId: MENU_PLANNER_INLINE_CONTEXT_SOURCE_ID }, deps);
    expect(missing.ok).toBe(false);
    const mixed = await issueMenuPlannerSignedPreview({ ...base, contextMenuTemplateId: "some-menu", inlineRunningContextJson: CONTEXT_JSON }, deps);
    expect(mixed.ok).toBe(false);
  });
});

describe("R12 unified composer: 保存（commit）", () => {
  it("編集後のメニュー名・順序・削除・差し替え・追加・notes・RUNNING_V2 調整がすべて 1 回の保存で残る", async () => {
    const { preview, token, replacement, added } = await setup();
    const warm = blockIndexOf(preview, "ウォームアップ");
    const main = blockIndexOf(preview, "主運動");
    expect(preview.blocks[warm]!.items).toHaveLength(2);

    const draft: ComposerDraftInput = {
      acceptToken: token,
      runningContextJson: CONTEXT_JSON,
      menuName: "コーチが直した名前",
      blocks: [
        // ウォームアップ: 2 件目（プランク）を先頭へ drag、1 件目（Aスキップ）はミニハードル走に差し替え
        { name: "ウォームアップ", aiBlockIndex: warm, items: [{ kind: "AI", previewIndex: 1, note: "体幹を意識" }, manual(replacement.id)] },
        // 主運動: RUNNING_V2 は AI のまま（notes 編集）+ 手動追加
        { name: "主運動", aiBlockIndex: main, items: [{ kind: "AI", previewIndex: 0, note: "1本ごとに歩いて戻る" }, manual(added.id, { note: "最後に" })] },
      ],
      runningOps: [{ aiBlockIndex: main, previewIndex: 0, kind: "EDIT", entries: [["field", "repRestS"], ["value", "300"]] }],
    };

    const outcome = await commitComposedMenu(draft);
    if (!outcome.ok) throw new Error(`commit failed: ${JSON.stringify(outcome)}`);

    // reload（別の読み取りで確認）
    const menu = await findMenu(outcome.menuId);
    expect(menu).not.toBeNull();
    expect(menu!.name).toBe("コーチが直した名前");
    expect(menu!.status).toBe("DRAFT");
    expect(menu!.runningContextJson).not.toBeNull();

    const [warmBlock, mainBlock] = menu!.blocks;
    expect(warmBlock!.name).toBe("ウォームアップ");
    expect(warmBlock!.items.map((i) => i.exercise?.name)).toEqual(["プランク", "ミニハードル走"]);
    expect(warmBlock!.items.map((i) => i.note)).toEqual(["体幹を意識", null]);
    expect(warmBlock!.items.map((i) => i.sortOrder)).toEqual([0, 1]);
    // 差し替え前の AI 項目（Aスキップ）は残らない
    expect(menu!.blocks.flatMap((b) => b.items).some((i) => i.exercise?.name === "Aスキップ")).toBe(false);

    expect(mainBlock!.items).toHaveLength(2);
    const [running, addedItem] = mainBlock!.items;
    expect(running!.prescriptionKind).toBe("RUNNING_V2");
    expect(running!.note).toBe("1本ごとに歩いて戻る");
    expect(addedItem!.exercise?.name).toBe("腹筋");
    expect(addedItem!.note).toBe("最後に");

    const prescription = runningPrescriptionSchema.parse(JSON.parse(running!.prescriptionJson!));
    expect(prescription.rest.repRestS).toMatchObject({ value: 300 });
    const provenance = JSON.parse(running!.provenanceJson!);
    expect(provenance.coachEdits).toEqual([expect.objectContaining({ field: "repRestS", to: 300 })]);
    expect(await prisma.menuTemplate.count()).toBe(1);
  });

  it("手動のみ（AI 無し）でも同じ保存経路でメニューを作れる", async () => {
    const ex = await makeExercise({ name: "スクワット", category: "WARM_UP" });
    const outcome = await commitComposedMenu({
      acceptToken: null,
      runningContextJson: null,
      menuName: "手動メニュー",
      blocks: [{ name: "メニュー", aiBlockIndex: null, items: [manual(ex.id, { note: "フォーム重視" })] }],
      runningOps: [],
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    const menu = await findMenu(outcome.menuId);
    expect(menu!.name).toBe("手動メニュー");
    expect(menu!.blocks[0]!.items.map((i) => [i.exercise?.name, i.sets, i.note])).toEqual([["スクワット", 3, "フォーム重視"]]);
  });

  it("running context を差し替えて送ると署名済み fingerprint と一致せず STALE。何も保存しない", async () => {
    const { preview, token } = await setup();
    const outcome = await commitComposedMenu({
      acceptToken: token,
      runningContextJson: JSON.stringify(runningContext("別のグループ")),
      menuName: "改ざん",
      blocks: preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
      runningOps: [],
    });
    expect(outcome).toMatchObject({ ok: false, scope: "DRAFT", error: { kind: "STALE_PREVIEW" } });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("RUNNING_V2 の調整は既存 Action の検証を通る: hard safety を超える値は拒否され、何も保存しない", async () => {
    const { preview, token } = await setup();
    const main = blockIndexOf(preview, "主運動");
    const outcome = await commitComposedMenu({
      acceptToken: token,
      runningContextJson: CONTEXT_JSON,
      menuName: "安全範囲外",
      blocks: preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
      runningOps: [{ aiBlockIndex: main, previewIndex: 0, kind: "EDIT", entries: [["field", "repRestS"], ["value", "5"]] }],
    });
    expect(outcome).toMatchObject({ ok: false, scope: "RUNNING_OP", opIndex: 0 });
    expect(await prisma.menuTemplate.count()).toBe(0);
    expect(await prisma.menuItem.count()).toBe(0);
  });

  it("後段（手動項目の保存）で失敗しても、materialize 済みの AI メニューは rollback される", async () => {
    const { preview, token } = await setup();
    const outcome = await commitComposedMenu({
      acceptToken: token,
      runningContextJson: CONTEXT_JSON,
      menuName: "途中で失敗",
      blocks: [
        ...preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
        { name: "メニュー", aiBlockIndex: null, items: [manual("does-not-exist")] },
      ],
      runningOps: [],
    });
    expect(outcome).toMatchObject({ ok: false, scope: "DRAFT" });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });

  it("running 調整の itemId を他メニューの項目にすり替えても、そのメニューには触れない（対象は server が固定）", async () => {
    const other = await setup();
    const otherMain = blockIndexOf(other.preview, "主運動");
    const first = await commitComposedMenu({
      acceptToken: other.token,
      runningContextJson: CONTEXT_JSON,
      menuName: "別メニュー",
      blocks: other.preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
      runningOps: [],
    });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const otherMenu = await findMenu(first.menuId);
    const otherRunning = otherMenu!.blocks[otherMain]!.items[0]!;
    const before = otherRunning.prescriptionJson;

    const { preview, token } = await setup();
    const main = blockIndexOf(preview, "主運動");
    const outcome = await commitComposedMenu({
      acceptToken: token,
      runningContextJson: CONTEXT_JSON,
      menuName: "本命",
      blocks: preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
      runningOps: [{ aiBlockIndex: main, previewIndex: 0, kind: "EDIT", entries: [["itemId", otherRunning.id], ["field", "repRestS"], ["value", "300"]] }],
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    expect((await prisma.menuItem.findUnique({ where: { id: otherRunning.id } }))!.prescriptionJson).toBe(before);
    const mine = await findMenu(outcome.menuId);
    expect(JSON.parse(mine!.blocks[main]!.items[0]!.provenanceJson!).coachEdits).toEqual([expect.objectContaining({ field: "repRestS", to: 300 })]);
  });
});

describe("R12 unified composer: 保存前 dry-run", () => {
  it("RUNNING_V2 の表示 DTO（調整後）を返し、DB には何も残さない。項目 id は本保存と一致する", async () => {
    const { preview, token } = await setup();
    const main = blockIndexOf(preview, "主運動");
    const draft: ComposerDraftInput = {
      acceptToken: token,
      runningContextJson: CONTEXT_JSON,
      menuName: "下書き",
      blocks: preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
      runningOps: [{ aiBlockIndex: main, previewIndex: 0, kind: "EDIT", entries: [["field", "repRestS"], ["value", "300"]] }],
    };

    const dry = await dryRunComposedMenu(draft);
    if (!dry.ok) throw new Error(JSON.stringify(dry));
    expect(dry.running).toHaveLength(1);
    const view = dry.running[0]!;
    expect(view).toMatchObject({ aiBlockIndex: main, previewIndex: 0, presentation: { status: "OK" } });
    expect(await prisma.menuTemplate.count()).toBe(0);
    expect(await prisma.menuItem.count()).toBe(0);

    const committed = await commitComposedMenu(draft);
    if (!committed.ok) throw new Error(JSON.stringify(committed));
    const menu = await findMenu(committed.menuId);
    const savedItem = menu!.blocks[main]!.items[0]!;
    if (view.presentation.status !== "OK") throw new Error("unreachable");
    expect(view.presentation.item.id).toBe(savedItem.id);
  });

  it("hard safety 違反は dry-run でも RUNNING_OP failure（既存 Action と同じ結果）", async () => {
    const { preview, token } = await setup();
    const main = blockIndexOf(preview, "主運動");
    const dry = await dryRunComposedMenu({
      acceptToken: token,
      runningContextJson: CONTEXT_JSON,
      menuName: "下書き",
      blocks: preview.blocks.map((b, aiBlockIndex) => ({ name: b.title, aiBlockIndex, items: b.items.map((_, previewIndex) => ({ kind: "AI" as const, previewIndex })) })),
      runningOps: [{ aiBlockIndex: main, previewIndex: 0, kind: "EDIT", entries: [["field", "repRestS"], ["value", "5"]] }],
    });
    expect(dry).toMatchObject({ ok: false, scope: "RUNNING_OP", opIndex: 0, failure: { ok: false } });
    expect(await prisma.menuTemplate.count()).toBe(0);
  });
});
