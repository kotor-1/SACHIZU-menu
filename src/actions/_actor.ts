/**
 * Running Prescription Engine v2 — CoachActor 生成の唯一の server boundary（R10-B1）。
 *
 * 通常の server module。**"use server" は付けない**（付けると export した関数がそのまま
 * 呼び出し可能な Server Action の endpoint になってしまうため）。
 *
 * ブランディングのロジックはここに複製しない。domain の `createCoachActor()`（唯一の生成関数）を
 * 包むだけで、ownerId は既存の `DEFAULT_OWNER_ID`（`src/domain/shared/constants.ts`）を再利用する
 * （"default-coach" をここで再定義しない）。
 *
 * AI 経路（`src/domain/ai/**`・`src/infra/ai/**`・`src/actions/ai-actions.ts`）はこのモジュールと
 * `createCoachActor` / `coachActorSchema` を import できない（`eslint.config.mjs` の
 * `no-restricted-imports` で強制する）。認証（誰がこのサーバーを操作しているか）は未実装のため、
 * 現状は「コーチ操作の経路 = running-actions.ts 等、AI 経路ではない場所」であることの型的な防波堤。
 */
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { createCoachActor, type CoachActor } from "@/domain/running/types/actor";

/** running-actions.ts 等、コーチが操作する Server Action からだけ呼ぶ。 */
export function getCoachActorForServer(): CoachActor {
  return createCoachActor(DEFAULT_OWNER_ID);
}
