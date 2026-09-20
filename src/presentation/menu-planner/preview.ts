import type { Prescription } from "@/domain/shared/prescription";
import type { Finding } from "@/domain/running/types/findings";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { RuleSetStatus } from "@/domain/running/rules/schema";
import type { RunningTrainingMethod } from "@/domain/running/types/method";
import type {
  DosePresentationDto,
  ConfidencePresentationDto,
  EligibilityReasonPresentationDto,
  FindingPresentationDto,
} from "@/presentation/running/dto";
import { presentConfidence } from "@/presentation/running/confidence";
import { presentDose } from "@/presentation/running/dose";
import { presentEligibilityReasons } from "@/presentation/running/eligibility";
import { presentFindings } from "@/presentation/running/findings";
import type { MenuAggregationDto } from "@/presentation/running/menu";
import type { EligibilityReason } from "@/domain/running/planning/schema";

export type PreviewItemSelection =
  | { kind: "RUNNING"; method: RunningTrainingMethod; templateId: string }
  | { kind: "EXERCISE"; exerciseId: string };

/**
 * engine が返した substitute 候補（`PlanResult.INELIGIBLE.substitutes`）の表示。
 * **informational alternatives であり、AI が自動で置換するための入力ではない。**
 * `label` は RuleSet の template labelJa。RuleSet に存在しない候補は null（推測でラベルを作らない）。
 */
export type MenuPlannerPreviewSubstitute = {
  method: RunningTrainingMethod;
  templateId: string;
  label: string | null;
};

/** Application 層が RuleSet から解決済みの substitute 表示入力。 */
export type PreviewItemSubstituteInput = {
  method: RunningTrainingMethod;
  templateId: string;
  label: string | null;
};

export type PreviewItemDose =
  | {
      kind: "RUNNING_V2";
      dose: DosePresentationDto;
      confidence: ConfidencePresentationDto;
    }
  | {
      kind: "LEGACY";
      prescription: Required<Prescription>;
      setRestSeconds: number | null;
    };

export type MenuPlannerPreviewItem = {
  itemKey: string;
  selection: PreviewItemSelection;
  title: string;
  state: "READY" | "MANUAL_INPUT_REQUIRED" | "REJECTED";
  dose: PreviewItemDose | null;
  aiReason: string | null;
  engineRationale: string[];
  findings: FindingPresentationDto[];
  warnings: string[];
  /**
   * INELIGIBLE のときだけ入る engine の理由（表示用）。state=REJECTED / canSave=false の理由を
   * Coach が読めるようにする。**Finding ではない**（acceptance の blockingFindingCodes には混ぜない）。
   */
  eligibilityReasons: EligibilityReasonPresentationDto[];
  /** INELIGIBLE のときだけ入る substitute 候補。informational のみ（AI の自動置換には使わない）。 */
  substitutes: MenuPlannerPreviewSubstitute[];
  /** BLOCKED + confirmationRequired のときだけ入る engine の確認要求 code。AI の承認として扱わない。 */
  confirmationRequiredCodes: string[];
};

export type MenuPlannerPreviewBlock = {
  blockKey: string;
  title: string;
  items: MenuPlannerPreviewItem[];
};

export type MenuPlannerPreviewEstimatedTime = {
  seconds: number | null;
  quality: "ESTIMATE" | "UNKNOWN";
  availableMinutes: number | null;
  exceedsAvailable: boolean;
};

export type MenuPlannerPreview = {
  schemaVersion: 1;
  menuName: string;
  statusOnSave: "DRAFT";
  ruleSet: { version: string; status: RuleSetStatus };
  blocks: MenuPlannerPreviewBlock[];
  aggregation: MenuAggregationDto;
  estimatedTime: MenuPlannerPreviewEstimatedTime;
  canSave: boolean;
  binding: {
    contextFingerprint: string;
    materializationDigest: string;
  };
};

export type MenuPlannerPreviewPresentationInput = {
  menuName: string;
  statusOnSave: "DRAFT";
  ruleSet: { version: string; status: RuleSetStatus };
  blocks: readonly {
    blockKey: string;
    title: string;
    items: readonly {
      itemKey: string;
      selection: PreviewItemSelection;
      title: string;
      state: "READY" | "MANUAL_INPUT_REQUIRED" | "REJECTED";
      runningPrescription: RunningPrescriptionValue | null;
      legacyPrescription: Required<Prescription> | null;
      legacySetRestSeconds: number | null;
      aiReason: string | null;
      engineRationale: readonly string[];
      findings: readonly Finding[];
      warnings: readonly string[];
      /** engine が返した生の EligibilityReason（表示変換は presentation が行う）。 */
      eligibilityReasons: readonly EligibilityReason[];
      substitutes: readonly PreviewItemSubstituteInput[];
      confirmationRequiredCodes: readonly string[];
    }[];
  }[];
  aggregation: MenuAggregationDto;
  estimatedTime: MenuPlannerPreviewEstimatedTime;
  canSave: boolean;
  binding: { contextFingerprint: string; materializationDigest: string };
};

function presentDoseFor(
  item: MenuPlannerPreviewPresentationInput["blocks"][number]["items"][number],
): PreviewItemDose | null {
  if (item.runningPrescription !== null) {
    return {
      kind: "RUNNING_V2",
      dose: presentDose(item.runningPrescription),
      confidence: presentConfidence(item.runningPrescription.confidence, item.runningPrescription.ruleSet.status),
    };
  }
  if (item.legacyPrescription !== null) {
    return {
      kind: "LEGACY",
      prescription: item.legacyPrescription,
      setRestSeconds: item.legacySetRestSeconds,
    };
  }
  return null;
}

export function presentMenuPlannerPreview(
  input: MenuPlannerPreviewPresentationInput,
): MenuPlannerPreview {
  return {
    schemaVersion: 1,
    menuName: input.menuName,
    statusOnSave: "DRAFT",
    ruleSet: input.ruleSet,
    blocks: input.blocks.map((block) => ({
      blockKey: block.blockKey,
      title: block.title,
      items: block.items.map((item) => ({
        itemKey: item.itemKey,
        selection: item.selection,
        title: item.title,
        state: item.state,
        dose: presentDoseFor(item),
        aiReason: item.aiReason,
        engineRationale: [...item.engineRationale],
        findings: presentFindings(item.findings),
        warnings: [...item.warnings],
        eligibilityReasons: presentEligibilityReasons(item.eligibilityReasons),
        substitutes: item.substitutes.map((substitute) => ({
          method: substitute.method,
          templateId: substitute.templateId,
          label: substitute.label,
        })),
        confirmationRequiredCodes: [...item.confirmationRequiredCodes],
      })),
    })),
    aggregation: input.aggregation,
    estimatedTime: input.estimatedTime,
    canSave: input.canSave,
    binding: input.binding,
  };
}
