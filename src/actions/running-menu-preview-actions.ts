"use server";

import { z } from "zod";
import { verifyRunningIntentClaims, type VerifiedRunningIntent } from "@/application/running-menu/intent";
import { createRunningMenuPreview, type RunningMenuPreview } from "@/application/running-menu/preview";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { extractRunningMenuIntent } from "@/infra/running-menu/openai-intent-extractor";
import { listExercisesForMenuPlanner } from "@/infra/repositories/exercise-repository";

const inputSchema = z.object({
  requestText: z.string().trim().min(1).max(2000),
  context: z.object({
    event: z.string().trim().min(1).max(32).optional(),
    ageGroup: z.enum(["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"]).optional(),
    availableTimeSeconds: z.number().int().positive().optional(),
  }).strict(),
}).strict();

export type RunningMenuPreviewActionResult =
  | { ok: true; intent: VerifiedRunningIntent; running: RunningMenuPreview | null; exercises: { id: string; name: string }[]; persistable: false }
  | { ok: false; message: string };

/** Read-only production boundary. No legacy RuleSet, Method, or Template enters this path. */
export async function generateRunningMenuPreviewAction(input: unknown): Promise<RunningMenuPreviewActionResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "入力内容を確認してください。" };
  if (process.env.AI_MENU_PLANNER_ENABLED !== "true") return { ok: false, message: "AIメニュー生成は現在利用できません。" };
  try {
    const rows = await listExercisesForMenuPlanner(DEFAULT_OWNER_ID);
    const reviewed = rows.filter((row) => row.status === "REVIEWED").map((row) => ({ id: row.id, name: row.name, category: row.category }));
    const extraction = await extractRunningMenuIntent({ requestText: parsed.data.requestText, exercises: reviewed });
    if (!extraction.ok) return { ok: false, message: extraction.reason === "UNAVAILABLE" ? "AIサービスを利用できません。時間をおいて再度お試しください。" : "入力条件を抽出できませんでした。文章を確認して再度お試しください。" };
    const verified = verifyRunningIntentClaims(parsed.data.requestText, extraction.claims, reviewed.map((row) => row.id));
    if (!verified.ok) return { ok: false, message: "文章と抽出条件が一致しませんでした。明示した距離・本数・休憩を確認して再度お試しください。" };
    const running = createRunningMenuPreview(verified.intent, parsed.data.context, parsed.data.requestText);
    const selected = verified.intent.exerciseIds.map((id) => reviewed.find((row) => row.id === id)!);
    return { ok: true, intent: verified.intent, running, exercises: selected.map(({ id, name }) => ({ id, name })), persistable: false };
  } catch {
    return { ok: false, message: "プレビューを作成できませんでした。時間をおいて再度お試しください。" };
  }
}
