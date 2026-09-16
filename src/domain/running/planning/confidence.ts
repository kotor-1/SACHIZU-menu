/**
 * Running Prescription Engine v2 — §9.2 step 10: CONFIDENCE & DIRECTNESS DERIVATION（§5.3〜§5.5）。
 *
 * - Evidence は「この処方が使った Envelope セル」の evidenceIds だけから集める。
 * - directness は R1 `deriveDirectness()` を runtime に適用する。ageBand が UNKNOWN の場合や
 *   maturity が EFFECTIVE_UNKNOWN の場合、GROUP の複数 member の場合は、ありうる context
 *   すべてで評価して**最も弱い** directness を採用する（楽観的に DIRECT にしない）。
 * - prescriptionConfidence は R1 `derivePrescriptionConfidence()` をそのまま使う。
 *   R4 では週次・履歴（step 5）が未接続のため historyCoverage72h は `NOT_EVALUATED`（中立）。
 * - [R4 provisional policy] performanceLevel は trainingAge tier から写像する:
 *   TRAINED / ADVANCED → TRAINED、BEGINNER / DEVELOPING → YOUTH_DEVELOPING。ELITE / NATIONAL には
 *   写像しない（競技レベルの情報を持たないため上位扱いしない）。
 */
import type { EnvelopeField, RuleSet } from "../rules/schema";
import type { Finding } from "../types/findings";
import type { EvidenceId } from "../types/primitives";
import type { Directness, InputDataConfidence, PrescriptionConfidence } from "../types/prescription";
import { AGE_BANDS, type AgeBand, type MaturityStatus, type TrainingAgeTier } from "../types/subject";
import type { PerformanceLevel } from "../evidence/schema";
import { deriveDirectness } from "../evidence/directness";
import { derivePrescriptionConfidence, type HistoryCoverage, type UsedEvidenceSummary } from "../evidence/confidence";
import { resolveAgeBand, type ResolvedAgeBand } from "../context/ageBand";
import { deriveTrainingAgeTier } from "../context/trainingAge";
import type { MaturityConstraintCategory } from "../context/maturity";
import type { SubjectProfile } from "../context/subject";
import type { SelectedEnvelope } from "./envelope";
import { positionCapForConfidence, type PlacedPosition } from "./placement";
import { itemFinding, type PlanRequest } from "./schema";

export function performanceLevelForTrainingAge(tier: TrainingAgeTier): PerformanceLevel {
  return tier === "TRAINED" || tier === "ADVANCED" ? "TRAINED" : "YOUTH_DEVELOPING";
}

type DirectnessContext = { ageBand: AgeBand; maturity: MaturityStatus; performanceLevel: PerformanceLevel };

function ageBandsFor(band: ResolvedAgeBand): readonly AgeBand[] {
  return band === "UNKNOWN" ? AGE_BANDS : [band];
}

function maturityStatusesFor(category: MaturityConstraintCategory): readonly MaturityStatus[] {
  // EFFECTIVE_UNKNOWN は「本当はどれか分からない」ので、ありうる status すべてで評価する。
  return category === "EFFECTIVE_UNKNOWN" ? ["PRE", "CIRCA", "POST", "UNKNOWN"] : [category];
}

function contextsFor(
  bands: readonly ResolvedAgeBand[],
  categories: readonly MaturityConstraintCategory[],
  tier: TrainingAgeTier,
): DirectnessContext[] {
  const performanceLevel = performanceLevelForTrainingAge(tier);
  const out: DirectnessContext[] = [];
  for (const band of bands) {
    for (const ageBand of ageBandsFor(band)) {
      for (const category of categories) {
        for (const maturity of maturityStatusesFor(category)) out.push({ ageBand, maturity, performanceLevel });
      }
    }
  }
  return out;
}

export function directnessContexts(request: PlanRequest, profile: SubjectProfile): DirectnessContext[] {
  if (request.subject.kind === "ATHLETE" || request.subject.profile.members.length === 0) {
    return contextsFor([profile.ageBand], profile.effectiveMaturityCategories, profile.trainingAgeTier);
  }
  const members = request.subject.profile.members;
  return members.flatMap((member, i) =>
    contextsFor(
      [resolveAgeBand({ birthDate: member.birthDate, ageBandOverride: member.ageBandOverride }, request.planningDate)],
      [profile.memberMaturities[i]?.constraintCategory ?? "EFFECTIVE_UNKNOWN"],
      deriveTrainingAgeTier(member.trainingAge),
    ),
  );
}

const DIRECTNESS_WEAKNESS: Record<Exclude<Directness, "NOT_APPLICABLE">, number> = { DIRECT: 0, PARTIAL: 1, INDIRECT: 2 };

function weaker(a: Exclude<Directness, "NOT_APPLICABLE">, b: Exclude<Directness, "NOT_APPLICABLE">) {
  return DIRECTNESS_WEAKNESS[b] > DIRECTNESS_WEAKNESS[a] ? b : a;
}

export type PlanningConfidence = {
  prescription: PrescriptionConfidence;
  directness: Directness;
  inputData: InputDataConfidence;
  positionCap: PlacedPosition | null;
  evidenceIds: EvidenceId[];
  usedEvidence: UsedEvidenceSummary[];
  findings: Finding[];
};

export function derivePlanningConfidence(args: {
  ruleSet: RuleSet;
  envelope: SelectedEnvelope;
  usedFields: readonly EnvelopeField[];
  request: PlanRequest;
  profile: SubjectProfile;
  inputData: InputDataConfidence;
  /** [R7] §9.2 step 5（weekly context）が接続された後の実測値。未接続時のみ NOT_EVALUATED。 */
  historyCoverage72h: HistoryCoverage;
}): PlanningConfidence {
  const { ruleSet, envelope, usedFields, request, profile, inputData, historyCoverage72h } = args;

  const evidenceIds: EvidenceId[] = [];
  const seen = new Set<string>();
  for (const field of usedFields) {
    for (const id of envelope.fields[field]?.evidenceIds ?? []) {
      if (!seen.has(id)) {
        seen.add(id);
        evidenceIds.push(id);
      }
    }
  }

  const contexts = directnessContexts(request, profile);
  const usedEvidence: UsedEvidenceSummary[] = evidenceIds.map((id) => {
    const record = ruleSet.evidence.find((e) => e.id === id);
    if (!record) throw new Error(`Envelope references unknown EvidenceRecord: ${id}`);
    if (record.sourceType === "ENGINE_POLICY") {
      return { sourceType: record.sourceType, verification: record.verification, directness: "NOT_APPLICABLE" };
    }
    const directness = contexts
      .map((ctx) => deriveDirectness({ sourceType: record.sourceType, population: record.population }, ctx))
      .reduce<Exclude<Directness, "NOT_APPLICABLE">>((acc, d) => (d === "NOT_APPLICABLE" ? acc : weaker(acc, d)), "DIRECT");
    return { sourceType: record.sourceType, verification: record.verification, directness };
  });

  const applicable = usedEvidence.filter((e) => e.directness !== "NOT_APPLICABLE");
  const directness: Directness =
    applicable.length === 0
      ? "NOT_APPLICABLE"
      : applicable.reduce<Exclude<Directness, "NOT_APPLICABLE">>(
          (acc, e) => weaker(acc, e.directness as Exclude<Directness, "NOT_APPLICABLE">),
          "DIRECT",
        );

  const prescription = derivePrescriptionConfidence({
    usedEvidence,
    inputDataConfidence: inputData,
    historyCoverage72h,
  });

  const findings: Finding[] = [];
  switch (prescription) {
    case "MODERATE":
      findings.push(itemFinding("CONFIDENCE_MODERATE", "INFO", { evidenceIds }));
      break;
    case "LOW":
      findings.push(itemFinding("CONFIDENCE_LOW", "REQUIRE_COACH_REVIEW", { evidenceIds }));
      break;
    case "POLICY_ONLY":
      findings.push(itemFinding("CONFIDENCE_POLICY_ONLY", "REQUIRE_COACH_REVIEW", { evidenceIds }));
      findings.push(itemFinding("PROVISIONAL_RULE_ONLY", "INFO", { evidenceIds }));
      break;
    case "HIGH":
      break;
  }

  return {
    prescription,
    directness,
    inputData,
    positionCap: positionCapForConfidence(prescription),
    evidenceIds,
    usedEvidence,
    findings,
  };
}
