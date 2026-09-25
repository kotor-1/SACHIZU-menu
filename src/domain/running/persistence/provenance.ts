/**
 * Running Prescription Engine v2 — Provenance（`MenuItem.provenanceJson`、§16.3・§19.1・§19.2）。
 *
 * [R9] §16.3 の形をそのまま strict schema にする。健康情報（§13.5）は持たない:
 *   - schema は全階層 `.strict()`（未知のキーを受け付けない）
 *   - 保存前に `findForbiddenHealthKeys` でキー名も検査する（二重の防御）
 *   - inputsDigest に残してよい readiness の情報は `readinessActions`（ReadinessActionCode）だけ
 *
 * provenance は plan / 再計算のときだけ新しく作る。duplicate / session snapshot では文字列をそのままコピーし、
 * repository が `acceptedByCoachAt` / `engineVersion` 等を書き換えることはない。
 */
import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "../../shared/canonical-json";
import { TRAINING_PHASES } from "../../menu/constants";
import { coachEditFieldSchema, coachOverrideTargetSchema, findingCodeSchema } from "../planning/schema";
import { generationRecordSchema } from "../types/actor";
import { appliedPlausibilityReviewSchema } from "../types/plausibilityReview";
import { canonicalPlausibilityIssueIdentity } from "../plausibility/review";
import { INTENSITY_REFERENCE_KINDS } from "../types/intensity";
import { historyCoverageLevelSchema } from "../types/load";
import {
  directnessSchema,
  inputDataConfidenceSchema,
  prescriptionConfidenceSchema,
  type RunningPrescriptionValue,
} from "../types/prescription";
import { evidenceIdSchema, isoDateSchema, isoDateTimeSchema, type EvidenceId } from "../types/primitives";
import { readinessActionCodeSchema } from "../types/readiness";
import { resolvedAgeBandSchema } from "../readiness/schema";
import { envelopeTierSchema, trainingAgeTierSchema, type TrainingAgeTier } from "../types/subject";

/**
 * [R10-B1.1] Provenance 監査ログ専用の最小型。**core の `TrainingAgeTier` へ "UNKNOWN" を追加しない**
 * （eligibility・range lookup 等の通常利用で "UNKNOWN" を実在の tier と誤用させないため。
 * `ResolvedAgeBand`（`../context/ageBand.ts`）と同じ設計判断）。
 * `resolveSubjectProfile()` の `trainingAgeKnown=false`（トレーニング歴が実際には分からず、
 * エンジンが保守的な既定値へ倒した状態）を、Provenance では偽装せず正直に "UNKNOWN" として記録するために使う。
 */
export const PROVENANCE_TRAINING_AGE_TIER_UNKNOWN = "UNKNOWN" as const;
export const provenanceTrainingAgeTierSchema = z.union([trainingAgeTierSchema, z.literal(PROVENANCE_TRAINING_AGE_TIER_UNKNOWN)]);
export type ProvenanceTrainingAgeTier = TrainingAgeTier | typeof PROVENANCE_TRAINING_AGE_TIER_UNKNOWN;

export const provenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** package.json version + git 短縮 hash（ビルド時注入。repository は生成・更新しない）。 */
    engineVersion: z.string().trim().min(1).max(64),
    ruleSet: z
      .object({
        version: z.string().min(1),
        contentHash: z.string().min(1),
        status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]),
      })
      .strict(),
    generatedBy: generationRecordSchema.strict(),
    /** 健康情報を含めない入力要約。 */
    inputsDigest: z
      .object({
        tier: envelopeTierSchema,
        /**
         * [R5 errata] 観測できない年齢帯は UNKNOWN のまま（U12 等へ偽装しない）。
         * [R10-B1.1] `ResolvedAgeBand`（`context/ageBand.ts` の resolveSubjectProfile が返す型）と
         * 同じ union をそのまま再利用する（`resolvedAgeBandSchema`。専用の別名は作らない）。
         */
        ageBand: resolvedAgeBandSchema,
        maturityEffective: z.string().min(1).max(64),
        /**
         * [R10-B1.1] トレーニング歴が実際に入力されていた場合は解決済みの `TrainingAgeTier`、
         * 分からない場合は `"UNKNOWN"`（エンジン内部の保守的な既定値 BEGINNER 等へは偽装しない）。
         */
        trainingAgeTier: provenanceTrainingAgeTierSchema,
        phase: z.enum(TRAINING_PHASES).nullable(),
        plannedDate: isoDateSchema.nullable(),
        competitionWindows: z.array(z.string().min(1).max(64)),
        referenceKinds: z.array(z.enum(INTENSITY_REFERENCE_KINDS)),
        historyCoverage72h: historyCoverageLevelSchema,
        readinessActions: z.array(readinessActionCodeSchema),
      })
      .strict(),
    evidenceIds: z.array(evidenceIdSchema),
    confidence: z
      .object({
        prescription: prescriptionConfidenceSchema,
        directness: directnessSchema,
        inputData: inputDataConfidenceSchema,
      })
      .strict(),
    coachEdits: z.array(
      z
        .object({
          at: isoDateTimeSchema,
          field: coachEditFieldSchema,
          /** Initial coach input has no prior value; later edits record both endpoints. */
          from: z.number().finite().optional(),
          to: z.number().finite(),
        })
        .strict(),
    ).default([]),
    overrides: z.array(
      z
        .object({
          at: isoDateTimeSchema,
          target: coachOverrideTargetSchema,
          from: z.number().finite().optional(),
          to: z.number().finite().optional(),
          reason: z.string().trim().min(1).max(1000),
          /**
           * [R10-B4A] コーチが Action で実際に送った二重確認の値（backward-compatible optional）。
           * 再計画でこの override を CoachOverride として再構築するときに使い、true へ自動昇格しない。
           * 欠落（R10-B4A より前の記録）は「確認の記録なし」= false として扱う。
           */
          confirmedTwice: z.boolean().optional(),
        })
        .strict(),
    ),
    /** AI の説明文（数値・出典除去済み §18.3）。 */
    aiReason: z.string().max(300).nullable(),
    /**
     * [R10-B4A] コーチが明示確認した REQUIRE_CONFIRMATION の監査記録（backward-compatible optional。schemaVersion=1 のまま）。
     * その保存時の plan 結果に実在した code だけを記録する（client が送った任意文字列は保存しない）。
     * 実際に確認した Finding が無い保存では key 自体を持たない。edit / override / recalculate では引き継がない。
     */
    findingConfirmations: z
      .array(z.object({ code: findingCodeSchema, at: isoDateTimeSchema }).strict())
      .max(50)
      .optional(),
    /** OPEN20 F2 audit records; absent remains valid for all historical provenance. */
    plausibilityReviews: z.array(appliedPlausibilityReviewSchema).max(50).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.evidenceIds).size !== p.evidenceIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidenceIds に重複があります", path: ["evidenceIds"] });
    }
    const confirmedCodes = (p.findingConfirmations ?? []).map((c) => c.code);
    if (new Set(confirmedCodes).size !== confirmedCodes.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "findingConfirmations に code の重複があります", path: ["findingConfirmations"] });
    }
    const reviews = p.plausibilityReviews ?? [];
    const reviewDigests = reviews.map((review) => review.issueDigest);
    if (new Set(reviewDigests).size !== reviewDigests.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "plausibilityReviews に issueDigest の重複があります", path: ["plausibilityReviews"] });
    }
    reviews.forEach((review, index) => {
      if (review.ruleSet.version !== p.ruleSet.version || review.ruleSet.contentHash !== p.ruleSet.contentHash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "plausibilityReview の RuleSet identity が provenance と一致しません",
          path: ["plausibilityReviews", index, "ruleSet"],
        });
      }
      const recomputedIssueDigest = sha256Utf8Hex(canonicalStringify(canonicalPlausibilityIssueIdentity(review)));
      if (review.issueDigest !== recomputedIssueDigest) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "plausibilityReview.issueDigest がreview identityと一致しません",
          path: ["plausibilityReviews", index, "issueDigest"],
        });
      }
    });
  });
export type Provenance = z.infer<typeof provenanceSchema>;

/** 処方の中で参照されている EvidenceId（全階層の `evidenceIds`）を重複なし・昇順で返す。 */
export function collectPrescriptionEvidenceIds(prescription: RunningPrescriptionValue): EvidenceId[] {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (key === "evidenceIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string") ids.add(id);
      } else {
        walk(child);
      }
    }
  };
  walk(prescription);
  return [...ids].sort() as EvidenceId[];
}

/**
 * plan 結果から Provenance を組み立てる（ruleSet / generatedBy / confidence / evidenceIds は処方から写す）。
 * inputsDigest・engineVersion・coachEdits・overrides・aiReason は呼び出し側（R10 Action）が渡す。
 */
export function buildProvenance(args: {
  prescription: RunningPrescriptionValue;
  engineVersion: string;
  inputsDigest: Provenance["inputsDigest"];
  coachEdits: Provenance["coachEdits"];
  overrides: Provenance["overrides"];
  aiReason: string | null;
  /** [R10-B4A] 今回の plan 結果に対してコーチが明示確認した code（空なら key を持たない）。 */
  findingConfirmations?: NonNullable<Provenance["findingConfirmations"]>;
  /** [OPEN20 F2] Explicitly supplied reviews only; ordinary F1 saves omit this key. */
  plausibilityReviews?: NonNullable<Provenance["plausibilityReviews"]>;
}): Provenance {
  const { prescription } = args;
  return provenanceSchema.parse({
    schemaVersion: 1,
    engineVersion: args.engineVersion,
    ruleSet: { ...prescription.ruleSet },
    generatedBy: structuredClone(prescription.generatedBy),
    inputsDigest: args.inputsDigest,
    evidenceIds: collectPrescriptionEvidenceIds(prescription),
    confidence: { ...prescription.confidence },
    coachEdits: args.coachEdits,
    overrides: args.overrides,
    aiReason: args.aiReason,
    ...(args.findingConfirmations !== undefined && args.findingConfirmations.length > 0 ? { findingConfirmations: args.findingConfirmations } : {}),
    ...(args.plausibilityReviews !== undefined ? { plausibilityReviews: args.plausibilityReviews } : {}),
  });
}

/** 保存前の整合検査（§19.2 / T-RV-02）。不一致の説明だけを返す（値は含めない）。 */
export function provenancePrescriptionIssues(provenance: Provenance, prescription: RunningPrescriptionValue): string[] {
  const issues: string[] = [];
  if (provenance.ruleSet.version !== prescription.ruleSet.version) {
    issues.push("provenance.ruleSet.version が処方の ruleSet.version と一致しません");
  }
  if (provenance.ruleSet.contentHash !== prescription.ruleSet.contentHash) {
    issues.push("provenance.ruleSet.contentHash が処方の ruleSet.contentHash と一致しません");
  }
  if (provenance.ruleSet.status !== prescription.ruleSet.status) {
    issues.push("provenance.ruleSet.status が処方の ruleSet.status と一致しません");
  }
  const c = provenance.confidence;
  const pc = prescription.confidence;
  if (c.prescription !== pc.prescription || c.directness !== pc.directness || c.inputData !== pc.inputData) {
    issues.push("provenance.confidence が処方の confidence と一致しません");
  }
  const expected = collectPrescriptionEvidenceIds(prescription);
  const actual = [...provenance.evidenceIds].sort();
  if (expected.length !== actual.length || expected.some((id, i) => id !== actual[i])) {
    issues.push("provenance.evidenceIds が処方で参照している evidenceIds と一致しません");
  }
  return issues;
}
