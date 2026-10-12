import { randomUUID } from "node:crypto";
import type { ComposerCatalogExercise, EditableComposition } from "@/domain/menu-composition/contracts";
import { validateComposition } from "@/domain/menu-composition/contracts";
import { trainingConditionsSchema, trainingConditionLevel, trainingRunningGoal, TRAINING_GOAL_LABELS, TRAINING_RUNNING_GOALS, type TrainingConditions, type TrainingGoal } from "@/domain/training-proposal/conditions";
import { TRAINING_SECTION_NAMES, trainingComposerOutputSchema, type TrainingComposerOutput, type TrainingProposalPreview, type TrainingItemAnnotation } from "@/domain/training-proposal/contracts";
import { assessTrainingComposition, trainingAvailability, trainingStrengthTarget, TRAINING_MOVEMENT_TARGET } from "@/domain/training-proposal/quality";
import type { ExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { explainTrainingIssue } from "@/domain/training-proposal/messages";
import { buildStructuredRunningPreview } from "./running";
import { assertUsableSigningKey } from "@/infra/security/hmac-token";
import { issueTrainingProposalToken } from "@/infra/training-proposal/preview-token";

export type TrainingComposerInput = {
  conditions: TrainingConditions;
  movement: ComposerCatalogExercise[]; strength: ComposerCatalogExercise[];
  /** Distinct families the content gate requires after normalization. */
  requiredMovement: number; requiredStrength: number;
  /** What the Composer is asked for: a small margin so one duplicate cannot sink the whole proposal. */
  requestedMovement: number; requestedStrength: number;
  stages: Record<string, number>; families: Record<string, string>;
};
type AssessedRow = { row: ComposerCatalogExercise; eligibility: ExerciseEligibility };

/**
 * Same-name registrations (e.g. one drill imported from two videos) are one movement.
 * The Composer is offered one of them, preferring coach-reviewed Guidance; people can
 * still add either registration manually.
 */
function onePerName(rows: readonly AssessedRow[]): AssessedRow[] {
  const reviewed = (entry: AssessedRow) => entry.row.videoGuidance?.videoAnalysisStatus === "COACH_REVIEWED";
  const chosen = new Map<string, AssessedRow>();
  for (const entry of rows) {
    const key = entry.row.name.normalize("NFKC").replace(/\s+/gu, "");
    const prior = chosen.get(key);
    if (!prior || (!reviewed(prior) && reviewed(entry))) chosen.set(key, entry);
  }
  return [...chosen.values()];
}
const familyCount = (rows: readonly AssessedRow[]) => new Set(rows.map(entry => entry.eligibility.family)).size;
type Proposal = TrainingComposerOutput["movement"][number];

/** Item-local checks only (no counts, order or families). A failing item is removed, never repaired. */
function itemIssues(proposal: Proposal, blockIndex: 0 | 2, input: TrainingComposerInput, catalog: readonly ComposerCatalogExercise[],
  ownerId: string, requestText: string): string[] {
  const id = "candidate";
  const composition: EditableComposition = { blocks: TRAINING_SECTION_NAMES.map((name, index) => ({ id: `section-${index}`, name,
    items: index === blockIndex ? [{ ...proposal.item, id }] : [] })) };
  const annotation: TrainingItemAnnotation = { intensity: proposal.intensity, stage: blockIndex === 0 ? input.stages[proposal.item.exerciseId] ?? 0 : null,
    family: input.families[proposal.item.exerciseId] ?? "UNKNOWN", relationship: proposal.relationship, alternativeGroup: proposal.alternativeGroup };
  const issues = assessTrainingComposition(composition, { [id]: annotation }, input.conditions, catalog, { proposal: false });
  const validated = validateComposition(composition, { catalog, ownerId, requestText, edited: true, runningAvailable: false });
  if (!validated.ok) issues.push(validated.code);
  return [...new Set(issues)];
}
export type GenerateTrainingProposalResult = { ok: true; preview: TrainingProposalPreview }
  | { ok: false; code: string; message: string; issues?: string[] };

const HIGH_INTENSITY_GOALS: readonly TrainingGoal[] = ["ACCEL", "MAX_SPEED", "SPEED_ENDURANCE", "STRENGTH"];
const LOW_LOAD_GOALS: readonly TrainingGoal[] = ["RECOVERY", "PRECOMP"];

/** Plain-language notes about how several selected goals were handled. Nothing is merged silently. */
function goalMessages(conditions: TrainingConditions): string[] {
  const messages: string[] = [];
  const label = (goal: TrainingGoal) => `「${TRAINING_GOAL_LABELS[goal]}」`;
  const runningGoal = trainingRunningGoal(conditions);
  if (runningGoal && runningGoal !== conditions.primaryGoal) {
    messages.push(`走練習の目的は${label(runningGoal)}です。主目的${label(conditions.primaryGoal)}は動きづくり・補強の候補選びで優先しています。`);
  } else if (runningGoal && conditions.goals.some(goal => goal !== runningGoal && (TRAINING_RUNNING_GOALS as readonly string[]).includes(goal))) {
    messages.push(`走練習の目的は主目的${label(runningGoal)}です。ほかの走の目的は同じ処方に混ぜていません。`);
  }
  const low = conditions.goals.filter(goal => LOW_LOAD_GOALS.includes(goal));
  const high = conditions.goals.filter(goal => HIGH_INTENSITY_GOALS.includes(goal));
  if (low.length && high.length) {
    messages.push(`${low.map(label).join("・")}と${high.map(label).join("・")}は同じ日の負荷として両立しにくい目的です。主目的${label(conditions.primaryGoal)}を優先しました。もう一方は別の日のメニューとして作成してください。`);
  }
  return messages;
}

/** Selection values own safety and intent. Only catalog selection/doses reach Composer. */
export async function generateTrainingProposal(raw: unknown, deps: {
  ownerId: string; signingKey: string; catalog: () => Promise<ComposerCatalogExercise[]>;
  compose: (input: TrainingComposerInput) => Promise<{ ok: true; value: TrainingComposerOutput } | { ok: false; reason: string }>;
}): Promise<GenerateTrainingProposalResult> {
  const parsed = trainingConditionsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "INVALID_CONDITIONS", message: parsed.error.issues[0]?.message ?? "選択条件を確認してください。" };
  try {
    assertUsableSigningKey(deps.signingKey);
    const conditions = parsed.data;
    const structured = buildStructuredRunningPreview(conditions);
    const runningPrescription = structured.running?.status === "READY" ? structured.running.prescription : null;
    const runningStatusReason = structured.running && structured.running.status !== "READY" ? structured.running.message
      : !structured.running ? "選択した目的に走の目的（加速力向上・最高速度向上・基礎走能力向上など）が含まれていないため、走練習は提案していません。走を行う場合は目的に追加してください。" : null;
    const catalog = (await deps.catalog()).filter(row => row.ownerId === deps.ownerId && row.status === "REVIEWED");
    const available = trainingAvailability(catalog, conditions);
    // All eligible reviewed movements remain visible to Composer. No legacy 24-item
    // cap or requested-duration retrieval is used on this path.
    const eligible = [...available.movement, ...available.strength];
    const offeredMovement = onePerName(available.movement);
    const offeredStrength = onePerName(available.strength);
    const input: TrainingComposerInput = { conditions,
      movement: offeredMovement.map(x => x.row), strength: offeredStrength.map(x => x.row),
      requiredMovement: available.requiredMovement, requiredStrength: available.requiredStrength,
      requestedMovement: Math.min(available.requiredMovement + 2, familyCount(offeredMovement)),
      requestedStrength: Math.min(available.requiredStrength + 1, familyCount(offeredStrength)),
      stages: Object.fromEntries(eligible.map(x => [x.row.id, x.eligibility.stage])),
      families: Object.fromEntries(eligible.map(x => [x.row.id, x.eligibility.family])) };
    // A condition hold is an explicit empty result, not a fabricated AI success.
    const output = eligible.length ? await deps.compose(input) : { ok: true as const, value: {
      movement: [], strength: [], explanation: "確認済みの環境・コンディションに適合する既存種目がありません。条件を確認してください。",
      uncertainty: "未確認の安全条件や利用できない設備を補って提案していません。" } };
    if (!output.ok) return { ok: false, code: "COMPOSER_UNAVAILABLE", message: "提案を取得できませんでした。自動再送は行いません。" };
    const model = trainingComposerOutputSchema.safeParse(output.value);
    if (!model.success) return incomplete(["INVALID_PROPOSAL_SCHEMA"]);
    // Each proposed item must pass on its own. Bad items are dropped (and reported), never
    // repaired or replaced; the section counts below are then checked on what remains.
    const dropped: { name: string; issues: string[] }[] = [];
    const valid = (proposals: readonly Proposal[], blockIndex: 0 | 2) => proposals.filter(proposal => {
      const found = itemIssues(proposal, blockIndex, input, catalog, deps.ownerId, structured.requestText);
      if (found.length) dropped.push({ name: proposal.item.displayName, issues: found });
      return found.length === 0;
    });
    // App-owned structure is normalized deterministically: the first of exact/family duplicates
    // is kept and movement follows the App's stage order. Counts are still checked afterwards.
    const distinct = <T extends { item: { exerciseId: string } }>(proposals: readonly T[]) => {
      const ids = new Set<string>(); const families = new Set<string>();
      return proposals.filter(({ item }) => {
        const family = input.families[item.exerciseId] ?? item.exerciseId;
        if (ids.has(item.exerciseId) || families.has(family)) return false;
        ids.add(item.exerciseId); families.add(family); return true;
      });
    };
    const movementProposals = distinct(valid(model.data.movement, 0))
      .sort((a, b) => (input.stages[a.item.exerciseId] ?? 0) - (input.stages[b.item.exerciseId] ?? 0));
    const strengthProposals = distinct(valid(model.data.strength, 2));
    if (dropped.length) console.warn("[training-proposal] dropped items", { codes: [...new Set(dropped.flatMap(entry => entry.issues))] });
    const annotations: Record<string, TrainingItemAnnotation> = {};
    const composition: EditableComposition = { blocks: TRAINING_SECTION_NAMES.map(name => ({ id: randomUUID(), name, items: [] })) };
    for (const [blockIndex, proposals] of [[0, movementProposals], [2, strengthProposals]] as const) {
      for (const proposal of proposals) {
        const id = randomUUID();
        composition.blocks[blockIndex].items.push({ ...proposal.item, id });
        annotations[id] = { intensity: proposal.intensity, stage: blockIndex === 0 ? input.stages[proposal.item.exerciseId] ?? 0 : null,
          family: input.families[proposal.item.exerciseId] ?? "UNKNOWN", relationship: proposal.relationship, alternativeGroup: proposal.alternativeGroup };
      }
    }
    if (runningPrescription) composition.blocks[1].items.push({ id: randomUUID(), type: "RUNNING_POLICY", plannedNote: "" });
    const issues = assessTrainingComposition(composition, annotations, conditions, catalog, { proposal: true });
    if (composition.blocks.some(block => block.items.length)) {
      const validated = validateComposition(composition, { catalog, ownerId: deps.ownerId, requestText: structured.requestText,
        edited: true, runningAvailable: runningPrescription !== null });
      if (!validated.ok) issues.push(validated.code);
    }
    if (issues.length) return incomplete([...issues, ...dropped.flatMap(entry => entry.issues)]);
    const level = trainingConditionLevel(conditions.condition);
    const reasons = (codes: string[]) => codes.length ? `主な理由：${codes.map(explainTrainingIssue).join(" ")}` : "";
    const messages = [model.data.explanation, model.data.uncertainty];
    if (dropped.length) {
      const codes = [...new Set(dropped.flatMap(entry => entry.issues))].slice(0, 3);
      messages.push(`AIの提案のうち${dropped.length}件（${dropped.map(entry => entry.name).join("、").slice(0, 200)}）は、条件・数え方・実施量の確認を通らなかったため除外しました。${reasons(codes)}`);
    }
    if (level === "HOLD") messages.push("痛みまたは体調不良が選択されているため、動きづくり・走・補強の提案を保留しています。実施の可否と内容を指導者が確認してください。");
    if (level === "STRONG_FATIGUE") messages.push("疲労または筋肉痛が強いため、走練習と補強は保留し、動きづくりは低強度の可動域・姿勢づくりに限定しています。");
    if (available.requiredMovement < TRAINING_MOVEMENT_TARGET) messages.push(`動きづくりは${available.requiredMovement}種目までです。確認済みの環境・対象・体調に適合する、重複しない既存候補が10種目に達しません。数合わせはしていません。${reasons(available.blockingReasons.MOVEMENT)}`);
    const strengthTarget = trainingStrengthTarget(conditions);
    if (level !== "HOLD" && level !== "STRONG_FATIGUE" && (available.requiredStrength < 2 || available.requiredStrength < strengthTarget && conditions.primaryGoal === "STRENGTH")) {
      messages.push(`補強は${available.requiredStrength}種目までです。設備・経験・体調に適合する候補が不足しています。${reasons(available.blockingReasons.STRENGTH)}`);
    }
    if (runningStatusReason) messages.push(`走：未処方。${runningStatusReason}`);
    messages.push(...goalMessages(conditions));
    const runningLimited = structured.running !== null && runningPrescription === null;
    const quality = available.requiredMovement < TRAINING_MOVEMENT_TARGET || available.requiredStrength < 2 || runningLimited ? "LIMITED" : "READY";
    const previewToken = issueTrainingProposalToken({ ownerId: deps.ownerId, conditions, proposal: composition, annotations, runningPrescription,
      runningStatusReason, allowedExerciseIds: eligible.map(x => x.row.id), messages, quality, revision: null }, deps.signingKey);
    return { ok: true, preview: { conditions, composition, previewToken, runningPrescription, runningStatusReason,
      annotations, selectedItemIds: composition.blocks.flatMap(block => block.items.map(item => item.id)), messages, quality } };
  } catch { return { ok: false, code: "PROPOSAL_UNAVAILABLE", message: "提案を作成できませんでした。条件と実行環境を確認してください。" }; }
}
function incomplete(issues: string[]): GenerateTrainingProposalResult {
  const unique = [...new Set(issues)];
  // Codes only. No user notes, model text, or credentials in operational logs.
  console.warn("[training-proposal] incomplete", { codes: unique });
  return { ok: false, code: "INCOMPLETE_PROPOSAL", message: "未完成の提案です。種目の構成・実施量・条件との整合性を確認できないため、採用しませんでした。", issues: unique };
}
