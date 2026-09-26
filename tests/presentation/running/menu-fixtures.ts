/**
 * R10-B4B — Menu 画面のテスト用フィクスチャと、markup からの検査ヘルパー。
 *
 * 期待値（LEGACY_*）は、B4B の変更を 1 行も入れる前の実際の出力を写したもの。
 * MenuBlockEditor / MenuItemForm は hooks を使うため、静的レンダリング（markup）で検査する。
 */
import { MenuBlockEditor } from "@/components/menu/menu-block-editor";
import { MenuItemForm } from "@/components/menu/menu-item-form";
import type { ExercisePickerItem } from "@/infra/repositories/exercise-repository";
import type { MenuBlockDetail } from "@/infra/repositories/menu-repository";
import { renderMarkup, stripTags } from "./helpers";

export const legacyDrillExercise = {
  id: "ex-1",
  name: "スキップドリル",
  category: "DRILL",
  metricType: "REPS",
  difficulty: "EASY",
  energySystem: null,
  defaultSets: 3,
  defaultReps: 10,
  defaultDistanceMeters: null,
  defaultDurationSeconds: null,
  defaultRestSeconds: 60,
  targets: [],
} as unknown as ExercisePickerItem;

/** 走系（B4B で Running v2 へ寄せる対象）。 */
export const legacyRunningExercise = {
  id: "ex-run",
  name: "30m加速走",
  category: "SPRINT",
  metricType: "DISTANCE",
  difficulty: "HARD",
  energySystem: "ATP_CP",
  defaultSets: 1,
  defaultReps: 4,
  defaultDistanceMeters: 30,
  defaultDurationSeconds: null,
  defaultRestSeconds: 180,
  targets: [{ target: "SPEED" }],
} as unknown as ExercisePickerItem;

export function legacyMenuItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    menuBlockId: "block-1",
    exerciseId: "ex-1",
    displayName: null,
    sortOrder: 0,
    sets: 3,
    reps: 10,
    distanceMeters: null,
    durationSeconds: null,
    restSeconds: 60,
    intensityPercent: null,
    loadKg: null,
    note: "ていねいに",
    exercise: legacyDrillExercise,
    ...overrides,
  } as unknown as MenuBlockDetail["items"][number];
}

export function legacyBlock(items: MenuBlockDetail["items"] = [legacyMenuItem()]): MenuBlockDetail {
  return { id: "block-1", menuTemplateId: "menu-1", name: "主運動", note: "アップ後", sortOrder: 0, items } as unknown as MenuBlockDetail;
}

/** markup から「操作できるもの」を取り出す（ボタンの表示名 / フォームの入力欄名）。 */
export function controlsOf(markup: string): { buttons: string[]; fields: string[] } {
  return {
    buttons: [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map((m) => stripTags(m[1]!).replace(/\s+/g, " ").trim())
      .sort(),
    fields: [...markup.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]!).sort(),
  };
}

/** React が挿入する form replay スクリプトを落として、コーチに見える文字列だけにする。 */
export function visibleText(markup: string): string {
  return stripTags(markup.replace(/<script[\s\S]*?<\/script>/g, " ")).replace(/\s+/g, " ").trim();
}

export function legacyBlockMarkup(props: Record<string, unknown> = {}): string {
  return renderMarkup(MenuBlockEditor as never, {
    menuId: "menu-1",
    block: legacyBlock(),
    exercises: [legacyDrillExercise, legacyRunningExercise],
    isFirst: true,
    isLast: false,
    phase: null,
    ...props,
  } as never);
}

export function legacyItemFormMarkup(props: Record<string, unknown> = {}): string {
  return renderMarkup(MenuItemForm as never, {
    action: (async () => ({ ok: true })) as never,
    exercises: [legacyDrillExercise, legacyRunningExercise],
    submitLabel: "追加する",
    ...props,
  } as never);
}

export function runningSelectionValues() {
  return {
    exerciseId: "ex-run",
    displayName: "",
    sets: "1",
    reps: "4",
    distanceMeters: "30",
    durationSeconds: "",
    restSeconds: "180",
    intensityPercent: "",
    loadKg: "",
    note: "",
  };
}

/** B4B 実装前の実出力（flag OFF ではこれと一致し続ける）。 */
export const LEGACY_BLOCK_BUTTONS = ["↑", "↑", "↓", "↓", "✎", "✕", "削除", "⠿", "＋ このブロックに種目を追加"];
export const LEGACY_BLOCK_FIELDS = [
  "blockId",
  "blockId",
  "blockId",
  "direction",
  "direction",
  "direction",
  "direction",
  "itemId",
  "itemId",
  "itemId",
  "menuId",
  "menuId",
  "menuId",
  "menuId",
  "menuId",
  "menuId",
].sort();
export const LEGACY_ITEM_FORM_FIELDS = [
  "displayName",
  "distanceMeters",
  "durationSeconds",
  "exerciseId",
  "intensityPercent",
  "loadKg",
  "note",
  "reps",
  "restSeconds",
  "sets",
];
export const LEGACY_BLOCK_TEXT = "主運動 アップ後 ↑ ↓ 削除 ⠿ スキップドリル 3set × 10回 / レスト 1分 ていねいに ↑ ↓ ✎ ✕ ＋ このブロックに種目を追加";

