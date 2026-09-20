/**
 * R12-A3B の server-only draft materialization contract。
 *
 * これは client payload ではなく、A3A の fresh deterministic replay が作った
 * 保存用の allow-list である。raw intent / token claims / Prisma row は含めない。
 */
import type { TrainingPhase } from "@/domain/menu/constants";
import type { Prescription } from "@/domain/shared/prescription";
import type { Provenance } from "@/domain/running/persistence/provenance";
import type { RunningPrescriptionValue } from "@/domain/running/types/prescription";
import type { RunningTrainingMethod } from "@/domain/running/types/method";

export type MenuPlannerDraftSelection =
  | { kind: "RUNNING"; method: RunningTrainingMethod; templateId: string }
  | { kind: "EXERCISE"; exerciseId: string };

export type MenuPlannerDraftItem = {
  selection: MenuPlannerDraftSelection;
  title: string;
  runningPrescription: RunningPrescriptionValue | null;
  runningProvenance: Provenance | null;
  legacyPrescription: Required<Prescription> | null;
  legacySetRestSeconds: number | null;
};

export type MenuPlannerDraftBlock = {
  name: string;
  items: MenuPlannerDraftItem[];
};

export type MenuPlannerDraftMaterialization = {
  menuName: string;
  phase: TrainingPhase | null;
  estimatedMinutes: number | null;
  runningContextJson: string | null;
  blocks: MenuPlannerDraftBlock[];
};
