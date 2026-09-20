import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  type MenuPlannerContextBindingInput,
  type MenuPlannerMaterializationDigestInput,
  evaluateMenuPlannerPreviewAcceptance,
} from "@/domain/menu-planner/preview";
import {
  buildMenuPlannerContextFingerprint,
  buildMenuPlannerMaterializationDigest,
} from "@/application/menu-planner/binding";

function contextBinding(): MenuPlannerContextBindingInput {
  return {
    contract: {
      previewSchemaVersion: 1,
      policyId: "R12_MENU_INTENT_V1",
      engineId: "R12_A2_DETERMINISTIC_PREVIEW",
      runningEngineId: "RUNNING_PRESCRIPTION_ENGINE_V2",
      legacyEngineId: "LEGACY_PRESCRIPTION_ENGINE_V1",
    },
    sourceMenu: {
      id: "menu-1",
      ownerId: "default-coach",
      status: "DRAFT",
      phase: "PREPARATION",
      estimatedMinutes: 60,
      runningContext: { plannedDate: "2026-09-20", plannedAt: null },
      blocks: [],
    },
    exerciseCatalog: [
      {
        id: "exercise-1",
        ownerId: "default-coach",
        status: "REVIEWED",
        name: "ドリル",
        category: "DRILL",
        metricType: "DISTANCE",
        difficulty: 3,
        energySystem: null,
        defaultSets: 3,
        defaultReps: null,
        defaultDistanceMeters: 30,
        defaultDurationSeconds: null,
        defaultRestSeconds: null,
        targets: ["TECHNIQUE"],
        purposes: [],
        events: [],
        equipmentTagIds: [],
      },
    ],
    ruleSet: { version: "rs-2026.09.0", contentHash: "rules-a", status: "DRAFT" },
    subjectContext: { tier: "DEVELOPMENTAL", ageBand: "U18", primaryEvent: "400m" },
    competitionContext: [{ id: "competition-1", date: "2026-10-01" }],
    historyContext: { events: [], unresolved: [] },
    planning: { planningDate: "2026-09-20", plannedAt: null },
    explicitConstraints: { preferredExerciseIds: [], excludedExerciseIds: [] },
  };
}

function materializationDigest(): MenuPlannerMaterializationDigestInput {
  return {
    contract: {
      previewSchemaVersion: 1,
      engineId: "R12_A2_DETERMINISTIC_PREVIEW",
      statusOnSave: "DRAFT",
      ruleSet: { version: "rs-2026.09.0", contentHash: "rules-a", status: "DRAFT" },
    },
    blocks: [
      {
        name: "主運動",
        items: [
          {
            selection: { kind: "EXERCISE", exerciseId: "exercise-1" },
            title: "ドリル",
            state: "READY",
            deterministicPrescription: { sets: 3, distanceMeters: 30 },
            legacySetRestSeconds: 60,
            provenance: { engine: "LEGACY_PRESCRIPTION_ENGINE_V1" },
            aiReason: "姿勢を整えるため",
            engineRationale: ["既定値を使用"],
            findings: [],
            warnings: [],
            eligibilityReasons: [],
            substitutes: [],
            confirmationRequiredCodes: [],
          },
          {
            selection: { kind: "EXERCISE", exerciseId: "exercise-2" },
            title: "別ドリル",
            state: "READY",
            deterministicPrescription: { sets: 2, distanceMeters: 20 },
            legacySetRestSeconds: 45,
            provenance: { engine: "LEGACY_PRESCRIPTION_ENGINE_V1" },
            aiReason: null,
            engineRationale: ["既定値を使用"],
            findings: [],
            warnings: [],
            eligibilityReasons: [],
            substitutes: [],
            confirmationRequiredCodes: [],
          },
        ],
      },
    ],
    aggregation: { totalRunningDistanceM: 0 },
    estimatedTime: { seconds: 180, quality: "ESTIMATE" },
    acceptance: { canSave: true, blockingFindingCodes: [] },
  };
}

describe("R12-A2 preview binding", () => {
  it("canonical serialization fixes object key order while preserving array order and null", () => {
    expect(canonicalStringify({ b: 2, a: { d: null, c: 1 } })).toBe(
      canonicalStringify({ a: { c: 1, d: null }, b: 2 }),
    );
    expect(canonicalStringify({ values: ["first", "second"] })).not.toBe(
      canonicalStringify({ values: ["second", "first"] }),
    );
    expect(canonicalStringify({ value: null })).not.toBe(canonicalStringify({}));
  });

  it("same authoritative context produces the exact same fingerprint", () => {
    const first = contextBinding();
    const second = { ...first, sourceMenu: { ...first.sourceMenu, runningContext: { plannedAt: null, plannedDate: "2026-09-20" } } };
    expect(buildMenuPlannerContextFingerprint(first)).toBe(buildMenuPlannerContextFingerprint(second));
  });

  it.each([
    ["RuleSet hash", (input: MenuPlannerContextBindingInput) => ({ ...input, ruleSet: { ...input.ruleSet, contentHash: "rules-b" } })],
    ["Exercise default", (input: MenuPlannerContextBindingInput) => ({
      ...input,
      exerciseCatalog: [{ ...input.exerciseCatalog[0]!, defaultDistanceMeters: 40 }],
    })],
    ["catalog status", (input: MenuPlannerContextBindingInput) => ({
      ...input,
      exerciseCatalog: [{ ...input.exerciseCatalog[0]!, status: "ARCHIVED" }],
    })],
    ["history", (input: MenuPlannerContextBindingInput) => ({
      ...input,
      historyContext: { events: [{ at: "2026-09-19T10:00:00.000Z" }] },
    })],
    ["competition", (input: MenuPlannerContextBindingInput) => ({
      ...input,
      competitionContext: [{ id: "competition-2", date: "2026-10-02" }],
    })],
    ["subject", (input: MenuPlannerContextBindingInput) => ({
      ...input,
      subjectContext: { tier: "ADVANCED", ageBand: "U18", primaryEvent: "100m" },
    })],
  ] as const)("changes fingerprint when %s changes", (_label, change) => {
    const original = contextBinding();
    expect(buildMenuPlannerContextFingerprint(original)).not.toBe(
      buildMenuPlannerContextFingerprint(change(original)),
    );
  });

  it("proposal materialization order changes the digest", () => {
    const original = materializationDigest();
    const reordered = {
      ...original,
      blocks: [{ ...original.blocks[0]!, items: [...original.blocks[0]!.items].reverse() }],
    };
    expect(buildMenuPlannerMaterializationDigest(original)).toBe(buildMenuPlannerMaterializationDigest(original));
    expect(buildMenuPlannerMaterializationDigest(original)).not.toBe(
      buildMenuPlannerMaterializationDigest(reordered),
    );
  });

  it("acceptance rejects manual, rejected, and blocking findings", () => {
    expect(evaluateMenuPlannerPreviewAcceptance({ itemStates: ["READY"], findings: [] })).toEqual({
      canSave: true,
      blockingFindingCodes: [],
    });
    expect(evaluateMenuPlannerPreviewAcceptance({
      itemStates: ["MANUAL_INPUT_REQUIRED"],
      findings: [],
    }).canSave).toBe(false);
    expect(evaluateMenuPlannerPreviewAcceptance({
      itemStates: ["READY"],
      findings: [{ code: "BLOCK_AUTOGEN", severity: "BLOCK_AUTOGEN" }],
    })).toEqual({ canSave: false, blockingFindingCodes: ["BLOCK_AUTOGEN"] });
  });
});
