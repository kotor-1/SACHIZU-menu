/** Offline annotations only. Never imported by production or used to repair live output. */
import { createHash } from "node:crypto";
import migrations from "../tests/fixtures/running-intent-v2-safety-contract-migrations.json";
import { runningSemanticIntentV2Schema, semanticReviewV2Schema } from "../src/application/running-menu/semantic-intent-v2";

export function prepareRecordedSafetyReplay(record: { id: string; primary: unknown; semanticReview: unknown }) {
  const migration = migrations.migrations.find(m => m.id === record.id);
  if (!migration) return { primary: record.primary, semanticReview: record.semanticReview, contractMigration: null };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  if (digest(record.primary) !== migration.primarySHA256 || digest(record.semanticReview) !== migration.reviewSHA256) {
    throw new Error("Offline contract migration source changed; no automatic repair or network fallback");
  }
  const primary = runningSemanticIntentV2Schema.parse(record.primary);
  const review = semanticReviewV2Schema.parse(record.semanticReview);
  return {
    primary: { ...primary, claims: primary.claims.map((claim, index) => index === migration.claimIndex
      ? { ...claim, safetyConcernEvidence: migration.safetyConcernEvidence } : claim) },
    semanticReview: { ...review, safetyAssessments: [migration.safetyAssessment] },
    contractMigration: { id: migration.id, measurementKind: migrations.measurementKind },
  };
}
