/**
 * Running Prescription Engine v2 — R10-B3 presentation DTO（型のみ）。
 *
 * Client Component へ渡すのはこのファイルの型だけ。RuleSet / Prisma model / 処方 JSON を丸ごと渡さない。
 * `…Internal` / `developerCode` / `key` / `confirmationKey` などは操作や React key のための内部値であり、
 * component はこれらを DOM テキストとして描画しない（L-4: enum キーを表示しない）。
 *
 * このファイルはランタイムの import を持たない（client bundle に domain の schema を持ち込まないため）。
 */
import type { FindingSeverity } from "@/domain/running/types/findings";
import type { RunningTrainingMethod } from "@/domain/running/types/method";
import type { SessionTemplateId } from "@/domain/running/types/template";
import type { EnvelopeField } from "@/domain/running/rules/schema";

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** 表示上の強さ（色だけに依存しない。必ず severityLabels のテキストと一緒に使う）。 */
export type FindingTone = "info" | "caution" | "review" | "restricted" | "blocked";

export type FindingDetailDto = {
  /** 対象の項目名（Finding.metric が構造化された既知の値のときだけ。自由文字列は出さない）。 */
  subjectLabel: string | null;
  /** Finding.value（QuantityInterval）の表示。不明側は「不明」（0 にしない）。 */
  valueLabel: string | null;
  /** Finding.limit（Range）の表示。 */
  limitLabel: string | null;
};

export type FindingPresentationDto = {
  /** React key 用。表示しない。 */
  key: string;
  /** 開発・調査用の Finding code。**通常 DOM には描画しない。** */
  developerCode: string;
  /** B4 で `confirmedFindingCodes[]` へ渡す値（= Finding code）。表示しない。 */
  confirmationKey: string;
  /** 内部値。表示は severityLabels を使う。 */
  severitiesInternal: FindingSeverity[];
  severityLabels: string[];
  /** 最も強い severity の補足文（BLOCK / BLOCK_AUTOGEN / REQUIRE_CONFIRMATION のときだけ）。 */
  severityNote: string | null;
  tone: FindingTone;
  scopeLabel: string;
  message: string;
  details: FindingDetailDto[];
  /** false = registry に無い code（安全な汎用文を表示している）。 */
  isKnownCode: boolean;
  /**
   * [R10-B4A] 保存済み処方の Finding について、コーチの明示確認の監査記録（Provenance.findingConfirmations）が
   * ある場合の表示（例:「コーチ確認済み（2026/9/20）」）。保存前の確認対象には付かない。
   */
  confirmationRecordLabel: string | null;
  requiresExplicitConfirmation: boolean;
  needsCoachReview: boolean;
  restrictsAutoGeneration: boolean;
  blocksCreation: boolean;
};

/** [R10-B4A] INELIGIBLE の理由（EligibilityReason）の表示。code は内部値として持つだけで描画しない。 */
export type EligibilityReasonPresentationDto = {
  key: string;
  developerCode: string;
  message: string;
  ruleIdInternal: string | null;
  /** domain が返した値そのもの（UI で推測しない）。 */
  overrideAllowed: boolean;
};

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export type ConfidenceTone = "high" | "moderate" | "low" | "policy";

export type ConfidencePresentationDto = {
  /** 「確信度 中」「暫定ルール」など（prescriptionConfidence）。 */
  prescriptionLabel: string;
  prescriptionDescription: string;
  prescriptionTone: ConfidenceTone;
  isPolicyOnly: boolean;
  directnessLabel: string;
  directnessDescription: string;
  inputDataLabel: string;
  ruleSetStatusLabel: string;
  /**
   * RuleSet の状態の注意表示（DRAFT →「ルールセット 暫定版」、RETIRED →「ルールセット 旧版」、ACTIVE → null）。
   * prescriptionConfidence の POLICY_ONLY（暫定ルール）とは別の事実なので、別に持つ。
   */
  ruleSetNoticeLabel: string | null;
  ruleSetIsDraft: boolean;
};

// ---------------------------------------------------------------------------
// Dose
// ---------------------------------------------------------------------------

export type RepStructurePresentationDto =
  | { kind: "DISTANCE"; distanceLabel: string }
  | {
      kind: "FLY";
      buildUpLabel: string;
      flyZoneLabel: string;
      /** 減速区間（高速走行量には含めない）。RuleSet にセルが無い場合は null（0 にしない）。 */
      decelerationLabel: string | null;
      /** 1本の走行距離（助走・フライ・減速の合計）。減速が null なら null。 */
      totalRunningLabel: string | null;
    }
  | { kind: "DURATION"; durationLabel: string; approxDistanceLabel: string | null }
  | { kind: "SPLIT"; segmentsLabel: string }
  | { kind: "ATTEMPTS"; approachLabel: string; approachDistanceLabel: string };

export type DosePresentationDto = {
  sets: number;
  reps: number;
  /** 「3セット × 2本」。セットで区切らない構造（STRUCTURAL_FIXED）は「4本」。試技は「5回」。 */
  countsLabel: string;
  repStructure: RepStructurePresentationDto;
  /** 1本の距離の要約（FLY は助走＋フライ。減速は含めない）。距離を持たない構造は null。 */
  distanceLabel: string | null;
  durationLabel: string | null;
  /** 「本間レスト 4分以上」。rest は常に「最低この時間」の意味で表示する。 */
  restLabel: string;
  setRestLabel: string | null;
  intraRepRestLabel: string | null;
  restFeasibilityLabel: string | null;
  /** 強度の基準（「全力意図」など）。 */
  intensityLabel: string;
  /** 数値の目標（%・秒）がある場合だけ。偽の % は作らない。 */
  intensityTargetLabel: string | null;
  /**
   * [R10-B4A.2] コーチが入力した目標スプリット（intensity.reference の snapshot）の区間表示。
   * エンジンが生成した個別目標タイムではない（GROUP でも保存された入力値として表示する）。
   */
  coachTargetSplit: { heading: string; segments: { distanceLabel: string; targetTimeLabel: string }[] } | null;
};

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type EvidenceSourceTypeCountDto = { label: string; count: number };

export type EvidencePresentationDto =
  | { status: "AVAILABLE"; sourceTypes: EvidenceSourceTypeCountDto[]; unresolvedCount: number; unresolvedMessage: string | null }
  | { status: "NONE"; message: string }
  | { status: "UNAVAILABLE"; message: string };

export type ProvenanceChangeDto = { label: string; detail: string | null; reason: string | null; atLabel: string | null };

export type ProvenanceChangesDto = { summaryLabel: string; items: ProvenanceChangeDto[] };

export type ProvenancePresentationDto =
  | { status: "UNAVAILABLE"; message: string }
  | {
      status: "AVAILABLE";
      ruleSetVersionLabel: string;
      ruleSetStatusLabel: string;
      ruleSetIsDraft: boolean;
      confidence: ConfidencePresentationDto;
      generatedByInternal: "ENGINE" | "AI_PLANNER";
      generatedByLabel: string;
      createdByLabel: string;
      acceptanceLabel: string;
      /** AI の提案のときだけ。エンジンの処方根拠（rationale）とは混ぜない。 */
      aiProposal: { heading: string; reason: string | null; engineBasisNote: string } | null;
      evidence: EvidencePresentationDto;
      coachEdits: ProvenanceChangesDto;
      overrides: ProvenanceChangesDto;
    };

// ---------------------------------------------------------------------------
// Template picker
// ---------------------------------------------------------------------------

export type RunningTemplateOptionDto = {
  /** React key / 選択判定用（表示しない）。 */
  key: string;
  methodInternal: RunningTrainingMethod;
  templateIdInternal: SessionTemplateId;
  /** SessionTemplate.labelJa（コーチ向けの主名称）。 */
  label: string;
  /** SessionTemplate.coachingAliases（検索対象・補助表示）。 */
  aliases: string[];
  recoveryLabel: string | null;
  advancedOnly: boolean;
  advancedOnlyLabel: string | null;
  /**
   * [R10-B4A] 「選択を試してよい候補か」。**適格性（eligibility）の保証ではない**。
   * 最終的に選べるかは `planRunningItemAction` の plan 結果（INELIGIBLE 等）が決める。
   * domain の判定結果（EligibilityReason）が渡されたときだけ false になりうる。
   */
  canAttemptSelection: boolean;
  restrictionMessage: string | null;
  /** [R10-B4A.2] RuleSet（MethodMeta.allowedIntensityReferences）がコーチ入力の目標スプリットを受け付けるか。 */
  acceptsCoachTargetSplit: boolean;
};

export type RunningTemplateGroupDto = {
  methodInternal: RunningTrainingMethod;
  /** 一覧整理用の分類名（template 名より弱く表示する）。 */
  groupLabel: string;
  options: RunningTemplateOptionDto[];
};

export type RunningTemplatePickerDto = {
  ruleSetNoticeLabel: string | null;
  /** [R10-B4A] 一覧は候補であり、適格性の判定ではないことの説明。 */
  candidateNote: string;
  groups: RunningTemplateGroupDto[];
};

export type RunningTemplateSelection = { method: RunningTrainingMethod; templateId: SessionTemplateId };

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** 編集対象のキー（EnvelopeField + EVENT_APPROACH_SPEED の助走距離）。内部値。 */
export type EditableFieldKey = EnvelopeField | "approachDistanceM";

export type OverrideLayer = "COACH_EDITABLE" | "HARD_SAFETY";

export type RangeDto = { min: number; max: number; label: string };

export type OverrideLayerOptionDto = {
  layerInternal: OverrideLayer;
  label: string;
  /** domain の CoachOverride schema が confirmedTwice を要求するか（presentation で規則を複製しない）。 */
  requiresDoubleConfirmation: boolean;
};

export type EditableFieldDto = {
  keyInternal: EditableFieldKey;
  label: string;
  unitLabel: string;
  /**
   * 画面に表示している現在値。aggregate 型の field（totalReps / attempts / sessionVolumeM / flyVolumeM /
   * vdecPercent / intensityPercent）は保存済み処方に 1:1 の値が無いことがあり、その場合は null
   * （server / Action 側で旧値を捏造しないため、表示できない値は編集リクエストにも載せない）。
   */
  currentValue: number | null;
  currentValueLabel: string;
  originLabel: string | null;
  recommended: RangeDto | null;
  coachEditable: RangeDto | null;
  /** 存在する場合だけ（null のときは表示しない）。 */
  hardSafety: RangeDto | null;
  editable: boolean;
  /**
   * [R10-B4A] 表示専用の field（aggregate / constraint 値、助走距離など）。現在値・範囲は表示できるが、
   * 直接編集・例外設定のボタンは出さない。EnvelopeField に存在することと直接編集できることは同義ではない。
   */
  readOnly: boolean;
  notEditableReason: string | null;
  overrideLayers: OverrideLayerOptionDto[];
};

export type EligibilityOverrideOptionDto = {
  /** CoachOverride target の ruleId（内部値）。 */
  ruleIdInternal: string;
  message: string;
  requiresDoubleConfirmation: boolean;
};

/** [R10-B4A.2] 目標スプリット入力欄の1区間（入力中の文字列。自動では埋めない）。 */
export type TargetSplitSegmentDraft = { distanceText: string; targetTimeText: string };

export type RunningItemEditorDto = {
  fields: EditableFieldDto[];
  eligibilityOverrides: EligibilityOverrideOptionDto[];
  /**
   * [R10-B4A.2] 保存済みのコーチ入力目標スプリット（1点の目標タイムで表せるときだけ exact な値。表せなければ null）と、
   * 保存時と一致した RuleSet がこの Method の TARGET_SPLIT 入力を受け付けるか（RuleSet を確認できなければ null）。
   */
  targetSplit: { current: { distanceM: number; targetTimeS: number }[] | null; acceptsInput: boolean | null };
};

// ---------------------------------------------------------------------------
// Running item
// ---------------------------------------------------------------------------

export type RunningItemPresentationDto = {
  id: string;
  title: string;
  subtitle: string | null;
  methodInternal: RunningTrainingMethod;
  templateIdInternal: string;
  dose: DosePresentationDto;
  confidence: ConfidencePresentationDto;
  findings: FindingPresentationDto[];
  /** Action が返したメニュー全体の Finding（永続化されない一時的な評価）。 */
  sessionFindings: FindingPresentationDto[];
  /** 保存済み MenuItem.rationale（再レンダリングしない）。 */
  rationaleText: string;
  provenance: ProvenancePresentationDto;
  editor: RunningItemEditorDto;
  canEdit: boolean;
  canRecalculate: boolean;
  /** 編集できない理由（表示用の目安。最終判定は Action）。 */
  editUnavailableMessage: string | null;
  needsCoachReview: boolean;
};

// ---------------------------------------------------------------------------
// Editor の controlled state と B4 へ渡すリクエスト
// ---------------------------------------------------------------------------

export type OverrideDraft =
  | {
      kind: "FIELD";
      fieldInternal: EditableFieldKey;
      layerInternal: OverrideLayer;
      valueText: string;
      reason: string;
      firstConfirmation: boolean;
      secondConfirmation: boolean;
    }
  | {
      kind: "ELIGIBILITY";
      ruleIdInternal: string;
      reason: string;
      firstConfirmation: boolean;
      secondConfirmation: boolean;
    };

/** B4 で editRunningItemAction へ接続する。`displayedFromValue` は画面に出していた値（無ければ null）。 */
export type RunningFieldEditRequest = {
  itemId: string;
  field: EditableFieldKey;
  value: number;
  displayedFromValue: number | null;
  /** [R10-B4A] 直前の Action 結果（CONFIRMATION_REQUIRED）で示された Finding を、コーチが明示確認した code。 */
  confirmedFindingCodes: string[];
};

/** B4 で overrideRunningItemAction へ接続する。reason の長さ等の最終検証は domain。 */
export type RunningOverrideRequest =
  | {
      itemId: string;
      kind: "FIELD";
      field: EditableFieldKey;
      layer: OverrideLayer;
      newValue: number;
      reason: string;
      confirmedTwice: boolean;
      confirmedFindingCodes: string[];
    }
  | { itemId: string; kind: "ELIGIBILITY"; ruleId: string; reason: string; confirmedTwice: boolean; confirmedFindingCodes: string[] };

/** [R10-B4A.2] B4-B で editRunningItemAction（coachReferenceJson）へ接続する。 */
export type RunningCoachReferenceEditRequest = {
  itemId: string;
  coachReference: { kind: "TARGET_SPLIT"; segments: { distanceM: number; targetTimeS: number }[] };
  confirmedFindingCodes: string[];
};

/** [R10-B4A] B4-B で recalculateWithActiveRuleSetAction へ接続する。 */
export type RunningRecalculateRequest = { itemId: string; confirmedFindingCodes: string[] };
