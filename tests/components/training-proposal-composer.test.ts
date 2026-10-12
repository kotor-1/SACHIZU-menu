import { describe, expect, it, vi } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

vi.mock("@/actions/training-proposal-actions", () => ({ generateTrainingProposalAction: vi.fn(), saveTrainingProposalAction: vi.fn(), previewTrainingRunningCoachEditAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { TrainingProposalComposer } from "@/components/menu/training-proposal-composer";
import { TrainingConditionsForm } from "@/components/menu/training-conditions-form";
import { RunningPolicyCoachEditor } from "@/components/menu/running-policy-coach-editor";
import { useState } from "react";
import { DEFAULT_TRAINING_CONDITIONS, TRAINING_GOAL_LABELS, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { TRAINING_SECTION_NAMES, type TrainingProposalPreview } from "@/domain/training-proposal/contracts";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import { planRunningPrescription } from "@/domain/running-policy/engine";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { catalogFixture } from "../fixtures/menu-composition";

const scienceContext = { experience: "EXPERIENCED", maturity: "POST", supervised: true, symptomFree: true,
  familiarWithSprint: true, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72,
  highIntensitySessionsLast7Days: 1, speedEnduranceMode: "SPRINT_SPECIFIC" } as const;
function safeConditions(): TrainingConditions {
  const c = structuredClone(DEFAULT_TRAINING_CONDITIONS);
  c.environment = { ...c.environment, straightMeters: 100, surface: "TRACK", flatSafe: true, trafficFree: true, obstacleFree: true };
  c.athlete = { ...c.athlete, experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "POST", supervised: true, familiarWithSprint: true };
  c.condition = { ...c.condition, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, competitionDays: 14 };
  return c;
}
function running(purpose = "MAX_SPEED"): RunningPrescription {
  const result = planRunningPrescription({ event: "100m", ageGroup: "HIGH_SCHOOL", purpose, science: scienceContext });
  if (result.status !== "READY") throw new Error("Offline Engine fixture unavailable");
  return result.prescription;
}
const catalog: ComposerCatalogExercise[] = [
  catalogFixture(),
  catalogFixture({ id: "movement-a", name: "肩回し", category: "MOBILITY", description: "肩を小さく回し、可動域を確認する。", metricType: "REPS", defaultDurationSeconds: null, defaultReps: 6 }),
  catalogFixture({ id: "movement-b", name: "足首回し", category: "MOBILITY", description: "足首を小さく回す。", metricType: "REPS", defaultDurationSeconds: null, defaultReps: 6 }),
  catalogFixture({ id: "step-a", name: "段差の支持", description: "低い台に手を置き、姿勢を保つ。" }),
];
function preview(prescription = running()): TrainingProposalPreview {
  const conditions = safeConditions();
  conditions.goals = ["MAX_SPEED"]; conditions.primaryGoal = "MAX_SPEED";
  const movement = suggestCatalogItem(catalog[1], conditions, "movement-item");
  const strength = suggestCatalogItem(catalog[0], conditions, "strength-item");
  return {
    conditions, previewToken: "offline-ui-preview", runningPrescription: prescription, runningStatusReason: null,
    composition: { blocks: [
      { id: "movement-block", name: "動きづくり", items: [movement.item] },
      { id: "running-block", name: "走練習", items: [{ id: "running-item", type: "RUNNING_POLICY", plannedNote: "" }] },
      { id: "strength-block", name: "補強トレーニング", items: [strength.item] },
    ] },
    annotations: { [movement.item.id]: movement.annotation, [strength.item.id]: strength.annotation },
    selectedItemIds: [movement.item.id, "running-item", strength.item.id], messages: [], quality: "READY",
  };
}
function visibleRunningCard(html: string) {
  return stripTags(html.split('data-training-item="running-item"')[1]?.split("<details")[0] ?? "").replace(/\s+/g, " ");
}

describe("training proposal UI (offline rendering, no Luna call)", () => {
  it("shows every conditions step, explicit safety questions and optional notes before generation", () => {
    const html = renderMarkup(TrainingProposalComposer, { catalog });
    const text = stripTags(html);
    expect(html.match(/aria-label="STEP \d /g)).toHaveLength(6);
    for (const label of ["練習する場所", "使える距離・設備", "対象となる選手", "今回の目的", "今日の状態・大会予定", "補足・希望（任意）", "その他の距離", "主目的", "競技経験", "競技レベル", "前回の高強度練習", "次の高強度練習", "直近7日間の高強度練習", "次の大会まで"]) expect(text).toContain(label);
    expect(html.match(/value="unknown" selected=""/g)).toHaveLength(5);
    expect(html).not.toContain('value="yes" selected=""');
    expect(text).not.toMatch(/希望時間|計画時間|90分|メニュー案を作る/);
  });

  it("asks separate hill, step, wall and endurance details without treating them as confirmed", () => {
    const conditions = structuredClone(DEFAULT_TRAINING_CONDITIONS);
    conditions.environment.equipment = ["HILL", "STEP", "WALL", "OTHER"];
    conditions.environment.straightMeters = 75;
    conditions.goals = ["SPEED_ENDURANCE"]; conditions.primaryGoal = "SPEED_ENDURANCE";
    const html = renderMarkup(TrainingConditionsForm, { value: conditions, onChange: vi.fn() });
    const text = stripTags(html);
    for (const label of ["その他の直線距離（m）", "坂の距離（m）", "傾斜（%）", "段差の高さ（cm）", "段差が安定している", "壁に体重をかけても安定している", "その他の設備・用具", "スプリント持久力（十分な回復）", "90〜95%走（既存ルール）"]) expect(text).toContain(label);
    expect(html).not.toContain('value="yes" selected=""');
    expect(html).toMatch(/<option value="" selected="">未確認<\/option>/);
  });

  it("shows location-specific safety prompts and honest zero/long distances", () => {
    const conditions = structuredClone(DEFAULT_TRAINING_CONDITIONS);
    conditions.location = "INDOOR"; conditions.environment.straightMeters = 500;
    const indoor = renderMarkup(TrainingConditionsForm, { value: conditions, onChange: vi.fn() });
    expect(stripTags(indoor)).toContain("床が平坦で滑らず安全に動ける");
    expect(stripTags(indoor)).toContain("天井・柱・他の利用者との接触の心配がない");
    expect(stripTags(indoor)).toContain("400m以上の直線距離（m）");
    expect(indoor).not.toContain('value="yes" selected=""');
    conditions.location = "PARK"; conditions.environment.straightMeters = 0;
    const park = renderMarkup(TrainingConditionsForm, { value: conditions, onChange: vi.fn() });
    expect(stripTags(park)).toContain("歩行者の混雑や遊具との接触の心配がない");
    expect(park).toContain('<option value="0" selected="">走れる直線なし</option>');
    expect(stripTags(park)).toContain("やや不調");
  });

  it("requires an explicit surface, offers event and recovery choices as selects, and warns before unconfirmed safety", () => {
    const html = renderMarkup(TrainingConditionsForm, { value: structuredClone(DEFAULT_TRAINING_CONDITIONS), onChange: vi.fn() });
    const text = stripTags(html);
    expect(html).toMatch(/<option value="" selected="">選択してください<\/option>/);
    expect(html).toContain('<option value="100m" selected="">100m</option>');
    for (const label of ["3日以上前・最近していない", "明日（大会前日）", "3回以上", "上級者（高度な動作に慣れている）",
      "安全に走れる平地の直線距離", "折り返しを含まない", "提案されません", "公園・広場", "自宅周辺・道路", "屋内・自宅", "手をつける安全な壁", "低強度・回復目的"]) expect(text).toContain(label);
    const saved = structuredClone(DEFAULT_TRAINING_CONDITIONS);
    saved.condition.hoursSinceHighIntensity = 50; saved.condition.competitionDays = 10; saved.athlete.event = "60m";
    saved.environment = { ...saved.environment, surface: "GRASS", flatSafe: true, trafficFree: true, obstacleFree: true };
    const reloaded = renderMarkup(TrainingConditionsForm, { value: saved, onChange: vi.fn() });
    expect(reloaded).toContain('<option value="48" selected="">2日前</option>');
    expect(reloaded).toContain('<option value="7" selected="">1〜2週間後</option>');
    expect(reloaded).toContain('<option value="OTHER" selected="">その他</option>');
    expect(reloaded).toContain('value="60m"');
    expect(reloaded).toContain('<option value="GRASS" selected="">芝生</option>');
    expect(stripTags(reloaded)).not.toContain("提案されません");
  });

  it("requires an explicit athlete 60m reference for controlled endurance", () => {
    const conditions = structuredClone(DEFAULT_TRAINING_CONDITIONS);
    conditions.goals = ["SPEED_ENDURANCE"]; conditions.primaryGoal = "SPEED_ENDURANCE";
    conditions.condition.speedEnduranceMode = "CONTROLLED_90_95";
    const html = renderMarkup(TrainingConditionsForm, { value: conditions, onChange: vi.fn() });
    expect(stripTags(html)).toContain("本人の現在の60m基準タイム（秒）");
    expect(stripTags(html)).toContain("走の処方を保留します");
    expect(html).toContain('<option value="60">60m</option>');
    expect(html).not.toContain('<option value="60" selected="">');
  });

  it("renders three optional sections and selection, editing, ordering and save controls", () => {
    const text = stripTags(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview() }));
    for (const name of TRAINING_SECTION_NAMES) expect(text).toContain(name);
    for (const label of ["すべて実施する必要はありません", "すべて選択", "すべて解除", "全選択", "削除", "上へ", "下へ", "登録種目を追加", "別の種目に入れ替える", "詳しい内容・編集", "強度の目安", "セット間休息（秒）", "選択した内容を保存"]) expect(text).toContain(label);
    expect(text).not.toMatch(/希望時間|計画時間|全体時間|90分/);
  });

  it("shows Engine intensity, full fly geometry, source and stop instruction before details", () => {
    const data = preview();
    const original = structuredClone(data.runningPrescription);
    const card = visibleRunningCard(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: data }));
    expect(card).toContain("50m × 計2本");
    expect(card).toContain("本間休息 240秒");
    expect(card).toContain("強度：全力を出す意図で、動作の質を保つ");
    expect(card).toContain("助走 20m ＋ フライ 10m ＋ 減速 20m");
    expect(card).toContain("目的：" + TRAINING_GOAL_LABELS.MAX_SPEED);
    expect(card).toContain("研究知見を参考にした暫定提案・コーチ承認前");
    expect(card).toContain(data.runningPrescription!.science!.stopInstruction);
    expect(card).not.toMatch(/強度：未指定|MAX_INTENT|SCIENCE_INFORMED_DEFAULT/);
    expect(data.runningPrescription).toEqual(original);
  });

  it("distinguishes total reps, each set and set-boundary rest in the visible card", () => {
    const result = planRunningPrescription({ event: "100m", ageGroup: "HIGH_SCHOOL", coachSetSplit: { setReps: [2, 2], setRestSeconds: 600 } });
    if (result.status !== "READY") throw new Error("Offline split fixture unavailable");
    const card = visibleRunningCard(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview(result.prescription) }));
    expect(card).toContain("60m × 計4本");
    expect(card).toContain("2セット（2本・2本）");
    expect(card).toContain("本間休息 240秒 / セット間休息 600秒");
    expect(card).toContain("前セット最後の走から次セット最初の走まで");
    expect(card).toContain("未指定。実施前に強度を確認してください。");
  });

  it("shows same-distance average-speed percentages without changing them into Vmax", () => {
    const result = planRunningPrescription({ event: "100m", ageGroup: "HIGH_SCHOOL", purpose: "SPEED_ENDURANCE", science: { ...scienceContext, speedEnduranceMode: "CONTROLLED_90_95", referenceDistanceMeters: 60, referenceTimeSeconds: 8 } });
    if (result.status !== "READY") throw new Error("Offline percentage fixture unavailable");
    const card = visibleRunningCard(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview(result.prescription) }));
    expect(card).toContain("90〜95%（同距離の平均速度を基準にする）");
    expect(card).toContain("目標タイムの目安：8.42〜8.89秒");
    expect(card).toContain("実測最高速度Vmaxの90–95%ではない");
  });

  it("includes only selected items in the adopted volume summary", () => {
    const data = preview(); data.selectedItemIds = ["strength-item"];
    const text = stripTags(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: data })).replace(/\s+/g, " ");
    const adopted = text.split("採用する内容")[1];
    expect(adopted).toContain("1種目");
    expect(adopted).toContain("走は未選択");
    expect(adopted).not.toMatch(/計100m|2本/);
  });

  it("offers existing items only in their own replacement picker and excludes unavailable equipment", () => {
    const html = renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview() });
    expect(html.match(/<option value="exercise-a">/g)).toHaveLength(1);
    expect(html.match(/<option value="movement-a">/g)).toHaveLength(1);
    expect(html.match(/<option value="movement-b">/g)).toHaveLength(2);
    expect(html).not.toContain('<option value="step-a">');
    expect(stripTags(html)).toContain("登録された秒数で量を指定します");
    expect(stripTags(html)).toContain("登録された回数で量を指定します");
  });

  it("keeps catalog descriptions intact and suppresses unsafe video links", () => {
    const rows = catalog.map(row => ({ ...row, videoUrl: "javascript:alert(1)" }));
    const html = renderMarkup(TrainingProposalComposer, { catalog: rows, initialPreview: preview() });
    expect(stripTags(html)).toContain(catalog[0].description);
    expect(stripTags(html)).toContain(catalog[1].description);
    expect(html).not.toMatch(/href="javascript:|参考動画を見る/);
    expect(html).toContain('href="/exercises/exercise-a"');
  });

  it("translates diagnostic messages and disables adoption while saved running edits are checked", () => {
    const data = preview(); data.messages = ["STEP_DETAILS_UNCONFIRMED", "SURFACE_UNCONFIRMED", "NEW_INTERNAL_CODE"];
    data.coachEdit = { totalReps: 1 };
    const html = renderMarkup(TrainingProposalComposer, { catalog, initialPreview: data });
    const text = stripTags(html);
    expect(text).toContain("段差の高さ・安定性・安全性が未確認");
    expect(text).toContain("練習に使う路面が未確認");
    expect(text).not.toMatch(/STEP_DETAILS_UNCONFIRMED|SURFACE_UNCONFIRMED|NEW_INTERNAL_CODE/);
    expect(text).toContain("保存済みの走調整を確認しています");
    expect(html).toMatch(/<fieldset disabled=""[^>]*><legend[^>]*>練習候補の選択と編集/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>選択した内容を保存<\/button>/);
  });

  it.each([10, 20])("keeps the signed %im option and exposes only allowed proposal dose edits", distance => {
    const result = planRunningPrescription({ event: "100m", ageGroup: distance === 10 ? "ELEMENTARY" : "HIGH_SCHOOL", purpose: "ACCEL",
      science: distance === 10 ? { ...scienceContext, ageYears: 10, maturity: "UNKNOWN" } : { ...scienceContext, experience: "BEGINNER" } });
    if (result.status !== "READY") throw new Error("Offline short-distance fixture unavailable");
    const initial = result.prescription;
    expect(initial.distanceMeters).toBe(distance);
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
    const html = renderMarkup(RunningPolicyCoachEditor, { initial, onSubmit: vi.fn(), proposalSafety: true });
    expect(html).toContain(`<option value="${distance}" selected="">${distance}m</option>`);
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toMatch(new RegExp(`<input[^>]*min="1"[^>]*max="${initial.totalReps}"`));
    expect(html).toMatch(new RegExp(`<input[^>]*min="${initial.repRestSeconds! / 60}"`));
    expect(stripTags(html)).toContain("本数の削減と休息の延長");
    expect(stripTags(html)).not.toMatch(/目標タイム（秒）|目標範囲|セット分割|実行指示/);
  });

  it("preserves the existing unrestricted coach editor when proposalSafety is absent", () => {
    vi.mocked(useState).mockReturnValueOnce([true, vi.fn()]);
    const html = renderMarkup(RunningPolicyCoachEditor, { initial: running(), onSubmit: vi.fn() });
    expect(html).not.toMatch(/<select[^>]*disabled=""/);
    for (const label of ["目標タイム（秒）", "目標範囲", "セット分割", "実行指示"]) expect(stripTags(html)).toContain(label);
    expect(stripTags(html)).not.toContain("この提案では本数の削減");
  });

  it("keeps the client free of Engine calculation, infrastructure imports and browser storage", async () => {
    const fs = await import("node:fs");
    const client = ["src/components/menu/training-proposal-composer.tsx", "src/components/menu/training-conditions-form.tsx"]
      .map(file => fs.readFileSync(file, "utf8")).join("\n");
    expect(client).toMatch(/from ["']@\/actions\/training-proposal-actions["']/);
    expect(client).not.toMatch(/import (?!type)[^;]*from ["']@\/(?:infra|application)\//);
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie|\bfetch\s*\(|OPENAI|planRunningPrescription|createRunningMenuPreview/);
    expect(client).not.toMatch(/希望時間|availableTime|durationPlan|requestedTimeSeconds/);
  });
});
