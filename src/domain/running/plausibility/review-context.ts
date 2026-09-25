/** Semantic planning identity for reviews. Every omitted field is an explicit audit decision. */
import { canonicalStringify } from "../../shared/canonical-json";
import type { PlanRequest } from "../planning/schema";
import type { RunningPrescriptionValue } from "../types/prescription";
import type { IntensityReference, TimedMark, VelocityEstimate } from "../types/intensity";
import type { MaturityAssessment } from "../types/subject";
import { plausibilityReviewContextSchema, type CanonicalReviewContextValue, type PlausibilityReviewContext } from "../types/plausibilityReview";

export type PlausibilityReviewPlanningInput = {
  request: PlanRequest;
  subjectIdentity: string;
  itemIdentity: string;
  /** Input findings can precede generation; output findings require the current prescription. */
  prescription?: RunningPrescriptionValue;
};

const OMIT_METADATA = Symbol("non-semantic metadata");
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
/** Required keys include optional fields and every branch of a union. Adding a field fails typecheck. */
type FieldProjection<T> = { [K in KeysOfUnion<T>]-?: CanonicalReviewContextValue | typeof OMIT_METADATA };

function project<T>(fields: FieldProjection<T>): CanonicalReviewContextValue {
  const result: Record<string, CanonicalReviewContextValue> = {};
  for (const [key, value] of Object.entries<CanonicalReviewContextValue | typeof OMIT_METADATA>(fields)) {
    if (value !== OMIT_METADATA) result[key] = value;
  }
  return result;
}

function assertNever(value: never): never {
  throw new Error(`Unmapped review context variant: ${String(value)}`);
}

function compareCanonical(left: CanonicalReviewContextValue, right: CanonicalReviewContextValue): number {
  const a = canonicalStringify(left);
  const b = canonicalStringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

// Use schema-inferred types rather than a narrower hand-written structural type: adding a
// nested schema field must also require an explicit decision in the projection inventory.
type Rep = RunningPrescriptionValue["rep"];
type RepOf<K extends Rep["kind"]> = Extract<Rep, { kind: K }>;
type ReviewField = RunningPrescriptionValue["sets"] | RunningPrescriptionValue["repsPerSet"] |
  NonNullable<RunningPrescriptionValue["rest"]["repRestS" | "setRestS" | "intraRepRestS"]> |
  RepOf<"DISTANCE">["distanceM"] | RepOf<"DURATION">["durationS"] |
  RepOf<"FLY">["buildUpDistanceM" | "flyZoneDistanceM"] | NonNullable<RepOf<"SPLIT">["segments"][number]["restAfterS"]>;
type ReviewRange = NonNullable<ReviewField["coachEditable" | "recommended" | "hardSafety"]>;
type ReviewInterval = RunningPrescriptionValue["exposure"][keyof RunningPrescriptionValue["exposure"]] |
  NonNullable<RunningPrescriptionValue["intensity"]["target"]> | RepOf<"DURATION">["displayDistanceM"] |
  RepOf<"FLY">["plannedHighSpeedExposureM"] | Extract<IntensityReference, { kind: "RACE_PACE" }>["targetTimeS"] |
  Extract<IntensityReference, { kind: "TARGET_SPLIT" }>["segments"][number]["targetS"];

function rangeState(range: ReviewRange | null): CanonicalReviewContextValue {
  return range === null ? null : project<ReviewRange>({ min: range.min, max: range.max, unit: range.unit });
}

function intervalState(value: ReviewInterval | null): CanonicalReviewContextValue {
  return value === null ? null : project<ReviewInterval>({
    lower: value.lower, upper: value.upper, unit: value.unit, source: value.source, confidence: value.confidence,
  });
}

function fieldState(field: ReviewField | null): CanonicalReviewContextValue {
  return field === null ? null : project<ReviewField>({
    value: field.value,
    unit: field.unit,
    recommended: rangeState(field.recommended),
    coachEditable: rangeState(field.coachEditable),
    hardSafety: rangeState(field.hardSafety),
    position: field.position,
    origin: field.origin,
    evidenceIds: OMIT_METADATA, // Citation inventory, not the value or its permission boundaries.
  });
}

function timedMarkState(mark: TimedMark): CanonicalReviewContextValue {
  return project<TimedMark>({
    event: mark.event, timeS: mark.timeS, date: mark.date, timing: mark.timing,
    videoFps: mark.videoFps ?? null, wind: mark.wind ?? null, startType: mark.startType ?? null,
    surface: mark.surface ?? null, spikes: mark.spikes ?? null,
  });
}

function performanceMarksState(marks: readonly TimedMark[]): CanonicalReviewContextValue {
  // The current reference resolver prioritizes latest date within fly/non-100m buckets;
  // equal-date ties keep input priority. Those ties are ordered semantics, not a set.
  const priorityKey = (mark: TimedMark) => {
    // Event is a typed discriminator, never a parsed display name or rule id.
    switch (mark.event) {
      case "FLY10": case "FLY20": case "FLY30": return `FLY:${mark.date}`;
      case "100m": return `100m:${mark.date}`;
      default: return `OTHER:${mark.date}`;
    }
  };
  return [...marks].sort((a, b) => {
    const left = priorityKey(a);
    const right = priorityKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }).map(timedMarkState);
}

function velocityState(vmax: VelocityEstimate): CanonicalReviewContextValue {
  return project<VelocityEstimate>({
    valueMps: vmax.valueMps, lowerMps: vmax.lowerMps, upperMps: vmax.upperMps,
    source: vmax.source, confidence: vmax.confidence, measuredAt: vmax.measuredAt, modelId: vmax.modelId ?? null,
  });
}

function referenceState(reference: IntensityReference): CanonicalReviewContextValue {
  switch (reference.kind) {
    case "MAX_INTENT":
    case "RELAXED_SUBMAX": return project<typeof reference>({ kind: reference.kind });
    case "MEASURED_VMAX": return project<typeof reference>({ kind: reference.kind, vmax: velocityState(reference.vmax) });
    case "FLY_SPLIT": return project<typeof reference>({ kind: reference.kind, flyZoneM: reference.flyZoneM, mark: timedMarkState(reference.mark) });
    case "SAME_DISTANCE_BEST": return project<typeof reference>({ kind: reference.kind, distanceM: reference.distanceM, mark: timedMarkState(reference.mark) });
    case "RACE_PACE": return project<typeof reference>({ kind: reference.kind, event: reference.event, targetTimeS: intervalState(reference.targetTimeS) });
    case "TARGET_SPLIT": return project<typeof reference>({
      kind: reference.kind,
      // Split sequence is semantic; never sort it.
      segments: reference.segments.map((segment) => project<typeof segment>({ distanceM: segment.distanceM, targetS: intervalState(segment.targetS) })),
    });
    case "VELOCITY_DECREMENT": return project<typeof reference>({ kind: reference.kind, band: reference.band, measured: reference.measured });
    // This label IS the coach's instruction (the only definition of this reference), not a UI caption.
    case "COACH_DEFINED": return project<typeof reference>({ kind: reference.kind, label: reference.label });
    default: return assertNever(reference);
  }
}

function repState(rep: RunningPrescriptionValue["rep"]): CanonicalReviewContextValue {
  switch (rep.kind) {
    case "DISTANCE": return project<typeof rep>({ kind: rep.kind, distanceM: fieldState(rep.distanceM) });
    case "DURATION": return project<typeof rep>({
      kind: rep.kind, durationS: fieldState(rep.durationS), displayDistanceM: intervalState(rep.displayDistanceM),
    });
    case "SPLIT": return project<typeof rep>({
      kind: rep.kind,
      segments: rep.segments.map((segment) => project<typeof segment>({
        distanceM: segment.distanceM, restAfterS: fieldState(segment.restAfterS),
      })),
    });
    case "FLY": return project<typeof rep>({
      kind: rep.kind, buildUpDistanceM: fieldState(rep.buildUpDistanceM), flyZoneDistanceM: fieldState(rep.flyZoneDistanceM),
      decelerationDistanceM: rep.decelerationDistanceM, totalRunningDistanceM: rep.totalRunningDistanceM,
      plannedHighSpeedExposureM: intervalState(rep.plannedHighSpeedExposureM),
    });
    case "ATTEMPTS": return project<typeof rep>({
      kind: rep.kind, approach: rep.approach,
      approachDistanceM: rep.approachDistanceM === null ? null : project<NonNullable<typeof rep.approachDistanceM>>({
        value: rep.approachDistanceM.value, unit: rep.approachDistanceM.unit, source: rep.approachDistanceM.source,
      }),
    });
    default: return assertNever(rep);
  }
}

function monitoringState(snapshot: RunningPrescriptionValue["monitoringSnapshot"]): CanonicalReviewContextValue {
  const policy = snapshot.stopPolicy;
  return project<typeof snapshot>({
    stopPolicy: project<typeof policy>({
      id: policy.id, method: policy.method, appliesToRecoveryStructure: policy.appliesToRecoveryStructure,
      appliesToEligibilityPath: policy.appliesToEligibilityPath,
      referenceDescription: OMIT_METADATA, ruleDescriptionJa: OMIT_METADATA, // Localized explanations of runtime fields.
      consecutiveFailuresToStop: policy.consecutiveFailuresToStop, numericStopAvailable: policy.numericStopAvailable,
      runtime: { ...policy.runtime }, // All fields are structured execution semantics; new fields are included automatically.
    }),
    timingTolerances: snapshot.timingTolerances.map((tolerance) => project<typeof tolerance>({
      timing: tolerance.timing, toleranceS: tolerance.toleranceS, toleranceSPerFps: tolerance.toleranceSPerFps,
      numericStopAllowed: tolerance.numericStopAllowed, coachOnlyRatioThreshold: tolerance.coachOnlyRatioThreshold,
      evidenceIds: OMIT_METADATA, judgement: OMIT_METADATA, provisional: OMIT_METADATA, // Citation/classification metadata only.
    })).sort(compareCanonical),
    safetyPolicy: project<typeof snapshot.safetyPolicy>({
      // Highest rank wins; equal-rank groups retain first-match priority.
      redFlagGroups: [...snapshot.safetyPolicy.redFlagGroups].sort((a, b) => a.severityRank - b.severityRank).map((group) => project<typeof group>({
        redFlags: [...group.redFlags].sort(), safetyOutcome: group.safetyOutcome, severityRank: group.severityRank,
      })),
      painPresentOutcome: snapshot.safetyPolicy.painPresentOutcome,
    }),
    vdecClassificationPolicy: snapshot.vdecClassificationPolicy === undefined ? null : project<NonNullable<typeof snapshot.vdecClassificationPolicy>>({
      // Classification uses first matching band; priority must survive possible overlaps.
      bands: snapshot.vdecClassificationPolicy.bands.map((band) => project<typeof band>({
        id: band.id, classification: band.classification, lowerPercent: band.lowerPercent, upperPercent: band.upperPercent,
        lowerInclusive: band.lowerInclusive, upperInclusive: band.upperInclusive, classificationOnly: band.classificationOnly,
        evidenceIds: OMIT_METADATA,
      })),
    }),
  });
}

/** Complete key inventory plus exhaustive rep switch: new fields cannot silently disappear. */
function prescriptionState(p: RunningPrescriptionValue): CanonicalReviewContextValue {
  const projected = project<RunningPrescriptionValue>({
    schemaVersion: p.schemaVersion, method: p.method, templateId: p.templateId, recoveryStructure: p.recoveryStructure,
    tier: p.tier, rep: repState(p.rep), sets: fieldState(p.sets), repsPerSet: fieldState(p.repsPerSet),
    rest: project<typeof p.rest>({
      repRestS: fieldState(p.rest.repRestS), setRestS: fieldState(p.rest.setRestS), intraRepRestS: fieldState(p.rest.intraRepRestS),
      displayAsFloor: OMIT_METADATA, feasibility: p.rest.feasibility, // Floor is a fixed presentation convention, not a numeric rest.
    }),
    intensity: project<typeof p.intensity>({ reference: referenceState(p.intensity.reference), target: intervalState(p.intensity.target) }),
    exposure: project<typeof p.exposure>({
      totalRunningDistanceM: intervalState(p.exposure.totalRunningDistanceM),
      plannedHighSpeedExposureM: intervalState(p.exposure.plannedHighSpeedExposureM),
      nearMaxSprintVolumeM: intervalState(p.exposure.nearMaxSprintVolumeM),
    }),
    stopPolicyId: p.stopPolicyId, monitoringSnapshot: monitoringState(p.monitoringSnapshot),
    confidence: { ...p.confidence }, readinessApplied: [...p.readinessApplied].sort(), safetyOutcome: p.safetyOutcome,
    ruleSet: { ...p.ruleSet }, loadSnapshot: p.loadSnapshot ? { ...p.loadSnapshot } : null,
    planningControls: p.planningControls ? { ...p.planningControls } : null,
    findings: OMIT_METADATA, rationale: OMIT_METADATA, generatedBy: OMIT_METADATA, // Derived explanations / creation audit; not numeric authority.
  });
  return { prescription: projected, totalReps: p.sets.value * p.repsPerSet.value };
}

function maturityState(maturity: MaturityAssessment): CanonicalReviewContextValue {
  return project<MaturityAssessment>({
    status: maturity.status, confidence: maturity.confidence, method: maturity.method,
    assessedAt: OMIT_METADATA, // Current maturity resolver does not use assessment recency.
    equation: maturity.equation ? { ...maturity.equation } : null,
    // The endpoint selector keeps input priority for same-date measurements. Different
    // dates are set-like, but sorting ties by height would erase a material selection.
    heightHistory: [...(maturity.heightHistory ?? [])].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map((point) => ({ ...point })),
  });
}

function subjectState(subject: PlanRequest["subject"]): CanonicalReviewContextValue {
  if (subject.kind === "ATHLETE") {
    const p = subject.profile;
    return project<typeof subject>({ kind: subject.kind, profile: project<typeof p>({
      birthDate: p.birthDate, ageBandOverride: p.ageBandOverride ?? null, primaryEvent: p.primaryEvent,
      schoolGrade: OMIT_METADATA, sexForNorms: OMIT_METADATA, // Not consumed by current planner; no implicit age/sex norms.
      maturity: maturityState(p.maturity), trainingAge: { ...p.trainingAge },
      marks: performanceMarksState(p.marks), vmax: p.vmax ? velocityState(p.vmax) : null,
      allowAdvancedMethods: p.allowAdvancedMethods,
    }) });
  }
  if (subject.kind === "GROUP") {
    const p = subject.profile;
    return project<typeof subject>({ kind: subject.kind, profile: project<typeof p>({
      label: OMIT_METADATA, allowAdvancedMethods: p.allowAdvancedMethods,
      availableMinutes: p.availableMinutes ?? null, memberCountHint: p.memberCountHint ?? null,
      members: p.members.map((member) => project<typeof member>({
        memberId: member.memberId ?? null, birthDate: member.birthDate, ageBandOverride: member.ageBandOverride ?? null,
        primaryEvent: member.primaryEvent, maturity: maturityState(member.maturity), trainingAge: { ...member.trainingAge },
      })).sort(compareCanonical),
    }) });
  }
  return assertNever(subject);
}

function readinessState(readiness: PlanRequest["readiness"]): CanonicalReviewContextValue {
  return readiness === null ? null : project<typeof readiness>({
    actions: [...readiness.actions].sort(),
    triggers: readiness.triggers.map((trigger) => project<typeof trigger>({
      ruleId: trigger.ruleId, actions: [...trigger.actions].sort(),
    })).sort(compareCanonical),
    stopPlanning: readiness.stopPlanning, safetyOutcome: readiness.safetyOutcome,
    highIntensityAllowedToday: readiness.highIntensityAllowedToday, painCheckRequired: readiness.painCheckRequired,
    transientFindings: OMIT_METADATA, ruleSet: { ...readiness.ruleSet }, evaluatedFor: { ...readiness.evaluatedFor },
  });
}

function requestState(request: PlanRequest): CanonicalReviewContextValue {
  return project<PlanRequest>({
    planningDate: request.planningDate, selection: { ...request.selection }, subject: subjectState(request.subject),
    actor: { kind: request.actor.kind }, // Role changes planner authority. Actor identifiers belong to the review audit trail.
    coachEdits: request.coachEdits.map((edit) => project<typeof edit>({ field: edit.field, value: edit.value, unit: edit.unit })).sort(compareCanonical),
    overrides: request.overrides.map((override) => project<typeof override>({
      target: { ...override.target }, newValue: override.newValue ?? null, confirmedTwice: override.confirmedTwice,
      reason: OMIT_METADATA, actor: OMIT_METADATA, at: OMIT_METADATA,
    })).sort(compareCanonical),
    coachReference: request.coachReference === null ? null : referenceState(request.coachReference),
    confirmedFindingCodes: [...request.confirmedFindingCodes].sort(),
    positionPreference: request.positionPreference, readiness: readinessState(request.readiness),
    menuContext: project<typeof request.menuContext>({
      phase: request.menuContext.phase, plannedDate: request.menuContext.plannedDate,
      // A scheduled instant drives 48h/72h rules; it is NOT an ephemeral audit timestamp.
      plannedAt: request.menuContext.plannedAt === null ? null : new Date(request.menuContext.plannedAt).toISOString(),
      competitions: request.menuContext.competitions.map((competition) => project<typeof competition>({
        id: competition.id, date: competition.date, endDate: competition.endDate ?? competition.date, priority: competition.priority,
      })).sort(compareCanonical),
      otherItems: request.menuContext.otherItems.map((item) => {
        switch (item.kind) {
          case "LEGACY": return project<typeof item>({ kind: item.kind, item: { ...item.item } });
          case "RUNNING_V2": return project<typeof item>({ kind: item.kind, prescription: prescriptionState(item.prescription) });
          default: return assertNever(item);
        }
      }).sort(compareCanonical),
      availableMinutes: request.menuContext.availableMinutes,
    }),
    history: request.history === null ? null : project<typeof request.history>({
      events: request.history.events.map((event) => ({ ...event, at: new Date(event.at).toISOString() })).sort(compareCanonical),
      coverage72h: request.history.coverage72h, coverage7d: request.history.coverage7d, coverage28d: request.history.coverage28d,
      dailyActivity7d: request.history.dailyActivity7d.map((day) => ({ ...day })).sort(compareCanonical),
    }),
  });
}

export function buildPlausibilityReviewContext(input: PlausibilityReviewPlanningInput): PlausibilityReviewContext {
  const { request, prescription } = input;
  if (prescription && (prescription.method !== request.selection.method || prescription.templateId !== request.selection.templateId)) {
    throw new Error("Prescription selection does not match the validated planning request");
  }
  return plausibilityReviewContextSchema.parse({
    subject: { kind: request.subject.kind, identity: input.subjectIdentity },
    planningDate: request.planningDate, selection: request.selection, itemIdentity: input.itemIdentity,
    planningState: {
      subjectState: subjectState(request.subject), requestState: requestState(request),
      prescriptionState: prescription ? prescriptionState(prescription) : null,
    },
  });
}

export function canonicalPlausibilityReviewContext(context: PlausibilityReviewContext) {
  return {
    subject: { kind: context.subject.kind, identity: context.subject.identity }, planningDate: context.planningDate,
    method: context.selection.method, templateId: context.selection.templateId, itemIdentity: context.itemIdentity,
    planningState: context.planningState,
  };
}
