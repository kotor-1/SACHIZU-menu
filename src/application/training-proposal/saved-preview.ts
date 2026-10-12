import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import type { TrainingProposalPreview, TrainingProposalSavedState } from "@/domain/training-proposal/contracts";
import { assessExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { issueTrainingProposalToken } from "@/infra/training-proposal/preview-token";

/** Candidate identities and unchecked choices survive storage independently of adopted DB rows. */
export function savedTrainingProposalPreview(state: TrainingProposalSavedState, menu: { id: string; ownerId: string; name: string },
  catalog: ComposerCatalogExercise[], signingKey: string): TrainingProposalPreview {
  const previewToken = issueTrainingProposalToken({ ownerId: menu.ownerId, menuId: menu.id, revision: state.revision,
    conditions: state.conditions, proposal: state.composition, annotations: state.annotations,
    runningPrescription: state.runningPrescription, runningStatusReason: state.runningStatusReason,
    messages: state.messages, quality: state.quality,
    allowedExerciseIds: catalog.filter(row => row.ownerId === menu.ownerId && assessExerciseEligibility(row, state.conditions).eligible).map(row => row.id),
  }, signingKey);
  return { ...state, previewToken, menuName: menu.name };
}
