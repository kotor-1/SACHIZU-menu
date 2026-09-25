import { describe, expect, it } from "vitest";

import {
  buildHeightPointRecordDigest,
  buildPlausibilityIssueDigest,
  buildPlausibilityIssueFromFinding,
  buildPlausibilityIssuesFromFindings,
  buildPlausibilityReviewContextDigest,
  buildTimedMarkRecordDigest,
  validatePlausibilityReviewRequest,
} from "@/application/running-plausibility-review";
import { checkInputPlausibility } from "@/domain/running/planning/normalize";
import { planRunningPrescription, planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import { checkOutputPlausibility } from "@/domain/running/plausibility/output";
import { plausibilityIssueDraftFromFinding } from "@/domain/running/plausibility/review";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import { createCoachActor, type AiPlannerActor, type CoachActor } from "@/domain/running/types/actor";
import { findingSchema, type Finding, type FindingSourceRecord } from "@/domain/running/types/findings";
import type { AppliedPlausibilityReview, PlausibilityIssue } from "@/domain/running/types/plausibilityReview";
import { runningPrescriptionSchema, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { evidenceIdSchema, isoDateSchema, isoDateTimeSchema, type IsoDate } from "@/domain/running/types/primitives";
import type { IntensityReference, TimedMark } from "@/domain/running/types/intensity";
import type { AthleteProfile, Subject } from "@/domain/running/types/subject";
import type { PlanRequest } from "@/domain/running/planning/schema";

const planningDate = isoDateSchema.parse("2026-09-15");
const resolvedRuleSet = getActiveRuleSet(planningDate);
const coach = createCoachActor("review-coach");
const at = isoDateTimeSchema.parse("2026-09-15T08:30:00.000Z");

function athlete(overrides: Partial<AthleteProfile> = {}): Subject {
  return {
    kind: "ATHLETE",
    profile: {
      birthDate: isoDateSchema.parse("1998-01-01"),
      primaryEvent: "400m",
      maturity: { status: "POST", confidence: "HIGH", method: "COACH_OBSERVATION", assessedAt: planningDate },
      trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" },
      marks: [{ event: "FLY20", timeS: 2, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" }],
      vmax: null,
      allowAdvancedMethods: true,
      ...overrides,
    },
  };
}

function makeRequest(method = "ACCELERATION", templateId = "ACC_BLOCK_20", subject = athlete()): PlanRequest {
  return {
    planningDate,
    selection: { method, templateId },
    subject,
    menuContext: { phase: null, plannedDate: null, plannedAt: null, competitions: [], otherItems: [], availableMinutes: null },
    history: null,
    readiness: null,
    positionPreference: null,
    coachEdits: [],
    overrides: [],
    coachReference: null,
    confirmedFindingCodes: [],
    actor: coach,
  } as unknown as PlanRequest;
}

function contextFor(
  method = "ACCELERATION",
  templateId = "ACC_BLOCK_20",
  prescription?: RunningPrescriptionValue,
  overrides: { subjectIdentity?: string; itemIdentity?: string; planningDate?: IsoDate; subject?: Subject; request?: PlanRequest } = {},
) {
  const baseRequest = overrides.request ?? makeRequest(method, templateId, overrides.subject ?? athlete());
  const request = overrides.planningDate
    ? { ...baseRequest, planningDate: overrides.planningDate }
    : baseRequest;
  return {
    request,
    subjectIdentity: overrides.subjectIdentity ?? "athlete:17",
    itemIdentity: overrides.itemIdentity ?? "draft-item:acc-01",
    ...(prescription ? { prescription } : {}),
  };
}

function planOk(): RunningPrescriptionValue {
  const result = planRunningPrescription(makeRequest());
  if (result.status !== "OK") throw new Error(`expected an OK plan; got ${JSON.stringify(result)}`);
  return structuredClone(result.prescription);
}

function overrideField<T extends { value: number; origin: string; position: unknown }>(field: T, value: number): T {
  return { ...field, value, origin: "COACH_OVERRIDE", position: null } as T;
}

function findingFor(prescription: RunningPrescriptionValue, ruleId: string): Finding {
  const result = checkOutputPlausibility(prescription, resolvedRuleSet.ruleSet);
  const finding = result.findings.find((candidate) => candidate.plausibility?.ruleId === ruleId);
  if (!finding) throw new Error(`expected ${ruleId} finding; got ${JSON.stringify(result.findings)}`);
  return finding;
}

function outputIssue(prescription: RunningPrescriptionValue, ruleId: string): PlausibilityIssue {
  const finding = findingFor(prescription, ruleId);
  const issue = buildPlausibilityIssueFromFinding({
    finding,
    resolvedRuleSet,
    planningContext: contextFor(prescription.method, prescription.templateId, JSON.parse(JSON.stringify(prescription))),
  });
  if (!issue) throw new Error(`expected ${ruleId} to create a review issue`);
  return issue;
}

function reviewRequest(issue: PlausibilityIssue, overrides: Record<string, unknown> = {}) {
  return {
    issueDigest: issue.issueDigest,
    reason: "コーチが記録内容を再確認しました",
    firstConfirmed: true,
    secondConfirmed: true,
    ...overrides,
  };
}

type RepKind = RunningPrescriptionValue["rep"]["kind"];
function semanticFixture(kind: RepKind) {
  let request: PlanRequest;
  switch (kind) {
    case "DISTANCE": request = makeRequest(); break;
    case "DURATION": request = makeRequest("SPRINT_ENDURANCE_SHORT", "SES_100"); break;
    case "FLY": request = makeRequest("MAX_VELOCITY", "MV_FLY20"); break;
    case "SPLIT":
      request = makeRequest("LONG_SPRINT_RACE_SPECIFIC", "LSR_BROKEN_400");
      request.coachReference = { kind: "TARGET_SPLIT", segments: [
        { distanceM: 300, targetS: { lower: 36, upper: 38, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
        { distanceM: 100, targetS: { lower: 13, upper: 14, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
      ] };
      break;
    case "ATTEMPTS":
      request = makeRequest("EVENT_APPROACH_SPEED", "EA_JUMP_FULL_APPROACH");
      request.coachReference = { kind: "COACH_DEFINED", label: "助走の技術課題" };
      request.coachEdits = [{ field: "approachDistanceM", value: 38, unit: "m" }];
      break;
    default: { const unmapped: never = kind; throw new Error(String(unmapped)); }
  }
  const result = planRunningPrescription(request);
  if (result.status !== "OK") throw new Error(`fixture ${kind}: ${JSON.stringify(result)}`);
  const prescription = structuredClone(result.prescription);
  if (prescription.rep.kind !== kind) throw new Error(`fixture rep ${prescription.rep.kind} != ${kind}`);
  prescription.sets = overrideField(prescription.sets, 1);
  prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
  return { request, prescription: runningPrescriptionSchema.parse(prescription) };
}

/** Mutate a real schema field, then validate the whole prescription. No projection-derived fixtures. */
function setSemanticPath(value: object, path: string, next: unknown): void {
  const parts = path.split(".");
  let parent: object = value;
  for (const key of parts.slice(0, -1)) {
    const child: unknown = Reflect.get(parent, key);
    if (child === null || typeof child !== "object") throw new Error(`missing fixture path ${path}`);
    parent = child;
  }
  Reflect.set(parent, parts.at(-1)!, next);
  if (parts.at(-1) === "value" && "origin" in parent) {
    Reflect.set(parent, "origin", "COACH_OVERRIDE");
    Reflect.set(parent, "position", null);
  }
}

function assertSemanticReviewStale(kind: RepKind, mutate: (p: RunningPrescriptionValue) => void, prepare?: (p: RunningPrescriptionValue) => void): void {
  const fixture = semanticFixture(kind);
  const before = fixture.prescription;
  prepare?.(before);
  runningPrescriptionSchema.parse(before);
  const after = structuredClone(before);
  mutate(after);
  if (after.rep.kind === "FLY") {
    after.rep.totalRunningDistanceM = after.rep.decelerationDistanceM === null ? null :
      after.rep.buildUpDistanceM.value + after.rep.flyZoneDistanceM.value + after.rep.decelerationDistanceM;
  }
  const current = runningPrescriptionSchema.parse(after);
  const context = (prescription: RunningPrescriptionValue) => ({
    request: fixture.request, prescription, subjectIdentity: "athlete:17", itemIdentity: "new-item:stable-slot",
  });
  const issue = (prescription: RunningPrescriptionValue) => buildPlausibilityIssueFromFinding({
    finding: findingFor(prescription, "PLA_REPS_PER_SET"), resolvedRuleSet, planningContext: context(prescription),
  });
  const oldIssue = issue(before);
  const currentIssue = issue(current);
  expect(oldIssue).not.toBeNull();
  expect(currentIssue).not.toBeNull();
  if (!oldIssue || !currentIssue) throw new Error("missing F07 issue");
  expect(currentIssue.contextDigest).not.toBe(oldIssue.contextDigest);
  expect(currentIssue.issueDigest).not.toBe(oldIssue.issueDigest);
  for (const currentIssues of [[currentIssue], [oldIssue]]) {
    expect(validatePlausibilityReviewRequest({
      currentIssues, request: reviewRequest(oldIssue), resolvedRuleSet, planningContext: context(current), actor: coach, at,
    }).ok).toBe(false);
  }
}

function inputBlockFinding(input: {
  ruleId: string;
  policy: "COACH_OVERRIDABLE_STRONG_REVIEW" | "NON_OVERRIDABLE_DATA_SANITY_HARD" | "DATE_AWARE_COACH_OVERRIDABLE_STRONG_REVIEW";
  side: "MIN" | "MAX";
  threshold: number;
  value: number;
  unit: "s" | "cm";
  metric: string;
  sourceRecord?: FindingSourceRecord;
}): Finding {
  return findingSchema.parse({
    code: "INPUT_PLAUSIBILITY_BLOCK",
    severity: "BLOCK",
    scope: "ITEM",
    metric: input.metric,
    value: { lower: input.value, upper: input.value, unit: input.unit, source: "MEASURED", confidence: "HIGH" },
    plausibility: {
      ruleId: input.ruleId,
      policy: input.policy,
      certainty: "CONFIRMED_EXCEED",
      presentationKind: input.policy === "NON_OVERRIDABLE_DATA_SANITY_HARD" ? "PRODUCT_DATA_SANITY" : "STRONG_REVIEW_REQUIRED",
      boundary: { side: input.side, threshold: input.threshold },
      ...(input.sourceRecord ? { sourceRecord: input.sourceRecord } : {}),
    },
    evidenceIds: [],
  });
}

describe("OPEN20 closure — complete semantic prescription context", () => {
  const repMutations: { kind: RepKind; path: string; value: unknown }[] = [
    { kind: "DISTANCE", path: "rep.distanceM.value", value: 21 },
    { kind: "DURATION", path: "rep.durationS.value", value: 10 },
    { kind: "DURATION", path: "rep.displayDistanceM.lower", value: 99 },
    { kind: "DURATION", path: "rep.displayDistanceM.upper", value: 101 },
    { kind: "DURATION", path: "rep.displayDistanceM.source", value: "ESTIMATED" },
    { kind: "DURATION", path: "rep.displayDistanceM.confidence", value: "LOW" },
    { kind: "SPLIT", path: "rep.segments.0.distanceM", value: 301 },
    { kind: "SPLIT", path: "rep.segments.0.restAfterS.value", value: 91 },
    { kind: "FLY", path: "rep.buildUpDistanceM.value", value: 41 },
    { kind: "FLY", path: "rep.flyZoneDistanceM.value", value: 11 },
    { kind: "FLY", path: "rep.decelerationDistanceM", value: 51 },
    { kind: "FLY", path: "rep.decelerationDistanceM", value: null },
    { kind: "FLY", path: "rep.plannedHighSpeedExposureM.lower", value: 0 },
    { kind: "FLY", path: "rep.plannedHighSpeedExposureM.upper", value: 101 },
    { kind: "FLY", path: "rep.plannedHighSpeedExposureM.source", value: "UNKNOWN" },
    { kind: "FLY", path: "rep.plannedHighSpeedExposureM.confidence", value: "NONE" },
    { kind: "ATTEMPTS", path: "rep.approach", value: "SHORT" },
    { kind: "ATTEMPTS", path: "rep.approachDistanceM.value", value: 39 },
    { kind: "ATTEMPTS", path: "rep.approachDistanceM", value: null },
  ];
  it.each(repMutations)("rejects stale $kind $path=$value independently of cached exposure", ({ kind, path, value }) => {
    assertSemanticReviewStale(kind, (p) => setSemanticPath(p, path, value));
  });

  it("closes the exact DURATION displayDistanceM 100→101 F07 reproduction", () => {
    assertSemanticReviewStale("DURATION", (p) => {
      if (p.rep.kind !== "DURATION") throw new Error("DURATION required");
      expect(p.rep.displayDistanceM.lower).toBe(100);
      expect(p.rep.displayDistanceM.upper).toBe(100);
      p.rep.displayDistanceM = { ...p.rep.displayDistanceM, lower: 101, upper: 101 };
      // Deliberately do not update exposure: this schema-valid inconsistency caused the closure failure.
    });
  });

  it("preserves semantic SPLIT segment order", () => {
    assertSemanticReviewStale("SPLIT", (p) => {
      if (p.rep.kind !== "SPLIT") throw new Error("SPLIT required");
      p.rep.segments.reverse();
    });
  });

  const commonMutations: { path: string; value: unknown }[] = [
    { path: "sets.value", value: 2 },
    { path: "repsPerSet.value", value: 32 },
    { path: "rest.repRestS.value", value: 121 },
    { path: "rest.feasibility", value: "EXCEEDS_AVAILABLE_TIME" },
    { path: "sets.coachEditable.max", value: 100 },
    { path: "rep.distanceM.recommended.max", value: 101 },
    { path: "confidence.prescription", value: "LOW" },
    { path: "confidence.inputData", value: "LOW" },
    { path: "confidence.directness", value: "INDIRECT" },
    { path: "exposure.totalRunningDistanceM.upper", value: 999 },
    { path: "exposure.plannedHighSpeedExposureM.upper", value: 999 },
    { path: "exposure.nearMaxSprintVolumeM.upper", value: 999 },
    { path: "loadSnapshot.loadClass", value: "LOW" },
    { path: "loadSnapshot.weeklyLoadCategory", value: "OTHER" },
    { path: "planningControls.positionPreference", value: "LOWER" },
    { path: "monitoringSnapshot.stopPolicy.consecutiveFailuresToStop", value: 9 },
    { path: "monitoringSnapshot.stopPolicy.runtime.poorStartConsecutiveThreshold", value: 9 },
    { path: "monitoringSnapshot.timingTolerances.0.toleranceS", value: 1.25 },
    { path: "monitoringSnapshot.safetyPolicy.painPresentOutcome", value: "STOP" },
  ];
  it.each(commonMutations)("rejects stale common prescription field $path", ({ path, value }) => {
    assertSemanticReviewStale("DISTANCE", (p) => setSemanticPath(p, path, value));
  });

  it.each(["setRestS", "intraRepRestS"] as const)("binds optional %s instead of treating null as zero", (field) => {
    assertSemanticReviewStale("DISTANCE", (p) => { p.rest[field] = overrideField(p.rest.repRestS, 123); });
  });

  it("binds numeric targets and all selected reference identity, including timing/source", () => {
    const references: RunningPrescriptionValue["intensity"]["reference"][] = [
      { kind: "MEASURED_VMAX", vmax: { valueMps: 10, lowerMps: 9, upperMps: 11, source: "RADAR_LASER", confidence: "HIGH", measuredAt: planningDate } },
      { kind: "FLY_SPLIT", flyZoneM: 20, mark: { event: "FLY20", timeS: 2, date: planningDate, timing: "PHOTO_CELL" } },
      { kind: "SAME_DISTANCE_BEST", distanceM: 100, mark: { event: "100m", timeS: 12, date: planningDate, timing: "HAND" } },
      { kind: "RACE_PACE", event: "400m", targetTimeS: { lower: 50, upper: 51, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } },
      { kind: "TARGET_SPLIT", segments: [{ distanceM: 100, targetS: { lower: 12, upper: 13, unit: "s", source: "COACH_ENTERED", confidence: "HIGH" } }] },
      { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true },
      { kind: "RELAXED_SUBMAX" },
      { kind: "COACH_DEFINED", label: "助走の速度課題" },
    ];
    for (const reference of references) assertSemanticReviewStale("DISTANCE", (p) => { p.intensity.reference = reference; });
    assertSemanticReviewStale("DURATION", (p) => {
      p.intensity.reference = { kind: "RACE_PACE", event: "400m", targetTimeS: { lower: 50, upper: 51, unit: "s", source: "COACH_ENTERED", confidence: "MEDIUM" } };
      p.intensity.target = { lower: 85, upper: 90, unit: "percent", source: "PLANNED", confidence: "HIGH" };
    });
  });

  const mark: TimedMark = { event: "FLY20", timeS: 2, date: planningDate, timing: "PHOTO_CELL" };
  const interval = { lower: 50, upper: 51, unit: "s" as const, source: "COACH_ENTERED" as const, confidence: "MEDIUM" as const };
  const referenceMutations: { reference: IntensityReference; fields: [string, unknown][] }[] = [
    { reference: { kind: "MEASURED_VMAX", vmax: { valueMps: 10, lowerMps: 9, upperMps: 11, source: "RADAR_LASER", confidence: "HIGH", measuredAt: planningDate } }, fields: [
      ["vmax.valueMps", 10.1], ["vmax.lowerMps", 8.9], ["vmax.upperMps", 11.1], ["vmax.source", "COACH_ESTIMATE"],
      ["vmax.confidence", "LOW"], ["vmax.measuredAt", "2026-09-14"], ["vmax.modelId", "model-v2"],
    ] },
    { reference: { kind: "FLY_SPLIT", flyZoneM: 20, mark }, fields: [
      ["flyZoneM", 21], ["mark.event", "FLY10"], ["mark.timeS", 2.1], ["mark.date", "2026-09-14"],
      ["mark.timing", "HAND"], ["mark.videoFps", 120], ["mark.wind", 1], ["mark.startType", "STANDING"],
      ["mark.surface", "GRASS"], ["mark.spikes", true],
    ] },
    { reference: { kind: "SAME_DISTANCE_BEST", distanceM: 100, mark }, fields: [["distanceM", 101], ["mark.timing", "HAND"]] },
    { reference: { kind: "RACE_PACE", event: "400m", targetTimeS: interval }, fields: [
      ["event", "200m"], ["targetTimeS.lower", 49], ["targetTimeS.upper", 52], ["targetTimeS.source", "PLANNED"], ["targetTimeS.confidence", "HIGH"],
    ] },
    { reference: { kind: "TARGET_SPLIT", segments: [{ distanceM: 300, targetS: interval }] }, fields: [
      ["segments.0.distanceM", 301], ["segments.0.targetS.lower", 49], ["segments.0.targetS.upper", 52],
      ["segments.0.targetS.source", "PLANNED"], ["segments.0.targetS.confidence", "HIGH"],
    ] },
    { reference: { kind: "VELOCITY_DECREMENT", band: "LIGHT", measured: true }, fields: [["band", "MODERATE"], ["measured", false]] },
    { reference: { kind: "COACH_DEFINED", label: "助走速度" }, fields: [["label", "接地リズム（異なる指示）"]] },
  ];
  it.each(referenceMutations.flatMap(({ reference, fields }) => fields.map(([path, value]) => ({ reference, path, value }))))(
    "binds selected $reference.kind reference field $path", ({ reference, path, value }) => {
      assertSemanticReviewStale("DISTANCE", (p) => setSemanticPath(p.intensity.reference, path, value), (p) => {
        p.intensity.reference = structuredClone(reference);
        p.intensity.target = null;
      });
    },
  );

  it.each([["lower", 49], ["upper", 52], ["unit", "percent"], ["source", "PLANNED"], ["confidence", "HIGH"]] as const)(
    "binds intensity target %s", (field, value) => {
      assertSemanticReviewStale("DISTANCE", (p) => setSemanticPath(p, `intensity.target.${field}`, value), (p) => {
        p.intensity.reference = { kind: "RACE_PACE", event: "400m", targetTimeS: { ...interval } };
        p.intensity.target = { ...interval };
      });
    },
  );

  it("does not bind citations, localized explanations, creation audit or object key order", () => {
    const fixture = semanticFixture("DISTANCE");
    const baseContext = { request: fixture.request, prescription: fixture.prescription, subjectIdentity: "athlete:17", itemIdentity: "item:1" };
    const changed = structuredClone(baseContext);
    changed.prescription.rationale = [];
    changed.prescription.findings = [];
    changed.prescription.sets.evidenceIds.reverse();
    changed.prescription.monitoringSnapshot.stopPolicy.referenceDescription = "表示だけの変更";
    changed.prescription.monitoringSnapshot.stopPolicy.ruleDescriptionJa = "翻訳の更新";
    changed.prescription.monitoringSnapshot.timingTolerances.reverse();
    changed.prescription.monitoringSnapshot.safetyPolicy.redFlagGroups.reverse();
    changed.prescription.generatedBy.acceptedByCoachAt = isoDateTimeSchema.parse("2026-09-16T09:00:00Z");
    if (changed.request.subject.kind !== "ATHLETE") throw new Error("ATHLETE required");
    changed.request.subject.profile.maturity.assessedAt = isoDateSchema.parse("2026-09-14");
    expect(buildPlausibilityReviewContextDigest(changed)).toBe(buildPlausibilityReviewContextDigest(baseContext));
    const reordered = { itemIdentity: baseContext.itemIdentity, prescription: baseContext.prescription, subjectIdentity: baseContext.subjectIdentity, request: baseContext.request };
    expect(buildPlausibilityReviewContextDigest(reordered)).toBe(buildPlausibilityReviewContextDigest(baseContext));
  });

  it("binds scheduled planning time, while equivalent timezone instants are identical", () => {
    const fixture = semanticFixture("DISTANCE");
    fixture.request.menuContext.plannedDate = planningDate;
    fixture.request.menuContext.plannedAt = isoDateTimeSchema.parse("2026-09-15T10:00:00Z");
    const a = { request: fixture.request, prescription: fixture.prescription, subjectIdentity: "athlete:17", itemIdentity: "item:1" };
    const b = structuredClone(a);
    b.request.menuContext.plannedAt = isoDateTimeSchema.parse("2026-09-15T19:00:00+09:00");
    expect(buildPlausibilityReviewContextDigest(a)).toBe(buildPlausibilityReviewContextDigest(b));
    b.request.menuContext.plannedAt = isoDateTimeSchema.parse("2026-09-15T20:00:00+09:00");
    expect(buildPlausibilityReviewContextDigest(a)).not.toBe(buildPlausibilityReviewContextDigest(b));
  });

  it("normalizes set-like record order but retains same-date selection tie priority", () => {
    const a = contextFor();
    if (a.request.subject.kind !== "ATHLETE") throw new Error("ATHLETE required");
    const profile = a.request.subject.profile;
    profile.marks = [
      { event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" },
      { event: "FLY20", timeS: 2, date: isoDateSchema.parse("2026-08-02"), timing: "PHOTO_CELL" },
    ];
    const original = buildPlausibilityReviewContextDigest(a);
    profile.marks.reverse();
    expect(buildPlausibilityReviewContextDigest(a)).toBe(original);
    profile.marks[0]!.date = profile.marks[1]!.date;
    const tied = buildPlausibilityReviewContextDigest(a);
    profile.marks.reverse();
    expect(buildPlausibilityReviewContextDigest(a)).not.toBe(tied);

    profile.maturity.heightHistory = [
      { date: isoDateSchema.parse("2025-01-01"), heightCm: 49.9 },
      { date: isoDateSchema.parse("2026-01-01"), heightCm: 170 },
    ];
    const height = buildPlausibilityReviewContextDigest(a);
    profile.maturity.heightHistory.reverse();
    expect(buildPlausibilityReviewContextDigest(a)).toBe(height);
    profile.maturity.heightHistory.push({ date: isoDateSchema.parse("2026-01-01"), heightCm: 260.1 });
    const heightTie = buildPlausibilityReviewContextDigest(a);
    profile.maturity.heightHistory.reverse();
    expect(buildPlausibilityReviewContextDigest(a)).not.toBe(heightTie);
  });

  it("retains priority of overlapping monitoring bands instead of silently sorting away execution semantics", () => {
    const fixture = semanticFixture("DISTANCE");
    const context = contextFor(fixture.prescription.method, fixture.prescription.templateId, fixture.prescription, { request: fixture.request });
    fixture.prescription.monitoringSnapshot.vdecClassificationPolicy = { bands: [
      { id: "band:A", classification: "LIGHT", lowerPercent: 0, upperPercent: 20, lowerInclusive: true, upperInclusive: true, evidenceIds: [evidenceIdSchema.parse("E10")], classificationOnly: true },
      { id: "band:B", classification: "MODERATE", lowerPercent: 10, upperPercent: 30, lowerInclusive: true, upperInclusive: true, evidenceIds: [evidenceIdSchema.parse("E10")], classificationOnly: true },
    ] };
    const before = buildPlausibilityReviewContextDigest(context);
    fixture.prescription.monitoringSnapshot.vdecClassificationPolicy.bands.reverse();
    expect(buildPlausibilityReviewContextDigest(context)).not.toBe(before);
  });

  it("fails closed on ambiguous repeated edits and non-finite nested interval input", () => {
    const fixture = semanticFixture("DURATION");
    const context = { request: fixture.request, prescription: fixture.prescription, subjectIdentity: "athlete:17", itemIdentity: "item:1" };
    const finding = findingFor(fixture.prescription, "PLA_REPS_PER_SET");
    const issue = buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet, planningContext: context });
    if (!issue) throw new Error("missing issue");
    fixture.request.coachEdits = [{ field: "sets", value: 1, unit: "sets" }, { field: "sets", value: 2, unit: "sets" }];
    expect(buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet, planningContext: context })).toBeNull();
    expect(validatePlausibilityReviewRequest({ currentIssues: [issue], request: reviewRequest(issue), resolvedRuleSet, planningContext: context, actor: coach, at })).toMatchObject({ ok: false, code: "INVALID_SERVER_CONTEXT" });
    fixture.request.coachEdits = [];
    if (fixture.prescription.rep.kind !== "DURATION") throw new Error("DURATION required");
    fixture.prescription.rep.displayDistanceM.upper = Infinity;
    expect(buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet, planningContext: context })).toBeNull();
    expect(validatePlausibilityReviewRequest({ currentIssues: [issue], request: reviewRequest(issue), resolvedRuleSet, planningContext: context, actor: coach, at })).toMatchObject({ ok: false, code: "INVALID_SERVER_CONTEXT" });
  });
});

describe("OPEN20 F2 — PlausibilityReview issue identity and validation", () => {
  it("creates review issues for each F07–F12 output boundary from actual plausibility findings", () => {
    const cases: { ruleId: string; mutate: (p: RunningPrescriptionValue) => void }[] = [
      { ruleId: "PLA_REPS_PER_SET", mutate: (p) => { p.sets = overrideField(p.sets, 1); p.repsPerSet = overrideField(p.repsPerSet, 31); } },
      { ruleId: "PLA_SETS", mutate: (p) => { p.sets = overrideField(p.sets, 21); p.repsPerSet = overrideField(p.repsPerSet, 1); } },
      { ruleId: "PLA_TOTAL_REPS", mutate: (p) => { p.sets = overrideField(p.sets, 9); p.repsPerSet = overrideField(p.repsPerSet, 10); } },
      { ruleId: "PLA_REP_REST_S", mutate: (p) => { p.rest.repRestS = overrideField(p.rest.repRestS, 3601); } },
      { ruleId: "PLA_SET_REST_S", mutate: (p) => {
        p.rest.setRestS = {
          value: 5401,
          unit: "s",
          recommended: null,
          coachEditable: { min: 0, max: 6000, unit: "s" },
          hardSafety: null,
          position: null,
          origin: "COACH_OVERRIDE",
          evidenceIds: [],
        };
      } },
      { ruleId: "PLA_ITEM_TOTAL_DISTANCE", mutate: (p) => {
        p.sets = overrideField(p.sets, 10);
        p.repsPerSet = overrideField(p.repsPerSet, 10);
        if (p.rep.kind !== "DISTANCE") throw new Error("fixture requires DISTANCE reps");
        p.rep.distanceM = overrideField(p.rep.distanceM, 101);
      } },
    ];

    for (const testCase of cases) {
      const prescription = planOk();
      testCase.mutate(prescription);
      const issue = outputIssue(prescription, testCase.ruleId);
      expect(issue.ruleId).toBe(testCase.ruleId);
      expect(issue.findingCode).toBe("PLAUSIBILITY_BLOCK");
      expect(issue.target.kind).toBe(testCase.ruleId === "PLA_ITEM_TOTAL_DISTANCE" ? "ITEM_TOTAL_DISTANCE" : "PRESCRIPTION_FIELD");
      expect(issue.observation.kind).toBe("SCALAR");
    }
  });

  it("expresses F14 MAX in the domain contract but rejects synthetic selection and the MIN hard boundary", () => {
    const mark: TimedMark = { event: "100m", timeS: 61, date: isoDateSchema.parse("2026-08-01"), timing: "HAND" };
    const maxFinding = inputBlockFinding({
      ruleId: "PLA_INPUT_100M_RECORD", policy: "COACH_OVERRIDABLE_STRONG_REVIEW", side: "MAX", threshold: 60,
      value: mark.timeS, unit: "s", metric: `selected.${mark.event}@${mark.date}`,
      sourceRecord: { kind: "TIMED_MARK", record: mark },
    });
    const context = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { subject: athlete({ marks: [mark] }) });
    // F14 has no selected 100m numeric runtime path. A synthetic finding must not invent one.
    expect(buildPlausibilityIssueFromFinding({
      finding: maxFinding,
      resolvedRuleSet,
      planningContext: context,
    })).toBeNull();
    const rule = resolvedRuleSet.ruleSet.plausibility.find((candidate) => candidate.ruleId === "PLA_INPUT_100M_RECORD");
    if (!rule) throw new Error("missing F14 rule");
    const draft = plausibilityIssueDraftFromFinding({
      finding: maxFinding, rule, ruleSet: { version: resolvedRuleSet.ruleSet.ruleSetVersion, contentHash: resolvedRuleSet.contentHash },
      contextDigest: buildPlausibilityReviewContextDigest(context), recordDigest: buildTimedMarkRecordDigest(mark, context.subjectIdentity),
    });
    if (!draft) throw new Error("expected reviewable F14 MAX domain draft");
    const issue = { ...draft, issueDigest: buildPlausibilityIssueDigest(draft) };
    expect(issue?.target.kind).toBe("TIMED_MARK");

    const minMark = { ...mark, timeS: 4.9 };
    const minFinding = inputBlockFinding({
      ruleId: "PLA_INPUT_100M_RECORD", policy: "NON_OVERRIDABLE_DATA_SANITY_HARD", side: "MIN", threshold: 5,
      value: minMark.timeS, unit: "s", metric: `selected.${minMark.event}@${minMark.date}`,
      sourceRecord: { kind: "TIMED_MARK", record: minMark },
    });
    expect(buildPlausibilityIssueFromFinding({
      finding: minFinding,
      resolvedRuleSet,
      planningContext: context,
    })).toBeNull();
    expect(plausibilityIssueDraftFromFinding({
      finding: minFinding, rule, ruleSet: issue.ruleSet, contextDigest: issue.contextDigest,
      recordDigest: buildTimedMarkRecordDigest(minMark, context.subjectIdentity),
    })).toBeNull();

    const forgedMinIssue = {
      ...issue!,
      observation: { kind: "SCALAR" as const, value: minMark.timeS, unit: "s" as const },
      boundary: { side: "MIN" as const, threshold: 5 },
      certainty: "CONFIRMED_EXCEED" as const,
    };
    const forgedMinDigest = buildPlausibilityIssueDigest(forgedMinIssue);
    expect(validatePlausibilityReviewRequest({
      currentIssues: [{ ...forgedMinIssue, issueDigest: forgedMinDigest }],
      request: { issueDigest: forgedMinDigest, reason: "下限側の境界を確認しました", firstConfirmed: true, secondConfirmed: true },
      resolvedRuleSet,
      planningContext: context,
      actor: coach,
      at,
    })).toMatchObject({ ok: false, code: "ISSUE_NOT_REVIEWABLE" });
  });

  it("uses the selected F15 Fly10 path: >5 is reviewable and <0.5 stays non-reviewable", () => {
    const makeFlyPlan = (timeS: number) => {
      const mark: TimedMark = { event: "FLY10", timeS, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" };
      const result = planRunningPrescription(makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({ marks: [mark] })));
      if (result.status !== "BLOCKED") throw new Error(`expected blocked F15 plan; got ${JSON.stringify(result)}`);
      const finding = result.findings.find((candidate) => candidate.plausibility?.ruleId === "PLA_INPUT_FLY_10M");
      if (!finding) throw new Error("missing F15 finding");
      const issue = buildPlausibilityIssueFromFinding({
        finding,
        resolvedRuleSet,
        planningContext: contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, {
          request: makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({ marks: [mark] })),
        }),
      });
      return { finding, issue };
    };

    expect(makeFlyPlan(5.1).issue?.target.kind).toBe("TIMED_MARK");
    expect(makeFlyPlan(0.49).issue).toBeNull();
    const selected = makeFlyPlan(5.1).issue;
    expect(selected?.target.kind === "TIMED_MARK" ? selected.target.recordDigest : null).toBe(
      buildTimedMarkRecordDigest({ event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" }, "athlete:17"),
    );
  });

  it("builds F16 issues from selected date-aware endpoints but not equality or unused data-quality points", () => {
    const point = (date: string, heightCm: number) => ({ date: isoDateSchema.parse(date), heightCm });
    const below = point("2025-01-01", 49.9);
    const above = point("2026-01-01", 260.1);
    const subject = athlete({ maturity: {
      status: "POST", confidence: "HIGH", method: "GROWTH_VELOCITY", assessedAt: planningDate,
      heightHistory: [below, above],
    } });
    const request = makeRequest("ACCELERATION", "ACC_BLOCK_20", subject);
    const result = checkInputPlausibility(request, resolvedRuleSet.ruleSet);
    const findings = result.blocking.filter((finding) => finding.plausibility?.ruleId === "PLA_INPUT_HEIGHT");
    expect(findings).toHaveLength(2);
    const issues = findings.map((finding) => {
      return buildPlausibilityIssueFromFinding({
        finding,
        resolvedRuleSet,
        planningContext: contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { request }),
      });
    });
    expect(issues.map((issue) => issue?.boundary)).toEqual([
      { side: "MIN", threshold: 50 },
      { side: "MAX", threshold: 260 },
    ]);
    expect(issues.every((issue) => issue?.target.kind === "HEIGHT_POINT")).toBe(true);
    const blockedPlan = planRunningPrescription(request);
    expect(blockedPlan.status).toBe("BLOCKED");
    const reviewContext = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { request });
    const validIssues = issues.filter((issue): issue is PlausibilityIssue => issue !== null);
    const approved = validatePlausibilityReviewRequest({
      currentIssues: validIssues,
      request: reviewRequest(validIssues[0]),
      resolvedRuleSet,
      planningContext: reviewContext,
      actor: coach,
      at,
    });
    expect(approved.ok).toBe(true);
    expect(planRunningPrescription(request).status).toBe("BLOCKED");

    const equalSubject = athlete({ maturity: {
      status: "POST", confidence: "HIGH", method: "GROWTH_VELOCITY", assessedAt: planningDate,
      heightHistory: [point("2025-01-01", 50), point("2026-01-01", 260)],
    } });
    const equal = checkInputPlausibility(makeRequest("ACCELERATION", "ACC_BLOCK_20", equalSubject), resolvedRuleSet.ruleSet);
    expect(equal.blocking.some((finding) => finding.plausibility?.ruleId === "PLA_INPUT_HEIGHT")).toBe(false);

    const unusedSubject = athlete({ maturity: {
      status: "POST", confidence: "HIGH", method: "GROWTH_VELOCITY", assessedAt: planningDate,
      heightHistory: [point("2025-01-01", 170), point("2025-06-01", 49.9), point("2026-01-01", 171)],
    } });
    const unused = checkInputPlausibility(makeRequest("ACCELERATION", "ACC_BLOCK_20", unusedSubject), resolvedRuleSet.ruleSet);
    const qualityFinding = unused.findings.find((finding) => finding.code === "INPUT_HEIGHT_DATA_QUALITY");
    expect(qualityFinding).toBeDefined();
    expect(buildPlausibilityIssueFromFinding({
      finding: qualityFinding!,
      resolvedRuleSet,
      planningContext: contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, {
        request: makeRequest("ACCELERATION", "ACC_BLOCK_20", unusedSubject),
      }),
    })).toBeNull();
  });

  it("binds rule, boundary side, threshold, observation, certainty, RuleSet, and context into issueDigest", () => {
    const prescription = planOk();
    prescription.sets = overrideField(prescription.sets, 1);
    prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
    const issue = outputIssue(prescription, "PLA_REPS_PER_SET");
    expect(buildPlausibilityIssueDigest(issue)).toBe(issue.issueDigest);

    const reordered = {
      contextDigest: issue.contextDigest,
      ruleSet: { contentHash: issue.ruleSet.contentHash, version: issue.ruleSet.version },
      certainty: issue.certainty,
      boundary: { threshold: issue.boundary.threshold, side: issue.boundary.side },
      observation: { unit: issue.observation.unit, value: issue.observation.kind === "SCALAR" ? issue.observation.value : 31, kind: "SCALAR" as const },
      target: { field: "repsPerSet", kind: "PRESCRIPTION_FIELD" as const },
      scope: issue.scope,
      findingCode: issue.findingCode,
      ruleId: issue.ruleId,
    };
    expect(buildPlausibilityIssueDigest(reordered)).toBe(issue.issueDigest);

    expect(buildPlausibilityIssueDigest({ ...issue, ruleId: "PLA_SETS" })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, boundary: { side: "MIN", threshold: 30 } })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, boundary: { side: "MAX", threshold: 29 } })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, observation: { kind: "SCALAR", value: 32, unit: "reps" } })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, certainty: "POSSIBLE_EXCEED" })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, ruleSet: { ...issue.ruleSet, contentHash: "a".repeat(64) } })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, ruleSet: { ...issue.ruleSet, version: "rs-2026.08.0" } })).not.toBe(issue.issueDigest);
    expect(buildPlausibilityIssueDigest({ ...issue, contextDigest: "b".repeat(64) })).not.toBe(issue.issueDigest);

    const basePrescription = planOk();
    const baseContext = contextFor("ACCELERATION", "ACC_BLOCK_20", basePrescription);
    expect(buildPlausibilityReviewContextDigest(baseContext)).toBe(buildPlausibilityReviewContextDigest(structuredClone(baseContext)));
    expect(() => buildPlausibilityReviewContextDigest({})).toThrow();
  });

  it("derives context from complete planning state, excluding labels and array insertion order", () => {
    const digest = buildPlausibilityReviewContextDigest(contextFor());
    expect(buildPlausibilityReviewContextDigest(contextFor("MAX_VELOCITY", "MV_FLY10"))).not.toBe(digest);
    expect(buildPlausibilityReviewContextDigest(contextFor("ACCELERATION", "ACC_BLOCK_30"))).not.toBe(digest);
    expect(buildPlausibilityReviewContextDigest(contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, {
      planningDate: isoDateSchema.parse("2026-09-16"),
    }))).not.toBe(digest);
    expect(buildPlausibilityReviewContextDigest(contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, {
      subjectIdentity: "athlete:18",
    }))).not.toBe(digest);

    const first: TimedMark = { event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" };
    const second: TimedMark = { event: "FLY20", timeS: 2.2, date: isoDateSchema.parse("2026-08-02"), timing: "HAND" };
    const forward = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { subject: athlete({ marks: [first, second] }) });
    const reverse = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { subject: athlete({ marks: [second, first] }) });
    expect(buildPlausibilityReviewContextDigest(forward)).toBe(buildPlausibilityReviewContextDigest(reverse));

    const groupA: Subject = { kind: "GROUP", profile: { label: "display A", members: [], allowAdvancedMethods: false } };
    const groupB: Subject = { kind: "GROUP", profile: { label: "display B", members: [], allowAdvancedMethods: false } };
    const groupContext = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { subjectIdentity: "group:1", subject: groupA });
    const groupLabelOnly = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { subjectIdentity: "group:1", subject: groupB });
    expect(buildPlausibilityReviewContextDigest(groupContext)).toBe(buildPlausibilityReviewContextDigest(groupLabelOnly));
    expect(buildPlausibilityReviewContextDigest(contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, {
      subjectIdentity: "group:2", subject: groupA,
    }))).not.toBe(buildPlausibilityReviewContextDigest(groupContext));
    expect(buildPlausibilityReviewContextDigest(contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, {
      itemIdentity: "draft-item:acc-02",
    }))).not.toBe(digest);
  });

  it("binds interval bounds, source, and confidence into issueDigest", () => {
    const prescription = planOk();
    prescription.sets = overrideField(prescription.sets, 1);
    prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
    const issue = outputIssue(prescription, "PLA_REPS_PER_SET");
    const intervalIssue = {
      ...issue,
      observation: {
        kind: "INTERVAL" as const,
        lower: 30,
        upper: 31,
        unit: "reps" as const,
        source: "MEASURED" as const,
        confidence: "HIGH" as const,
      },
    };
    const digest = buildPlausibilityIssueDigest(intervalIssue);
    expect(buildPlausibilityIssueDigest({ ...intervalIssue, observation: { ...intervalIssue.observation } })).toBe(digest);
    expect(buildPlausibilityIssueDigest({ ...intervalIssue, observation: { ...intervalIssue.observation, lower: 29 } })).not.toBe(digest);
    expect(buildPlausibilityIssueDigest({ ...intervalIssue, observation: { ...intervalIssue.observation, source: "COACH_ENTERED" } })).not.toBe(digest);
    expect(buildPlausibilityIssueDigest({ ...intervalIssue, observation: { ...intervalIssue.observation, confidence: "MEDIUM" } })).not.toBe(digest);
  });

  it("makes record identity independent of input array order and distinguishes record changes", () => {
    const marks: TimedMark[] = [
      { event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" },
      { event: "100m", timeS: 61, date: isoDateSchema.parse("2026-08-02"), timing: "HAND" },
    ];
    const digestList = (records: readonly TimedMark[]) => records.map((mark) => buildTimedMarkRecordDigest(mark, "athlete:17")).sort();
    expect(digestList(marks)).toEqual(digestList([...marks].reverse()));
    expect(buildTimedMarkRecordDigest(marks[0], "athlete:17")).not.toBe(buildTimedMarkRecordDigest({ ...marks[0], timeS: 5.2 }, "athlete:17"));
    expect(buildTimedMarkRecordDigest(marks[0], "athlete:17")).not.toBe(buildTimedMarkRecordDigest({ ...marks[0], date: isoDateSchema.parse("2026-08-03") }, "athlete:17"));
    expect(buildTimedMarkRecordDigest(marks[0], "athlete:17")).not.toBe(buildTimedMarkRecordDigest({ ...marks[0], timing: "HAND" }, "athlete:17"));

    const heightPoint = { date: isoDateSchema.parse("2026-01-01"), heightCm: 260.1 };
    const firstMember = buildHeightPointRecordDigest({ point: heightPoint, subjectIdentity: "group:4", memberIdentity: "member:1" });
    expect(firstMember).not.toBe(buildHeightPointRecordDigest({ point: heightPoint, subjectIdentity: "group:4", memberIdentity: "member:2" }));
    expect(firstMember).not.toBe(buildHeightPointRecordDigest({ point: { ...heightPoint, heightCm: 260 }, subjectIdentity: "group:4", memberIdentity: "member:1" }));
  });

  it("sorts several review issues by digest regardless of finding order", () => {
    const prescription = planOk();
    prescription.sets = overrideField(prescription.sets, 21);
    prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
    const findings = checkOutputPlausibility(prescription, resolvedRuleSet.ruleSet).findings;
    const context = contextFor(prescription.method, prescription.templateId, JSON.parse(JSON.stringify(prescription)));
    const build = (values: readonly Finding[]) => buildPlausibilityIssuesFromFindings({
      findings: values,
      resolvedRuleSet,
      planningContext: context,
    }).map((issue) => issue.issueDigest);
    expect(build(findings)).toEqual(build([...findings].reverse()));
    expect(build(findings).length).toBeGreaterThan(1);
  });

  it("accepts only one current, review-eligible digest and returns server-owned actor/time", () => {
    const prescription = planOk();
    prescription.sets = overrideField(prescription.sets, 1);
    prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
    const context = contextFor(prescription.method, prescription.templateId, JSON.parse(JSON.stringify(prescription)));
    const issue = outputIssue(prescription, "PLA_REPS_PER_SET");
    const result = validatePlausibilityReviewRequest({
      currentIssues: [issue],
      request: reviewRequest(issue),
      resolvedRuleSet,
      planningContext: context,
      actor: coach,
      at,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.appliedReview).toMatchObject({
      issueDigest: issue.issueDigest,
      reason: "コーチが記録内容を再確認しました",
      confirmedTwice: true,
      actor: coach,
      at,
    } satisfies Partial<AppliedPlausibilityReview>);

    expect(validatePlausibilityReviewRequest({
      currentIssues: [issue],
      request: reviewRequest(issue, { issueDigest: "f".repeat(64) }),
      resolvedRuleSet,
      planningContext: context,
      actor: coach,
      at,
    })).toMatchObject({ ok: false, code: "ISSUE_NOT_CURRENT" });
    expect(validatePlausibilityReviewRequest({
      currentIssues: [issue, issue],
      request: reviewRequest(issue),
      resolvedRuleSet,
      planningContext: context,
      actor: coach,
      at,
    })).toMatchObject({ ok: false, code: "ISSUE_AMBIGUOUS" });
  });

  it("rejects missing confirmation, forged body fields, short reasons, and oversized reasons", () => {
    const prescription = planOk();
    prescription.sets = overrideField(prescription.sets, 1);
    prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
    const context = contextFor(prescription.method, prescription.templateId, JSON.parse(JSON.stringify(prescription)));
    const issue = outputIssue(prescription, "PLA_REPS_PER_SET");
    const validateRequest = (request: unknown) => validatePlausibilityReviewRequest({
      currentIssues: [issue], request, resolvedRuleSet, planningContext: context, actor: coach, at,
    });

    expect(validateRequest({ ...reviewRequest(issue), firstConfirmed: false })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest({ ...reviewRequest(issue), secondConfirmed: undefined })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest({ ...reviewRequest(issue), reason: "短い" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest({ ...reviewRequest(issue), reason: "123456789" })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest({ ...reviewRequest(issue), reason: "1234567890" }).ok).toBe(true);
    expect(validateRequest({ ...reviewRequest(issue), reason: "x".repeat(1000) }).ok).toBe(true);
    expect(validateRequest({ ...reviewRequest(issue), reason: "x".repeat(1001) })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest({ ...reviewRequest(issue), reason: " ".repeat(10) })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(validateRequest({ ...reviewRequest(issue), actor: coach, at, policy: "COACH_OVERRIDABLE_STRONG_REVIEW", value: 31 })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("rejects stale value, method, template, and RuleSet identities", () => {
    const oldPrescription = planOk();
    oldPrescription.sets = overrideField(oldPrescription.sets, 1);
    oldPrescription.repsPerSet = overrideField(oldPrescription.repsPerSet, 31);
    const oldContext = contextFor(oldPrescription.method, oldPrescription.templateId, JSON.parse(JSON.stringify(oldPrescription)));
    const oldIssue = outputIssue(oldPrescription, "PLA_REPS_PER_SET");
    const oldRequest = reviewRequest(oldIssue);

    const changedValue = structuredClone(oldPrescription);
    changedValue.repsPerSet = overrideField(changedValue.repsPerSet, 32);
    const changedValueIssue = outputIssue(changedValue, "PLA_REPS_PER_SET");
    expect(validatePlausibilityReviewRequest({ currentIssues: [changedValueIssue], request: oldRequest, resolvedRuleSet, planningContext: contextFor(changedValue.method, changedValue.templateId, JSON.parse(JSON.stringify(changedValue))), actor: coach, at })).toMatchObject({ ok: false, code: "ISSUE_NOT_CURRENT" });

    const changedSets = structuredClone(oldPrescription);
    changedSets.sets = overrideField(changedSets.sets, 2);
    const changedSetsIssue = outputIssue(changedSets, "PLA_REPS_PER_SET");
    expect(changedSetsIssue.observation).toEqual(oldIssue.observation);
    expect(changedSetsIssue.contextDigest).not.toBe(oldIssue.contextDigest);
    expect(changedSetsIssue.issueDigest).not.toBe(oldIssue.issueDigest);
    expect(validatePlausibilityReviewRequest({
      currentIssues: [changedSetsIssue], request: oldRequest, resolvedRuleSet,
      planningContext: contextFor(changedSets.method, changedSets.templateId, changedSets), actor: coach, at,
    })).toMatchObject({ ok: false, code: "ISSUE_NOT_CURRENT" });

    for (const changedContext of [
      contextFor("MAX_VELOCITY", "MV_FLY10"),
      contextFor("ACCELERATION", "ACC_BLOCK_30"),
      contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { subjectIdentity: "athlete:18" }),
      contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { planningDate: isoDateSchema.parse("2026-09-16") }),
    ]) {
      expect(validatePlausibilityReviewRequest({ currentIssues: [oldIssue], request: oldRequest, resolvedRuleSet, planningContext: changedContext, actor: coach, at })).toMatchObject({ ok: false });
    }

    const changedRuleSet = { ...resolvedRuleSet, contentHash: "c".repeat(64) };
    expect(buildPlausibilityIssueFromFinding({ finding: findingFor(oldPrescription, "PLA_REPS_PER_SET"), resolvedRuleSet: changedRuleSet, planningContext: oldContext })).toBeNull();
    expect(validatePlausibilityReviewRequest({ currentIssues: [oldIssue], request: oldRequest, resolvedRuleSet: changedRuleSet, planningContext: oldContext, actor: coach, at })).toMatchObject({ ok: false, code: "ISSUE_NOT_REVIEWABLE" });
  });

  it("does not accept a client AI actor as the server-resolved reviewer", () => {
    const prescription = planOk();
    prescription.sets = overrideField(prescription.sets, 1);
    prescription.repsPerSet = overrideField(prescription.repsPerSet, 31);
    const context = contextFor(prescription.method, prescription.templateId, JSON.parse(JSON.stringify(prescription)));
    const issue = outputIssue(prescription, "PLA_REPS_PER_SET");
    const aiActor: AiPlannerActor = { kind: "AI_PLANNER", provider: "test-provider", model: "test-model", requestId: "ai-1" };
    expect(validatePlausibilityReviewRequest({
      currentIssues: [issue], request: reviewRequest(issue), resolvedRuleSet, planningContext: context,
      actor: aiActor as unknown as CoachActor, at,
    })).toMatchObject({ ok: false, code: "SERVER_ACTOR_INVALID" });
    // @ts-expect-error AI actors are not accepted by the server review contract.
    validatePlausibilityReviewRequest({ currentIssues: [issue], request: reviewRequest(issue), resolvedRuleSet, planningContext: context, actor: aiActor, at });
  });

  it("constructs an AppliedPlausibilityReview without changing planner BLOCKED behavior", () => {
    const blockedRequest = makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({
      marks: [{ event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" }],
    }));
    const plan = planRunningPrescription(blockedRequest);
    expect(plan.status).toBe("BLOCKED");
    if (plan.status !== "BLOCKED") throw new Error("expected F15 block");
    const finding = plan.findings.find((candidate) => candidate.plausibility?.ruleId === "PLA_INPUT_FLY_10M");
    if (!finding) throw new Error("missing F15 finding");
    const context = contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: blockedRequest });
    const issue = buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet, planningContext: context });
    if (!issue) throw new Error("expected an issue");
    const validation = validatePlausibilityReviewRequest({ currentIssues: [issue], request: reviewRequest(issue), resolvedRuleSet, planningContext: context, actor: coach, at });
    expect(validation.ok).toBe(true);
    expect(planRunningPrescription(blockedRequest).status).toBe("BLOCKED");
  });

  it("binds selected record findings to their source timing and stable group member identity", () => {
    const photo: TimedMark = { event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" };
    const hand = { ...photo, timing: "HAND" as const };
    const photoRequest = makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({ marks: [photo] }));
    const photoPlan = planRunningPrescription(photoRequest);
    if (photoPlan.status !== "BLOCKED") throw new Error("expected selected F15 block");
    const photoFinding = photoPlan.findings.find((finding) => finding.plausibility?.ruleId === "PLA_INPUT_FLY_10M");
    if (!photoFinding) throw new Error("missing F15 finding");
    const handRequest = makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({ marks: [hand] }));
    expect(buildPlausibilityIssueFromFinding({
      finding: photoFinding,
      resolvedRuleSet,
      planningContext: contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: handRequest }),
    })).toBeNull();
    const duplicateMarkRequest = makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({ marks: [photo, { ...photo }] }));
    expect(buildPlausibilityIssueFromFinding({ finding: photoFinding, resolvedRuleSet, planningContext: contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: duplicateMarkRequest }) })).toBeNull();

    const first = { date: isoDateSchema.parse("2025-01-01"), heightCm: 49.9 };
    const second = { date: isoDateSchema.parse("2026-01-01"), heightCm: 170 };
    const member = (memberId: string) => ({
      memberId,
      birthDate: null,
      ageBandOverride: "ADULT" as const,
      primaryEvent: "100m" as const,
      maturity: { status: "POST" as const, confidence: "HIGH" as const, method: "GROWTH_VELOCITY" as const, assessedAt: planningDate, heightHistory: [first, second] },
      trainingAge: { structuredSprintYears: 5, coachAssignedTier: "ADVANCED" as const },
    });
    const group: Subject = { kind: "GROUP", profile: { label: "display label", members: [member("member:A"), member("member:B")], allowAdvancedMethods: true } };
    const groupRequest = makeRequest("ACCELERATION", "ACC_BLOCK_20", group);
    const groupFindings = checkInputPlausibility(groupRequest, resolvedRuleSet.ruleSet).blocking
      .filter((finding) => finding.plausibility?.ruleId === "PLA_INPUT_HEIGHT");
    const findingA = groupFindings.find((finding) => finding.metric?.startsWith("members[0]"));
    const findingB = groupFindings.find((finding) => finding.metric?.startsWith("members[1]"));
    if (!findingA || !findingB) throw new Error("expected per-member height findings");
    const contextA = contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { request: groupRequest, subjectIdentity: "group:4" });
    const issueA = buildPlausibilityIssueFromFinding({ finding: findingA, resolvedRuleSet, planningContext: contextA });
    const issueB = buildPlausibilityIssueFromFinding({ finding: findingB, resolvedRuleSet, planningContext: contextA });
    expect(issueA?.target.kind).toBe("HEIGHT_POINT");
    expect(issueB?.target.kind).toBe("HEIGHT_POINT");
    if (issueA?.target.kind !== "HEIGHT_POINT" || issueB?.target.kind !== "HEIGHT_POINT") throw new Error("expected height targets");
    expect(issueA.target.recordDigest).not.toBe(issueB.target.recordDigest);
    expect(issueA.target.recordDigest).toBe(buildHeightPointRecordDigest({ point: first, subjectIdentity: "group:4", memberIdentity: "member:A" }));

    const onlyBRequest = makeRequest("ACCELERATION", "ACC_BLOCK_20", { ...group, profile: { ...group.profile, members: [member("member:B")] } });
    expect(buildPlausibilityIssueFromFinding({
      finding: findingA,
      resolvedRuleSet,
      planningContext: contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { request: onlyBRequest, subjectIdentity: "group:4" }),
    })).toBeNull();
    for (const members of [
      [member("member:A"), member("member:A")],
      [{ ...member("member:A"), memberId: undefined }],
      [{ ...member("member:A"), maturity: { ...member("member:A").maturity, heightHistory: [first, { ...first }, second] } }],
    ]) {
      const ambiguous = makeRequest("ACCELERATION", "ACC_BLOCK_20", { ...group, profile: { ...group.profile, members } });
      expect(buildPlausibilityIssueFromFinding({ finding: findingA, resolvedRuleSet, planningContext: contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { request: ambiguous, subjectIdentity: "group:4" }) })).toBeNull();
    }

    const reversedGroup = { ...group, profile: { ...group.profile, members: [...group.profile.members].reverse() } };
    const reversedRequest = makeRequest("ACCELERATION", "ACC_BLOCK_20", reversedGroup);
    const reversedFindingA = checkInputPlausibility(reversedRequest, resolvedRuleSet.ruleSet).blocking
      .find((finding) => finding.plausibility?.sourceRecord?.kind === "HEIGHT_POINT" && finding.plausibility.sourceRecord.memberIdentity === "member:A");
    if (!reversedFindingA) throw new Error("missing reordered member A finding");
    const reversedIssueA = buildPlausibilityIssueFromFinding({
      finding: reversedFindingA,
      resolvedRuleSet,
      planningContext: contextFor("ACCELERATION", "ACC_BLOCK_20", undefined, { request: reversedRequest, subjectIdentity: "group:4" }),
    });
    expect(reversedIssueA?.issueDigest).toBe(issueA.issueDigest);
  });

  it("rejects an old Fly10 finding when its exact record remains present but is no longer selected", () => {
    const photo: TimedMark = { event: "FLY10", timeS: 5.1, date: isoDateSchema.parse("2026-08-01"), timing: "PHOTO_CELL" };
    const oldRequest = makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({ marks: [photo] }));
    const oldPlan = planRunningPrescription(oldRequest);
    if (oldPlan.status !== "BLOCKED") throw new Error("expected Fly10 block");
    const finding = oldPlan.findings.find((candidate) => candidate.plausibility?.ruleId === "PLA_INPUT_FLY_10M");
    if (!finding) throw new Error("expected selected Fly10 finding");
    const oldIssue = buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet, planningContext: contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: oldRequest }) });
    if (!oldIssue) throw new Error("expected current selected issue");
    const currentRequest = makeRequest("TEMPO_EXTENSIVE", "TE_100", athlete({
      marks: [photo],
      vmax: { valueMps: 10, lowerMps: 9.9, upperMps: 10.1, source: "RADAR_LASER", confidence: "HIGH", measuredAt: planningDate },
    }));
    const currentPlan = planRunningPrescription(currentRequest);
    expect(currentPlan.status).toBe("OK");
    if (currentPlan.status !== "OK") throw new Error("expected direct measured Vmax to be selected");
    expect(currentPlan.prescription.findings.some((candidate) => candidate.plausibility?.ruleId === "PLA_INPUT_FLY_10M" && candidate.severity === "BLOCK")).toBe(false);
    expect(buildPlausibilityIssueFromFinding({
      finding, resolvedRuleSet, planningContext: contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: currentRequest }),
    })).toBeNull();
    const currentContext = contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: currentRequest });
    const forged = { ...oldIssue, contextDigest: buildPlausibilityReviewContextDigest(currentContext) };
    forged.issueDigest = buildPlausibilityIssueDigest(forged);
    expect(validatePlausibilityReviewRequest({ currentIssues: [forged], request: reviewRequest(forged), resolvedRuleSet, planningContext: currentContext, actor: coach, at }).ok).toBe(false);
    const alteredRecord = { ...oldIssue, target: { kind: "TIMED_MARK" as const, recordDigest: "f".repeat(64) } };
    alteredRecord.issueDigest = buildPlausibilityIssueDigest(alteredRecord);
    expect(validatePlausibilityReviewRequest({ currentIssues: [alteredRecord], request: reviewRequest(alteredRecord), resolvedRuleSet, planningContext: contextFor("TEMPO_EXTENSIVE", "TE_100", undefined, { request: oldRequest }), actor: coach, at }).ok).toBe(false);
  });

  it("rejects rehashed forged output bodies and altered finding source/confidence against the current prescription", () => {
    const fixture = semanticFixture("DURATION");
    const context = contextFor(fixture.prescription.method, fixture.prescription.templateId, fixture.prescription, { request: fixture.request });
    const finding = findingFor(fixture.prescription, "PLA_REPS_PER_SET");
    const issue = buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet, planningContext: context });
    if (!issue || !finding.value) throw new Error("expected output issue");
    const forged = { ...issue, observation: { kind: "SCALAR" as const, value: 32, unit: issue.observation.unit } };
    forged.issueDigest = buildPlausibilityIssueDigest(forged);
    expect(validatePlausibilityReviewRequest({ currentIssues: [forged], request: reviewRequest(forged), resolvedRuleSet, planningContext: context, actor: coach, at }).ok).toBe(false);
    for (const value of [
      { ...finding.value, source: finding.value.source === "UNKNOWN" ? "MEASURED" as const : "UNKNOWN" as const },
      { ...finding.value, confidence: finding.value.confidence === "LOW" ? "HIGH" as const : "LOW" as const },
    ]) {
      expect(buildPlausibilityIssueFromFinding({ finding: { ...finding, value }, resolvedRuleSet, planningContext: context })).toBeNull();
    }
  });

  it("keeps the F07 planner BLOCK after a valid review object exists", () => {
    const request = makeRequest();
    const baseline = planRunningPrescription(request);
    if (baseline.status !== "OK") throw new Error(JSON.stringify(baseline));
    const testRuleSet = structuredClone(resolvedRuleSet.ruleSet);
    const repsRule = testRuleSet.plausibility.find((rule) => rule.ruleId === "PLA_REPS_PER_SET");
    if (!repsRule?.blockThreshold) throw new Error("missing F07 RuleSet block policy");
    repsRule.blockThreshold.max = baseline.prescription.repsPerSet.value - 1;
    const testResolved = { ...resolvedRuleSet, ruleSet: testRuleSet };
    const blocked = planRunningPrescriptionWithRuleSet(request, testResolved);
    expect(blocked.status).toBe("BLOCKED");
    if (blocked.status !== "BLOCKED") throw new Error("expected F07 BLOCK");
    const testPrescription = { ...baseline.prescription };
    testPrescription.sets = overrideField(testPrescription.sets, 1);
    testPrescription.repsPerSet = overrideField(testPrescription.repsPerSet, 31);
    const finding = checkOutputPlausibility(testPrescription, testRuleSet).findings.find((candidate) => candidate.plausibility?.ruleId === "PLA_REPS_PER_SET");
    if (!finding) throw new Error("missing F07 finding");
    const testContext = contextFor("ACCELERATION", "ACC_BLOCK_20", testPrescription);
    const issue = buildPlausibilityIssueFromFinding({ finding, resolvedRuleSet: testResolved, planningContext: testContext });
    if (!issue) throw new Error("expected F07 issue");
    const approved = validatePlausibilityReviewRequest({
      currentIssues: [issue],
      request: reviewRequest(issue),
      resolvedRuleSet: testResolved,
      planningContext: testContext,
      actor: coach,
      at,
    });
    expect(approved.ok).toBe(true);
    expect(planRunningPrescriptionWithRuleSet(request, testResolved).status).toBe("BLOCKED");
  });
});
