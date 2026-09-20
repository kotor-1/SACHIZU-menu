import type { FindingSeverity } from "@/domain/running/types/findings";

export const MENU_PLANNER_PREVIEW_SCHEMA_VERSION = 1 as const;
export const MENU_PLANNER_ENGINE_ID = "R12_A2_DETERMINISTIC_PREVIEW" as const;
export const RUNNING_PLANNER_ENGINE_ID = "RUNNING_PRESCRIPTION_ENGINE_V2" as const;
export const LEGACY_PLANNER_ENGINE_ID = "LEGACY_PRESCRIPTION_ENGINE_V1" as const;

/** Preview の item state は client/UI ではなく application result の契約として固定する。 */
export const MENU_PLANNER_PREVIEW_ITEM_STATES = [
  "READY",
  "MANUAL_INPUT_REQUIRED",
  "REJECTED",
] as const;
export type MenuPlannerPreviewItemState = (typeof MENU_PLANNER_PREVIEW_ITEM_STATES)[number];

/**
 * MenuPlanner binding に含める server context の最小 read model。
 * 値を object の insertion order に依存させず、canonicalizer が field order を決める。
 */
export type MenuPlannerContextBindingInput = {
  contract: {
    previewSchemaVersion: number;
    policyId: string;
    engineId: string;
    runningEngineId: string;
    legacyEngineId: string;
  };
  sourceMenu: {
    id: string;
    ownerId: string;
    status: string;
    phase: string | null;
    estimatedMinutes: number | null;
    runningContext: unknown;
    blocks: readonly {
      id: string;
      name: string;
      sortOrder: number;
      items: readonly {
        id: string;
        sortOrder: number;
        exerciseId: string | null;
        displayName: string | null;
        note: string | null;
        prescriptionKind: string;
        sets: number | null;
        reps: number | null;
        distanceMeters: number | null;
        durationSeconds: number | null;
        restSeconds: number | null;
        intensityPercent: number | null;
        loadKg: number | null;
        runningMethod: string | null;
        sessionTemplateId: string | null;
        ruleSetVersion: string | null;
        ruleSetContentHash: string | null;
        prescriptionJson: string | null;
      }[];
    }[];
  };
  exerciseCatalog: readonly {
    id: string;
    ownerId: string;
    status: string;
    name: string;
    category: string;
    metricType: string;
    difficulty: number;
    energySystem: string | null;
    defaultSets: number | null;
    defaultReps: number | null;
    defaultDistanceMeters: number | null;
    defaultDurationSeconds: number | null;
    defaultRestSeconds: number | null;
    targets: readonly string[];
    purposes: readonly string[];
    events: readonly string[];
    equipmentTagIds: readonly string[];
  }[];
  ruleSet: { version: string; contentHash: string; status: string };
  subjectContext: unknown;
  competitionContext: readonly unknown[];
  historyContext: unknown;
  planning: { planningDate: string; plannedAt: string | null };
  explicitConstraints: unknown;
};

/** ephemeral key（previewId / itemKey / blockKey）を持たない digest input。 */
export type MenuPlannerMaterializationDigestInput = {
  contract: {
    previewSchemaVersion: number;
    engineId: string;
    statusOnSave: "DRAFT";
    ruleSet: { version: string; contentHash: string; status: string };
  };
  blocks: readonly {
    name: string;
    items: readonly {
      selection: unknown;
      title: string;
      state: MenuPlannerPreviewItemState;
      deterministicPrescription: unknown;
      legacySetRestSeconds: number | null;
      provenance: unknown;
      aiReason: string | null;
      engineRationale: readonly string[];
      findings: readonly unknown[];
      warnings: readonly string[];
      /**
       * engine が返した INELIGIBLE の意味（生の EligibilityReason）。表示文言は RuleSet から決まるため
       * digest には code / ruleId / overrideAllowed だけを入れ、日本語ラベルは拘束しない。
       */
      eligibilityReasons: readonly {
        code: string;
        ruleId: string | null;
        overrideAllowed: boolean | null;
      }[];
      /** engine が返した substitute 候補（informational）。表示ラベルではなく選択の同一性だけを拘束する。 */
      substitutes: readonly { method: string; templateId: string }[];
      /** BLOCKED + confirmationRequired のときだけ入る engine の確認要求 code。 */
      confirmationRequiredCodes: readonly string[];
    }[];
  }[];
  aggregation: unknown;
  estimatedTime: unknown;
  acceptance: { canSave: boolean; blockingFindingCodes: readonly string[] };
};

/**
 * Recursive canonical JSON serializer.
 * - object key は lexical order
 * - array order は caller が意味のある順序として確定したものを保持
 * - null は保持し、undefined は object では omitted、array では JSON の null 相当
 * - Date は ISO 文字列へ正規化
 */
export function canonicalStringify(value: unknown): string {
  const active = new Set<object>();

  function encode(current: unknown): string {
    if (current === null) return "null";
    if (typeof current === "string") return JSON.stringify(current);
    if (typeof current === "boolean") return current ? "true" : "false";
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("Canonical value must be finite");
      return JSON.stringify(current);
    }
    if (typeof current === "bigint") return JSON.stringify(`${current.toString()}n`);
    if (current instanceof Date) return JSON.stringify(current.toISOString());
    if (typeof current !== "object") throw new Error("Canonical value must be JSON-compatible");

    if (active.has(current)) throw new Error("Canonical value cannot contain cycles");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${current.map((entry) => (entry === undefined ? "null" : encode(entry))).join(",")}]`;
      }
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
    } finally {
      active.delete(current);
    }
  }

  return encode(value);
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

/**
 * Context binding の field と semantic array order を明示する。
 * proposal order はここに含めないため、proposal の reorder は materialization digest だけを変える。
 */
export function canonicalizeMenuPlannerContextPayload(input: MenuPlannerContextBindingInput): unknown {
  return {
    contract: {
      previewSchemaVersion: input.contract.previewSchemaVersion,
      policyId: input.contract.policyId,
      engineId: input.contract.engineId,
      runningEngineId: input.contract.runningEngineId,
      legacyEngineId: input.contract.legacyEngineId,
    },
    sourceMenu: {
      id: input.sourceMenu.id,
      ownerId: input.sourceMenu.ownerId,
      status: input.sourceMenu.status,
      phase: input.sourceMenu.phase,
      estimatedMinutes: input.sourceMenu.estimatedMinutes,
      runningContext: input.sourceMenu.runningContext,
      blocks: [...input.sourceMenu.blocks]
        .slice()
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
        .map((block) => ({
          id: block.id,
          name: block.name,
          sortOrder: block.sortOrder,
          items: [...block.items]
            .slice()
            .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
            .map((item) => ({
              id: item.id,
              sortOrder: item.sortOrder,
              exerciseId: item.exerciseId,
              displayName: item.displayName,
              note: item.note,
              prescriptionKind: item.prescriptionKind,
              sets: item.sets,
              reps: item.reps,
              distanceMeters: item.distanceMeters,
              durationSeconds: item.durationSeconds,
              restSeconds: item.restSeconds,
              intensityPercent: item.intensityPercent,
              loadKg: item.loadKg,
              runningMethod: item.runningMethod,
              sessionTemplateId: item.sessionTemplateId,
              ruleSetVersion: item.ruleSetVersion,
              ruleSetContentHash: item.ruleSetContentHash,
              prescriptionJson: item.prescriptionJson,
            })),
        })),
    },
    exerciseCatalog: [...input.exerciseCatalog]
      .slice()
      .sort(compareById)
      .map((exercise) => ({
        id: exercise.id,
        ownerId: exercise.ownerId,
        status: exercise.status,
        name: exercise.name,
        category: exercise.category,
        metricType: exercise.metricType,
        difficulty: exercise.difficulty,
        energySystem: exercise.energySystem,
        defaults: {
          sets: exercise.defaultSets,
          reps: exercise.defaultReps,
          distanceMeters: exercise.defaultDistanceMeters,
          durationSeconds: exercise.defaultDurationSeconds,
          restSeconds: exercise.defaultRestSeconds,
        },
        targets: [...exercise.targets].slice().sort(),
        purposes: [...exercise.purposes].slice().sort(),
        events: [...exercise.events].slice().sort(),
        equipmentTagIds: [...exercise.equipmentTagIds].slice().sort(),
      })),
    ruleSet: {
      version: input.ruleSet.version,
      contentHash: input.ruleSet.contentHash,
      status: input.ruleSet.status,
    },
    subjectContext: input.subjectContext,
    competitionContext: input.competitionContext,
    historyContext: input.historyContext,
    planning: {
      planningDate: input.planning.planningDate,
      plannedAt: input.planning.plannedAt,
    },
    explicitConstraints: input.explicitConstraints,
  };
}

/** Digest payload は display key と時刻を意図的に含めない。 */
export function canonicalizeMenuPlannerMaterializationPayload(
  input: MenuPlannerMaterializationDigestInput,
): unknown {
  return {
    contract: {
      previewSchemaVersion: input.contract.previewSchemaVersion,
      engineId: input.contract.engineId,
      statusOnSave: input.contract.statusOnSave,
      ruleSet: {
        version: input.contract.ruleSet.version,
        contentHash: input.contract.ruleSet.contentHash,
        status: input.contract.ruleSet.status,
      },
    },
    blocks: input.blocks.map((block) => ({
      name: block.name,
      items: block.items.map((item) => ({
        selection: item.selection,
        title: item.title,
        state: item.state,
        deterministicPrescription: item.deterministicPrescription,
        legacySetRestSeconds: item.legacySetRestSeconds,
        provenance: item.provenance,
        aiReason: item.aiReason,
        engineRationale: [...item.engineRationale],
        findings: [...item.findings],
        warnings: [...item.warnings],
        eligibilityReasons: item.eligibilityReasons.map((reason) => ({
          code: reason.code,
          ruleId: reason.ruleId,
          overrideAllowed: reason.overrideAllowed,
        })),
        substitutes: item.substitutes.map((substitute) => ({
          method: substitute.method,
          templateId: substitute.templateId,
        })),
        confirmationRequiredCodes: [...item.confirmationRequiredCodes],
      })),
    })),
    aggregation: input.aggregation,
    estimatedTime: input.estimatedTime,
    acceptance: {
      canSave: input.acceptance.canSave,
      blockingFindingCodes: [...input.acceptance.blockingFindingCodes],
    },
  };
}

export type MenuPlannerAcceptanceInput = {
  itemStates: readonly MenuPlannerPreviewItemState[];
  findings: readonly { code: string; severity: FindingSeverity }[];
};

export type MenuPlannerAcceptanceResult = {
  canSave: boolean;
  blockingFindingCodes: string[];
};

/** AI accept では Coach confirmation / override を暗黙に使わない。 */
export function evaluateMenuPlannerPreviewAcceptance(
  input: MenuPlannerAcceptanceInput,
): MenuPlannerAcceptanceResult {
  const blockedCodes = new Set<string>();
  for (const finding of input.findings) {
    if (
      finding.severity === "BLOCK" ||
      finding.severity === "BLOCK_AUTOGEN" ||
      finding.severity === "REQUIRE_CONFIRMATION"
    ) {
      blockedCodes.add(finding.code);
    }
  }
  return {
    canSave:
      input.itemStates.every((state) => state === "READY") &&
      blockedCodes.size === 0,
    blockingFindingCodes: [...blockedCodes].sort(),
  };
}
