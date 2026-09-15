/**
 * Running Prescription Engine v2 — Actor / AI boundary の基礎型（§18.2）。
 *
 * R1 では認証システムは実装しない。ここで作るのは「誰が処方を作った/
 * 変更したか」を型で区別するための最小限の構造だけ。
 *
 * 重要（§14 の要求）: コーチ権限を単なる `isCoach: true` の boolean だけで
 * 偽装できないようにする。`CoachActor` は Zod の `.brand()` を使ったブランド
 * 型にし、`createCoachActor()` という**唯一の生成経路**を通らない限り
 * 型として成立しないようにする。呼び出し側が `{ kind: "COACH", ownerId }`
 * という plain object リテラルを直接 `CoachActor` 型の変数へ代入しようとすると
 * TypeScript の型エラーになる（ブランドフィールドを持たないため）。
 * これは実行時の改ざんを防ぐものではないが、「うっかり」偽装できない
 * コンパイル時の防波堤にはなる（本格的な認可は R11 の Server Action 層の責務）。
 */
import { z } from "zod";
import { isoDateTimeSchema } from "./primitives";

// ---------------------------------------------------------------------------
// CoachActor（branded）
// ---------------------------------------------------------------------------

/**
 * discriminatedUnion のメンバーには生の ZodObject が必要（`.brand()` を通すと
 * ZodBranded になり discriminatedUnion に渡せなくなる）。そのため、構造だけの
 * unbranded schema を先に作り、`coachActorSchema`（外部に公開する branded 版）
 * と `actorSchema`（union 用。あえて unbranded のまま）の両方をそこから作る。
 * ブランドの主目的は「`createCoachActor()` を通さずに plain object リテラルを
 * `CoachActor` 型へ代入できないようにする」ことであり、`CoachActor` 単体の
 * 型として branded であれば目的は満たす。
 */
const coachActorShape = z.object({
  kind: z.literal("COACH"),
  ownerId: z.string().min(1),
});

export const coachActorSchema = coachActorShape.brand<"CoachActor">();
export type CoachActor = z.infer<typeof coachActorSchema>;

/**
 * CoachActor を作る唯一の関数。R1 時点では ownerId の正当性を検証する
 * 認証機構が無いため、呼び出し元（将来のサーバー専用モジュール）が
 * 正しい ownerId を渡す責任を持つ。少なくとも、コード上のどこか別の場所で
 * `{ kind: "COACH", ... }` を書いただけでは `CoachActor` 型にならない、
 * という型レベルの制約は成立する。
 */
export function createCoachActor(ownerId: string): CoachActor {
  return coachActorSchema.parse({ kind: "COACH", ownerId });
}

// ---------------------------------------------------------------------------
// AiPlannerActor / SystemActor / Actor
// ---------------------------------------------------------------------------

export const aiPlannerActorSchema = z.object({
  kind: z.literal("AI_PLANNER"),
  provider: z.string().min(1),
  model: z.string().min(1),
  requestId: z.string().min(1),
});
export type AiPlannerActor = z.infer<typeof aiPlannerActorSchema>;

export const systemActorSchema = z.object({ kind: z.literal("SYSTEM") });
export type SystemActor = z.infer<typeof systemActorSchema>;

/**
 * `actorSchema` は discriminated union なので、"COACH" 分岐を通しても
 * ブランド（`__brand`）までは Zod が自動的には保証しない。
 * 「Actor が本当に CoachActor かどうか」を区別する必要がある呼び出し側は、
 * `createCoachActor()` で作られた値をそのまま渡す運用にするか、
 * `actor.kind === "COACH"` で絞り込んだ後 `coachActorSchema.parse(actor)`
 * を通すこと。
 */
export const actorSchema = z.discriminatedUnion("kind", [
  coachActorShape,
  aiPlannerActorSchema,
  systemActorSchema,
]);
export type Actor = z.infer<typeof actorSchema>;

// ---------------------------------------------------------------------------
// GenerationRecord（§16.3 Provenance.generatedBy と同じ形）
// ---------------------------------------------------------------------------

/**
 * `proposer` の "ENGINE" は `SystemActor` の "SYSTEM" とは別概念
 * （"ENGINE" = ルールセットの機械的な処方生成、"SYSTEM" = actor 全般としての
 * システム主体）。混同を避けるため専用の schema を定義する。
 */
const engineProposerSchema = z.object({ kind: z.literal("ENGINE") });

export const generationRecordSchema = z.object({
  proposer: z.discriminatedUnion("kind", [engineProposerSchema, aiPlannerActorSchema]),
  createdByCoach: z.boolean(),
  acceptedByCoachAt: isoDateTimeSchema.nullable(),
});
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
