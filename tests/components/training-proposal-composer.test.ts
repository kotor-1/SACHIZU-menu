import { describe, expect, it, vi } from "vitest";
import { renderMarkup, stripTags } from "../presentation/running/helpers";

vi.mock("react", async importOriginal => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

vi.mock("@/actions/training-proposal-actions", () => ({ generateTrainingProposalAction: vi.fn(), saveTrainingProposalAction: vi.fn(), previewTrainingRunningCoachEditAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { TrainingProposalComposer } from "@/components/menu/training-proposal-composer";
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
  it("asks only five questions before generation, and says what it assumes", () => {
    const html = renderMarkup(TrainingProposalComposer, { catalog });
    const text = stripTags(html).replace(/\s+/g, " ");
    for (const title of ["場所", "走れる直線", "選手", "目的", "今日の状態"]) expect(text).toContain(title);
    expect(html.match(/<fieldset class="min-w-0 border-t-2/g)).toHaveLength(5);
    expect(html.match(/type="radio"/g)).toHaveLength(5 + 8 + 6 + 9 + 4);
    expect(html.match(/type="radio"[^>]*checked=""/g)).toHaveLength(5);
    for (const label of ["陸上競技場", "トラック1周", "高校生（経験あり）", "加速", "元気"]) expect(text).toContain(label);
    expect(text).toContain("車や自転車が来ず、障害物のない場所で、コーチが見守る前提で提案します");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>安全を確認して提案する<\/button>/);
    expect(text).not.toMatch(/競技経験|成長段階|前回の高強度練習|補足・希望|未確認|希望時間|計画時間|90分/);
  });

  it("shows the reasons and a way back when nothing can be proposed", () => {
    const data = preview(); data.composition = { blocks: data.composition.blocks.map(block => ({ ...block, items: [] })) };
    data.selectedItemIds = []; data.messages = ["痛みまたは体調不良が選択されているため、動きづくり・走・補強の提案を保留しています。"];
    const text = stripTags(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: data })).replace(/\s+/g, " ");
    expect(text).toContain("提案できる練習がありませんでした");
    expect(text).toContain("痛みまたは体調不良が選択されているため");
    expect(text).not.toContain("採用する内容");
  });





  it("renders three optional sections and selection, editing, ordering and save controls", () => {
    const text = stripTags(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview() }));
    for (const name of TRAINING_SECTION_NAMES) expect(text).toContain(name);
    for (const label of ["組み合わせを選んで、メニューにする", "すべて実施する必要はありません", "すべて選択", "すべて解除", "全選択", "削除", "上へ", "下へ", "登録種目を追加", "別の種目に入れ替える", "詳しい内容・編集", "強度の目安", "セット間休息（秒）", "選択した内容を保存"]) expect(text).toContain(label);
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

  it("shows zero rest as continuous work instead of a 0-second rest", () => {
    const data = preview();
    const first = data.composition.blocks[0].items[0];
    if (first.type === "CATALOG_EXERCISE") first.plannedRestSeconds = 0;
    const text = stripTags(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: data }));
    expect(text).toContain("休息なし（続けて行う）");
    expect(text).not.toContain("休息 0秒");
  });

  it("includes only selected items in the adopted volume summary", () => {
    const data = preview(); data.selectedItemIds = ["strength-item"];
    const text = stripTags(renderMarkup(TrainingProposalComposer, { catalog, initialPreview: data })).replace(/\s+/g, " ");
    const adopted = text.split("採用する内容")[1];
    expect(adopted).toContain("1種目");
    expect(adopted).toContain("走は未選択");
    expect(adopted).not.toMatch(/計100m|2本/);
  });

  it("never offers an item already in the menu, resets with its own button, and excludes unavailable equipment", () => {
    const html = renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview() });
    expect(html).not.toContain('<option value="exercise-a">');
    expect(html).not.toContain('<option value="movement-a">');
    expect(html.match(/<option value="movement-b">/g)).toHaveLength(2);
    expect(stripTags(html).match(/提案時の値に戻す/g)).toHaveLength(2);
    expect(html).not.toContain('<option value="step-a">');
    expect(stripTags(html)).toContain("登録された秒数で量を指定します");
    expect(stripTags(html)).toContain("登録された回数で量を指定します");
  });

  it("tells same-name registrations apart in the pickers", () => {
    const rows = [...catalog, catalogFixture({ id: "movement-a2", name: "足首回し", category: "MOBILITY", description: "かかとを上げ下げしながら、足首をゆっくり大きく回して可動域を確認する。", metricType: "REPS", defaultDurationSeconds: null, defaultReps: 6 })];
    const html = renderMarkup(TrainingProposalComposer, { catalog: rows, initialPreview: preview() });
    expect(html).toContain('<option value="movement-b">足首回し（足首を小さく回す。）</option>');
    expect(html).toContain('<option value="movement-a2">足首回し（かかとを上げ下げしながら、足首をゆっ…）</option>');
  });

  it("shows the exercise video first as a light thumbnail, and keeps long text folded", () => {
    const html = renderMarkup(TrainingProposalComposer, { catalog, initialPreview: preview() });
    // Both exercise items carry the fixture's YouTube link; nothing heavy loads until a thumbnail is pressed.
    expect(html.match(/<img src="https:\/\/i\.ytimg\.com\/vi\/abcdefghijk\/mqdefault\.jpg"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-label="肩回しの動画を再生"/);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("お手本動画あり");
    const card = html.split('data-training-item="movement-item"')[1].split("</article>")[0];
    const folded = card.split("説明文とメモ")[1];
    for (const label of ["強度の目安", "実施指示", "メモ", "種目の基本説明"]) {
      expect(card.split("説明文とメモ")[0]).not.toContain(`>${label}<`);
      expect(folded).toContain(label);
    }
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
    const client = ["src/components/menu/training-proposal-composer.tsx", "src/components/menu/simple-conditions-form.tsx"]
      .map(file => fs.readFileSync(file, "utf8")).join("\n");
    expect(client).toMatch(/from ["']@\/actions\/training-proposal-actions["']/);
    expect(client).not.toMatch(/import (?!type)[^;]*from ["']@\/(?:infra|application)\//);
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie|\bfetch\s*\(|OPENAI|planRunningPrescription|createRunningMenuPreview/);
    expect(client).not.toMatch(/希望時間|availableTime|durationPlan|requestedTimeSeconds/);
  });
});
