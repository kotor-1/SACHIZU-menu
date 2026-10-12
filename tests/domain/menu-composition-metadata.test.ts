import { describe, expect, it } from "vitest";
import { compositionSchema, editableComposition, type MenuComposition } from "@/domain/menu-composition/contracts";
import { catalogPlan } from "../fixtures/menu-composition";

const legacy = { blocks: [{ name: "準備", items: [catalogPlan()] }] };

describe("composition planning metadata", () => {
  it("keeps legacy fixture shapes valid while accepting overview and block allocations", () => {
    expect(compositionSchema.safeParse(legacy).success).toBe(true);
    expect(compositionSchema.safeParse({
      overview: { title: "100mの練習", objective: "加速と技術を練習する", approach: "既存種目を組み合わせる" },
      transitionSeconds: 120,
      blocks: [{ name: "準備", phase: "WARM_UP", allocatedSeconds: 300, items: [catalogPlan()] }],
    }).success).toBe(true);
  });

  it.each([
    { overview: { title: "", objective: "目的", approach: "方針" } },
    { transitionSeconds: -1 },
    { blocks: [{ name: "準備", phase: "UNSUPPORTED", allocatedSeconds: 30, items: [catalogPlan()] }] },
    { blocks: [{ name: "準備", phase: "WARM_UP", allocatedSeconds: -1, items: [catalogPlan()] }] },
    { blocks: [{ name: "準備", phase: "WARM_UP", allocatedSeconds: 604801, items: [catalogPlan()] }] },
  ])("rejects invalid planning metadata: %j", patch => {
    const value = { ...legacy, ...patch };
    expect(compositionSchema.safeParse(value).success).toBe(false);
  });

  it("drops composer-only metadata when converting items to the existing editable shape", () => {
    const proposal = compositionSchema.parse({
      overview: { title: "基礎練習", objective: "動きを整える", approach: "登録種目を使う" },
      transitionSeconds: null,
      blocks: [{ name: "準備", phase: "WARM_UP", allocatedSeconds: null, items: [catalogPlan()] }],
    }) as MenuComposition;
    const editable = editableComposition(proposal, (() => { let index = 0; return () => `id-${++index}`; })());
    expect(editable.blocks[0]).toMatchObject({ name: "準備", items: [expect.objectContaining({ type: "CATALOG_EXERCISE" })] });
    expect(editable.blocks[0]).not.toHaveProperty("phase");
    expect(editable.blocks[0]).not.toHaveProperty("allocatedSeconds");
    expect(editable).not.toHaveProperty("overview");
    expect(editable).not.toHaveProperty("transitionSeconds");
  });
});
