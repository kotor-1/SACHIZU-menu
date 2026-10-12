import { describe, expect, it } from "vitest";
import { COMPOSER_CATALOG_CHARACTER_LIMIT, COMPOSER_CATALOG_LIMIT, COMPOSER_CATALOG_ROLES, composerCatalogRoles, selectComposerCatalog } from "@/application/menu-composition/catalog";
import { catalogFixture } from "../fixtures/menu-composition";

const context = { event: "100m", availableTimeSeconds: 5400 };
const request = "高校生です。来週末の試合に向けて少し疲労をためたいです。今は10が一番疲労が強いとしたら1です。";
const option = (id: string, name: string, category: string, description: string, patch = {}) => catalogFixture({
  id, name, category, description, events: ["COMMON"], purposes: [], targets: [], videoGuidance: null, ...patch,
});
function rows() {
  return [
    ...Array.from({ length: 30 }, (_, n) => option(`early-${n}`, `体幹${n}`, "CORE", "体幹を保って膝を曲げ伸ばしする。", { metricType: "REPS" })),
    option("walk-a", "膝上げウォーク", "DRILL", "直立姿勢で一歩ずつ歩行する。", { targets: ["TECHNIQUE"], metricType: "DISTANCE" }),
    option("walk-b", "腕回し", "MOBILITY", "軽く弾みながら腕を回して前進する。", { purposes: ["ARM_SWING"], metricType: "DISTANCE" }),
    option("joint-a", "股関節回し", "MOBILITY", "立って股関節を外から内へ回す。", { purposes: ["HIP_JOINT"] }),
    option("joint-b", "足首回し", "MOBILITY", "座って足首を回す。", { purposes: ["ANKLE_JOINT"] }),
    option("tech-a", "その場接地", "DRILL", "その場で膝を上げて下ろし接地を確認する。", { targets: ["TECHNIQUE"], events: ["SPRINT"] }),
    option("tech-b", "軌道確認", "DRILL", "静止姿勢で片脚の軌道を確認する。", { targets: ["TECHNIQUE"], events: ["SPRINT"] }),
    option("timed", "姿勢保持", "CORE", "肘をついて身体をまっすぐ保持する。", { metricType: "TIME" }),
    option("close-a", "背骨運動", "MOBILITY", "四つ這いで背中をゆっくり動かす。"),
    option("close-b", "胸の伸張", "MOBILITY", "胸を伸張した姿勢を保持する。"),
    option("unrelated", "ハードル専用", "HURDLE", "その場でハードルをまたぐ。", { events: ["HURDLE"], targets: ["TECHNIQUE"] }),
    option("running", "加速走", "SPRINT", "直線を走る。"),
    option("draft", "未確認の整理", "COOL_DOWN", "ゆっくり動かす。", { status: "DRAFT" }),
  ];
}

describe("whole-session catalog retrieval", () => {
  it("uses verified event and time to expose all available roles without dedicated warm-up/cool-down categories", () => {
    const source = rows();
    const selected = selectComposerCatalog(source, request, [], context);
    expect(selected).toHaveLength(COMPOSER_CATALOG_LIMIT);
    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(COMPOSER_CATALOG_CHARACTER_LIMIT);
    for (const role of COMPOSER_CATALOG_ROLES) expect(selected.filter(row => composerCatalogRoles(row).includes(role)).length).toBeGreaterThanOrEqual(2);
    expect(selected.map(row => row.id)).toEqual(expect.arrayContaining(["walk-a", "walk-b", "tech-a", "tech-b", "timed", "close-a", "close-b"]));
    expect(selected.map(row => row.id)).not.toContain("unrelated");
    expect(selected.map(row => row.id)).not.toContain("running");
    expect(selected.map(row => row.id)).not.toContain("draft");
    for (const row of selected) expect(row).toEqual(source.find(sourceRow => sourceRow.id === row.id));
  });

  it("keeps explicit preferences first and does not duplicate formal names while alternatives fit", () => {
    const source = [...rows(), option("duplicate", "膝上げウォーク", "DRILL", "一歩ずつ歩行する。", { targets: ["TECHNIQUE"] })];
    const selected = selectComposerCatalog(source, request, ["early-29"], context);
    expect(selected[0].id).toBe("early-29");
    expect(selected.filter(row => row.name === "膝上げウォーク")).toHaveLength(1);
    expect(selectComposerCatalog([...source].reverse(), request, ["early-29"], context)).toEqual(selected);
  });

  it("leaves missing roles empty instead of inventing catalog entries or default doses", () => {
    const source = [option("only", "姿勢保持", "CORE", "身体をまっすぐ保持する。", { defaultSets: null, defaultDurationSeconds: null })];
    expect(selectComposerCatalog(source, request, [], context)).toEqual(source);
    expect(composerCatalogRoles(source[0])).toEqual(["SUPPORT"]);
  });

  it.each(["少しだけ疲労をためたい", "1回だけ90分メニューを作りたい"])("does not confuse %s with a single-exercise restriction", text => {
    const selected = selectComposerCatalog(rows(), text, [], context);
    expect(selected.some(row => composerCatalogRoles(row).includes("CLOSING"))).toBe(true);
    expect(selected.some(row => row.id === "tech-a")).toBe(true);
  });

  it.each(["走だけ", "補強だけ", "姿勢保持だけ"])("preserves focused retrieval for %s", text => {
    const source = rows();
    expect(selectComposerCatalog(source, text, [], context)).toEqual(selectComposerCatalog(source, text));
  });

  it("preserves the established retrieval for shorter sessions", () => {
    expect(selectComposerCatalog(rows(), request, [], { event: "100m", availableTimeSeconds: 1800 }))
      .toEqual(selectComposerCatalog(rows(), request));
  });

  it("does not label running transitions or explosive locomotion as introduction/closing candidates", () => {
    const runningTransition = option("transition", "ウォークから疾走へ", "DRILL", "歩行からスプリントへ移行する。", { targets: ["TECHNIQUE"] });
    expect(composerCatalogRoles(runningTransition)).toEqual([]);
    expect(composerCatalogRoles(option("jump", "跳躍", "MOBILITY", "ホップしながら前進し姿勢を保持する。"))).not.toContain("CLOSING");
  });

  it("skips oversized optional rows without spending the budget before closing alternatives", () => {
    const oversized = option("huge", "巨大な導入", "WARM_UP", "歩行する。", { tags: ["登録済み長文".repeat(10000)] });
    const selected = selectComposerCatalog([oversized, ...rows()], request, [], context);
    expect(selected.map(row => row.id)).not.toContain("huge");
    expect(selected.some(row => composerCatalogRoles(row).includes("CLOSING"))).toBe(true);
    expect(JSON.stringify(selected).length).toBeLessThanOrEqual(COMPOSER_CATALOG_CHARACTER_LIMIT);
  });
});
