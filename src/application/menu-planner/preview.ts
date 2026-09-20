import { z } from "zod";

import {
  AI_REASON_SANITIZED,
  aiPlannerProposalSchema,
  canonicalizeMenuPlannerIntentRequest,
  exerciseCandidateDtoSchema,
  menuPlannerIntentRequestSchema,
  menuPlannerProviderRequestSchema,
  sanitizeAiReason,
  validateAiPlannerProposalAgainstCatalog,
  type AiPlannerProposal,
  type AiPlannerItemProposal,
  type MenuPlannerIntentRequest,
} from "@/domain/menu-planner";
import {
  LEGACY_PLANNER_ENGINE_ID,
  MENU_PLANNER_ENGINE_ID,
  MENU_PLANNER_PREVIEW_SCHEMA_VERSION,
  RUNNING_PLANNER_ENGINE_ID,
  evaluateMenuPlannerPreviewAcceptance,
  type MenuPlannerContextBindingInput,
  type MenuPlannerMaterializationDigestInput,
  type MenuPlannerPreviewItemState,
} from "@/domain/menu-planner/preview";
import { BASELINE_LEVEL, type PrescriptionKind } from "@/domain/prescription/constants";
import { classify, type ClassifiableExercise } from "@/domain/prescription/classify";
import { suggestPrescription, type SuggestibleExercise } from "@/domain/prescription/calculate";
import type { Prescription } from "@/domain/shared/prescription";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { TRAINING_PHASES, type TrainingPhase } from "@/domain/menu/constants";
import {
  evaluateSessionAggregation,
  type AggregationItem,
  type SessionAggregate,
} from "@/domain/running/aggregation";
import { resolveCompetitionDay, type CompetitionRef } from "@/domain/running/competition";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { runningMenuContextSchema, type RunningMenuContext } from "@/domain/running/persistence/menuContext";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import {
  planRequestSchema,
  type EligibilityReason,
  type PlanRequest,
  type PlanResult,
} from "@/domain/running/planning/schema";
import { planRunningPrescriptionWithRuleSet } from "@/domain/running/planning";
import { checkLegacyItemPlausibility, checkOutputPlausibility, checkSessionPlausibility } from "@/domain/running/plausibility";
import { getActiveRuleSet, type ActiveRuleSetResult } from "@/domain/running/rules/loader";
import { buildAiSafeSubjectContext } from "@/domain/running/readiness/aiSafeContext";
import { resolveSubjectProfile, type SubjectProfile } from "@/domain/running/context/subject";
import { runningSelectionSchema, type RunningSelection } from "@/domain/running/types/template";
import type { Subject } from "@/domain/running/types/subject";
import type { IsoDate, IsoDateTime } from "@/domain/running/types/primitives";
import type { Finding } from "@/domain/running/types/findings";
import type { WeeklyHistoryInput } from "@/domain/running/types/load";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { RuleSet } from "@/domain/running/rules/schema";
import { findExercisesForMenuPlanner, listExercisesForMenuPlanner, type ExerciseWithRelations } from "@/infra/repositories/exercise-repository";
import { listCompetitionRefs } from "@/infra/repositories/competition-repository";
import { listLoadHistory, type LoadHistoryResult } from "@/infra/repositories/load-history-repository";
import { findMenuForOwner, type MenuDetail } from "@/infra/repositories/menu-repository";
import { buildMenuPlannerContextFingerprint, buildMenuPlannerMaterializationDigest } from "./binding";
import {
  presentMenuPlannerPreview,
  type MenuPlannerPreview,
  type MenuPlannerPreviewPresentationInput,
  type PreviewItemSelection,
  type PreviewItemSubstituteInput,
} from "@/presentation/menu-planner/preview";
import { presentFindings } from "@/presentation/running/findings";
import { presentMenuAggregation, type MenuAggregationDto } from "@/presentation/running/menu";
import { estimateSeconds } from "@/domain/shared/prescription";

const PREVIEW_PROVIDER = "VALIDATED_PROPOSAL" as const;
const PREVIEW_MODEL = "DETERMINISTIC_PREVIEW_V1" as const;
const PREVIEW_REQUEST_ID = "r12-a2-preview" as const;

const previewInputSchema = z
  .object({
    schemaVersion: z.literal(MENU_PLANNER_PREVIEW_SCHEMA_VERSION),
    ownerId: z.string().trim().min(1).max(120),
    contextMenuTemplateId: z.string().trim().min(1).max(64),
    menuName: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().min(1).max(120)),
    intent: z.unknown(),
    proposal: z.unknown(),
  })
  .strict();

export type BuildMenuPlannerPreviewInput = {
  schemaVersion: 1;
  /** server composition で認証済み owner から渡す。client proposal の authority ではない。 */
  ownerId: string;
  contextMenuTemplateId: string;
  menuName: string;
  intent: MenuPlannerIntentRequest;
  proposal: unknown;
};

export type MenuPlannerPreviewErrorKind = "INVALID_INPUT" | "AI_OUTPUT_INVALID" | "PLANNING_REJECTED";

export type MenuPlannerPreviewError = {
  kind: MenuPlannerPreviewErrorKind;
  code: string;
  message: string;
};

export type BuildMenuPlannerPreviewResult =
  | { ok: true; preview: MenuPlannerPreview }
  | { ok: false; error: MenuPlannerPreviewError };

type PlannerExerciseRow = ExerciseWithRelations;

type InternalItem = {
  index: number;
  blockName: string;
  itemKey: string;
  selection: PreviewItemSelection;
  title: string;
  state: MenuPlannerPreviewItemState;
  runningPrescription: RunningPrescriptionValue | null;
  legacyPrescription: Required<Prescription> | null;
  legacySetRestSeconds: number | null;
  aiReason: string | null;
  engineRationale: string[];
  findings: Finding[];
  warnings: string[];
  provenance: unknown;
  aggregationItem: AggregationItem | null;
  sessionFindings: Finding[];
  /** engine が返した INELIGIBLE の理由。意味を変えずにそのまま保持する（Finding へ捏造しない）。 */
  eligibilityReasons: EligibilityReason[];
  /** engine が返した substitute 候補。informational のみ。 */
  substituteSelections: RunningSelection[];
  /** engine が返した確認要求 code（BLOCKED + confirmationRequired のときだけ）。 */
  confirmationRequiredCodes: string[];
};

type HistoryContext = {
  input: WeeklyHistoryInput | null;
  result: LoadHistoryResult | null;
};

type SanitizedProposal = {
  proposal: AiPlannerProposal;
  findingsByIndex: Map<number, Finding[]>;
};

const PREVIEW_ACTOR = {
  kind: "AI_PLANNER" as const,
  provider: PREVIEW_PROVIDER,
  model: PREVIEW_MODEL,
  requestId: PREVIEW_REQUEST_ID,
};

function failure(kind: MenuPlannerPreviewErrorKind, code: string, message: string): BuildMenuPlannerPreviewResult {
  return { ok: false, error: { kind, code, message } };
}

function finding(code: string, severity: Finding["severity"], scope: Finding["scope"] = "ITEM"): Finding {
  return { code, severity, scope, evidenceIds: [] };
}

function previewProvenance(): unknown {
  return {
    engine: MENU_PLANNER_ENGINE_ID,
    generatedBy: {
      proposer: PREVIEW_ACTOR,
      createdByCoach: false,
      acceptedByCoachAt: null,
    },
  };
}

function safeWarningTexts(findings: readonly Finding[]): string[] {
  return presentFindings(findings.filter((item) => item.severity === "WARN")).map((item) => item.message);
}

function subjectFromRunningContext(context: RunningMenuContext): Subject {
  return {
    kind: "GROUP",
    profile: {
      label: context.subject.label,
      members: context.subject.members.map((member) => ({
        birthDate: null,
        ageBandOverride: member.ageBandOverride,
        maturity: {
          status: member.maturity.status,
          confidence: member.maturity.confidence,
          method: member.maturity.method,
          assessedAt: member.maturity.assessedAt,
        },
        trainingAge: member.trainingAge,
        primaryEvent: member.primaryEvent,
      })),
      memberCountHint: context.subject.memberCountHint,
      availableMinutes: null,
      allowAdvancedMethods: context.subject.allowAdvancedMethods,
    },
  };
}

function fullPrescription(prescription: Prescription): Required<Prescription> {
  return {
    sets: prescription.sets ?? null,
    reps: prescription.reps ?? null,
    distanceMeters: prescription.distanceMeters ?? null,
    durationSeconds: prescription.durationSeconds ?? null,
    restSeconds: prescription.restSeconds ?? null,
    intensityPercent: prescription.intensityPercent ?? null,
    loadKg: prescription.loadKg ?? null,
  };
}

function hasLegacyDose(prescription: Required<Prescription>): boolean {
  return prescription.sets !== null &&
    (prescription.reps !== null || prescription.distanceMeters !== null || prescription.durationSeconds !== null);
}

function exerciseForSuggestion(row: PlannerExerciseRow): SuggestibleExercise {
  return {
    category: row.category,
    energySystem: row.energySystem,
    difficulty: row.difficulty,
    targets: row.targets.map((target) => target.target),
    name: row.name,
    metricType: row.metricType,
    defaultSets: row.defaultSets,
    defaultReps: row.defaultReps,
    defaultDistanceMeters: row.defaultDistanceMeters,
    defaultDurationSeconds: row.defaultDurationSeconds,
    defaultRestSeconds: row.defaultRestSeconds,
  };
}

function isLegacyRunningKind(kind: PrescriptionKind): boolean {
  return (
    kind === "SPEED_ACCELERATION" ||
    kind === "SPEED_MAX_VELOCITY" ||
    kind === "SPEED_ENDURANCE" ||
    kind === "TEMPO_AEROBIC"
  );
}

function legacyAggregationItem(
  row: PlannerExerciseRow,
  prescription: Required<Prescription>,
): Extract<AggregationItem, { kind: "LEGACY" }> {
  return {
    kind: "LEGACY",
    item: {
      category: row.category,
      sets: prescription.sets,
      reps: prescription.reps,
      distanceMeters: prescription.distanceMeters,
      durationSeconds: prescription.durationSeconds,
      // legacy aggregation treats 0 as an omitted rest value; the preview still keeps 0 in its dose DTO.
      restSeconds: prescription.restSeconds === 0 ? null : prescription.restSeconds,
    },
  };
}

function equipmentTagIds(row: PlannerExerciseRow): string[] {
  return row.tags
    .filter((tag) => tag.tag.kind === "EQUIPMENT")
    .map((tag) => tag.tagId)
    .sort();
}

function candidateOf(row: PlannerExerciseRow) {
  return exerciseCandidateDtoSchema.parse({
    id: row.id,
    name: row.name,
    category: row.category,
    purposes: row.purposes.map((purpose) => purpose.purpose),
    events: row.events.map((event) => event.event),
    equipmentTagIds: equipmentTagIds(row),
  });
}

function rowBindingOf(row: PlannerExerciseRow): MenuPlannerContextBindingInput["exerciseCatalog"][number] {
  return {
    id: row.id,
    ownerId: row.ownerId,
    status: row.status,
    name: row.name,
    category: row.category,
    metricType: row.metricType,
    difficulty: row.difficulty,
    energySystem: row.energySystem,
    defaultSets: row.defaultSets,
    defaultReps: row.defaultReps,
    defaultDistanceMeters: row.defaultDistanceMeters,
    defaultDurationSeconds: row.defaultDurationSeconds,
    defaultRestSeconds: row.defaultRestSeconds,
    targets: row.targets.map((target) => target.target),
    purposes: row.purposes.map((purpose) => purpose.purpose),
    events: row.events.map((event) => event.event),
    equipmentTagIds: equipmentTagIds(row),
  };
}

function sourceMenuBindingOf(
  menu: MenuDetail,
  runningContext: RunningMenuContext,
): MenuPlannerContextBindingInput["sourceMenu"] {
  return {
    id: menu.id,
    ownerId: menu.ownerId,
    status: menu.status,
    phase: menu.phase,
    estimatedMinutes: menu.estimatedMinutes,
    runningContext,
    blocks: menu.blocks.map((block) => ({
      id: block.id,
      name: block.name,
      sortOrder: block.sortOrder,
      items: block.items.map((item) => ({
        id: item.id,
        sortOrder: item.sortOrder,
        exerciseId: item.exerciseId,
        displayName: item.displayName,
        note: item.note,
        prescriptionKind: item.prescriptionKind,
        sets: item.sets,
        reps: item.reps,
        distanceMeters: item.distanceMeters,
        durationSeconds: item.durationSeconds,
        restSeconds: item.restSeconds,
        intensityPercent: item.intensityPercent,
        loadKg: item.loadKg,
        runningMethod: item.runningMethod,
        sessionTemplateId: item.sessionTemplateId,
        ruleSetVersion: item.ruleSetVersion,
        ruleSetContentHash: item.ruleSetContentHash,
        prescriptionJson: item.prescriptionJson,
      })),
    })),
  };
}

function sanitizeProposal(proposal: AiPlannerProposal): SanitizedProposal | null {
  const findingsByIndex = new Map<number, Finding[]>();
  const items: AiPlannerItemProposal[] = [];

  for (const [index, item] of proposal.items.entries()) {
    const result = sanitizeAiReason(item.proposal.reason);
    if (!result.ok) return null;
    if (result.sanitized) {
      findingsByIndex.set(index, [finding(AI_REASON_SANITIZED, "INFO")]);
    }
    items.push(
      item.kind === "RUNNING"
        ? { kind: "RUNNING", proposal: { ...item.proposal, reason: result.reason } }
        : { kind: "EXERCISE", proposal: { ...item.proposal, reason: result.reason } },
    );
  }

  return {
    proposal: { ...proposal, items },
    findingsByIndex,
  };
}

function equipmentConstraintFinding(
  row: PlannerExerciseRow,
  intent: MenuPlannerIntentRequest,
): { state: MenuPlannerPreviewItemState | null; finding: Finding | null } {
  const equipment = intent.constraints.equipment;
  if (equipment === null) return { state: null, finding: null };

  const registered = equipmentTagIds(row);
  if (registered.length === 0) {
    return {
      state: "MANUAL_INPUT_REQUIRED",
      finding: finding("EQUIPMENT_CONSTRAINT_UNDETERMINED", "REQUIRE_COACH_REVIEW"),
    };
  }

  const available = new Set(equipment.availableTagIds);
  if (registered.every((tagId) => available.has(tagId))) return { state: null, finding: null };
  return { state: "REJECTED", finding: finding("EQUIPMENT_CONSTRAINT_UNSATISFIED", "BLOCK") };
}

function exerciseConstraintFinding(
  row: PlannerExerciseRow,
  intent: MenuPlannerIntentRequest,
): Finding | null {
  const constraints = intent.constraints;
  const events = new Set(row.events.map((event) => event.event));
  if (
    constraints.targetEvents.length > 0 &&
    !constraints.targetEvents.some((event) => events.has(event) || events.has("COMMON"))
  ) {
    return finding("TARGET_EVENT_CONSTRAINT_UNSATISFIED", "BLOCK");
  }
  const purposes = new Set(row.purposes.map((purpose) => purpose.purpose));
  if (constraints.purposes.length > 0 && !constraints.purposes.some((purpose) => purposes.has(purpose))) {
    return finding("PURPOSE_CONSTRAINT_UNSATISFIED", "BLOCK");
  }
  return null;
}

function materializeExercise(
  item: Extract<AiPlannerItemProposal, { kind: "EXERCISE" }>,
  index: number,
  row: PlannerExerciseRow,
  intent: MenuPlannerIntentRequest,
  phase: TrainingPhase | null,
  reasonFindings: readonly Finding[],
): InternalItem {
  const selection: PreviewItemSelection = { kind: "EXERCISE", exerciseId: row.id };
  const aiReason = item.proposal.reason.length === 0 ? null : item.proposal.reason;
  const base = {
    index,
    blockName: item.proposal.blockName,
    itemKey: `item-${String(index + 1).padStart(2, "0")}`,
    selection,
    title: row.name,
    runningPrescription: null,
    legacyPrescription: null,
    legacySetRestSeconds: null,
    aiReason,
    engineRationale: [] as string[],
    findings: [...reasonFindings],
    warnings: [] as string[],
    provenance: previewProvenance(),
    aggregationItem: null,
    sessionFindings: [] as Finding[],
    eligibilityReasons: [] as EligibilityReason[],
    substituteSelections: [] as RunningSelection[],
    confirmationRequiredCodes: [] as string[],
  };

  if (intent.constraints.excludedExerciseIds.includes(row.id)) {
    return { ...base, state: "REJECTED", findings: [...base.findings, finding("EXERCISE_EXCLUDED_BY_CONSTRAINT", "BLOCK")] };
  }

  const semanticConstraint = exerciseConstraintFinding(row, intent);
  if (semanticConstraint !== null) {
    return { ...base, state: "REJECTED", findings: [...base.findings, semanticConstraint] };
  }

  const equipment = equipmentConstraintFinding(row, intent);
  if (equipment.finding !== null && equipment.state === "REJECTED") {
    return { ...base, state: "REJECTED", findings: [...base.findings, equipment.finding] };
  }

  const classifiable: ClassifiableExercise = exerciseForSuggestion(row);
  const kind = classify(classifiable);
  if (isLegacyRunningKind(kind)) {
    return {
      ...base,
      state: "REJECTED",
      engineRationale: ["この種目はRunning分類のため、Exerciseのlegacy処方経路では自動作成しません。"],
      findings: [...base.findings, finding("RUNNING_CLASSIFIED_EXERCISE", "BLOCK")],
    };
  }

  const suggestion = suggestPrescription(classifiable, { phase, level: BASELINE_LEVEL });
  const prescription = fullPrescription(suggestion.prescription);
  const findings = [...base.findings];
  if (equipment.finding !== null) findings.push(equipment.finding);
  if (!hasLegacyDose(prescription)) findings.push(finding("MANUAL_INPUT_REQUIRED", "BLOCK"));

  const menuItemValidation = menuItemInputSchema.safeParse({
    exerciseId: row.id,
    displayName: row.name,
    ...prescription,
  });
  if (!menuItemValidation.success) findings.push(finding("MANUAL_INPUT_REQUIRED", "BLOCK"));

  const manual = findings.some((itemFinding) => itemFinding.code === "MANUAL_INPUT_REQUIRED") || equipment.state === "MANUAL_INPUT_REQUIRED";
  const ready = !manual;
  return {
    ...base,
    state: ready ? "READY" : "MANUAL_INPUT_REQUIRED",
    legacyPrescription: prescription,
    legacySetRestSeconds: suggestion.setRestSeconds,
    engineRationale: [...suggestion.rationale],
    warnings: [...suggestion.warnings],
    findings,
    aggregationItem: ready ? legacyAggregationItem(row, prescription) : null,
  };
}

function titleForRunning(ruleSet: RuleSet, selection: { templateId: string }): string {
  return ruleSet.templates.find((template) => template.id === selection.templateId)?.labelJa ?? "Runningテンプレート";
}

/**
 * engine が返した substitute 候補に、RuleSet の labelJa を添えるだけ（選択の同一性は変えない）。
 * 候補は同じ RuleSet から解決されるため通常は label が付く。付かない場合は null のままにする
 * （推測でラベルを作らない。AI が自動で置換することもない）。
 */
function substituteViewOf(ruleSet: RuleSet, selection: RunningSelection): PreviewItemSubstituteInput {
  return {
    method: selection.method,
    templateId: selection.templateId,
    label: ruleSet.templates.find((template) => template.id === selection.templateId)?.labelJa ?? null,
  };
}

function runningStateFor(result: PlanResult, findings: readonly Finding[]): MenuPlannerPreviewItemState {
  if (result.status === "OK") {
    return findings.some((itemFinding) => itemFinding.severity === "BLOCK" || itemFinding.severity === "BLOCK_AUTOGEN")
      ? "REJECTED"
      : "READY";
  }
  if (
    result.status === "BLOCKED" &&
    findings.some((itemFinding) => itemFinding.code === "MANUAL_INPUT_REQUIRED") &&
    findings
      .filter((itemFinding) => itemFinding.severity === "BLOCK" || itemFinding.severity === "BLOCK_AUTOGEN")
      .every((itemFinding) => itemFinding.code === "MANUAL_INPUT_REQUIRED")
  ) {
    return "MANUAL_INPUT_REQUIRED";
  }
  return "REJECTED";
}

function materializeRunning(
  item: Extract<AiPlannerItemProposal, { kind: "RUNNING" }>,
  index: number,
  selection: Extract<PreviewItemSelection, { kind: "RUNNING" }>,
  result: PlanResult,
  reasonFindings: readonly Finding[],
  ruleSet: RuleSet,
): InternalItem {
  const findings = [...reasonFindings];
  const aiReason = item.proposal.reason.length === 0 ? null : item.proposal.reason;
  if (result.status === "OK") {
    findings.push(...result.prescription.findings);
    const state = runningStateFor(result, findings);
    return {
      index,
      blockName: item.proposal.blockName,
      itemKey: `item-${String(index + 1).padStart(2, "0")}`,
      selection: { kind: "RUNNING", method: selection.method, templateId: selection.templateId },
      title: titleForRunning(ruleSet, selection),
      state,
      runningPrescription: result.prescription,
      legacyPrescription: null,
      legacySetRestSeconds: null,
      aiReason,
      engineRationale: renderRationaleJa(result.prescription.rationale),
      findings,
      warnings: safeWarningTexts([...findings, ...result.sessionFindings]),
      provenance: { engine: RUNNING_PLANNER_ENGINE_ID, generatedBy: result.prescription.generatedBy },
      aggregationItem: state === "READY" ? { kind: "RUNNING_V2", prescription: result.prescription } : null,
      sessionFindings: [...result.sessionFindings],
      eligibilityReasons: [],
      substituteSelections: [],
      confirmationRequiredCodes: [],
    };
  }

  if (result.status === "INELIGIBLE") {
    findings.push(...result.findings);
    if (result.findings.length === 0) findings.push(finding("RUNNING_AUTOGEN_INELIGIBLE", "BLOCK_AUTOGEN"));
  } else {
    findings.push(...result.findings);
    if (result.findings.length === 0) findings.push(finding("RUNNING_PLAN_BLOCKED", "BLOCK"));
  }
  return {
    index,
    blockName: item.proposal.blockName,
    itemKey: `item-${String(index + 1).padStart(2, "0")}`,
    selection: { kind: "RUNNING", method: selection.method, templateId: selection.templateId },
    title: titleForRunning(ruleSet, selection),
    state: runningStateFor(result, findings),
    runningPrescription: null,
    legacyPrescription: null,
    legacySetRestSeconds: null,
    aiReason,
    engineRationale: ["Running処方エンジンが自動作成を停止しました。"],
    findings,
    warnings: safeWarningTexts(findings),
    provenance: previewProvenance(),
    aggregationItem: null,
    sessionFindings: [],
    /**
     * INELIGIBLE の理由は engine 設計上 `findings` ではなく `reasons` に入る（`findings` は RULESET_DRAFT 等の
     * 横断情報だけ）。ここで落とすと Coach に理由が伝わらないため、engine の意味のまま保持する。
     * Finding へ捏造しない（acceptance は state=REJECTED で既に止まる）。
     */
    eligibilityReasons: result.status === "INELIGIBLE" ? [...result.reasons] : [],
    substituteSelections: result.status === "INELIGIBLE" ? [...result.substitutes] : [],
    confirmationRequiredCodes:
      result.status === "BLOCKED" ? [...(result.confirmationRequired?.requiredFindingCodes ?? [])] : [],
  };
}

/**
 * `index` の item だけを除いた集計入力を proposal 順で返す。
 * **集合は proposal prefix に依存しない**（呼び出し側が「全 item が materialize 済みの snapshot」を渡す）。
 * 配列順は presentation order のままで、`evaluateSessionAggregation` は順序非依存
 * （LEGACY / RUNNING_V2 の全順列で同一結果を確認済み）。
 */
function aggregationItemsFor(
  items: ReadonlyMap<number, InternalItem>,
  currentIndex: number,
  proposalLength: number,
): AggregationItem[] {
  const result: AggregationItem[] = [];
  for (let index = 0; index < proposalLength; index += 1) {
    if (index === currentIndex) continue;
    const aggregationItem = items.get(index)?.aggregationItem;
    if (aggregationItem !== null && aggregationItem !== undefined) result.push(aggregationItem);
  }
  return result;
}

/** 除外なし版。Phase B の candidate planning が共有する order-independent な context を作る。 */
function aggregationItemsOf(
  items: ReadonlyMap<number, InternalItem>,
  proposalLength: number,
): AggregationItem[] {
  return aggregationItemsFor(items, -1, proposalLength);
}

function planRunning(
  item: Extract<AiPlannerItemProposal, { kind: "RUNNING" }>,
  index: number,
  ruleSet: ActiveRuleSetResult,
  subject: Subject,
  phase: TrainingPhase | null,
  plannedDate: IsoDate,
  plannedAt: IsoDateTime | null,
  availableMinutes: number | null,
  competitions: readonly CompetitionRef[],
  history: WeeklyHistoryInput | null,
  otherItems: readonly AggregationItem[],
  reasonFindings: readonly Finding[],
  sourceRuleSet: RuleSet,
): InternalItem {
  const selectionResult = runningSelectionSchema.safeParse({ method: item.proposal.method, templateId: item.proposal.templateId });
  if (!selectionResult.success) {
    const rejected: PlanResult = { status: "BLOCKED", findings: [finding("RUNNING_SELECTION_INVALID", "BLOCK")] };
    return materializeRunning(
      item,
      index,
      { kind: "RUNNING", method: item.proposal.method, templateId: item.proposal.templateId },
      rejected,
      reasonFindings,
      sourceRuleSet,
    );
  }
  const selection = selectionResult.data;
  const rawRequest = {
    planningDate: plannedDate,
    selection,
    subject,
    menuContext: {
      phase,
      plannedDate,
      plannedAt,
      competitions: [...competitions],
      otherItems: [...otherItems],
      availableMinutes,
    },
    history,
    readiness: null,
    positionPreference: item.proposal.positionPreference,
    coachEdits: [],
    overrides: [],
    coachReference: null,
    actor: PREVIEW_ACTOR,
    confirmedFindingCodes: [],
  } satisfies PlanRequest;
  const parsedRequest = planRequestSchema.safeParse(rawRequest);
  const result = parsedRequest.success
    ? planRunningPrescriptionWithRuleSet(parsedRequest.data, ruleSet)
    : ({ status: "BLOCKED", findings: [finding("RUNNING_PLAN_REQUEST_INVALID", "BLOCK")] } satisfies PlanResult);
  return materializeRunning(
    item,
    index,
    { kind: "RUNNING", method: selection.method, templateId: selection.templateId },
    result,
    reasonFindings,
    sourceRuleSet,
  );
}

function estimatedRunningSeconds(prescription: RunningPrescriptionValue): number | null {
  if (prescription.rep.kind !== "DURATION") return null;
  const totalReps = prescription.sets.value * prescription.repsPerSet.value;
  const work = totalReps * prescription.rep.durationS.value;
  const repRest = Math.max(0, totalReps - 1) * prescription.rest.repRestS.value;
  const setRest = Math.max(0, prescription.sets.value - 1) * (prescription.rest.setRestS?.value ?? 0);
  return work + repRest + setRest;
}

function estimateMenuTime(items: readonly InternalItem[], availableMinutes: number | null): MenuPlannerPreviewPresentationInput["estimatedTime"] {
  if (items.some((item) => item.state !== "READY")) {
    return { seconds: null, quality: "UNKNOWN", availableMinutes, exceedsAvailable: false };
  }
  let seconds = 0;
  for (const item of items) {
    if (item.runningPrescription !== null) {
      const runningSeconds = estimatedRunningSeconds(item.runningPrescription);
      if (runningSeconds === null) return { seconds: null, quality: "UNKNOWN", availableMinutes, exceedsAvailable: false };
      seconds += runningSeconds;
    } else if (item.legacyPrescription !== null) {
      seconds += estimateSeconds(item.legacyPrescription);
    } else {
      return { seconds: null, quality: "UNKNOWN", availableMinutes, exceedsAvailable: false };
    }
  }
  return {
    seconds,
    quality: "ESTIMATE",
    availableMinutes,
    exceedsAvailable: availableMinutes !== null && seconds > availableMinutes * 60,
  };
}

function uniqueFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const result: Finding[] = [];
  for (const item of findings) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

type InternalBlock = { blockKey: string; title: string; items: InternalItem[] };

function groupedBlocks(items: readonly InternalItem[]): InternalBlock[] {
  const groups: InternalBlock[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    let group = previous?.title === item.blockName ? previous : undefined;
    if (group === undefined) {
      group = { blockKey: `block-${String(groups.length + 1).padStart(2, "0")}`, title: item.blockName, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function materializationDigestInput(
  blocks: readonly MenuPlannerPreviewPresentationInput["blocks"][number][],
  aggregation: unknown,
  estimatedTime: unknown,
  canSave: boolean,
  blockingFindingCodes: readonly string[],
  ruleSet: ActiveRuleSetResult,
): MenuPlannerMaterializationDigestInput {
  return {
    contract: {
      previewSchemaVersion: MENU_PLANNER_PREVIEW_SCHEMA_VERSION,
      engineId: MENU_PLANNER_ENGINE_ID,
      statusOnSave: "DRAFT",
      ruleSet: { version: ruleSet.ruleSet.ruleSetVersion, contentHash: ruleSet.contentHash, status: ruleSet.ruleSet.status },
    },
    blocks: blocks.map((block) => ({
      name: block.title,
      items: block.items.map((item) => ({
        selection: item.selection,
        title: item.title,
        state: item.state,
        deterministicPrescription: item.runningPrescription ?? item.legacyPrescription,
        legacySetRestSeconds: item.legacySetRestSeconds,
        provenance: item.runningPrescription === null ? previewProvenance() : { engine: RUNNING_PLANNER_ENGINE_ID, generatedBy: item.runningPrescription.generatedBy },
        aiReason: item.aiReason,
        engineRationale: item.engineRationale,
        findings: item.findings,
        warnings: item.warnings,
        eligibilityReasons: item.eligibilityReasons,
        substitutes: item.substitutes,
        confirmationRequiredCodes: item.confirmationRequiredCodes,
      })),
    })),
    aggregation,
    estimatedTime,
    acceptance: { canSave, blockingFindingCodes },
  };
}

function buildSubjectBinding(profile: SubjectProfile, context: RunningMenuContext, safeSubject: unknown): unknown {
  return {
    persistedGroup: context.subject,
    aiSafe: safeSubject,
    resolved: {
      ageBand: profile.ageBand,
      trainingAgeTier: profile.trainingAgeTier,
      trainingAgeKnown: profile.trainingAgeKnown,
      envelopeTier: profile.envelopeTier,
      allowAdvancedMethods: profile.allowAdvancedMethods,
      primaryEvents: profile.primaryEvents,
      effectiveMaturityCategories: profile.effectiveMaturityCategories,
      rapidGrowthFlag: profile.rapidGrowthFlag,
      resolvedConstraints: profile.resolvedConstraints,
    },
  };
}

async function loadHistory(ownerId: string, plannedAt: string | null): Promise<HistoryContext> {
  if (plannedAt === null) return { input: null, result: null };
  const asOf = new Date(plannedAt);
  if (Number.isNaN(asOf.getTime())) throw new Error("PLANNED_AT_INVALID");
  const result = await listLoadHistory({ ownerId, asOf, windowHours: 24 * 28 });
  return {
    input: {
      events: result.events,
      coverage72h: "PARTIAL",
      coverage7d: "PARTIAL",
      coverage28d: "PARTIAL",
      dailyActivity7d: [],
    },
    result,
  };
}

function phaseOf(menu: MenuDetail): TrainingPhase | null {
  if (menu.phase === null) return null;
  return z.enum(TRAINING_PHASES).parse(menu.phase);
}

function providerCatalog(
  rows: readonly PlannerExerciseRow[],
  ruleSet: RuleSet,
) {
  const reviewed = rows.filter((row) => row.status === "REVIEWED");
  const equipmentById = new Map<string, string>();
  for (const row of rows) {
    for (const tag of row.tags) {
      if (tag.tag.kind === "EQUIPMENT") equipmentById.set(tag.tagId, tag.tag.name);
    }
  }
  return {
    exercises: reviewed.map(candidateOf),
    runningTemplates: ruleSet.templates.map((template) => ({
      method: template.method,
      templateId: template.id,
      label: template.labelJa,
    })),
    equipment: [...equipmentById.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, name]) => ({ id, name })),
  };
}

/**
 * Public application boundary:
 * unknown proposal -> strict parse -> owner/catalog validation -> reason sanitizer -> deterministic planning.
 */
export async function buildMenuPlannerPreview(input: BuildMenuPlannerPreviewInput): Promise<BuildMenuPlannerPreviewResult> {
  const parsedInput = previewInputSchema.safeParse(input);
  if (!parsedInput.success) return failure("INVALID_INPUT", "PREVIEW_INPUT_INVALID", "プレビュー入力を確認できません。");

  const validatedIntent = menuPlannerIntentRequestSchema.safeParse(parsedInput.data.intent);
  if (!validatedIntent.success) return failure("INVALID_INPUT", "INTENT_INVALID", "メニュー作成条件を確認できません。");
  const intent = canonicalizeMenuPlannerIntentRequest(validatedIntent.data);

  const parsedProposal = aiPlannerProposalSchema.safeParse(parsedInput.data.proposal);
  if (!parsedProposal.success) return failure("AI_OUTPUT_INVALID", "PROPOSAL_SCHEMA_INVALID", "AI提案の形式を確認できません。");
  if (parsedProposal.data.question !== null) {
    return failure("AI_OUTPUT_INVALID", "CLARIFICATION_NOT_ALLOWED", "追加質問を含む提案はプレビューできません。");
  }

  let menu: MenuDetail | null;
  try {
    menu = await findMenuForOwner(parsedInput.data.contextMenuTemplateId, parsedInput.data.ownerId);
  } catch {
    return failure("PLANNING_REJECTED", "CONTEXT_MENU_UNAVAILABLE", "計画の参照メニューを確認できません。");
  }
  if (menu === null) return failure("PLANNING_REJECTED", "CONTEXT_MENU_UNAVAILABLE", "計画の参照メニューを確認できません。");

  const contextResult = parseJsonColumn(menu.runningContextJson, runningMenuContextSchema, { rejectHealthKeys: true });
  if (!contextResult.ok || contextResult.value.subject.kind !== "GROUP") {
    return failure("PLANNING_REJECTED", "RUNNING_CONTEXT_UNAVAILABLE", "計画対象のグループ条件を確認できません。");
  }
  const context = contextResult.value;
  if (context.plannedDate === null) return failure("PLANNING_REJECTED", "PLANNED_DATE_UNAVAILABLE", "計画日が設定された参照メニューを使用してください。");
  /** closure（planRunningAt）へ渡すため、narrowing 済みの値を固定する（TS は closure 内で property narrowing を保持しない）。 */
  const plannedDate = context.plannedDate;

  let phase: TrainingPhase | null;
  try {
    phase = phaseOf(menu);
  } catch {
    return failure("PLANNING_REJECTED", "MENU_PHASE_INVALID", "参照メニューの期分けを確認できません。");
  }
  if (intent.constraints.phase !== null && intent.constraints.phase !== phase) {
    return failure("PLANNING_REJECTED", "PHASE_CONSTRAINT_UNSATISFIED", "指定された期分けと参照メニューの期分けが一致しません。");
  }
  if (
    intent.constraints.availableMinutes !== null &&
    (context.availableMinutes === null || intent.constraints.availableMinutes > context.availableMinutes)
  ) {
    return failure("PLANNING_REJECTED", "AVAILABLE_TIME_CONSTRAINT_UNSATISFIED", "指定された練習時間が参照メニューの条件を超えています。");
  }

  let selectedRuleSet: ActiveRuleSetResult;
  let subject: Subject;
  let profile: SubjectProfile;
  let competitions: CompetitionRef[];
  let history: HistoryContext;
  let allExerciseRows: PlannerExerciseRow[];
  try {
    selectedRuleSet = getActiveRuleSet(context.plannedDate);
    subject = subjectFromRunningContext(context);
    profile = resolveSubjectProfile({ subject, asOf: context.plannedDate, ruleSet: selectedRuleSet.ruleSet });
    const safeSubject = buildAiSafeSubjectContext({ profile, ruleSet: selectedRuleSet.ruleSet, decision: null });
    competitions = await listCompetitionRefs(parsedInput.data.ownerId);
    history = await loadHistory(parsedInput.data.ownerId, context.plannedAt);
    allExerciseRows = await listExercisesForMenuPlanner(parsedInput.data.ownerId);

    const provider = menuPlannerProviderRequestSchema.safeParse({
      schemaVersion: MENU_PLANNER_PREVIEW_SCHEMA_VERSION,
      policy: { id: "R12_MENU_INTENT_V1" },
      coachRequest: intent,
      subject: safeSubject,
      catalog: providerCatalog(allExerciseRows, selectedRuleSet.ruleSet),
    });
    if (!provider.success) return failure("PLANNING_REJECTED", "AUTHORITATIVE_CATALOG_INVALID", "ExerciseとRunningのカタログを確認できません。");

    const catalogValidation = validateAiPlannerProposalAgainstCatalog(parsedProposal.data, provider.data.catalog);
    if (!catalogValidation.ok) return failure("AI_OUTPUT_INVALID", "PROPOSAL_CATALOG_INVALID", "AI提案に現在のカタログにない選択が含まれています。");

    const sanitized = sanitizeProposal(parsedProposal.data);
    if (sanitized === null) return failure("AI_OUTPUT_INVALID", "REASON_INVALID", "AI提案の理由を表示用に安全化できません。");

    const selectedExerciseIds = sanitized.proposal.items
      .filter((item): item is Extract<AiPlannerItemProposal, { kind: "EXERCISE" }> => item.kind === "EXERCISE")
      .map((item) => item.proposal.exerciseId);
    const selectedRows = await findExercisesForMenuPlanner(selectedExerciseIds, parsedInput.data.ownerId);
    const selectedById = new Map(selectedRows.map((row) => [row.id, row]));
    const itemCount = sanitized.proposal.items.length;
    /** 1 つの RUNNING item を、与えられた otherItems で plan する（phase で条件を変えるのはここだけ）。 */
    const planRunningAt = (index: number, otherItems: readonly AggregationItem[]): InternalItem => {
      const item = sanitized.proposal.items[index]!;
      if (item.kind !== "RUNNING") throw new Error("PLANNER_ITEM_KIND_INVALID");
      return planRunning(
        item,
        index,
        selectedRuleSet,
        subject,
        phase,
        plannedDate,
        context.plannedAt,
        context.availableMinutes,
        competitions,
        history.input,
        otherItems,
        sanitized.findingsByIndex.get(index) ?? [],
        selectedRuleSet.ruleSet,
      );
    };

    // Phase A: non-Running item。他 item に依存しないため proposal の並びに依らず決まる。
    const items = new Map<number, InternalItem>();
    for (const [index, item] of sanitized.proposal.items.entries()) {
      const reasonFindings = sanitized.findingsByIndex.get(index) ?? [];
      if (item.kind === "EXERCISE") {
        const row = selectedById.get(item.proposal.exerciseId);
        if (row === undefined || row.status !== "REVIEWED") {
          return failure("AI_OUTPUT_INVALID", "EXERCISE_CATALOG_BINDING_INVALID", "AI提案のExerciseを現在のowner-scoped catalogに結び付けられません。");
        }
        items.set(index, materializeExercise(item, index, row, intent, phase, reasonFindings));
      }
    }

    // Phase B: 全 RUNNING item の candidate 処方を **同一条件**（non-Running item のみを otherItems）で作る。
    // ここで proposal prefix を渡さないことが order-independence の要。prefix 累積にすると
    // 「後方の item だけが BLOCKED → snapshot から脱落 → 他 item の context にも現れない」という
    // 自己強化が起き、accepted/rejected 集合が並び順で変わってしまう（R12-A2 監査 B1）。
    const nonRunningContext = aggregationItemsOf(items, itemCount);
    const candidates = new Map<number, InternalItem>();
    for (const [index, item] of sanitized.proposal.items.entries()) {
      if (item.kind !== "RUNNING") continue;
      candidates.set(index, planRunningAt(index, nonRunningContext));
    }

    // Phase C: 全 item の candidate snapshot（並び順に依存しない）。
    const candidateSnapshot = new Map(items);
    for (const [index, candidate] of candidates) candidateSnapshot.set(index, candidate);

    // Phase D: 各 RUNNING item を「自分以外の全 candidate item」を otherItems として final plan。
    for (const [index, item] of sanitized.proposal.items.entries()) {
      if (item.kind !== "RUNNING") continue;
      items.set(index, planRunningAt(index, aggregationItemsFor(candidateSnapshot, index, itemCount)));
    }

    const orderedItems = sanitized.proposal.items.map((_, index) => items.get(index)!);
    const readyAggregationItems = orderedItems.flatMap((item) => (item.aggregationItem === null ? [] : [item.aggregationItem]));
    const competitionDay = resolveCompetitionDay(context.plannedDate, competitions);
    const aggregate: SessionAggregate = evaluateSessionAggregation(readyAggregationItems, {
      ruleSet: selectedRuleSet.ruleSet,
      tier: profile.envelopeTier,
      availableMinutes: context.availableMinutes,
      competitionDay,
      mode: "PLANNING",
    });
    const sessionPlausibility = checkSessionPlausibility(aggregate.totalRunningDistanceM, selectedRuleSet.ruleSet);
    const itemPlausibility = new Map<number, Finding[]>();
    for (const item of orderedItems) {
      if (item.runningPrescription !== null) {
        itemPlausibility.set(item.index, checkOutputPlausibility(item.runningPrescription, selectedRuleSet.ruleSet).findings);
      } else if (item.legacyPrescription !== null) {
        const row = selectedById.get(item.selection.kind === "EXERCISE" ? item.selection.exerciseId : "");
        if (row !== undefined) {
          const aggregationItem = item.aggregationItem;
          const legacy = aggregationItem !== null && aggregationItem.kind === "LEGACY"
            ? aggregationItem.item
            : legacyAggregationItem(row, item.legacyPrescription).item;
          itemPlausibility.set(item.index, checkLegacyItemPlausibility(legacy, selectedRuleSet.ruleSet).findings);
        }
      }
    }
    for (const item of orderedItems) {
      const extra = itemPlausibility.get(item.index) ?? [];
      if (extra.length > 0) item.findings = uniqueFindings([...item.findings, ...extra]);
    }
    const allPlausibilityFindings = [...sessionPlausibility.findings, ...[...itemPlausibility.values()].flat()];
    const planningSessionFindings = orderedItems.flatMap((item) => item.sessionFindings);
    const aggregationFindings = uniqueFindings([
      ...aggregate.findings,
      ...allPlausibilityFindings,
      ...planningSessionFindings,
    ]);
    const allFindings = uniqueFindings([...orderedItems.flatMap((item) => item.findings), ...aggregationFindings]);
    const acceptance = evaluateMenuPlannerPreviewAcceptance({
      itemStates: orderedItems.map((item) => item.state),
      findings: allFindings,
    });

    const estimatedTime = estimateMenuTime(orderedItems, context.availableMinutes);
    const blocks = groupedBlocks(orderedItems).map((block) => ({
      blockKey: block.blockKey,
      title: block.title,
      items: block.items.map((item) => ({
        itemKey: item.itemKey,
        selection: item.selection,
        title: item.title,
        state: item.state,
        runningPrescription: item.runningPrescription,
        legacyPrescription: item.legacyPrescription,
        legacySetRestSeconds: item.legacySetRestSeconds,
        aiReason: item.aiReason,
        engineRationale: item.engineRationale,
        findings: item.findings,
        warnings: item.warnings,
        eligibilityReasons: item.eligibilityReasons,
        substitutes: item.substituteSelections.map((selection) => substituteViewOf(selectedRuleSet.ruleSet, selection)),
        confirmationRequiredCodes: item.confirmationRequiredCodes,
      })),
    }));
    const aggregationView: MenuAggregationDto = presentMenuAggregation({
      status: "EVALUATED",
      aggregate,
      plausibilityFindings: aggregationFindings,
      competitionDay,
    });
    const contextBinding: MenuPlannerContextBindingInput = {
      contract: {
        previewSchemaVersion: MENU_PLANNER_PREVIEW_SCHEMA_VERSION,
        policyId: "R12_MENU_INTENT_V1",
        engineId: MENU_PLANNER_ENGINE_ID,
        runningEngineId: RUNNING_PLANNER_ENGINE_ID,
        legacyEngineId: LEGACY_PLANNER_ENGINE_ID,
      },
      sourceMenu: sourceMenuBindingOf(menu, context),
      exerciseCatalog: allExerciseRows.map(rowBindingOf),
      ruleSet: {
        version: selectedRuleSet.ruleSet.ruleSetVersion,
        contentHash: selectedRuleSet.contentHash,
        status: selectedRuleSet.ruleSet.status,
      },
      subjectContext: buildSubjectBinding(profile, context, safeSubject),
      competitionContext: competitions,
      historyContext: {
        input: history.input,
        result: history.result,
      },
      planning: { planningDate: context.plannedDate, plannedAt: context.plannedAt },
      explicitConstraints: intent.constraints,
    };
    const contextFingerprint = buildMenuPlannerContextFingerprint(contextBinding);
    const digestInput = materializationDigestInput(
      blocks,
      { aggregate, aggregationFindings, competitionDay },
      estimatedTime,
      acceptance.canSave,
      acceptance.blockingFindingCodes,
      selectedRuleSet,
    );
    const materializationDigest = buildMenuPlannerMaterializationDigest(digestInput);
    const presentationInput: MenuPlannerPreviewPresentationInput = {
      menuName: parsedInput.data.menuName,
      statusOnSave: "DRAFT",
      ruleSet: { version: selectedRuleSet.ruleSet.ruleSetVersion, status: selectedRuleSet.ruleSet.status },
      blocks,
      aggregation: aggregationView,
      estimatedTime,
      canSave: acceptance.canSave,
      binding: { contextFingerprint, materializationDigest },
    };
    return { ok: true, preview: presentMenuPlannerPreview(presentationInput) };
  } catch (error) {
    if (error instanceof z.ZodError) return failure("PLANNING_REJECTED", "AUTHORITATIVE_CONTEXT_INVALID", "計画に必要なserver contextを確認できません。");
    if (error instanceof Error && error.message === "PLANNED_AT_INVALID") return failure("PLANNING_REJECTED", "PLANNED_AT_INVALID", "計画時刻を確認できません。");
    return failure("PLANNING_REJECTED", "DETERMINISTIC_PLANNING_FAILED", "決定論的なプレビューを生成できません。");
  }
}
