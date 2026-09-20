import type {
  AiPlannerProposal,
  MenuPlannerProviderRequest,
} from "./contracts";

export const AI_PLANNER_CATALOG_ISSUE_CODES = [
  "UNKNOWN_EXERCISE_ID",
  "UNKNOWN_RUNNING_TEMPLATE",
  "TEMPLATE_METHOD_MISMATCH",
] as const;

export type AiPlannerCatalogIssueCode =
  (typeof AI_PLANNER_CATALOG_ISSUE_CODES)[number];

export type AiPlannerCatalogIssue = {
  code: AiPlannerCatalogIssueCode;
  itemIndex: number;
};

export type AiPlannerCatalogValidationResult =
  | {
      ok: true;
      proposal: AiPlannerProposal;
    }
  | {
      ok: false;
      issues: AiPlannerCatalogIssue[];
    };

export function validateAiPlannerProposalAgainstCatalog(
  proposal: AiPlannerProposal,
  catalog: MenuPlannerProviderRequest["catalog"],
): AiPlannerCatalogValidationResult {
  const exerciseIds = new Set(catalog.exercises.map((candidate) => candidate.id));
  const runningByTemplateId = new Map(
    catalog.runningTemplates.map((candidate) => [
      candidate.templateId,
      candidate.method,
    ]),
  );
  const issues: AiPlannerCatalogIssue[] = [];

  for (const [itemIndex, item] of proposal.items.entries()) {
    if (item.kind === "EXERCISE") {
      if (!exerciseIds.has(item.proposal.exerciseId)) {
        issues.push({ code: "UNKNOWN_EXERCISE_ID", itemIndex });
      }
      continue;
    }

    const catalogMethod = runningByTemplateId.get(item.proposal.templateId);
    if (catalogMethod === undefined) {
      issues.push({ code: "UNKNOWN_RUNNING_TEMPLATE", itemIndex });
    } else if (catalogMethod !== item.proposal.method) {
      issues.push({ code: "TEMPLATE_METHOD_MISMATCH", itemIndex });
    }
  }

  return issues.length === 0
    ? { ok: true, proposal }
    : { ok: false, issues };
}
