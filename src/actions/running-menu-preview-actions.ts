"use server";

import { z } from "zod";
import type { VerifiedRunningIntent } from "@/application/running-menu/intent";
import { verifySemanticIntentV2 } from "@/application/running-menu/semantic-intent-v2";
import { createRunningMenuPreview, type RunningMenuPreview } from "@/application/running-menu/preview";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { extractRunningSemanticIntentV2 } from "@/infra/running-menu/openai-semantic-intent-v2";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";
import { issueRunningMenuPreviewToken, runningMenuSigningKey } from "@/infra/running-menu/preview-token";

const inputSchema = z.object({
  requestText: z.string().trim().min(1).max(2000),
  context: z.object({
    event: z.string().trim().min(1).max(32).optional(),
    ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
    availableTimeSeconds: z.number().int().positive().optional(),
  }).strict(),
}).strict();

export type RunningMenuPreviewActionResult =
  | { ok: true; intent: VerifiedRunningIntent; running: RunningMenuPreview | null; exercises: { id: string; name: string }[]; unsupportedIntents: string[]; persistable: boolean; previewToken: string | null }
  | { ok: false; message: string };

/** Read-only production boundary. No legacy RuleSet, Method, or Template enters this path. */
export async function generateRunningMenuPreviewAction(input: unknown): Promise<RunningMenuPreviewActionResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "入力内容を確認してください。" };
  if (process.env.AI_MENU_PLANNER_ENABLED !== "true") return { ok: false, message: "AIメニュー生成は現在利用できません。" };
  try {
    const rows = await listExercisesForMenuPlanner(DEFAULT_OWNER_ID);
    const reviewed = rows.filter((row) => row.status === "REVIEWED").map((row) => ({ id: row.id, name: row.name, category: row.category }));
    const extractorInput = { requestText: parsed.data.requestText, exercises: reviewed };
    let extraction = await extractRunningSemanticIntentV2(extractorInput);
    if (!extraction.ok) return { ok: false, message: extraction.reason === "UNAVAILABLE" ? "AIサービスを利用できません。時間をおいて再度お試しください。" : "入力条件を抽出できませんでした。文章を確認して再度お試しください。" };
    let verified = verifySemanticIntentV2(parsed.data.requestText, extraction.interpretation, extraction.review, extraction.numericRoleReview, reviewed.map((row) => row.id));
    if (!verified.ok && verified.reason === "INVALID_AI_CLAIM") {
      // A fresh semantic pass may correct a malformed claim. Every retry still
      // has to pass the same verifier before it can reach the policy engine.
      extraction = await extractRunningSemanticIntentV2(extractorInput);
      if (extraction.ok) verified = verifySemanticIntentV2(parsed.data.requestText, extraction.interpretation, extraction.review, extraction.numericRoleReview, reviewed.map((row) => row.id));
    }
    if (!verified.ok) return { ok: false, message: verified.reason === "AMBIGUOUS" ? verified.question ?? "どの条件を指定したか確認してください。" : "抽出した条件を確認できませんでした。内容を少し具体的にして再度お試しください。" };
    const running = createRunningMenuPreview(verified.engineIntent, parsed.data.context, parsed.data.requestText);
    const selected = verified.engineIntent.exerciseIds.map((id) => reviewed.find((row) => row.id === id)!);
    let previewToken: string | null = null;
    if (running?.status === "READY") {
      try {
        previewToken = issueRunningMenuPreviewToken({
          ownerId: DEFAULT_OWNER_ID,
          requestText: parsed.data.requestText,
          context: parsed.data.context,
          intent: verified.engineIntent,
          prescription: running.prescription,
        }, runningMenuSigningKey());
      } catch {
        // A missing or invalid signing key leaves the preview read-only.
      }
    }
    return { ok: true, intent: verified.engineIntent, running, exercises: selected.map(({ id, name }) => ({ id, name })), unsupportedIntents: verified.interpretation.unsupportedIntents.map((item) => item.meaning), persistable: previewToken !== null, previewToken };
  } catch {
    return { ok: false, message: "プレビューを作成できませんでした。時間をおいて再度お試しください。" };
  }
}
