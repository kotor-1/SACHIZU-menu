/**
 * R9 persistence テスト用の fixture（DB は prisma/test.db）。
 * 処方は domain の planner で作る（repository / createSessionFromMenu は plan を呼ばない）。
 */
import { prisma } from "@/infra/db/prisma";
import { planRunningPrescription, planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import type { PlanRequest, PlanResult } from "@/domain/running/planning/schema";
import type { ResolvedRuleSet } from "@/domain/running/planning/build";
import { buildProvenance, type Provenance } from "@/domain/running/persistence/provenance";
import type { RunningMenuItemPersistInput } from "@/domain/running/persistence/runningItem";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { createCoachActor } from "@/domain/running/types/actor";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { IsoDate } from "@/domain/running/types/primitives";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";

export const COACH = createCoachActor("coach-1");
const iso = (v: string) => v as IsoDate;
export const FLY20_PHOTO = { event: "FLY20", timeS: 2.0, date: iso("2026-08-01"), timing: "PHOTO_CELL" } as const;

export function athlete(o: Partial<AthleteProfile> = {}): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: iso("1998-01-01"),
      primaryEvent: "400m",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: iso("2026-09-01") },
      trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
      marks: [],
      vmax: null,
      allowAdvancedMethods: true,
      ...o,
    },
  } as Subject;
}

type RequestOptions = { subject?: Subject; coachEdits?: unknown[]; overrides?: unknown[]; coachReference?: unknown };

export function makeRequest(method: string, templateId: string, o: RequestOptions = {}): PlanRequest {
  return {
    planningDate: iso("2026-09-15"),
    selection: { method, templateId },
    subject: o.subject ?? athlete(),
    menuContext: { phase: null, plannedDate: null, plannedAt: null, competitions: [], otherItems: [], availableMinutes: null },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: o.coachEdits ?? [],
    overrides: o.overrides ?? [],
    coachReference: o.coachReference ?? null,
    actor: COACH,
  } as unknown as PlanRequest;
}

export function expectOk(r: PlanResult): RunningPrescriptionValue {
  if (r.status !== "OK") throw new Error(`plan failed: ${JSON.stringify(r)}`);
  return r.prescription;
}

export const plan = (method: string, templateId: string, o: RequestOptions = {}) => expectOk(planRunningPrescription(makeRequest(method, templateId, o)));
export const planWith = (resolved: ResolvedRuleSet, method: string, templateId: string, o: RequestOptions = {}) =>
  expectOk(planRunningPrescriptionWithRuleSet(makeRequest(method, templateId, o), resolved));

export const planAcc = () => plan("ACCELERATION", "ACC_BLOCK_30");
export const planMvFly20 = () => plan("MAX_VELOCITY", "MV_FLY20", { subject: athlete({ marks: [FLY20_PHOTO] }) });
export const planSes = () => plan("SPRINT_ENDURANCE_SHORT", "SES_100", { subject: athlete({ marks: [FLY20_PHOTO] }) });
export const planTi = () => plan("TEMPO_INTENSIVE", "TI_VITTORI_SE", { subject: athlete({ marks: [FLY20_PHOTO] }) });
export const planStride = () => plan("STRIDE", "ST_RELAXED");
export const planEa = () => plan("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH", { coachReference: { kind: "COACH_DEFINED", label: "助走" } });
export const planAssisted = () =>
  plan("ASSISTED_SPRINT", "AS_DOWNHILL", {
    subject: athlete({ birthDate: iso("2000-01-01"), marks: [FLY20_PHOTO] }),
    coachEdits: [
      { field: "buildUpM", value: 30, unit: "m" },
      { field: "flyZoneM", value: 20, unit: "m" },
      { field: "totalReps", value: 3, unit: "reps" },
      { field: "repRestS", value: 600, unit: "s" },
      { field: "intensityPercent", value: 103, unit: "percent" },
    ],
  });
const splitRef = (segments: [number, number, number][]) => ({
  kind: "TARGET_SPLIT",
  segments: segments.map(([distanceM, lower, upper]) => ({ distanceM, targetS: { lower, upper, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } })),
});
const fieldOverride = (field: string, newValue: number) => ({
  target: { kind: "FIELD", field, layer: "COACH_EDITABLE" },
  newValue,
  reason: "コーチ判断で本日の例外として実施する",
  confirmedTwice: false,
  actor: COACH,
  at: "2026-09-15T09:00:00+09:00",
});
export const planTe = () => plan("TEMPO_EXTENSIVE", "TE_200", { subject: athlete({ marks: [FLY20_PHOTO] }) });
export const planRs = () => plan("RESISTED_SPRINT", "RS_SLED_LIGHT", { coachReference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true } });
export const planLsrIncomplete = () =>
  plan("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400", {
    coachReference: splitRef([[300, 36, 38], [100, 13, 14]]),
    overrides: [fieldOverride("totalReps", 3), fieldOverride("sessionVolumeM", 1200)],
  });

export function provenanceFor(p: RunningPrescriptionValue, o: Partial<Pick<Provenance, "aiReason" | "overrides">> = {}): Provenance {
  return buildProvenance({
    prescription: p,
    engineVersion: "0.1.0+test",
    inputsDigest: {
      tier: p.tier,
      ageBand: "ADULT",
      maturityEffective: "POST",
      trainingAgeTier: "ADVANCED",
      phase: null,
      plannedDate: null,
      competitionWindows: [],
      referenceKinds: [p.intensity.reference.kind],
      historyCoverage72h: "NONE",
      readinessActions: [...p.readinessApplied],
    },
    coachEdits: [],
    overrides: o.overrides ?? [],
    aiReason: o.aiReason ?? null,
  });
}

/** 保存入力。rationale は plan 時点でレンダリングした日本語テキスト。 */
export function persistInputFor(p: RunningPrescriptionValue, o: { note?: string | null; prescriptionJson?: string; provenanceJson?: string; rationale?: string } = {}): RunningMenuItemPersistInput {
  return {
    prescriptionJson: o.prescriptionJson ?? JSON.stringify(p),
    provenanceJson: o.provenanceJson ?? JSON.stringify(provenanceFor(p)),
    rationale: o.rationale ?? renderRationaleJa(p.rationale).join("\n"),
    note: o.note ?? null,
  };
}

export async function makeMenuWithBlock(name = "走メニュー") {
  const menu = await prisma.menuTemplate.create({ data: { name, blocks: { create: { name: "主運動", sortOrder: 0 } } }, include: { blocks: true } });
  return { menu, block: menu.blocks[0] };
}

/** 文字列を UTF-8 で指定バイト数になるまで JSON の空白で埋める（JSON として同じ値のまま）。 */
export function padJsonToBytes(json: string, bytes: number): string {
  const current = new TextEncoder().encode(json).length;
  if (current > bytes) throw new Error(`already ${current} bytes > ${bytes}`);
  return json + " ".repeat(bytes - current);
}
