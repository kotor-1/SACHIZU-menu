import rawCatalog from "./training-proposal-catalog.json";
import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { DEFAULT_TRAINING_CONDITIONS, type TrainingConditions } from "@/domain/training-proposal/conditions";
import type { TrainingComposerInput } from "@/application/training-proposal/generate";
import type { TrainingComposerOutput } from "@/domain/training-proposal/contracts";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";

export const TRAINING_TEST_KEY = "offline-training-proposal-test-signing-key-20261012";
export const trainingCatalog = rawCatalog.catalog as unknown as ComposerCatalogExercise[];
/** Explicit test answers. They are never assumptions inserted by the product. */
export function trainingCaseA(): TrainingConditions {
  const c = structuredClone(DEFAULT_TRAINING_CONDITIONS);
  c.environment = { ...c.environment, straightMeters: 100, surface: "TRACK", flatSafe: true, trafficFree: true, obstacleFree: true };
  c.athlete = { ...c.athlete, ageYears: 17, grade: "高校2年", experience: "EXPERIENCED", level: "INTERMEDIATE", maturity: "POST", supervised: true, familiarWithSprint: true };
  c.condition = { ...c.condition, fatigue: 2, hoursSinceHighIntensity: 72, hoursUntilNextHighIntensity: 72, highIntensitySessionsLast7Days: 1, competitionDays: 14 };
  return c;
}
export function trainingCases(): Record<string, TrainingConditions> {
  const a = trainingCaseA(), b = trainingCaseA(), c = trainingCaseA(), d = trainingCaseA(), e = trainingCaseA(), f = trainingCaseA(), g = trainingCaseA();
  b.location = "PARK"; b.environment.surface = "DIRT"; b.environment.straightMeters = 30;
  c.location = "SCHOOL"; c.environment.surface = "DIRT"; c.environment.straightMeters = 20;
  c.athlete = { ...c.athlete, ageGroup: "ELEMENTARY", ageYears: 10, grade: "小学4年", experience: "BEGINNER", level: "BEGINNER", maturity: "PRE" };
  c.goals = ["BASIC"]; c.primaryGoal = "BASIC";
  d.goals = ["MAX_SPEED"]; d.primaryGoal = "MAX_SPEED"; d.environment.straightMeters = 60; d.condition.fatigue = 1;
  e.location = "ROAD"; e.environment.surface = "ASPHALT"; e.environment.straightMeters = 20;
  e.environment.equipment = ["WALL"]; e.environment.wallStable = true; e.goals = ["MOVEMENT"]; e.primaryGoal = "MOVEMENT";
  f.goals = ["PRECOMP"]; f.primaryGoal = "PRECOMP"; f.condition = { ...f.condition, competitionDays: 1, fatigue: 7, load: "LIGHT" };
  g.location = "INDOOR"; g.environment.surface = "INDOOR"; g.environment.straightMeters = 0;
  g.athlete = { ...g.athlete, ageGroup: "JUNIOR_HIGH", ageYears: 14, grade: "中学2年" }; g.goals = ["STRENGTH"]; g.primaryGoal = "STRENGTH";
  return { A: a, B: b, C: c, D: d, E: e, F: f, G: g };
}

const preferredMovement = ["キャット&ドッグ", "下向き胸椎回旋", "ジャックナイフ", "インチワーム（手足歩き）", "アウトエッジウォーク",
  "片手付きランジから股関節&胸椎回旋", "引きつけ軌道確認", "ニーアップウォーク", "その場で挟み込み1回入れ替え（腕振りあり）", "高速タッピング"];
const preferredStrength = ["仰向けハンドプレス（腹圧・腰椎圧迫キープ）", "自重スクワット（手腰スクワット・基礎下肢強化）", "サイドアブダクション"];

/** Handwritten offline response. This is not evidence that Luna selected these items. */
export function offlineTrainingComposer(input: TrainingComposerInput): TrainingComposerOutput {
  function choose(rows: ComposerCatalogExercise[], target: number, preferred: string[], coverStages = false) {
    const families = new Set<string>();
    const selected: ComposerCatalogExercise[] = [];
    const ranked = [...rows].sort((a, b) => {
      const rank = (row: ComposerCatalogExercise) => preferred.includes(row.name) ? preferred.indexOf(row.name) : 100;
      return rank(a) - rank(b) || (a.difficulty ?? 9) - (b.difficulty ?? 9);
    });
    if (coverStages) for (const stage of [...new Set(rows.map(row => input.stages[row.id]))]) {
      const row = ranked.find(row => input.stages[row.id] === stage && !families.has(input.families[row.id]));
      if (row) { families.add(input.families[row.id]); selected.push(row); }
    }
    for (const row of ranked) {
      if (selected.length >= target) break;
      if (families.has(input.families[row.id])) continue;
      families.add(input.families[row.id]); selected.push(row);
      if (selected.length >= target) break;
    }
    return selected.sort((a, b) => input.stages[a.id] - input.stages[b.id]).map(row => {
      const { item, annotation } = suggestCatalogItem(row, input.conditions, "fixture-item");
      const { id: _id, ...proposal } = item; void _id;
      return { item: proposal, intensity: annotation.intensity, relationship: annotation.relationship, alternativeGroup: annotation.alternativeGroup };
    });
  }
  return { movement: input.requestedMovement ? choose(input.movement, input.requestedMovement, preferredMovement, input.requiredMovement >= 10) : [],
    strength: input.requestedStrength ? choose(input.strength, input.requestedStrength, preferredStrength) : [],
    explanation: "選択した主目的に向け、可動域から支持・協調、接地へ進める。補強は必要なものを選び、併用の量を調整する。",
    uncertainty: "手書きoffline fixture。数量は登録動作に基づく編集可能な仮提案であり、実Lunaの生成結果ではない。" };
}
