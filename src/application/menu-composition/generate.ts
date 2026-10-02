import { randomUUID } from "node:crypto";
import { composeMenuInputSchema, editableComposition, validateComposition, type ComposeMenuInput, type ComposerCatalogExercise, type EditableComposition, type MenuComposition } from "@/domain/menu-composition/contracts";
import { selectComposerCatalog } from "./catalog";
import type { RunningMenuPreviewActionResult } from "@/actions/running-menu-preview-actions";
import type { MenuComposerInput } from "@/infra/menu-composition/openai-composer";
import { issueMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import type { RunningPrescription } from "@/domain/running-policy/contracts";
import { assertUsableSigningKey } from "@/infra/security/hmac-token";

export type ComposedMenuPreview = {
  composition: EditableComposition; previewToken: string; runningPrescription: RunningPrescription | null;
  runningToken: string | null; requestText: string; context: ComposeMenuInput["context"]; unsupportedIntents: string[];
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
    if (interpreted.running && interpreted.running.status !== "READY") return { ok: false, code: interpreted.running.status, message: interpreted.running.message };
    const running = interpreted.running?.status === "READY" ? interpreted.running.prescription : null;
    if (running && !interpreted.previewToken) return { ok: false, code: "UNSIGNED_RUNNING", message: "走メニューを確認できませんでした。" };
    const catalog = (await deps.catalog()).filter((row) => row.ownerId === deps.ownerId);
    const candidates = selectComposerCatalog(catalog, parsed.data.requestText, interpreted.exercises.map((row) => row.id));
    const output = await deps.compose({ ...parsed.data, catalog: candidates, runningPrescription: running, unsupportedIntents: interpreted.unsupportedIntents });
    if (!output.ok) return { ok: false, code: "COMPOSITION_UNAVAILABLE", message: "メニュー案を取得できませんでした。時間をおいて再度お試しください。" };
    const runningSourceTexts = interpreted.intent.explicitDistances.map((claim) => claim.sourceText);
    const validated = validateComposition(output.value, { catalog: candidates, ownerId: deps.ownerId,
      requestText: parsed.data.requestText, runningAvailable: running !== null, runningSourceTexts });
    if (!validated.ok) return { ok: false, code: validated.code, message: "メニュー案の項目や量を確認できませんでした。内容を少し具体的にして再度お試しください。" };
    const composition = editableComposition(validated.value as MenuComposition, randomUUID);
    const previewToken = issueMenuCompositionToken({ ownerId: deps.ownerId, ...parsed.data,
      proposal: composition, allowedExerciseIds: catalog.filter((row) => row.status === "REVIEWED").map((row) => row.id),
      runningToken: interpreted.previewToken, runningPrescription: running, runningSourceTexts }, deps.signingKey);
    return { ok: true, preview: { composition, previewToken, runningPrescription: running,
      runningToken: interpreted.previewToken, ...parsed.data, unsupportedIntents: interpreted.unsupportedIntents } };
  } catch { return { ok: false, code: "COMPOSITION_UNAVAILABLE", message: "メニュー案を作成できませんでした。時間をおいて再度お試しください。" }; }
}
