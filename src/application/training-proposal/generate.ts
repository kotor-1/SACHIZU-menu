import { randomUUID } from "node:crypto";
import type { ComposerCatalogExercise, EditableComposition } from "@/domain/menu-composition/contracts";
import { validateComposition } from "@/domain/menu-composition/contracts";
import { trainingConditionsSchema, trainingConditionLevel, trainingRunningGoal, TRAINING_GOAL_LABELS, TRAINING_RUNNING_GOALS, type TrainingConditions, type TrainingGoal } from "@/domain/training-proposal/conditions";
import { TRAINING_SECTION_NAMES, trainingComposerOutputSchema, type TrainingComposerOutput, type TrainingComposerSelection, type TrainingProposalPreview, type TrainingItemAnnotation } from "@/domain/training-proposal/contracts";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import { assessTrainingComposition, trainingAvailability, trainingStrengthTarget, TRAINING_MOVEMENT_TARGET } from "@/domain/training-proposal/quality";
import { compareMovementOrder, compareStrengthOrder, type ExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { explainTrainingIssue } from "@/domain/training-proposal/messages";
import { buildStructuredRunningPreview } from "./running";
import { ruleBasedTrainingSelection } from "./rule-based";
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
  /** Place inside the section: 動きづくり from the ground up to one-leg hops, 補強 from jumps to the floor. */
  progressions: Record<string, number>;
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

/** The App sets every name, instruction and quantity from the catalog; the Composer contributes the choice and its explanation. */
function toProposal(selection: TrainingComposerSelection, row: ComposerCatalogExercise, conditions: TrainingConditions) {
  const { id: _id, ...item } = suggestCatalogItem(row, conditions, "candidate").item; void _id;
  return { item: { ...item, reason: selection.reason }, intensity: selection.intensity,
    relationship: selection.relationship, alternativeGroup: selection.alternativeGroup };
}
type Proposal = ReturnType<typeof toProposal>;

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
  // The App's numbers are the only numbers: the explanation may not state another set count or rest.
  const text = `${proposal.item.reason} ${proposal.intensity}`.normalize("NFKC");
  for (const match of text.matchAll(/(?:\b|[^\d])(\d+)\s*セット/gu)) if (Number(match[1]) !== proposal.item.plannedSets) issues.push("DOSE_TEXT_CONFLICT");
  for (const match of text.matchAll(/(?:休息|休憩|レスト)(?:は|を|:|：)?\s*(\d+)\s*秒/gu)) if (Number(match[1]) !== proposal.item.plannedRestSeconds) issues.push("REST_TEXT_CONFLICT");
  return [...new Set(issues)];
}

type AssemblyContext = { catalog: readonly ComposerCatalogExercise[]; ownerId: string; requestText: string; runningAvailable: boolean };
/**
 * Turns a selection (the Composer's, or the App's rule-based one) into the three sections and
 * checks it as a whole. Each item must pass on its own; bad items are dropped (and reported),
 * never repaired or replaced, and the section counts are then checked on what remains.
 */
function assemble(output: TrainingComposerOutput, input: TrainingComposerInput, context: AssemblyContext) {
  const dropped: { name: string; issues: string[] }[] = [];
  const build = (selections: readonly TrainingComposerSelection[], blockIndex: 0 | 2) => selections.flatMap(selection => {
    const row = context.catalog.find(x => x.id === selection.exerciseId);
    if (!row) { dropped.push({ name: "登録外の候補", issues: ["UNKNOWN_EXERCISE"] }); return []; }
    const proposal = toProposal(selection, row, input.conditions);
    const found = itemIssues(proposal, blockIndex, input, context.catalog, context.ownerId, context.requestText);
    if (found.length) dropped.push({ name: row.name, issues: found });
    return found.length ? [] : [proposal];
  });
  // App-owned structure is normalized deterministically: the first of exact/family duplicates
  // is kept, movement follows the App's order (the stage, then the ground up inside it) and
  // 補強 runs from jumps to the floor, so the model's order never decides either. Counts are
  // still checked afterwards.
  const distinct = (proposals: readonly Proposal[]) => {
    const ids = new Set<string>(); const families = new Set<string>();
    return proposals.filter(({ item }) => {
      const family = input.families[item.exerciseId] ?? item.exerciseId;
      if (ids.has(item.exerciseId) || families.has(family)) return false;
      ids.add(item.exerciseId); families.add(family); return true;
    });
  };
  const movement = distinct(build(output.movement, 0))
    .sort((a, b) => compareMovementOrder(input, a.item.exerciseId, b.item.exerciseId));
  const strength = distinct(build(output.strength, 2)).sort((a, b) => compareStrengthOrder(input, a.item.exerciseId, b.item.exerciseId));
  const annotations: Record<string, TrainingItemAnnotation> = {};
  const composition: EditableComposition = { blocks: TRAINING_SECTION_NAMES.map(name => ({ id: randomUUID(), name, items: [] })) };
  for (const [blockIndex, proposals] of [[0, movement], [2, strength]] as const) {
    for (const proposal of proposals) {
      const id = randomUUID();
      composition.blocks[blockIndex].items.push({ ...proposal.item, id });
      annotations[id] = { intensity: proposal.intensity, stage: blockIndex === 0 ? input.stages[proposal.item.exerciseId] ?? 0 : null,
        family: input.families[proposal.item.exerciseId] ?? "UNKNOWN", relationship: proposal.relationship, alternativeGroup: proposal.alternativeGroup };
    }
  }
  if (context.runningAvailable) composition.blocks[1].items.push({ id: randomUUID(), type: "RUNNING_POLICY", plannedNote: "" });
  const issues = assessTrainingComposition(composition, annotations, input.conditions, context.catalog, { proposal: true });
  if (composition.blocks.some(block => block.items.length)) {
    const validated = validateComposition(composition, { catalog: context.catalog, ownerId: context.ownerId, requestText: context.requestText,
      edited: true, runningAvailable: context.runningAvailable });
    if (!validated.ok) issues.push(validated.code);
  }
  return { output, composition, annotations, dropped, issues: [...new Set(issues)] };
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

/**
 * Selection values own safety and intent. The Composer only chooses catalog items and explains
 * them; the App sets every number, and shows its own rule-based proposal when the Composer fails.
 */
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
      : !structured.running ? "選んだ目的には走練習を入れていません。走練習も行うときは、目的を「加速」「最高速度」「スピード持久」「基礎の走力」のどれかにしてください。" : null;
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
      families: Object.fromEntries(eligible.map(x => [x.row.id, x.eligibility.family])),
      progressions: Object.fromEntries(eligible.map(x => [x.row.id, x.eligibility.progression])) };
    // A condition hold is an explicit empty result, not a fabricated AI success.
    let output: Awaited<ReturnType<typeof deps.compose>> = { ok: true, value: {
      movement: [], strength: [], explanation: "確認済みの環境・コンディションに適合する既存種目がありません。条件を確認してください。",
      uncertainty: "未確認の安全条件や利用できない設備を補って提案していません。" } };
    if (eligible.length) {
      try { output = await deps.compose(input); } catch { output = { ok: false, reason: "COMPOSER_FAILED" }; }
    }
    const context: AssemblyContext = { catalog, ownerId: deps.ownerId, requestText: structured.requestText, runningAvailable: runningPrescription !== null };
    const model = output.ok ? trainingComposerOutputSchema.safeParse(output.value) : null;
    const ai = model?.success ? assemble(model.data, input, context) : null;
    // The Composer's answer is used only when it passes as a whole. Otherwise the App's own
    // rule-based proposal is shown and labelled as such: the two are never mixed and nothing is resent.
    const fallbackCodes = !output.ok ? ["COMPOSER_UNAVAILABLE"] : !ai ? ["INVALID_PROPOSAL_SCHEMA"]
      : ai.issues.length ? [...new Set([...ai.issues, ...ai.dropped.flatMap(entry => entry.issues)])] : [];
    const fallback = fallbackCodes.length > 0 || !ai;
    const chosen = fallback || !ai ? assemble(ruleBasedTrainingSelection(input), input, context) : ai;
    const dropped = fallback ? [] : chosen.dropped;
    if (fallback) console.warn("[training-proposal] rule-based fallback", { codes: fallbackCodes });
    else if (dropped.length) console.warn("[training-proposal] dropped items", { codes: [...new Set(dropped.flatMap(entry => entry.issues))] });
    if (chosen.issues.length) return incomplete([...chosen.issues, ...fallbackCodes]);
    const { composition, annotations } = chosen;
    const level = trainingConditionLevel(conditions.condition);
    const reasons = (codes: string[]) => codes.length ? `主な理由：${codes.map(explainTrainingIssue).join(" ")}` : "";
    const messages = [chosen.output.explanation, chosen.output.uncertainty];
    if (fallback) {
      messages.unshift(!output.ok ? "AIの提案を取得できなかったため、AIを使わない基本提案を表示しています。"
        : !ai ? "AIの提案の形式を確認できなかったため、AIを使わない基本提案を表示しています。"
          : `AIの提案が条件・構成の確認を通らなかったため、AIを使わない基本提案を表示しています。${reasons(fallbackCodes.slice(0, 3))}`);
    } else if (dropped.length) {
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
    const quality = fallback || available.requiredMovement < TRAINING_MOVEMENT_TARGET || available.requiredStrength < 2 || runningLimited ? "LIMITED" : "READY";
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
