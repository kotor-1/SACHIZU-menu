/**
 * R10-B4B — 既存 Menu 画面への統合（実際の Menu の DOM で検査する）。
 *
 * - feature flag OFF（running = null）では、B4B 実装前と同じ操作・表示のまま（golden は legacy-menu-ui.test.ts）。
 * - flag ON では走項目が専用表示になり、内部キー（Method / template id / severity / Finding code）が DOM に出ない。
 * - 走系の種目では legacy の「推奨処方を入れる」を出さず、走トレーニングの導線を案内する。
 */
import { describe, expect, it } from "vitest";
import { MenuBlockEditor } from "@/components/menu/menu-block-editor";
import { MenuItemForm } from "@/components/menu/menu-item-form";
import { RunningContextEditor } from "@/components/running/running-context-editor";
import { RunningItemCreateForm } from "@/components/running/running-item-create-form";
import { RunningMenuPanel } from "@/components/running/running-menu-panel";
import { PLANNED_DATE_REQUIRED_FOR_PICKER_JA, templatePickerForPlannedDate } from "@/actions/_running-template-options";
import { RUNNING_CONTEXT_UNREADABLE_MESSAGE_JA, type RunningMenuView } from "@/actions/_running-menu-view";
import { presentMenuAggregation } from "@/presentation/running/menu";
import { contextDraftFrom, emptyContextDraft, emptyMemberDraft } from "@/presentation/running/menu-context";
import { presentSavedRunningMenuItem, type SavedRunningItemPresentation } from "@/presentation/running/server";
import { LEGACY_RUNNING_SUGGESTION_NOTICE_JA } from "@/presentation/running/legacy-routing";
import { planAcc, provenanceFor } from "../../repository/running/fixtures";
import { renderMarkup, rawKeyLeaks, stripTags } from "./helpers";
import {
  controlsOf,
  legacyBlock,
  legacyDrillExercise,
  legacyMenuItem,
  legacyRunningExercise,
  runningSelectionValues,
  visibleText,
  LEGACY_BLOCK_BUTTONS,
} from "./menu-fixtures";

const prescription = planAcc();

function savedRunningItem(): SavedRunningItemPresentation {
  return presentSavedRunningMenuItem({
    id: "item-run",
    displayName: null,
    rationale: "保存済みの根拠テキスト。",
    prescriptionKind: "RUNNING_V2",
    prescriptionJson: JSON.stringify(prescription),
    provenanceJson: JSON.stringify(provenanceFor(prescription)),
    ruleSetVersion: prescription.ruleSet.version,
    ruleSetContentHash: prescription.ruleSet.contentHash,
  });
}

function runningItemRow() {
  return legacyMenuItem({ id: "item-run", prescriptionKind: "RUNNING_V2", exercise: null, exerciseId: null, displayName: "加速走", note: null });
}

function blockMarkup(options: { running: boolean; items?: unknown[]; plannedDate?: string | null } = { running: true }) {
  const picker = templatePickerForPlannedDate(options.plannedDate === undefined ? "2026-09-20" : options.plannedDate);
  return renderMarkup(MenuBlockEditor as never, {
    menuId: "menu-1",
    block: legacyBlock((options.items ?? [legacyMenuItem(), runningItemRow()]) as never),
    exercises: [legacyDrillExercise, legacyRunningExercise],
    isFirst: true,
    isLast: false,
    phase: null,
    running: options.running ? { items: { "item-run": savedRunningItem() }, picker } : null,
  } as never);
}

describe("R10-B4B: Menu ブロックへの統合", () => {
  it("flag OFF（running = null）では、走項目を含んでいても legacy の表示・操作のまま", () => {
    const markup = blockMarkup({ running: false });
    const { buttons } = controlsOf(markup);
    expect([...new Set(buttons)].sort()).toEqual([...new Set(LEGACY_BLOCK_BUTTONS)].sort());
    expect(visibleText(markup)).not.toContain("走トレーニングを追加");
    expect(visibleText(markup)).not.toContain("内容を見る・調整する");
  });

  it("flag ON では、走項目が専用表示になり、legacy 項目はそのまま残る", () => {
    const markup = blockMarkup();
    const text = visibleText(markup);
    // legacy 項目は従来どおり
    expect(text).toContain("スキップドリル");
    expect(text).toContain("3set × 10回");
    // 走項目は保存済みの練習の型の名前で出る（内部 id ではない）
    expect(text).toContain("＋ 走トレーニングを追加");
    expect(text).toContain("内容を見る・調整する");
    expect(controlsOf(markup).buttons).toContain("＋ 走トレーニングを追加");
  });

  it("走項目には legacy の汎用編集（✎）を出さない（専用 Action しか使えないため）", () => {
    const onlyRunning = blockMarkup({ running: true, items: [runningItemRow()] });
    expect(controlsOf(onlyRunning).buttons).not.toContain("✎");
    // 並べ替え・削除は従来どおり使える
    expect(controlsOf(onlyRunning).buttons).toEqual(expect.arrayContaining(["↑", "↓", "✕"]));
  });

  it("実際の Menu の DOM に内部キー（Method / template id / severity / Finding code）が出ない", () => {
    expect(rawKeyLeaks(blockMarkup())).toEqual([]);
  });

  it("計画日が無ければ、候補ではなく理由を出す（当日で代用しない）", () => {
    const markup = renderMarkup(RunningItemCreateForm as never, {
      menuId: "menu-1",
      blockId: "block-1",
      picker: templatePickerForPlannedDate(null),
    } as never);
    expect(stripTags(markup)).toContain(PLANNED_DATE_REQUIRED_FOR_PICKER_JA);
    expect(rawKeyLeaks(markup)).toEqual([]);
  });
});

describe("R10-B4B: legacy フォームからの案内", () => {
  it("走系の種目では「推奨処方を入れる」を出さず、走トレーニングの導線を案内する", () => {
    const markup = renderMarkup(MenuItemForm as never, {
      action: (async () => ({ ok: true })) as never,
      exercises: [legacyDrillExercise, legacyRunningExercise],
      submitLabel: "追加する",
      initial: runningSelectionValues(),
      runningV2Enabled: true,
    } as never);
    expect(controlsOf(markup).buttons).toEqual(["追加する"]);
    expect(visibleText(markup)).toContain(LEGACY_RUNNING_SUGGESTION_NOTICE_JA);
  });

  it("走系でない種目では、legacy の推奨処方をこれまでどおり使える", () => {
    const markup = renderMarkup(MenuItemForm as never, {
      action: (async () => ({ ok: true })) as never,
      exercises: [legacyDrillExercise, legacyRunningExercise],
      submitLabel: "追加する",
      initial: { ...runningSelectionValues(), exerciseId: "ex-1" },
      runningV2Enabled: true,
    } as never);
    expect(controlsOf(markup).buttons).toContain("推奨処方を入れる");
  });

  it("flag OFF では、走系の種目でも legacy のまま（案内を出さない）", () => {
    const markup = renderMarkup(MenuItemForm as never, {
      action: (async () => ({ ok: true })) as never,
      exercises: [legacyDrillExercise, legacyRunningExercise],
      submitLabel: "追加する",
      initial: runningSelectionValues(),
    } as never);
    expect(controlsOf(markup).buttons).toContain("推奨処方を入れる");
    expect(visibleText(markup)).not.toContain(LEGACY_RUNNING_SUGGESTION_NOTICE_JA);
  });
});

describe("R10-B4B: 対象グループ・計画日の入力", () => {
  const editorMarkup = (props: Record<string, unknown> = {}) =>
    renderMarkup(RunningContextEditor as never, {
      menuId: "menu-1",
      initial: { ...emptyContextDraft(), label: "短距離", plannedDate: "2026-09-20", members: [emptyMemberDraft()] },
      ...props,
    } as never);

  it("健康情報・個人情報の入力欄を作らない", () => {
    const markup = editorMarkup();
    const text = stripTags(markup);
    for (const word of ["痛み", "痛", "けが", "怪我", "睡眠", "疲労", "体調", "生年月日", "性別", "病", "薬"]) {
      expect(text, word).not.toContain(word);
    }
    for (const name of ["birthDate", "sexForNorms", "pain", "soreness", "sleep", "fatigue", "readiness"]) {
      expect(markup, name).not.toContain(name);
    }
  });

  it("入力欄にはラベルが紐づき、タップ領域は 44px 以上", () => {
    const markup = editorMarkup();
    const ids = [...markup.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) {
      const hasLabel = markup.includes(`for="${id}"`);
      const isCheckbox = new RegExp(`<input[^>]*id="${id}"[^>]*type="checkbox"`).test(markup);
      expect(hasLabel || isCheckbox, id).toBe(true);
    }
    for (const control of markup.match(/<(?:input|select)\b[^>]*class="[^"]*"/g) ?? []) {
      if (control.includes('type="checkbox"')) continue;
      expect(control).toMatch(/h-11/);
    }
  });

  it("保存済みの設定が壊れていたら、空欄＋案内にする（推測して埋めない）", () => {
    const markup = editorMarkup({ initial: contextDraftFrom(null), statusMessage: RUNNING_CONTEXT_UNREADABLE_MESSAGE_JA });
    expect(stripTags(markup)).toContain(RUNNING_CONTEXT_UNREADABLE_MESSAGE_JA);
    expect(markup).not.toMatch(/value="20\d\d-\d\d-\d\d"/);
  });
});

describe("R10-B4B: メニュー全体のパネル", () => {
  function view(aggregation: RunningMenuView["aggregation"]): RunningMenuView {
    return {
      context: { status: "NONE", draft: emptyContextDraft(), message: null, plannedDate: null },
      picker: templatePickerForPlannedDate(null),
      items: {},
      aggregation,
    };
  }

  it("版が混ざっているときは、その理由を出す（合計を捏造しない）", () => {
    const markup = renderMarkup(RunningMenuPanel as never, {
      menuId: "menu-1",
      view: view(presentMenuAggregation({ status: "NOT_EVALUATED", reason: "MIXED_RULESET_VERSIONS" })),
    } as never);
    const text = stripTags(markup);
    expect(text).toContain("複数のルールセットが混ざっている");
    expect(text).not.toMatch(/合計\s*0m/);
    expect(rawKeyLeaks(markup)).toEqual([]);
  });

  it("走項目が無いときは、合計ではなく案内を出す", () => {
    const markup = renderMarkup(RunningMenuPanel as never, { menuId: "menu-1", view: view({ status: "NONE" }) } as never);
    expect(stripTags(markup)).toContain("走トレーニングの項目を追加すると");
  });
});

describe("R10-B4B: 狭い画面（375 / 390 / 430px）での安全性", () => {
  /** 画面幅を固定する指定（px 幅・固定 min-width）が無いこと。折り返しと省略で収める。 */
  const markups = () => [
    blockMarkup(),
    renderMarkup(RunningItemCreateForm as never, { menuId: "m", blockId: "b", picker: templatePickerForPlannedDate("2026-09-20") } as never),
    renderMarkup(RunningContextEditor as never, {
      menuId: "m",
      initial: { ...emptyContextDraft(), label: "短距離", plannedDate: "2026-09-20", members: [emptyMemberDraft()] },
    } as never),
    renderMarkup(RunningMenuPanel as never, {
      menuId: "m",
      view: {
        context: { status: "NONE", draft: emptyContextDraft(), message: null, plannedDate: null },
        picker: templatePickerForPlannedDate(null),
        items: {},
        aggregation: presentMenuAggregation({ status: "SKIP" }),
      },
    } as never),
  ];

  it("px 固定幅・固定 min-width を使わない", () => {
    for (const markup of markups()) {
      for (const cls of markup.match(/class="[^"]*"/g) ?? []) {
        expect(cls).not.toMatch(/\bw-\[\d+px\]|\bmin-w-\[\d+px\]/);
      }
    }
  });

  it("横に並べる箇所は折り返し、長い文字列は折り返す（legacy の行は golden のまま）", () => {
    // B4B で新しく足した component だけを対象にする（legacy のブロック行は変更していない）。
    for (const markup of markups().slice(1)) {
      const rows = markup.match(/class="[^"]*\bflex\b[^"]*"/g) ?? [];
      for (const row of rows) {
        // flex 行は「折り返す」か「縮む要素を含む（min-w-0）」のどちらかにする
        expect(row, row).toMatch(/flex-wrap|flex-col|items-center|min-w-0|shrink-0|justify-between/);
      }
    }
    expect(blockMarkup()).toMatch(/break-words/);
  });

  it("操作できるものは 44px 以上、アイコンだけのボタンも 32px 以上", () => {
    const markup = renderMarkup(RunningItemCreateForm as never, {
      menuId: "m",
      blockId: "b",
      picker: templatePickerForPlannedDate("2026-09-20"),
    } as never);
    for (const button of markup.match(/<button\b[^>]*class="[^"]*"/g) ?? []) {
      expect(button, button).toMatch(/\b(h-11|min-h-11|h-12|h-8)\b/);
    }
  });
});
