/**
 * R4 PROPERTY / BOUNDARY グリッド（§20.1）と 38 template の到達可能性監査。
 * fast-check を使わず、列挙値の全組み合わせで決定的に検証する。
 *
 * ## PROPERTY グリッド（フィルタなしの完全な直積）
 *   axis                 要素数  値
 *   template             38     RuleSet の全 SessionTemplate（10 Method）
 *   actor                3      COACH / AI_PLANNER / SYSTEM
 *   maturity             4      PRE / EFFECTIVE_UNKNOWN（UNKNOWN・LOW）/ CIRCA / POST（HIGH）
 *   trainingAge          4      BEGINNER(0.5年) / DEVELOPING(2年) / TRAINED(4年) / ADVANCED(コーチ割当)
 *   data                 2      NONE / MEASURED（FLY20 PHOTO_CELL・200m FAT・400m FAT）
 *   positionPreference   2      null / LOWER
 *   → 基本組み合わせ 38×3×4×4×2×2 = 7,296 件（phase=null で評価し、PROPERTY を検査）
 *   phase                5      null + TRAINING_PHASES 4期。R4 は phase 未接続なので、4期それぞれで再計画し
 *                               phase=null の結果と完全一致することを検査（追加 7,296×4 = 29,184 件、計 36,480 回の計画）
 *   EnvelopeTier（DEVELOPMENTAL / ADVANCED）は maturity × trainingAge から R3 が導出する（POST × TRAINED/ADVANCED のみ ADVANCED）。
 *   年齢帯は U18（2009-06-01 生、年齢帯の追加制約なし）に固定。年齢帯の制約は下の到達可能性監査と T-POP-07 で扱う。
 *   COACH のときだけ、参照や手動専用セルが必要な template にテンプレート別のコーチ入力を付ける（フィルタではない）。
 *
 * OK の処方すべてで §20.1 PROPERTY の6条件を検証する:
 *   ① エンジンが置いた値（ENGINE_POSITIONED / SOLVER_DERIVED）は recommended 内。template 固定値・構造正規化値は
 *     Finding 付きの明示的例外、コーチ入力は coachEditable 内
 *   ② エンジンが置いた rest の位置は MIDDLE 以上
 *   ③ hardSafety を超えない
 *   ④ LONG 以外は recoveryStructure=null（LONG は非 null）
 *   ⑤ MAX_INTENT（および RELAXED_SUBMAX / MAX_VELOCITY）は数値目標を持たない
 *   ⑥ sets / repsPerSet は非 null の正の整数
 */
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { planRunningPrescription } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import { selectEnvelope } from "@/domain/running/planning/envelope";
import { placeValue, positionPoint } from "@/domain/running/planning/placement";
import { validatePrescriptionAgainstRuleSet } from "@/domain/running/planning/validatePrescription";
import { resolveEligibility } from "@/domain/running/context/constraints";
import { resolveSubjectProfile } from "@/domain/running/context/subject";
import { getActiveRuleSet, getRuleSet } from "@/domain/running/rules/loader";
import type { RuleSetSessionTemplate } from "@/domain/running/rules/schema";
import { createCoachActor } from "@/domain/running/types/actor";
import { runningPrescriptionSchema, type FieldValue, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";
import type { IsoDate, Unit } from "@/domain/running/types/primitives";
import type { TimedMark } from "@/domain/running/types/intensity";
import { TRAINING_PHASES } from "@/domain/menu/constants";

const ruleSet = getRuleSet("rs-2026.09.0")!;
const CONTENT_HASH = getActiveRuleSet("2026-09-15").contentHash;
const iso = (v: string) => v as IsoDate;

const COACH = createCoachActor("grid-coach");
const AI = { kind: "AI_PLANNER", provider: "grid", model: "grid", requestId: "grid" } as const;
const SYSTEM = { kind: "SYSTEM" } as const;
type GridActor = typeof COACH | typeof AI | typeof SYSTEM;

const MATURITY = {
  PRE: { status: "PRE", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
  EFFECTIVE_UNKNOWN: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
  CIRCA: { status: "CIRCA", confidence: "MEDIUM", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
  POST: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
} as const;
type MaturityKey = keyof typeof MATURITY;

const TRAINING_AGE = {
  BEGINNER: { structuredSprintYears: 0.5 },
  DEVELOPING: { structuredSprintYears: 2 },
  TRAINED: { structuredSprintYears: 4 },
  ADVANCED: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
} as const;
type TrainingAgeKey = keyof typeof TRAINING_AGE;

const MEASURED_MARKS: TimedMark[] = [
  { event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" },
  { event: "200m", timeS: 24.0, date: iso("2026-07-01"), timing: "FAT" },
  { event: "400m", timeS: 52.0, date: iso("2026-07-01"), timing: "FAT" },
];
const DATA_VARIANTS = { NONE: [] as TimedMark[], MEASURED: MEASURED_MARKS };
type DataKey = keyof typeof DATA_VARIANTS;

type Phase = (typeof TRAINING_PHASES)[number] | null;
type CoachInputs = { coachReference: unknown; coachEdits: unknown[] };

const split = (segments: [number, number, number][]) => ({
  kind: "TARGET_SPLIT",
  segments: segments.map(([distanceM, lower, upper]) => ({ distanceM, targetS: { lower, upper, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } })),
});

/**
 * COACH のときだけ付けるテンプレート別のコーチ入力（手動専用セルや参照が必要な template 用）。
 * RuleSet の構造化データ（Method / recoveryStructure / resistanceBand / fixedDistanceField）から決める。
 */
function coachInputsFor(template: RuleSetSessionTemplate): CoachInputs {
  switch (template.method) {
    case "LONG_SPRINT_RACE_SPECIFIC":
      return {
        coachReference: template.recoveryStructure === "INCOMPLETE" ? split([[300, 36, 38], [100, 13, 14]]) : split([[300, 36, 38]]),
        coachEdits: [],
      };
    case "RESISTED_SPRINT":
      return template.resistanceBand === null
        ? { coachReference: null, coachEdits: [] }
        : { coachReference: { kind: "VELOCITY_DECREMENT", band: template.resistanceBand, measured: true }, coachEdits: [] };
    case "EVENT_APPROACH_SPEED":
      return { coachReference: { kind: "COACH_DEFINED", label: "グリッド用の助走" }, coachEdits: [{ field: "approachDistanceM", value: 30, unit: "m" }] };
    case "TEMPO_INTENSIVE":
      return template.fixedDistanceField === null
        ? {
            coachReference: null,
            coachEdits: [
              { field: "repDistanceM", value: 150, unit: "m" },
              { field: "repsPerSet", value: 3, unit: "reps" },
              { field: "sets", value: 1, unit: "sets" },
              { field: "repRestS", value: 180, unit: "s" },
              { field: "intensityPercent", value: 85, unit: "percent" },
            ],
          }
        : { coachReference: null, coachEdits: [] };
    case "ASSISTED_SPRINT":
      return {
        coachReference: null,
        coachEdits: [
          { field: "buildUpM", value: 30, unit: "m" },
          { field: "flyZoneM", value: 20, unit: "m" },
          { field: "totalReps", value: 3, unit: "reps" },
          { field: "repRestS", value: 600, unit: "s" },
          { field: "intensityPercent", value: 102, unit: "percent" },
        ],
      };
    default:
      return { coachReference: null, coachEdits: [] };
  }
}

function subjectFor(maturity: MaturityKey, trainingAge: TrainingAgeKey, data: DataKey, extra: Partial<AthleteProfile> = {}): Subject {
  const profile: AthleteProfile = {
    birthDate: iso("2009-06-01"), // 2026-09-15 時点で 17歳（U18。年齢帯の追加制約なし）
    primaryEvent: "400m",
    maturity: MATURITY[maturity],
    trainingAge: TRAINING_AGE[trainingAge],
    marks: DATA_VARIANTS[data],
    vmax: null,
    allowAdvancedMethods: true,
    ...extra,
  };
  return { kind: "ATHLETE", profile };
}

function templateById(templateId: string): RuleSetSessionTemplate {
  return ruleSet.templates.find((t) => t.id === templateId)!;
}

function request(
  method: string,
  templateId: string,
  subject: Subject,
  actor: GridActor,
  preference: "LOWER" | null,
  phase: Phase,
  coach: CoachInputs | null = null,
): PlanRequest {
  const inputs = actor.kind === "COACH" ? (coach ?? coachInputsFor(templateById(templateId))) : { coachReference: null, coachEdits: [] };
  return {
    planningDate: iso("2026-09-15"),
    selection: { method, templateId },
    subject,
    menuContext: { phase, plannedDate: null, competitions: [], otherItems: [], availableMinutes: null },
    history: null,
    readiness: null,
    positionPreference: preference,
    coachEdits: inputs.coachEdits,
    overrides: [],
    coachReference: inputs.coachReference,
    actor,
  } as unknown as PlanRequest;
}

type FieldRecord = { name: string; rest: boolean; fv: FieldValue<Unit> };

function collectFieldValues(p: RunningPrescriptionValue): FieldRecord[] {
  const out: FieldRecord[] = [
    { name: "sets", rest: false, fv: p.sets },
    { name: "repsPerSet", rest: false, fv: p.repsPerSet },
    { name: "repRestS", rest: true, fv: p.rest.repRestS },
  ];
  if (p.rest.setRestS) out.push({ name: "setRestS", rest: true, fv: p.rest.setRestS });
  if (p.rest.intraRepRestS) out.push({ name: "intraRepRestS", rest: true, fv: p.rest.intraRepRestS });
  const rep = p.rep;
  switch (rep.kind) {
    case "DISTANCE":
      out.push({ name: "repDistanceM", rest: false, fv: rep.distanceM });
      break;
    case "FLY":
      out.push({ name: "buildUpM", rest: false, fv: rep.buildUpDistanceM }, { name: "flyZoneM", rest: false, fv: rep.flyZoneDistanceM });
      break;
    case "DURATION":
      out.push({ name: "repDurationS", rest: false, fv: rep.durationS });
      break;
    case "SPLIT":
      rep.segments.forEach((s, i) => {
        if (s.restAfterS) out.push({ name: `segments[${i}].restAfterS`, rest: true, fv: s.restAfterS });
      });
      break;
    case "ATTEMPTS":
      break;
  }
  return out;
}

const within = (v: number, r: { min: number; max: number } | null) => r !== null && v >= r.min - 1e-9 && v <= r.max + 1e-9;

function checkOkPrescription(p: RunningPrescriptionValue, label: string, req: PlanRequest): void {
  const autogenActor = req.actor.kind !== "COACH";

  expect(runningPrescriptionSchema.safeParse(p).success, label).toBe(true);
  expect(validatePrescriptionAgainstRuleSet(p, ruleSet, CONTENT_HASH), label).toEqual([]);
  expect(p.ruleSet, label).toEqual({ version: "rs-2026.09.0", contentHash: CONTENT_HASH, status: "DRAFT" });

  const codes = p.findings.map((f) => f.code);
  const records = collectFieldValues(p);

  for (const { name, rest, fv } of records) {
    const where = `${label} ${name}`;
    expect(fv.position !== null, `${where} position↔origin`).toBe(fv.origin === "ENGINE_POSITIONED");
    switch (fv.origin) {
      // ① エンジンの値は recommended 内
      case "ENGINE_POSITIONED":
      case "SOLVER_DERIVED":
        expect(within(fv.value, fv.recommended), where).toBe(true);
        break;
      // ① 明示的な例外（Finding 付き）
      case "TEMPLATE_FIXED":
        expect(
          within(fv.value, fv.recommended) || p.findings.some((f) => f.code === "TEMPLATE_FIXED_OUTSIDE_RECOMMENDED" && f.metric === name),
          where,
        ).toBe(true);
        expect(within(fv.value, fv.coachEditable), where).toBe(true);
        break;
      case "STRUCTURAL_FIXED":
        expect(within(fv.value, fv.recommended) || codes.includes("STRUCTURAL_VALUE_OUTSIDE_RECOMMENDED"), where).toBe(true);
        expect(within(fv.value, fv.coachEditable), where).toBe(true);
        break;
      case "COACH":
        expect(req.actor.kind, where).toBe("COACH");
        expect(within(fv.value, fv.coachEditable), where).toBe(true);
        break;
      case "COACH_OVERRIDE":
        throw new Error(`${where}: COACH_OVERRIDE without overrides in the grid`);
    }
    // recommended=null のセルにエンジン値が無い
    if (fv.recommended === null) expect(fv.origin, where).toBe("COACH");
    // ② rest は MIDDLE 以上
    if (rest && fv.origin === "ENGINE_POSITIONED") {
      expect(["MIDDLE", "UPPER_HALF"], where).toContain(fv.position);
      expect(fv.value, where).toBeGreaterThanOrEqual(positionPoint(fv.recommended!, "MIDDLE") - 1e-9);
    }
    // ③ hardSafety を超えない
    if (fv.hardSafety !== null) expect(within(fv.value, fv.hardSafety), where).toBe(true);
  }

  // ④ recoveryStructure
  if (p.method === "LONG_SPRINT_RACE_SPECIFIC") expect(p.recoveryStructure, label).not.toBeNull();
  else expect(p.recoveryStructure, label).toBeNull();

  // ⑤ 数値目標なし
  const refKind = p.intensity.reference.kind;
  if (refKind === "MAX_INTENT" || refKind === "RELAXED_SUBMAX" || p.method === "MAX_VELOCITY") {
    expect(p.intensity.target, label).toBeNull();
  }
  // データ不要の参照を HIGH と偽装しない
  if (refKind === "MAX_INTENT" || refKind === "RELAXED_SUBMAX") {
    expect(["NOT_REQUIRED", "LOW"], label).toContain(p.confidence.inputData);
  }

  // ⑥ sets / repsPerSet
  for (const fv of [p.sets, p.repsPerSet]) {
    expect(Number.isInteger(fv.value) && fv.value >= 1, label).toBe(true);
  }

  // v2 初期（全 Evidence が SECONDARY_REPORT_ONLY）では HIGH にならない（T-POP-06）
  expect(p.confidence.prescription, label).not.toBe("HIGH");

  // monitoring snapshot（§17.1）
  expect(p.monitoringSnapshot.stopPolicy.id, label).toBe(p.stopPolicyId);
  expect(p.monitoringSnapshot.timingTolerances.length, label).toBe(ruleSet.timingTolerances.length);

  // T-EV-02: LOW / POLICY_ONLY → 回数・距離・時間は LOWER_HALF 以下、REQUIRE_COACH_REVIEW
  if (p.confidence.prescription === "LOW" || p.confidence.prescription === "POLICY_ONLY") {
    expect(p.findings.some((f) => f.severity === "REQUIRE_COACH_REVIEW"), label).toBe(true);
    for (const { name, rest, fv } of records) {
      if (!rest && fv.origin === "ENGINE_POSITIONED") {
        expect(["LOWER_BOUND", "LOWER_HALF"], `${label} ${name}`).toContain(fv.position);
      }
    }
    const env = selectEnvelope(ruleSet, req.selection, p.tier, p.recoveryStructure);
    if (!env.ok) throw new Error(label);
    const totalCell = env.envelope.fields.totalReps ?? env.envelope.fields.attempts;
    const countsFromEngine = [p.sets, p.repsPerSet].every((fv) => fv.origin === "SOLVER_DERIVED" || fv.origin === "STRUCTURAL_FIXED");
    if (totalCell?.recommended && countsFromEngine) {
      expect(p.sets.value * p.repsPerSet.value, label).toBeLessThanOrEqual(placeValue(totalCell.recommended, "LOWER_HALF", "COUNT"));
    }
  }

  // AI / SYSTEM boundary（§18.4）
  if (autogenActor) {
    expect(codes.some((c) => c === "ELIGIBILITY_MANUAL_SELECTION" || c === "ELIGIBILITY_MANUAL_REVIEW" || c === "ELIGIBILITY_OVERRIDDEN"), label).toBe(false);
    expect(p.method, label).not.toBe("ASSISTED_SPRINT");
    expect(p.generatedBy.proposer.kind, label).toBe(req.actor.kind === "AI_PLANNER" ? "AI_PLANNER" : "ENGINE");
    expect(p.generatedBy.createdByCoach, label).toBe(false);
    const methodMeta = ruleSet.methods.find((m) => m.method === p.method)!;
    if (methodMeta.loadClass === "HIGH_METABOLIC") {
      expect(["LOW", "POLICY_ONLY"], label).not.toContain(p.confidence.prescription);
    }
    // AI が OK なら、その選手のカテゴリで R2 の eligibility は AUTO の行でなければならない
    const profile = resolveSubjectProfile({ subject: req.subject, asOf: req.planningDate, ruleSet });
    for (const category of profile.effectiveMaturityCategories) {
      expect(resolveEligibility(ruleSet, p.method, p.templateId, category).mode, label).toBe("AUTO");
    }
  } else {
    expect(p.generatedBy, label).toEqual({ proposer: { kind: "ENGINE" }, createdByCoach: true, acceptedByCoachAt: null });
  }

  // T-EV-03: Moran 16本が自動処方されない
  if (p.method === "ACCELERATION") expect(p.sets.value * p.repsPerSet.value, label).not.toBe(16);

  // STRIDE
  if (p.method === "STRIDE") {
    expect(refKind, label).toBe("RELAXED_SUBMAX");
    expect(p.exposure.plannedHighSpeedExposureM, label).toEqual({ lower: 0, upper: 0, unit: "m", source: "RULE_DEFINITION", confidence: "HIGH" });
  }
}

// ---------------------------------------------------------------------------
// 集計（件数の監査用。環境変数 R4_GRID_REPORT に出力先パスを指定したときだけ JSON を書き出す）
// ---------------------------------------------------------------------------

type StatusCounts = { OK: number; INELIGIBLE: number; BLOCKED: number };
const newCounts = (): StatusCounts => ({ OK: 0, INELIGIBLE: 0, BLOCKED: 0 });

const grid = {
  basePlans: 0,
  phaseReplans: 0,
  byStatus: newCounts(),
  byActor: {} as Record<string, StatusCounts>,
  byTemplate: {} as Record<string, StatusCounts>,
  byMethodActorOk: {} as Record<string, number>,
  tiersSeenByTemplate: {} as Record<string, Set<string>>,
  maturitySeen: new Set<string>(),
  trainingAgeSeen: new Set<string>(),
  phasesSeen: new Set<string>(),
};
const reachability: Record<string, unknown> = {};

afterAll(() => {
  if (process.env.R4_GRID_REPORT) {
    const serializable = {
      ...grid,
      tiersSeenByTemplate: Object.fromEntries(Object.entries(grid.tiersSeenByTemplate).map(([k, v]) => [k, [...v]])),
      maturitySeen: [...grid.maturitySeen],
      trainingAgeSeen: [...grid.trainingAgeSeen],
      phasesSeen: [...grid.phasesSeen],
    };
    fs.writeFileSync(process.env.R4_GRID_REPORT, JSON.stringify({ grid: serializable, reachability }, null, 1));
  }
});

const MATURITY_KEYS = Object.keys(MATURITY) as MaturityKey[];
const TRAINING_AGE_KEYS = Object.keys(TRAINING_AGE) as TrainingAgeKey[];
const DATA_KEYS = Object.keys(DATA_VARIANTS) as DataKey[];

describe("R4 planning grid（§20.1 PROPERTY / BOUNDARY）", () => {
  for (const template of ruleSet.templates) {
    for (const actor of [COACH, AI, SYSTEM] as const) {
      it(`${template.id} × ${actor.kind}`, () => {
        for (const maturity of MATURITY_KEYS) {
          for (const trainingAge of TRAINING_AGE_KEYS) {
            for (const data of DATA_KEYS) {
              const subject = subjectFor(maturity, trainingAge, data);
              const tier = resolveSubjectProfile({ subject, asOf: iso("2026-09-15"), ruleSet }).envelopeTier;
              for (const preference of [null, "LOWER"] as const) {
                const label = `${template.id}/${actor.kind}/${maturity}/${trainingAge}/${data}/${preference}`;
                const base = request(template.method, template.id, subject, actor, preference, null);
                const result: PlanResult = planRunningPrescription(base);
                grid.basePlans += 1;
                grid.phasesSeen.add("null");

                // phase は値に影響しない（R7 未接続）
                for (const phase of TRAINING_PHASES) {
                  const withPhase = planRunningPrescription(request(template.method, template.id, subject, actor, preference, phase));
                  grid.phaseReplans += 1;
                  grid.phasesSeen.add(phase);
                  expect(withPhase, `${label}/phase=${phase}`).toEqual(result);
                }

                grid.byStatus[result.status] += 1;
                (grid.byActor[actor.kind] ??= newCounts())[result.status] += 1;
                (grid.byTemplate[template.id] ??= newCounts())[result.status] += 1;
                (grid.tiersSeenByTemplate[template.id] ??= new Set()).add(tier);
                grid.maturitySeen.add(maturity);
                grid.trainingAgeSeen.add(trainingAge);

                const resultFindings = result.status === "OK" ? result.prescription.findings : result.findings;
                expect(resultFindings.map((f) => f.code), label).toContain("RULESET_DRAFT");
                if (result.status === "OK") {
                  const key = `${template.method}/${actor.kind}`;
                  grid.byMethodActorOk[key] = (grid.byMethodActorOk[key] ?? 0) + 1;
                  checkOkPrescription(result.prescription, label, base);
                } else if (result.status === "INELIGIBLE") {
                  expect(result.reasons.length, label).toBeGreaterThan(0);
                  expect(result.substitutes, label).toEqual([]);
                } else {
                  expect(result.findings.some((f) => f.severity === "BLOCK" || f.severity === "BLOCK_AUTOGEN"), label).toBe(true);
                }
              }
            }
          }
        }
      });
    }
  }

  it("件数とカバレッジの監査: 直積どおりに実行され、全 template で両 tier・全 maturity・全 trainingAge・全 phase を通っている", () => {
    expect(grid.basePlans).toBe(38 * 3 * 4 * 4 * 2 * 2);
    expect(grid.phaseReplans).toBe(grid.basePlans * TRAINING_PHASES.length);
    expect(grid.byStatus.OK + grid.byStatus.INELIGIBLE + grid.byStatus.BLOCKED).toBe(grid.basePlans);
    expect(Object.keys(grid.byTemplate)).toHaveLength(38);
    for (const [templateId, tiers] of Object.entries(grid.tiersSeenByTemplate)) {
      expect([...tiers].sort(), templateId).toEqual(["ADVANCED", "DEVELOPMENTAL"]);
    }
    expect(grid.maturitySeen.size).toBe(4);
    expect(grid.trainingAgeSeen.size).toBe(4);
    expect(grid.phasesSeen.size).toBe(1 + TRAINING_PHASES.length);

    for (const method of ruleSet.methods.map((m) => m.method)) {
      expect(grid.byMethodActorOk[`${method}/COACH`] ?? 0, method).toBeGreaterThan(0);
    }
    for (const method of ["ACCELERATION", "MAX_VELOCITY", "TEMPO_EXTENSIVE", "RESISTED_SPRINT", "STRIDE"]) {
      expect(grid.byMethodActorOk[`${method}/AI_PLANNER`] ?? 0, method).toBeGreaterThan(0);
    }
    for (const method of ["ASSISTED_SPRINT", "EVENT_APPROACH_SPEED", "TEMPO_INTENSIVE", "SPRINT_ENDURANCE_SHORT"]) {
      expect(grid.byMethodActorOk[`${method}/AI_PLANNER`] ?? 0, method).toBe(0);
      expect(grid.byMethodActorOk[`${method}/SYSTEM`] ?? 0, method).toBe(0);
    }
    // SYSTEM は AI_PLANNER と同じ自動生成制限（generatedBy だけが違う）
    expect(grid.byActor.SYSTEM).toEqual(grid.byActor.AI_PLANNER);
  });
});

// ---------------------------------------------------------------------------
// 38 template の到達可能性監査（数値を広げて ENVELOPE_INFEASIBLE を隠さない）
// ---------------------------------------------------------------------------

const REACH_BIRTH = { U12: "2016-01-01", U15: "2012-01-01", U18: "2009-06-01", ADULT: "1998-01-01" } as const;

type ReachClass = "AUTO_REACHABLE" | "COACH_MANUAL_REACHABLE" | "INTENTIONALLY_MANUAL_ONLY" | "UNREACHABLE";

/** コーチが回数を coachEditable 内で入力する候補（エンジンの位置上限で解が無い場合の手動経路）。 */
function coachCountVariants(template: RuleSetSessionTemplate, subject: Subject): CoachInputs[] {
  const base = coachInputsFor(template);
  const profile = resolveSubjectProfile({ subject, asOf: iso("2026-09-15"), ruleSet });
  const env = selectEnvelope(ruleSet, { method: template.method, templateId: template.id } as PlanRequest["selection"], profile.envelopeTier, template.recoveryStructure);
  if (!env.ok) return [base];
  const f = env.envelope.fields;
  const edited = new Set((base.coachEdits as { field: string }[]).map((e) => e.field));
  const variants: CoachInputs[] = [base];
  const bounds = (cell: NonNullable<typeof f.totalReps>) =>
    [...new Set([cell.recommended?.min, cell.recommended?.max, cell.coachEditable.min, cell.coachEditable.max].filter((v): v is number => v !== undefined && v >= 1))];
  const total = f.totalReps ? { field: "totalReps", cell: f.totalReps } : f.attempts ? { field: "attempts", cell: f.attempts } : null;
  if (total && !edited.has(total.field)) {
    for (const v of bounds(total.cell)) variants.push({ ...base, coachEdits: [...base.coachEdits, { field: total.field, value: v, unit: "reps" }] });
  } else if (!total && f.sets && f.repsPerSet && !edited.has("sets")) {
    for (const s of bounds(f.sets)) {
      for (const r of bounds(f.repsPerSet)) {
        variants.push({ ...base, coachEdits: [...base.coachEdits, { field: "sets", value: s, unit: "sets" }, { field: "repsPerSet", value: r, unit: "reps" }] });
      }
    }
  }
  return variants;
}

describe("R4 template reachability audit（38 template）", () => {
  const classes: Record<string, ReachClass> = {};

  for (const template of ruleSet.templates) {
    it(template.id, () => {
      let aiOk = 0;
      let coachOkContexts = 0;
      const aiOutcomes: Record<string, number> = {};
      const aiPassedEligibility: Record<string, number> = {};
      for (const birthDate of Object.values(REACH_BIRTH)) {
        for (const maturity of MATURITY_KEYS) {
          for (const trainingAge of TRAINING_AGE_KEYS) {
            for (const data of DATA_KEYS) {
              for (const allowAdvancedMethods of [true, false]) {
                for (const primaryEvent of ["400m", "100m"] as const) {
                  const subject = subjectFor(maturity, trainingAge, data, { birthDate: iso(birthDate), allowAdvancedMethods, primaryEvent });
                  for (const preference of [null, "LOWER"] as const) {
                    const ai = planRunningPrescription(request(template.method, template.id, subject, AI, preference, null));
                    const outcome =
                      ai.status === "OK" ? "OK" : ai.status === "INELIGIBLE" ? `INELIGIBLE:${ai.reasons[0].code}` : `BLOCKED:${ai.findings.find((f) => f.severity !== "INFO")?.code}`;
                    aiOutcomes[outcome] = (aiOutcomes[outcome] ?? 0) + 1;
                    if (ai.status !== "INELIGIBLE") aiPassedEligibility[outcome] = (aiPassedEligibility[outcome] ?? 0) + 1;
                    if (ai.status === "OK") aiOk += 1;
                  }
                  for (const variant of coachCountVariants(template, subject)) {
                    const coach = planRunningPrescription(request(template.method, template.id, subject, COACH, null, null, variant));
                    if (coach.status === "OK") {
                      coachOkContexts += 1;
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }

      const hasAutoRow = ruleSet.eligibility.some((r) => r.outcome === "AUTO" && (r.templateIds as readonly string[]).includes(template.id));
      const cls: ReachClass =
        aiOk > 0 ? "AUTO_REACHABLE" : coachOkContexts === 0 ? "UNREACHABLE" : hasAutoRow ? "COACH_MANUAL_REACHABLE" : "INTENTIONALLY_MANUAL_ONLY";
      classes[template.id] = cls;
      reachability[template.id] = { class: cls, hasAutoRow, enabledByDefault: template.enabledByDefault, aiOk, coachOkContexts, aiOutcomes };

      expect(cls, template.id).not.toBe("UNREACHABLE");
      // AUTO 候補の行があるのに、eligibility を通過した AI の経路がすべて ENVELOPE_INFEASIBLE で終わる template は RuleSet の設計問題
      const passed = Object.keys(aiPassedEligibility);
      const allInfeasible = passed.length > 0 && passed.every((k) => k === "BLOCKED:ENVELOPE_INFEASIBLE");
      expect(hasAutoRow && aiOk === 0 && allInfeasible, `${template.id}: AUTO 候補がすべて ENVELOPE_INFEASIBLE`).toBe(false);
    });
  }

  it("分類の集計（38 template・UNREACHABLE が0件）", () => {
    expect(Object.keys(classes)).toHaveLength(38);
    expect(Object.entries(classes).filter(([, c]) => c === "UNREACHABLE")).toEqual([]);
  });
});

describe("T-POP-07: ASSISTED は youth / 非 POST に出ない（年齢帯 × maturity × trainingAge、override でも不可）", () => {
  for (const templateId of ["AS_TOWING", "AS_DOWNHILL"]) {
    it(templateId, () => {
      for (const [band, birthDate] of Object.entries(REACH_BIRTH)) {
        for (const maturity of MATURITY_KEYS) {
          for (const trainingAge of TRAINING_AGE_KEYS) {
            const subject = subjectFor(maturity, trainingAge, "MEASURED", { birthDate: iso(birthDate), primaryEvent: "100m" });
            const label = `${templateId}/${band}/${maturity}/${trainingAge}`;
            expect(planRunningPrescription(request("ASSISTED_SPRINT", templateId, subject, AI, null, null)).status, label).toBe("INELIGIBLE");

            const coachResult = planRunningPrescription(request("ASSISTED_SPRINT", templateId, subject, COACH, null, null));
            const profile = resolveSubjectProfile({ subject, asOf: iso("2026-09-15"), ruleSet });
            const youthOrNonPost = band === "U12" || band === "U15" || profile.effectiveMaturityCategories[0] !== "POST";
            if (youthOrNonPost && coachResult.status === "INELIGIBLE") {
              // 報告された ruleId をすべて override しても不可
              const overrides = coachResult.reasons
                .filter((r) => r.ruleId !== null)
                .map((r) => ({
                  target: { kind: "ELIGIBILITY", ruleId: r.ruleId },
                  reason: "グリッド検証のための例外申請を行う",
                  confirmedTwice: true,
                  actor: COACH,
                  at: "2026-09-15T09:00:00+09:00",
                }));
              const withOverrides = { ...request("ASSISTED_SPRINT", templateId, subject, COACH, null, null), overrides } as unknown as PlanRequest;
              expect(planRunningPrescription(withOverrides).status, `${label} + overrides`).not.toBe("OK");
            }
            if (youthOrNonPost) expect(coachResult.status, label).not.toBe("OK");
          }
        }
      }
    });
  }
});
