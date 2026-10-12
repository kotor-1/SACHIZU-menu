import { describe, expect, it } from "vitest";
import type { TrainingComposerInput } from "@/application/training-proposal/generate";
import { ruleBasedTrainingSelection } from "@/application/training-proposal/rule-based";
import type { ComposerCatalogExercise } from "@/domain/menu-composition/contracts";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import { catalogFixture } from "../fixtures/menu-composition";
import { trainingCaseA } from "../fixtures/training-proposals";

type Candidate = { row: ComposerCatalogExercise; stage: number; family?: string };
const drill = (id: string, stage: number, patch: Partial<ComposerCatalogExercise> = {}, family?: string): Candidate => ({ stage, family,
  row: catalogFixture({ id, name: id, category: "DRILL", metricType: "REPS", defaultSets: null, defaultDurationSeconds: null,
    defaultRestSeconds: null, purposes: [], ...patch }) });
function input(movement: Candidate[], requiredMovement: number, strength: Candidate[] = [], requiredStrength = 0): TrainingComposerInput {
  const all = [...movement, ...strength];
  return { conditions: trainingCaseA(), movement: movement.map(x => x.row), strength: strength.map(x => x.row),
    requiredMovement, requiredStrength, requestedMovement: requiredMovement + 2, requestedStrength: requiredStrength + 1,
    stages: Object.fromEntries(all.map(x => [x.row.id, x.stage])), families: Object.fromEntries(all.map(x => [x.row.id, x.family ?? `F:${x.row.id}`])) };
}

describe("rule-based training selection (no AI)", () => {
  it("takes movement in turn from each stage and returns it in stage order", () => {
    const rows = [drill("m0a", 0), drill("m0b", 0), drill("m0c", 0), drill("m1a", 1), drill("m2a", 2), drill("m2b", 2)];
    expect(ruleBasedTrainingSelection(input(rows, 5)).movement.map(x => x.exerciseId)).toEqual(["m0a", "m0b", "m1a", "m2a", "m2b"]);
  });
  it("within a stage prefers the primary goal's purposes, then registered values, then easier movements", () => {
    const rows = [drill("easy", 0, { difficulty: 1 }), drill("registered", 0, { defaultReps: 6, difficulty: 2 }),
      drill("posture", 0, { purposes: ["POSTURE"], difficulty: 3 }), drill("accel", 0, { purposes: ["ACCELERATION", "POWER"], difficulty: 3 })];
    expect(ruleBasedTrainingSelection(input(rows, 4)).movement.map(x => x.exerciseId)).toEqual(["accel", "posture", "registered", "easy"]);
  });
  it("keeps one candidate per family in both sections and uses the App's plain texts and doses", () => {
    const movement = [drill("a1", 0, {}, "F:a"), drill("a2", 0, {}, "F:a"), drill("b", 1)];
    const strength = [drill("s1", 0, { category: "STRENGTH" }, "F:s"), drill("s2", 0, { category: "STRENGTH" }, "F:s"), drill("t", 0, { category: "STRENGTH" })];
    const output = ruleBasedTrainingSelection(input(movement, 2, strength, 2));
    expect(output.movement.map(x => x.exerciseId)).toEqual(["a1", "b"]);
    expect(output.strength.map(x => x.exerciseId)).toEqual(["s1", "t"]);
    const { item, annotation } = suggestCatalogItem(movement[0].row, trainingCaseA(), "x");
    expect(output.movement[0]).toEqual({ exerciseId: "a1", reason: item.reason, intensity: annotation.intensity, relationship: "COMBINABLE", alternativeGroup: null });
    expect(output.explanation).toContain("AIを使わない基本提案");
  });
  it("never exceeds the required counts and returns empty sections when nothing is required", () => {
    expect(ruleBasedTrainingSelection(input([drill("m", 0)], 0))).toMatchObject({ movement: [], strength: [] });
  });
});
