/**
 * R12-A3B — MenuPlanner の fresh materialization を MenuTemplate / MenuBlock / MenuItem へ保存する。
 *
 * ここは transaction client だけを受け取り、plan / token / provider を知らない。
 * 入力は domain の明示的な draft allow-list であり、Prisma data の spread は行わない。
 */
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { menuItemInputSchema } from "@/domain/menu/schema";
import { buildRunningMenuItemRecord } from "@/domain/running/persistence/runningItem";
import { provenanceSchema } from "@/domain/running/persistence/provenance";
import { renderRationaleJa } from "@/domain/running/rationale/render-ja";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import type { MenuPlannerDraftItem, MenuPlannerDraftMaterialization } from "@/domain/menu-planner/draft";
import { canonicalStringify } from "@/domain/menu-planner/preview";
import { prisma, type PrismaDbClient } from "@/infra/db/prisma";

export type MenuPlannerDraftSaveInput = MenuPlannerDraftMaterialization & {
  ownerId: string;
  targetMenuId: string;
};

export type MenuPlannerDraftTarget = {
  ownerId: string;
  status: string;
};

const draftHierarchyInclude = {
  blocks: {
    orderBy: { sortOrder: "asc" as const },
    include: {
      items: { orderBy: { sortOrder: "asc" as const } },
    },
  },
} as const;

export type MenuPlannerDraftTargetHierarchy = Prisma.MenuTemplateGetPayload<{
  include: typeof draftHierarchyInclude;
}>;

export async function findMenuPlannerDraftTarget(
  targetMenuId: string,
  db: PrismaDbClient = prisma,
): Promise<MenuPlannerDraftTarget | null> {
  return db.menuTemplate.findUnique({
    where: { id: targetMenuId },
    select: { ownerId: true, status: true },
  });
}

export async function findMenuPlannerDraftTargetHierarchy(
  targetMenuId: string,
  db: PrismaDbClient = prisma,
): Promise<MenuPlannerDraftTargetHierarchy | null> {
  return db.menuTemplate.findUnique({
    where: { id: targetMenuId },
    include: draftHierarchyInclude,
  });
}

function legacyItemData(item: MenuPlannerDraftItem, menuBlockId: string, sortOrder: number) {
  if (item.legacyPrescription === null || item.selection.kind !== "EXERCISE") {
    throw new Error("LEGACY_DRAFT_ITEM_INVALID");
  }
  const parsed = menuItemInputSchema.parse({
    exerciseId: item.selection.exerciseId,
    displayName: item.title,
    sets: item.legacyPrescription.sets,
    reps: item.legacyPrescription.reps,
    distanceMeters: item.legacyPrescription.distanceMeters,
    durationSeconds: item.legacyPrescription.durationSeconds,
    restSeconds: item.legacyPrescription.restSeconds,
    intensityPercent: item.legacyPrescription.intensityPercent,
    loadKg: item.legacyPrescription.loadKg,
    note: null,
  });
  return {
    menuBlockId,
    exerciseId: parsed.exerciseId,
    displayName: parsed.displayName,
    sortOrder,
    sets: parsed.sets,
    reps: parsed.reps,
    distanceMeters: parsed.distanceMeters,
    durationSeconds: parsed.durationSeconds,
    restSeconds: parsed.restSeconds,
    intensityPercent: parsed.intensityPercent,
    loadKg: parsed.loadKg,
    note: parsed.note,
    prescriptionKind: "LEGACY",
    runningMethod: null,
    sessionTemplateId: null,
    recoveryStructure: null,
    buildUpDistanceMeters: null,
    flyZoneDistanceMeters: null,
    setRestSeconds: null,
    intraRepRestSeconds: null,
    intensityReferenceKind: null,
    prescriptionConfidence: null,
    ruleSetVersion: null,
    ruleSetContentHash: null,
    prescriptionJson: null,
    provenanceJson: null,
    rationale: null,
  } as const;
}

function runningItemData(item: MenuPlannerDraftItem, menuBlockId: string, sortOrder: number) {
  if (item.runningPrescription === null || item.runningProvenance === null || item.selection.kind !== "RUNNING") {
    throw new Error("RUNNING_DRAFT_ITEM_INVALID");
  }
  const provenance = provenanceSchema.parse(item.runningProvenance);
  const built = buildRunningMenuItemRecord({
    prescriptionJson: JSON.stringify(item.runningPrescription),
    provenanceJson: JSON.stringify(provenance),
    rationale: renderRationaleJa(item.runningPrescription.rationale).join("\n"),
    note: null,
  });
  return {
    menuBlockId,
    exerciseId: built.record.exerciseId,
    displayName: built.record.displayName,
    sortOrder,
    sets: built.record.sets,
    reps: built.record.reps,
    distanceMeters: built.record.distanceMeters,
    durationSeconds: built.record.durationSeconds,
    restSeconds: built.record.restSeconds,
    intensityPercent: built.record.intensityPercent,
    loadKg: built.record.loadKg,
    note: built.record.note,
    prescriptionKind: built.record.prescriptionKind,
    runningMethod: built.record.runningMethod,
    sessionTemplateId: built.record.sessionTemplateId,
    recoveryStructure: built.record.recoveryStructure,
    buildUpDistanceMeters: built.record.buildUpDistanceMeters,
    flyZoneDistanceMeters: built.record.flyZoneDistanceMeters,
    setRestSeconds: built.record.setRestSeconds,
    intraRepRestSeconds: built.record.intraRepRestSeconds,
    intensityReferenceKind: built.record.intensityReferenceKind,
    prescriptionConfidence: built.record.prescriptionConfidence,
    ruleSetVersion: built.record.ruleSetVersion,
    ruleSetContentHash: built.record.ruleSetContentHash,
    prescriptionJson: built.record.prescriptionJson,
    provenanceJson: built.record.provenanceJson,
    rationale: built.record.rationale,
  };
}

function itemData(item: MenuPlannerDraftItem, menuBlockId: string, sortOrder: number) {
  if (item.runningPrescription !== null) return runningItemData(item, menuBlockId, sortOrder);
  return legacyItemData(item, menuBlockId, sortOrder);
}

type SavedDraftItemIdentity = {
  exerciseId: string | null;
  displayName: string | null;
  sortOrder: number;
  sets: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  restSeconds: number | null;
  intensityPercent: number | null;
  loadKg: number | null;
  note: string | null;
  prescriptionKind: string;
  runningMethod: string | null;
  sessionTemplateId: string | null;
  recoveryStructure: string | null;
  buildUpDistanceMeters: number | null;
  flyZoneDistanceMeters: number | null;
  setRestSeconds: number | null;
  intraRepRestSeconds: number | null;
  intensityReferenceKind: string | null;
  prescriptionConfidence: string | null;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
  prescriptionJson: string | null;
  provenanceJson: string | null;
  rationale: string | null;
};

export type MenuPlannerDraftIdentity = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  purpose: string | null;
  phase: string | null;
  estimatedMinutes: number | null;
  runningContextJson: string | null;
  status: "DRAFT";
  blocks: Array<{
    name: string;
    note: string | null;
    sortOrder: number;
    items: SavedDraftItemIdentity[];
  }>;
};

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

function withoutAcceptedByCoachAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAcceptedByCoachAt);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "acceptedByCoachAt")
        .map(([key, entry]) => [key, withoutAcceptedByCoachAt(entry)]),
    );
  }
  return value;
}

/** Stored JSON is compared structurally, while save-time acceptance timestamps are dynamic. */
function normalizedStoredJson(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return canonicalStringify(withoutAcceptedByCoachAt(JSON.parse(raw)));
  } catch {
    return null;
  }
}

function normalizedRunningContextJson(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return canonicalStringify(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isValidJson(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    canonicalStringify(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}

function acceptedAtOf(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { generatedBy?: { acceptedByCoachAt?: unknown } };
    const acceptedAt = parsed.generatedBy?.acceptedByCoachAt;
    if (typeof acceptedAt !== "string" || !isoDateTimeSchema.safeParse(acceptedAt).success) return null;
    return acceptedAt;
  } catch {
    return null;
  }
}

function savedItemIdentityOf(item: {
  exerciseId: string | null;
  displayName: string | null;
  sortOrder: number;
  sets: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  restSeconds: number | null;
  intensityPercent: number | null;
  loadKg: number | null;
  note: string | null;
  prescriptionKind: string;
  runningMethod: string | null;
  sessionTemplateId: string | null;
  recoveryStructure: string | null;
  buildUpDistanceMeters: number | null;
  flyZoneDistanceMeters: number | null;
  setRestSeconds: number | null;
  intraRepRestSeconds: number | null;
  intensityReferenceKind: string | null;
  prescriptionConfidence: string | null;
  ruleSetVersion: string | null;
  ruleSetContentHash: string | null;
  prescriptionJson: string | null;
  provenanceJson: string | null;
  rationale: string | null;
}): SavedDraftItemIdentity {
  return {
    exerciseId: item.exerciseId,
    displayName: item.displayName,
    sortOrder: item.sortOrder,
    sets: item.sets,
    reps: item.reps,
    distanceMeters: item.distanceMeters,
    durationSeconds: item.durationSeconds,
    restSeconds: item.restSeconds,
    intensityPercent: item.intensityPercent,
    loadKg: item.loadKg,
    note: item.note,
    prescriptionKind: item.prescriptionKind,
    runningMethod: item.runningMethod,
    sessionTemplateId: item.sessionTemplateId,
    recoveryStructure: item.recoveryStructure,
    buildUpDistanceMeters: item.buildUpDistanceMeters,
    flyZoneDistanceMeters: item.flyZoneDistanceMeters,
    setRestSeconds: item.setRestSeconds,
    intraRepRestSeconds: item.intraRepRestSeconds,
    intensityReferenceKind: item.intensityReferenceKind,
    prescriptionConfidence: item.prescriptionConfidence,
    ruleSetVersion: item.ruleSetVersion,
    ruleSetContentHash: item.ruleSetContentHash,
    prescriptionJson: normalizedStoredJson(item.prescriptionJson),
    provenanceJson: normalizedStoredJson(item.provenanceJson),
    rationale: item.rationale,
  };
}

function savedDraftIdentityOfExisting(
  existing: MenuPlannerDraftTargetHierarchy,
): MenuPlannerDraftIdentity {
  return {
    id: existing.id,
    ownerId: existing.ownerId,
    name: existing.name,
    description: existing.description,
    purpose: existing.purpose,
    phase: existing.phase,
    estimatedMinutes: existing.estimatedMinutes,
    runningContextJson: normalizedRunningContextJson(existing.runningContextJson),
    status: existing.status as MenuPlannerDraftIdentity["status"],
    blocks: existing.blocks.map((block) => ({
      name: block.name,
      note: block.note,
      sortOrder: block.sortOrder,
      items: block.items.map(savedItemIdentityOf),
    })),
  };
}

export function menuPlannerDraftIdentityOf(
  input: MenuPlannerDraftSaveInput,
): MenuPlannerDraftIdentity {
  return {
    id: input.targetMenuId,
    ownerId: input.ownerId,
    name: input.menuName,
    description: null,
    purpose: null,
    phase: input.phase,
    estimatedMinutes: input.estimatedMinutes,
    runningContextJson: normalizedRunningContextJson(input.runningContextJson),
    status: "DRAFT",
    blocks: input.blocks.map((block, blockIndex) => ({
      name: block.name,
      note: null,
      sortOrder: blockIndex,
      items: block.items.map((item, itemIndex) => savedItemIdentityOf(itemData(item, "__identity__", itemIndex))),
    })),
  };
}

/**
 * A3B post-commit retry 用の signed identity。
 * A3A materializationDigest は preview-only の表示・集計情報も含むため、
 * DB hierarchy から同じ入力を再構築できない。ここでは保存される semantic projection
 * だけを canonicalize し、token にはその digest だけを署名する。
 */
export function buildMenuPlannerDraftIdentityDigest(
  input: MenuPlannerDraftSaveInput,
): string {
  return sha256Canonical(menuPlannerDraftIdentityOf(input));
}

function savedDraftIdentityIsValid(existing: MenuPlannerDraftTargetHierarchy): boolean {
  if (existing.status !== "DRAFT") return false;
  if (!isValidJson(existing.runningContextJson)) return false;

  for (const item of existing.blocks.flatMap((block) => block.items)) {
    if (!isValidJson(item.prescriptionJson) || !isValidJson(item.provenanceJson)) return false;
    if (item.prescriptionKind !== "RUNNING_V2") continue;
    const prescriptionAcceptedAt = acceptedAtOf(item.prescriptionJson);
    const provenanceAcceptedAt = acceptedAtOf(item.provenanceJson);
    if (
      prescriptionAcceptedAt === null ||
      provenanceAcceptedAt === null ||
      prescriptionAcceptedAt !== provenanceAcceptedAt
    ) {
      return false;
    }
  }

  return true;
}

/** Existing row を token の signed savedDraftIdentityDigest と比較するための純粋 projection。 */
export function savedMenuPlannerDraftIdentityDigest(
  existing: MenuPlannerDraftTargetHierarchy,
): string | null {
  if (!savedDraftIdentityIsValid(existing)) return null;
  return sha256Canonical(savedDraftIdentityOfExisting(existing));
}

export function isMenuPlannerDraftIdentityEquivalent(
  expected: MenuPlannerDraftIdentity,
  existing: MenuPlannerDraftTargetHierarchy,
): boolean {
  const existingIdentity = savedDraftIdentityOfExisting(existing);
  if (!savedDraftIdentityIsValid(existing)) return false;
  return canonicalStringify(expected) === canonicalStringify(existingIdentity);
}

/**
 * MenuTemplate → blocks → items を1つずつ同一transactionで作る。
 * nested createではなく明示的な順序にして、各段階のfailure rollbackを検証可能にする。
 */
export async function createMenuPlannerDraft(
  input: MenuPlannerDraftSaveInput,
  db: PrismaDbClient,
): Promise<{ menuId: string; status: "DRAFT" }> {
  const menu = await db.menuTemplate.create({
    data: {
      id: input.targetMenuId,
      ownerId: input.ownerId,
      name: input.menuName,
      description: null,
      purpose: null,
      phase: input.phase,
      estimatedMinutes: input.estimatedMinutes,
      runningContextJson: input.runningContextJson,
      status: "DRAFT",
    },
    select: { id: true, status: true },
  });

  for (const [blockIndex, blockInput] of input.blocks.entries()) {
    const block = await db.menuBlock.create({
      data: {
        menuTemplateId: menu.id,
        name: blockInput.name,
        note: null,
        sortOrder: blockIndex,
      },
      select: { id: true },
      });
    for (const [itemIndex, itemInput] of blockInput.items.entries()) {
      await db.menuItem.create({
        data: itemData(itemInput, block.id, itemIndex),
      });
    }
  }

  if (menu.status !== "DRAFT") throw new Error("DRAFT_STATUS_INVARIANT_FAILED");
  return { menuId: menu.id, status: "DRAFT" };
}

export function isTargetConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
