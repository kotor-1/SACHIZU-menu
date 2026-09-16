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
import { TRAINING_PHASES } from "../../menu/constants";
import { envelopeFieldSchema } from "../rules/schema";
import { coachOverrideTargetSchema } from "../planning/schema";
import { generationRecordSchema } from "../types/actor";
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
import { ageBandSchema, envelopeTierSchema, trainingAgeTierSchema } from "../types/subject";

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
        /** [R5 errata] 観測できない年齢帯は UNKNOWN のまま（U12 等へ偽装しない）。 */
        ageBand: z.union([ageBandSchema, z.literal("UNKNOWN")]),
        maturityEffective: z.string().min(1).max(64),
        trainingAgeTier: trainingAgeTierSchema,
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
          field: envelopeFieldSchema,
          from: z.number().finite(),
          to: z.number().finite(),
        })
        .strict(),
    ),
    overrides: z.array(
      z
        .object({
          at: isoDateTimeSchema,
          target: coachOverrideTargetSchema,
          from: z.number().finite().optional(),
          to: z.number().finite().optional(),
          reason: z.string().trim().min(1).max(1000),
        })
        .strict(),
    ),
    /** AI の説明文（数値・出典除去済み §18.3）。 */
    aiReason: z.string().max(300).nullable(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.evidenceIds).size !== p.evidenceIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidenceIds に重複があります", path: ["evidenceIds"] });
    }
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
