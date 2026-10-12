import { describe, expect, it } from "vitest";
import { selectComposerCatalog } from "@/application/menu-composition/catalog";
import { catalogFixture } from "../fixtures/menu-composition";

describe("composer catalog metadata diversity", () => {
  it("surfaces registered categories for whole-session variety while keeping preferred exercises first", () => {
    const rows = [
      catalogFixture({ id: "core-a", category: "CORE", name: "体幹準備A", description: "股関節を動かす" }),
      catalogFixture({ id: "core-b", category: "CORE", name: "体幹準備B", description: "股関節を動かす" }),
      catalogFixture({ id: "mobility-a", category: "MOBILITY", name: "股関節モビリティA", description: "股関節を動かす" }),
      catalogFixture({ id: "mobility-b", category: "MOBILITY", name: "股関節モビリティB", description: "股関節を動かす" }),
      catalogFixture({ id: "warmup-a", category: "WARM_UP", name: "股関節準備", description: "股関節を動かす" }),
      catalogFixture({ id: "drill-a", category: "DRILL", name: "股関節ドリル", description: "股関節を動かす" }),
      catalogFixture({ id: "running", category: "SPRINT", name: "走る", description: "股関節を動かす" }),
      catalogFixture({ id: "draft", category: "COOL_DOWN", name: "未承認の整理", status: "DRAFT" }),
    ];

    const selected = selectComposerCatalog(rows, "股関節の練習", ["core-b"]);
    expect(selected[0]?.id).toBe("core-b");
    expect(new Set(selected.slice(1, 4).map(row => row.category)).size).toBe(3);
    expect(selected.slice(1, 4).map(row => row.category)).toEqual(expect.arrayContaining(["MOBILITY", "WARM_UP", "DRILL"]));
    expect(selected.map(row => row.id)).not.toContain("running");
    expect(selected.map(row => row.id)).not.toContain("draft");
    expect(selected.every(row => rows.some(source => source.id === row.id))).toBe(true);
  });

  it("keeps unrelated unmatched candidates in deterministic prior ID order", () => {
    const rows = [
      catalogFixture({ id: "core-1", category: "CORE", name: "種目1", description: null }),
      catalogFixture({ id: "core-2", category: "CORE", name: "種目2", description: null }),
      catalogFixture({ id: "mobility-1", category: "MOBILITY", name: "種目3", description: null }),
      catalogFixture({ id: "drill-1", category: "DRILL", name: "種目4", description: null }),
    ];
    const first = selectComposerCatalog(rows, "用途に合うもの", []);
    const second = selectComposerCatalog(rows, "用途に合うもの", []);
    expect(first.map(row => row.id)).toEqual(["core-1", "core-2", "drill-1", "mobility-1"]);
    expect(second.map(row => row.id)).toEqual(first.map(row => row.id));
    expect(first.every(row => rows.some(source => source.id === row.id))).toBe(true);
  });

  it("surfaces up to three registered prep/closing mobility options for a running session within the existing budget", () => {
    const mobility = (id: string, name: string, description: string, relevant = true) => catalogFixture({
      id, category: "MOBILITY", name, description,
      events: relevant ? ["COMMON"] : [],
      purposes: relevant ? ["MOBILITY", "HIP_JOINT"] : ["OTHER"],
      targets: relevant ? ["MOBILITY", "TECHNIQUE"] : ["OTHER"],
    });
    const rows = [
      catalogFixture({ id: "preferred", category: "CORE", name: "本人指定の補助種目" }),
      mobility("mobility-a", "キャット&ドッグ", "四つ這いで背中をゆっくり丸め、反らせる動きを繰り返す。"),
      mobility("mobility-b", "インチワーム", "手足を歩かせて体を伸ばしながら前進する。"),
      mobility("mobility-c", "股関節回し", "前進しながら股関節を回す。"),
      mobility("mobility-z", "irrelevant mobility", "名詞だけで準備や整理の動作説明がない。", false),
      ...Array.from({ length: 28 }, (_, index) => catalogFixture({
        id: "core-" + String(index).padStart(2, "0"), category: "CORE", name: "補助" + index,
        description: "登録済みの体幹種目。",
      })),
    ];

    const selected = selectComposerCatalog(rows, "高校生の100m練習メニュー", ["preferred"]);
    const selectedMobility = selected.filter(row => row.category === "MOBILITY");

    expect(selected[0]?.id).toBe("preferred");
    expect(new Set(selectedMobility.map(row => row.id))).toEqual(new Set(["mobility-a", "mobility-b", "mobility-c"]));
    expect(selected.length).toBeLessThanOrEqual(24);
    expect(selected.every(row => rows.some(source => source.id === row.id))).toBe(true);
  });

  it("keeps other registered mobility candidates in the catalog when the prompt budget permits", () => {
    const rows = [
      catalogFixture({ id: "mobility-a", category: "MOBILITY", name: "キャット&ドッグ", description: "ゆっくり背骨を動かす。" }),
      catalogFixture({ id: "mobility-z", category: "MOBILITY", name: "別のモビリティ種目", description: "登録済みの別動作。",
        events: ["OTHER"], purposes: ["OTHER"], targets: ["OTHER"] }),
      catalogFixture({ id: "core", category: "CORE", name: "体幹種目" }),
    ];
    const selected = selectComposerCatalog(rows, "100m練習");
    expect(selected.map(row => row.id)).toEqual(expect.arrayContaining(rows.map(row => row.id)));
  });

  it("preserves every explicit preferred mobility match even when that exceeds the supplemental quota", () => {
    const rows = ["mobility-a", "mobility-b", "mobility-c", "mobility-d"].map(id => catalogFixture({
      id, category: "MOBILITY", name: "股関節回し" + id, description: "前進しながら股関節を回す。",
      purposes: ["HIP_JOINT"], targets: ["MOBILITY"], events: ["COMMON"],
    }));
    const selected = selectComposerCatalog(rows, "100mの練習", rows.map(row => row.id));
    expect(selected.map(row => row.id)).toEqual(rows.map(row => row.id));
  });
});
