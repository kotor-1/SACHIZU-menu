/** R11-B4B2: persisted SessionItem execution state -> JSON-safe presentation DTO. */
import { z } from "zod";
import { monitorStateSchema, plannedRepCountOf, type RepLogEntry } from "@/domain/running/monitoring";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { readStartedExecutionState } from "@/domain/running/persistence/executionState";
import { provenanceSchema } from "@/domain/running/persistence/provenance";
import { readRepLog, runtimeCoachReviewIdentityOf, type RuntimeCoachReviewIdentity } from "@/domain/running/persistence/repLog";
import { readReadinessExecutionState, type ReadinessExecutionStateV1 } from "@/domain/running/readiness/execution";
import { CONFIDENCES, DATA_SOURCES, quantityIntervalSchema } from "@/domain/running/types/primitives";
import { safetyOutcomeSchema, type SafetyOutcome } from "@/domain/running/types/readiness";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import { TIMING_METHODS, type TimingMethod } from "@/domain/running/types/intensity";
import type { RunningItemPresentationDto } from "./dto";
import {
  EXECUTION_SAFETY_OUTCOME_LABEL_JA,
  MONITOR_ACTION_LABEL_JA,
  REP_QUALITY_LABEL_JA,
  STOP_REASON_LABEL_JA,
} from "./execution";
import { formatIntervalJa, formatSecondsJa } from "./format";
import { presentRunningItem } from "./item";
import { READINESS_ACTION_LABEL_JA, READINESS_GATE_LABEL_JA } from "./readiness";

export const EXECUTION_DATA_SOURCE_LABEL_JA = {
  MEASURED: "実測",
  PLANNED: "計画値",
  ESTIMATED: "推定",
  RULE_DEFINITION: "ルール定義",
  COACH_ENTERED: "コーチ入力",
  UNKNOWN: "取得元不明",
} satisfies Record<(typeof DATA_SOURCES)[number], string>;

export const EXECUTION_CONFIDENCE_LABEL_JA = {
  HIGH: "信頼度 高",
  MEDIUM: "信頼度 中",
  LOW: "信頼度 低",
  NONE: "信頼度情報なし",
} satisfies Record<(typeof CONFIDENCES)[number], string>;

export const EXECUTION_TIMING_LABEL_JA = {
  FAT: "全自動計時",
  HAND: "手動計時",
  PHOTO_CELL: "光電管",
  VIDEO: "映像計時",
  RADAR_LASER: "レーダー・レーザー計測",
  UNKNOWN: "計時方法不明",
} satisfies Record<TimingMethod, string>;

export const SESSION_EXECUTION_LABEL_COVERAGE = {
  timingMethods: TIMING_METHODS,
  dataSources: DATA_SOURCES,
  confidences: CONFIDENCES,
};

export type SessionExecutionItemInput = {
  id: string;
  exerciseNameSnapshot: string;
  prescriptionKind: string;
  plannedPrescriptionJson: string | null;
  plannedProvenanceJson: string | null;
  plannedRationale: string | null;
  readinessActionsJson: string | null;
  actualRepLogJson: string | null;
  actualHighSpeedExposureJson: string | null;
  stopReason: string | null;
  safetyOutcome: string | null;
};

export type RunningSessionExecutionDto = {
  sessionItemId: string;
  display: {
    name: string;
    prescription: { status: "READY"; item: RunningItemPresentationDto } | { status: "UNREADABLE"; message: string };
  };
  readiness: {
    state: "NOT_EVALUATED" | "READY" | "BLOCKED" | "COACH_DECISION_REQUIRED" | "REEVALUATION_REQUIRED" | "UNREADABLE";
    message: string;
    actions: { codeInternal: string; label: string }[];
  };
  execution: {
    state: "NOT_STARTED" | "READY_FOR_NEXT_REP" | "END_SET" | "COACH_REVIEW_ACK_REQUIRED" | "TERMINAL" | "UNREADABLE";
    message: string;
    terminalKindInternal: "END_SESSION_QUALITY" | "STOP_SAFETY" | null;
  };
  latestMonitor: ReturnType<typeof presentLatestRep> | null;
  progress: { completedRepCount: number; plannedRepCount: number | null; label: string };
  exposure:
    | { state: "NOT_RECORDED" | "UNREADABLE"; message: string }
    | { state: "READY"; valueLabel: string | null; unit: "m"; sourceInternal: string; sourceLabel: string; confidenceInternal: string; confidenceLabel: string };
  safety:
    | { state: "NOT_RECORDED" | "UNREADABLE"; message: string }
    | { state: "READY"; outcomeInternal: SafetyOutcome; label: string; lifecycleNote: string };
  pendingCoachReview: null | {
    reviewIdentity: RuntimeCoachReviewIdentity;
    occurredAtRep: { setIndex: number; repIndex: number };
    title: string;
    message: string;
  };
  capabilities: { canSubmitReadiness: boolean; canRecordRep: boolean; canAcknowledgeCoachReview: boolean };
};

function presentPrescription(item: SessionExecutionItemInput, prescription: z.infer<typeof runningPrescriptionSchema> | null) {
  if (prescription === null) return { status: "UNREADABLE" as const, message: "この項目の処方データを読み込めません。内容を確認してください。" };
  const provenance = parseJsonColumn(item.plannedProvenanceJson, provenanceSchema, { rejectHealthKeys: true });
  return {
    status: "READY" as const,
    item: presentRunningItem({
      id: item.id,
      displayName: item.exerciseNameSnapshot,
      rationale: item.plannedRationale,
      prescription,
      provenance: provenance.ok ? provenance.value : null,
      exactRuleSet: { status: "UNAVAILABLE" },
    }),
  };
}

function presentReadinessState(
  state: ReturnType<typeof readReadinessExecutionState> | ReadinessExecutionStateV1 | null,
): RunningSessionExecutionDto["readiness"] {
  if (state === null) return { state: "UNREADABLE" as const, message: "当日の体調確認情報を確認できません", actions: [] };
  if ("kind" in state) {
    if (state.kind === "NOT_EVALUATED") return { state: "NOT_EVALUATED" as const, message: "当日の体調確認は未評価です", actions: [] };
    if (state.kind === "LEGACY_UNVERSIONED") return {
      state: "REEVALUATION_REQUIRED" as const,
      message: "実施前に当日の体調を再評価してください",
      actions: state.actions.map((code) => ({ codeInternal: code, label: READINESS_ACTION_LABEL_JA[code] })),
    };
    if (state.kind === "UNREADABLE") return { state: "UNREADABLE" as const, message: "当日の体調確認情報を確認できません", actions: [] };
    return presentReadinessState(state.readinessExecutionStateV1);
  }
  const mapped = state.executionGate === "YES" ? "READY" : state.executionGate === "NO" ? "BLOCKED" : "COACH_DECISION_REQUIRED";
  return {
    state: mapped,
    message: READINESS_GATE_LABEL_JA[state.executionGate],
    actions: state.actions.map((code) => ({ codeInternal: code, label: READINESS_ACTION_LABEL_JA[code] })),
  };
}

function presentLatestRep(rep: RepLogEntry) {
  return {
    actionInternal: rep.action,
    actionLabel: MONITOR_ACTION_LABEL_JA[rep.action],
    qualityInternal: rep.quality,
    qualityLabel: REP_QUALITY_LABEL_JA[rep.quality],
    reasons: rep.reasons.map((code) => ({ codeInternal: code, label: STOP_REASON_LABEL_JA[code] })),
    setIndex: rep.setIndex,
    repIndex: rep.repIndex,
    timingInternal: rep.timing,
    timingLabel: EXECUTION_TIMING_LABEL_JA[rep.timing],
    timeS: rep.timeS,
    timeLabel: rep.timeS === null ? null : formatSecondsJa(rep.timeS),
    restTakenS: rep.restTakenS,
    restTakenLabel: rep.restTakenS === null ? null : formatSecondsJa(rep.restTakenS),
    nextRepRestS: null,
    nextRepRestMessage: "次の休息提案は直後の判定結果だけで利用でき、再読み込み後は復元できません",
  };
}

function presentExposure(raw: string | null): RunningSessionExecutionDto["exposure"] {
  if (raw === null) return { state: "NOT_RECORDED", message: "高速走行量はまだ記録されていません" };
  const parsed = parseJsonColumn(raw, quantityIntervalSchema(z.literal("m")), { rejectHealthKeys: true });
  if (!parsed.ok) return { state: "UNREADABLE", message: "高速走行量の計測情報を確認できません" };
  return {
    state: "READY",
    valueLabel: formatIntervalJa(parsed.value, "m"),
    unit: "m",
    sourceInternal: parsed.value.source,
    sourceLabel: EXECUTION_DATA_SOURCE_LABEL_JA[parsed.value.source],
    confidenceInternal: parsed.value.confidence,
    confidenceLabel: EXECUTION_CONFIDENCE_LABEL_JA[parsed.value.confidence],
  };
}

function presentSafety(raw: unknown): RunningSessionExecutionDto["safety"] {
  if (raw === null) return { state: "NOT_RECORDED", message: "実行ライフサイクルの安全対応記録はまだありません" };
  const parsed = safetyOutcomeSchema.safeParse(raw);
  if (!parsed.success) return { state: "UNREADABLE", message: "安全対応の記録を確認できません" };
  return {
    state: "READY",
    outcomeInternal: parsed.data,
    label: EXECUTION_SAFETY_OUTCOME_LABEL_JA[parsed.data],
    lifecycleNote: "当日の体調確認と実施中判定で記録された、最も強い安全対応の要約です。現在の健康状態を示すものではありません。",
  };
}

/** Pure and read-only. It performs no RuleSet lookup, policy evaluation, monitor rerun, or database write. */
export function presentRunningSessionExecution(input: {
  sessionStatus: string;
  item: SessionExecutionItemInput;
}): RunningSessionExecutionDto | null {
  const { item } = input;
  if (item.prescriptionKind !== "RUNNING_V2") return null;
  const active = input.sessionStatus === "PLANNED" || input.sessionStatus === "IN_PROGRESS";
  const prescriptionRead = parseJsonColumn(item.plannedPrescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
  const prescription = prescriptionRead.ok ? prescriptionRead.value : null;
  const logRead = readRepLog(item.actualRepLogJson);
  const reps = logRead.kind === "READY" ? logRead.state.reps : [];
  const started = logRead.kind === "READY" && reps.length > 0;
  const monitorStateValid = prescription !== null && logRead.kind === "READY"
    && monitorStateSchema.safeParse({ prescription, priorLogs: reps }).success;

  let execution: RunningSessionExecutionDto["execution"];
  let readiness: RunningSessionExecutionDto["readiness"];
  let pendingCoachReview: RunningSessionExecutionDto["pendingCoachReview"] = null;
  let canSubmitReadiness = false;
  let canRecordRep = false;

  if (prescription === null || logRead.kind === "UNREADABLE" || (started && !monitorStateValid) || (!started && item.stopReason !== null)) {
    execution = { state: "UNREADABLE", message: "実施状態を確認できません。コーチによる確認が必要です", terminalKindInternal: null };
    readiness = presentReadinessState(null);
  } else if (!started) {
    const read = readReadinessExecutionState(item.readinessActionsJson, item.safetyOutcome);
    readiness = presentReadinessState(read);
    execution = { state: "NOT_STARTED", message: "この項目の実施記録はまだありません", terminalKindInternal: null };
    canSubmitReadiness = active && read.kind !== "UNREADABLE";
    canRecordRep = active && read.kind === "READY_V1" && read.executionDirective.executionGate === "YES";
  } else {
    const read = readStartedExecutionState({
      readinessActionsJson: item.readinessActionsJson,
      safetyOutcome: item.safetyOutcome,
      actualRepLogJson: item.actualRepLogJson,
      stopReason: item.stopReason,
    });
    if (read.kind === "UNREADABLE" || read.kind === "LEGACY_SAFETY_STOP") {
      execution = { state: "UNREADABLE", message: "実施状態を確認できません。コーチによる確認が必要です", terminalKindInternal: null };
      readiness = presentReadinessState(null);
    } else {
      readiness = presentReadinessState(read.readinessState);
      if (read.kind === "TERMINAL") {
        execution = {
          state: "TERMINAL",
          message: read.terminalAction === "STOP_SAFETY" ? "安全上の判定により、この項目の実施は終了しています" : "実施品質または予定量の判定により、この項目は終了しています",
          terminalKindInternal: read.terminalAction,
        };
      } else if (read.kind === "COACH_REVIEW_ACK_REQUIRED") {
        const latest = read.logs[read.logs.length - 1];
        const reviewIdentity = runtimeCoachReviewIdentityOf(latest);
        execution = { state: "COACH_REVIEW_ACK_REQUIRED", message: "次の1本へ進む前にコーチ確認が必要です", terminalKindInternal: null };
        pendingCoachReview = {
          reviewIdentity,
          occurredAtRep: { setIndex: latest.setIndex, repIndex: latest.repIndex },
          title: "実施中のコーチ確認",
          message: "この判定を確認するまで次の1本は記録できません",
        };
      } else if (read.latestAction === "END_SET") {
        execution = { state: "END_SET", message: "現在のセットは終了しています。次のセットへ進めます", terminalKindInternal: null };
        canRecordRep = active;
      } else {
        execution = {
          state: "READY_FOR_NEXT_REP",
          message: read.latestAction === "COACH_REVIEW" ? "コーチ確認済みです。次の1本を記録できます" : "次の1本を記録できます",
          terminalKindInternal: null,
        };
        canRecordRep = active;
      }
    }
  }

  const plannedRepCount = prescription === null ? null : plannedRepCountOf(prescription);
  const completedRepCount = reps.length;
  return {
    sessionItemId: item.id,
    display: { name: item.exerciseNameSnapshot, prescription: presentPrescription(item, prescription) },
    readiness,
    execution,
    latestMonitor: reps.length === 0 ? null : presentLatestRep(reps[reps.length - 1]),
    progress: {
      completedRepCount,
      plannedRepCount,
      label: plannedRepCount === null ? `${completedRepCount}本を記録` : `${completedRepCount} / ${plannedRepCount}本を記録`,
    },
    exposure: presentExposure(item.actualHighSpeedExposureJson),
    safety: presentSafety(item.safetyOutcome),
    pendingCoachReview,
    capabilities: {
      canSubmitReadiness,
      canRecordRep,
      canAcknowledgeCoachReview: input.sessionStatus === "IN_PROGRESS" && pendingCoachReview !== null,
    },
  };
}
