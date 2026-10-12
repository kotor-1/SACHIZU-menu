import { randomUUID } from "node:crypto";
import { composeMenuInputSchema, editableComposition, validateComposition, type ComposeMenuInput, type ComposerCatalogExercise, type EditableComposition, type MenuComposition } from "@/domain/menu-composition/contracts";
import { selectComposerCatalog } from "./catalog";
import type { RunningMenuPreviewActionResult } from "@/actions/running-menu-preview-actions";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import { issueMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { assertUsableSigningKey } from "@/infra/security/hmac-token";
import { EMPTY_UNPRESCRIBED_RUNNING_DOSE, type UnprescribedRunningContext } from "@/domain/menu-composition/unprescribed-running";
import type { MenuOverview } from "@/domain/menu-composition/contracts";
import type { DurationPlan } from "@/domain/menu-composition/duration";
import { proposedDurationPlan } from "./planning";
import { buildSessionBrief } from "./session-brief";

export type ComposedMenuPreview = {
  overview?: MenuOverview; athleteLabel?: string; durationPlan?: DurationPlan; confirmationQuestions?: string[];
  composition: EditableComposition; previewToken: string; runningPrescription: RunningPrescription | null;
  unprescribedRunning?: UnprescribedRunningContext | null;
  requestedTimeSeconds?: number | null; runningToken: string | null; requestText: string; context: ComposeMenuInput["context"]; unsupportedIntents: string[];
};
export type GenerateComposedMenuResult = { ok: true; preview: ComposedMenuPreview }
  | { ok: false; code: string; message: string };

/** Running interpretation stays frozen. Composition failure never executes an Engine default. */
export async function generateComposedMenu(input: unknown, deps: {
  ownerId: string; signingKey: string; catalog: () => Promise<ComposerCatalogExercise[]>;
  interpret: (input: ComposeMenuInput) => Promise<RunningMenuPreviewActionResult>;
  compose: (input: MenuComposerInput) => Promise<{ ok: true; value: MenuComposition } | { ok: false; reason: string }>;
}): Promise<GenerateComposedMenuResult> {
  const parsed = composeMenuInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "INVALID_INPUT", message: "希望の内容を入力してください。" };
  try {
    // Fail before paid stages if a preview cannot be safely saved.
    assertUsableSigningKey(deps.signingKey);
    const interpreted = await deps.interpret(parsed.data);
    if (!interpreted.ok) return { ok: false, code: interpreted.reason ?? "INTERPRETATION_INVALID", message: interpreted.message };
    const pending = interpreted.running && interpreted.running.status !== "READY" ? interpreted.running : null;
    // Missing policy/input can leave an editable draft. Safety, conflicts and invalid
    // inputs remain stops and must not be disguised as missing approval.
    const canDraft = pending?.status === "NEEDS_POLICY"
      || (pending?.status === "NEEDS_INPUT" && (["EVENT_REQUIRED", "AGE_REQUIRED"].includes(pending.reason) || pending.reason.startsWith("SCIENCE_")))
      || (pending?.status === "COACH_REVIEW_REQUIRED" && pending.reason === "RECOVERY_REST_PREFERRED");
    if (pending && !canDraft) return { ok: false, code: pending.status, message: pending.message };
    const unprescribedRunning = pending ? { reasonCode: pending.reason, reasonMessage: pending.message } : null;
    const running = interpreted.running?.status === "READY" ? interpreted.running.prescription : null;
    if (running && !interpreted.previewToken) return { ok: false, code: "UNSIGNED_RUNNING", message: "走メニューを確認できませんでした。" };
    const requestedTimeSeconds = interpreted.intent.availableTimeSeconds?.value ?? parsed.data.context.availableTimeSeconds ?? null;
    if (interpreted.intent.availableTimeSeconds && parsed.data.context.availableTimeSeconds !== undefined
      && interpreted.intent.availableTimeSeconds.value !== parsed.data.context.availableTimeSeconds) {
      return { ok: false, code: "TIME_CONTEXT_CONFLICT", message: "文章と入力欄の希望時間が異なります。どちらを使うか確認してください。" };
    }
    // Composer needs verified facts, while the Running token keeps its original input context.
    const composerContext = {
      ...(parsed.data.context.science ? { science: parsed.data.context.science } : {}),
      ...(parsed.data.context.event ? { event: parsed.data.context.event } : {}),
      ...(parsed.data.context.ageGroup ? { ageGroup: parsed.data.context.ageGroup } : {}),
      ...(interpreted.intent.event ? { event: interpreted.intent.event.value } : {}),
      ...(interpreted.intent.ageGroup ? { ageGroup: interpreted.intent.ageGroup.value } : {}),
      ...(requestedTimeSeconds !== null ? { availableTimeSeconds: requestedTimeSeconds } : {}),
    };
    const catalog = (await deps.catalog()).filter((row) => row.ownerId === deps.ownerId);
    const elementaryNotConfirmedExperienced = composerContext.ageGroup === "ELEMENTARY"
      && parsed.data.context.science?.experience !== "EXPERIENCED";
    // Conservative proposal retrieval boundary: elementary athletes stay within
    // reviewed difficulty 1–2 unless experience is explicitly confirmed.
    // Unknown difficulty is excluded; this does not infer experience from text
    // or change Engine and human-editing rules.
    const composerEligibleCatalog = elementaryNotConfirmedExperienced
      ? catalog.filter((row) => Number.isInteger(row.difficulty) && row.difficulty! >= 1 && row.difficulty! <= 2)
      : catalog;
    const candidates = selectComposerCatalog(composerEligibleCatalog, parsed.data.requestText, interpreted.exercises.map((row) => row.id), composerContext);
    const sessionBrief = buildSessionBrief({ ...parsed.data, context: composerContext }, interpreted.intent, candidates, running);
    const output = await deps.compose({ ...parsed.data, context: composerContext, sessionBrief, catalog: candidates, runningPrescription: running, unprescribedRunning, unsupportedIntents: interpreted.unsupportedIntents });
    if (!output.ok) return { ok: false, code: "COMPOSITION_UNAVAILABLE", message: "メニュー案を取得できませんでした。時間をおいて再度お試しください。" };
    const runningSourceTexts = interpreted.intent.explicitDistances.map((claim) => claim.sourceText);
    const validated = validateComposition(output.value, { catalog: candidates, ownerId: deps.ownerId,
      requestText: parsed.data.requestText, runningAvailable: running !== null, unprescribedRunningAvailable: unprescribedRunning !== null, runningSourceTexts });
    if (!validated.ok) {
      // Allowlisted metadata only: never log user text, model output, tokens or secrets.
      console.warn("[menu-composition] validation rejected", { stage: "COMPOSITION_VALIDATION", code: validated.code,
        runningState: running ? "READY" : unprescribedRunning ? "UNPRESCRIBED" : "NONE" });
      return { ok: false, code: validated.code,
        message: "AIが返したメニュー案に不整合があるため、保存を止めました。入力内容の不足ではありません。再生成するか、手動で作成してください。" };
    }
    const composition = editableComposition(validated.value as MenuComposition, randomUUID);
    if (unprescribedRunning) {
      const placeholder = { type: "UNPRESCRIBED_RUNNING" as const, id: randomUUID(), ...unprescribedRunning,
        plannedNote: "", ...EMPTY_UNPRESCRIBED_RUNNING_DOSE };
      const markerBlock = composition.blocks.find(block => block.items.some(item => item.type === "RUNNING_POLICY"));
      if (markerBlock) markerBlock.items = markerBlock.items.map(item => item.type === "RUNNING_POLICY" ? { ...placeholder, id: item.id } : item);
      // Respect existing menu bounds even for a model response at the block limit.
      else if (composition.blocks.length < 12) composition.blocks.push({ id: randomUUID(), name: "走（未処方）", items: [placeholder] });
      else {
        const block = composition.blocks.find(row => row.items.length < 30);
        if (!block) return { ok: false, code: "TOO_MANY_ITEMS", message: "項目数を減らして作成してください。" };
        block.items.push(placeholder);
      }
      if (composition.blocks.flatMap(block => block.items).length > 50) return { ok: false, code: "TOO_MANY_ITEMS", message: "項目数を減らして作成してください。" };
    }
    const proposal = validated.value as MenuComposition;
    const overview = proposal.overview;
    const ageLabels = { ELEMENTARY: "小学生", JUNIOR_HIGH: "中学生", HIGH_SCHOOL: "高校生", ADULT: "一般" };
    const athleteLabel = [composerContext.ageGroup ? ageLabels[composerContext.ageGroup] : null, composerContext.event].filter(Boolean).join("・");
    const durationPlan = proposedDurationPlan(proposal, composition, running);
    const confirmationQuestions = pending ? [pending.reason === "SCIENCE_COMPETITION_CONTEXT_REQUIRED"
      ? "大会までの日数と、今回は調整・負荷をかける練習のどちらを希望するか確認してください。"
      : pending.reason === "EVENT_REQUIRED" ? "走練習を処方するには、対象の競技種目を教えてください。"
      : pending.reason === "AGE_REQUIRED" ? "走練習を処方するには、選手の年齢区分を教えてください。"
      : pending.message] : [];
    const previewToken = issueMenuCompositionToken({ ownerId: deps.ownerId, ...parsed.data, overview, athleteLabel,
      proposal: composition, requestedTimeSeconds, unprescribedRunning, allowedExerciseIds: catalog.filter((row) => row.status === "REVIEWED").map((row) => row.id),
      runningToken: running ? interpreted.previewToken : null, runningPrescription: running, runningSourceTexts }, deps.signingKey);
    return { ok: true, preview: { composition, previewToken, overview, athleteLabel, durationPlan, confirmationQuestions, requestedTimeSeconds, unprescribedRunning, runningPrescription: running,
      runningToken: running ? interpreted.previewToken : null, ...parsed.data, unsupportedIntents: interpreted.unsupportedIntents } };
  } catch { return { ok: false, code: "COMPOSITION_UNAVAILABLE", message: "メニュー案を作成できませんでした。時間をおいて再度お試しください。" }; }
}
