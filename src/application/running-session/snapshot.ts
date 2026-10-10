import { z } from "zod";
import { canonicalStringify, sha256Utf8Hex } from "@/domain/shared/canonical-json";
import {
  parseRunningMenuEnvelope,
  finalRunningMenuPrescription,
  coachEditRecordSchema,
  runningMenuFinalPrescriptionSchema,
  runningMenuPrescriptionSchema,
  RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION,
  RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION,
  RUNNING_MENU_PRESCRIPTION_KIND,
} from "@/application/running-menu/persistence";

export const RUNNING_SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RUNNING_SESSION_COACH_EDIT_SCHEMA_VERSION = 2 as const;
export const RUNNING_SESSION_SNAPSHOT_KIND = "RUNNING_POLICY_SNAPSHOT" as const;

// Historical identities belong to the snapshot reader. Never compare an old
// saved Menu with the currently active prescription engine.
const supportedPolicyHashes: Readonly<Record<string, string>> = {
  "rp-2026.09.0": "b522cdccba0fa65c5639eb823ccd313439700fb65ce00f8192edca51699b535f",
  "rp-science-2026.10.0": "c5068433ea03572aee26ddaa981060f8a97703dc30800278cc559e3fe6a530ff",
};

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const savedPreviewProvenanceSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("SIGNED_RUNNING_PREVIEW"),
  requestDigest: digestSchema,
  intent: z.object({}).passthrough(),
  context: z.object({}).passthrough(),
}).strict();
const snapshotBodySchema = z.object({
  kind: z.literal(RUNNING_SESSION_SNAPSHOT_KIND),
  snapshotSchemaVersion: z.literal(RUNNING_SESSION_SNAPSHOT_SCHEMA_VERSION),
  sourcePersistenceSchemaVersion: z.literal(RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION),
  sourceMenuItemId: z.string().min(1),
  sourceMenuItemDigest: digestSchema,
  policyVersion: z.string().min(1),
  policyHash: digestSchema,
  prescription: runningMenuPrescriptionSchema,
}).strict();
const snapshotSchema = snapshotBodySchema.extend({ snapshotDigest: digestSchema }).strict();
const coachEditSnapshotBodySchema = z.object({
  kind: z.literal(RUNNING_SESSION_SNAPSHOT_KIND),
  snapshotSchemaVersion: z.literal(RUNNING_SESSION_COACH_EDIT_SCHEMA_VERSION),
  sourcePersistenceSchemaVersion: z.literal(RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION),
  sourceMenuItemId: z.string().min(1),
  sourceMenuItemDigest: digestSchema,
  policyVersion: z.string().min(1),
  policyHash: digestSchema,
  prescription: runningMenuFinalPrescriptionSchema,
  origin: z.literal("COACH_EDITED"),
  coachEditProvenance: z.object({ edited: z.literal(true), edits: z.array(coachEditRecordSchema).min(1).max(100) }).strict(),
}).strict();
const coachEditSnapshotSchema = coachEditSnapshotBodySchema.extend({ snapshotDigest: digestSchema }).strict();
export type RunningSessionSnapshot = z.infer<typeof snapshotSchema> | z.infer<typeof coachEditSnapshotSchema>;

export class RunningSessionSnapshotError extends Error {
  constructor(readonly code: "INVALID_MENU_ITEM" | "UNSUPPORTED_POLICY" | "STALE_MENU_FOR_SESSION") {
    super(code);
    this.name = "RunningSessionSnapshotError";
  }
}

export type RunningMenuSourceItem = {
  id: string;
  prescriptionKind: string;
  prescriptionJson: string | null;
  provenanceJson: string | null;
  exerciseId: string | null;
  runningMethod: string | null;
  sessionTemplateId: string | null;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
  distanceMeters: number | null;
  reps: number | null;
  sets: number | null;
  restSeconds: number | null;
  setRestSeconds: number | null;
  durationSeconds: number | null;
  intensityPercent: number | null;
  loadKg: number | null;
  recoveryStructure: string | null;
  buildUpDistanceMeters: number | null;
  flyZoneDistanceMeters: number | null;
  intraRepRestSeconds: number | null;
  intensityReferenceKind: string | null;
  prescriptionConfidence: string | null;
  rationale: string | null;
};

/** Binds the form to the complete saved source, including non-running items. */
export function runningSessionSourceFingerprint(menu: {
  id: string;
  name: string;
  updatedAt: Date;
  blocks: readonly {
    id: string;
    name: string;
    note: string | null;
    sortOrder: number;
    items: readonly (Record<string, unknown> & {
      exercise: { name: string; category: string } | null;
    })[];
  }[];
}): string {
  return sha256Utf8Hex(canonicalStringify({
    id: menu.id,
    name: menu.name,
    updatedAt: menu.updatedAt,
    blocks: menu.blocks.map((block) => ({
      id: block.id, name: block.name, note: block.note, sortOrder: block.sortOrder,
      items: block.items.map((item) => ({
        ...item,
        exercise: item.exercise === null ? null : { name: item.exercise.name, category: item.exercise.category },
      })),
    })),
  }));
}

/** Validate saved bytes and projections; no current Engine or old taxonomy. */
export function snapshotSavedRunningMenuItem(item: RunningMenuSourceItem): RunningSessionSnapshot {
  const envelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson);
  if (envelope === null || item.prescriptionKind !== RUNNING_MENU_PRESCRIPTION_KIND) throw new RunningSessionSnapshotError("INVALID_MENU_ITEM");
  try {
    if (item.provenanceJson === null || !savedPreviewProvenanceSchema.safeParse(JSON.parse(item.provenanceJson)).success) {
      throw new RunningSessionSnapshotError("INVALID_MENU_ITEM");
    }
  } catch {
    throw new RunningSessionSnapshotError("INVALID_MENU_ITEM");
  }
  if (supportedPolicyHashes[envelope.policyVersion] !== envelope.policyHash) throw new RunningSessionSnapshotError("UNSUPPORTED_POLICY");
  const p = finalRunningMenuPrescription(envelope);
  if (item.exerciseId !== null || item.runningMethod !== null || item.sessionTemplateId !== null ||
      item.ruleSetVersion !== null || item.ruleSetContentHash !== null ||
      item.distanceMeters !== p.distanceMeters || item.reps !== p.totalReps ||
      item.sets !== p.sets || item.restSeconds !== p.repRestSeconds ||
      item.setRestSeconds !== p.setRestSeconds || item.durationSeconds !== null ||
      item.intensityPercent !== null || item.loadKg !== null ||
      item.recoveryStructure !== null || item.buildUpDistanceMeters !== null ||
      item.flyZoneDistanceMeters !== null || item.intraRepRestSeconds !== null ||
      item.intensityReferenceKind !== null || item.prescriptionConfidence !== null ||
      item.rationale !== null) throw new RunningSessionSnapshotError("INVALID_MENU_ITEM");
  const common = {
    kind: RUNNING_SESSION_SNAPSHOT_KIND,
    sourceMenuItemId: item.id,
    sourceMenuItemDigest: sha256Utf8Hex(canonicalStringify({
      id: item.id, prescriptionJson: item.prescriptionJson, provenanceJson: item.provenanceJson,
      distanceMeters: item.distanceMeters, reps: item.reps, sets: item.sets,
      restSeconds: item.restSeconds, setRestSeconds: item.setRestSeconds,
    })),
    policyVersion: envelope.policyVersion,
    policyHash: envelope.policyHash,
  };
  if (envelope.schemaVersion === 2) {
    const body = coachEditSnapshotBodySchema.parse({
      ...common,
      snapshotSchemaVersion: RUNNING_SESSION_COACH_EDIT_SCHEMA_VERSION,
      sourcePersistenceSchemaVersion: RUNNING_MENU_COACH_EDIT_SCHEMA_VERSION,
      prescription: p,
      origin: "COACH_EDITED",
      coachEditProvenance: envelope.coachEditProvenance,
    });
    return coachEditSnapshotSchema.parse({ ...body, snapshotDigest: sha256Utf8Hex(canonicalStringify(body)) });
  }
  const body = snapshotBodySchema.parse({
    ...common,
    snapshotSchemaVersion: RUNNING_SESSION_SNAPSHOT_SCHEMA_VERSION,
    sourcePersistenceSchemaVersion: RUNNING_MENU_PERSISTENCE_SCHEMA_VERSION,
    prescription: envelope.prescription,
  });
  return snapshotSchema.parse({ ...body, snapshotDigest: sha256Utf8Hex(canonicalStringify(body)) });
}

export function serializeRunningSessionSnapshot(snapshot: RunningSessionSnapshot): string {
  return canonicalStringify(snapshot.snapshotSchemaVersion === 2
    ? coachEditSnapshotSchema.parse(snapshot) : snapshotSchema.parse(snapshot));
}

export function parseRunningSessionSnapshot(kind: string, raw: string | null): RunningSessionSnapshot | null {
  if (kind !== RUNNING_MENU_PRESCRIPTION_KIND || raw === null || raw.length > 32_768) return null;
  try {
    const unknown: unknown = JSON.parse(raw);
    const v1 = snapshotSchema.safeParse(unknown);
    const v2 = coachEditSnapshotSchema.safeParse(unknown);
    if (!v1.success && !v2.success) return null;
    const result = v1.success ? v1.data : v2.success ? v2.data : null;
    if (result === null) return null;
    const { snapshotDigest, ...body } = result;
    if (sha256Utf8Hex(canonicalStringify(body)) !== snapshotDigest) return null;
    if (supportedPolicyHashes[result.policyVersion] !== result.policyHash) return null;
    if (result.policyVersion !== result.prescription.policyVersion || result.policyHash !== result.prescription.policyHash) return null;
    return result;
  } catch {
    return null;
  }
}

export function presentRunningSessionSnapshot(kind: string, raw: string | null):
  | { status: "NOT_RUNNING_POLICY" }
  | { status: "UNREADABLE" }
  | { status: "OK"; title: string; restText: string | null; instruction: string | null; coachEdited: boolean; targetTimeText: string | null; setText: string | null;
      science: RunningSessionSnapshot["prescription"]["science"] | null; scienceManualEdited: boolean } {
  if (kind !== RUNNING_MENU_PRESCRIPTION_KIND) return { status: "NOT_RUNNING_POLICY" };
  const snapshot = parseRunningSessionSnapshot(kind, raw);
  if (snapshot === null) return { status: "UNREADABLE" };
  const p = snapshot.prescription;
  return {
    status: "OK",
    title: `${p.distanceMeters}m × ${p.totalReps}本`,
    restText: p.repRestSeconds === null ? null : `1本ごとの休憩 ${p.repRestSeconds / 60}分`,
    instruction: p.executionInstructionText,
    coachEdited: snapshot.snapshotSchemaVersion === 2,
    science: p.science ?? null,
    scienceManualEdited: "scienceManualEdited" in p ? p.scienceManualEdited ?? false : false,
    targetTimeText: p.coachTargetTimeRange !== null
      ? `目標タイム ${p.coachTargetTimeRange.minSeconds}〜${p.coachTargetTimeRange.maxSeconds}秒`
      : p.coachTargetTimeSeconds !== null ? `目標タイム ${p.coachTargetTimeSeconds}秒` : null,
    setText: p.setReps === null ? null : `${p.setReps.join("本 + ")}本／セット間休憩 ${p.setRestSeconds! / 60}分`,
  };
}
