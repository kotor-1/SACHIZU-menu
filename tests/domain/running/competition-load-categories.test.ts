import { describe, expect, it } from "vitest";
import {
  buildCompetitionPlanningSnapshot,
  buildPlanningSnapshot,
  planningSnapshotSchema,
  readCompetitionLoadCategories,
} from "@/domain/running/persistence/sessionSnapshot";

const base = () => buildPlanningSnapshot({ sessionDateInput: "2026-09-20", items: [] });

describe("R11-B6 competition load category snapshot", () => {
  it.each([
    [["RACE"]],
    [["RELAY"]],
    [["RACE", "RELAY"]],
  ] as const)("canonical plural %j を保存・読取できる", (categories) => {
    const snapshot = buildCompetitionPlanningSnapshot("2026-09-20", [...categories]);
    expect(snapshot).toMatchObject({ schemaVersion: 1, competitionLoadCategories: categories });
    expect(snapshot).not.toHaveProperty("competitionLoadCategory");
    expect(readCompetitionLoadCategories(JSON.stringify(snapshot))).toEqual({ kind: "RESOLVED", source: "PLURAL", categories });
  });

  it.each([
    { categories: [] },
    { categories: ["RELAY", "RACE"] },
    { categories: ["RACE", "RACE"] },
    { categories: ["WORLD"] },
  ])("persisted plural corruption $categories を拒否する", ({ categories }) => {
    const raw = JSON.stringify({ ...base(), competitionLoadCategories: categories });
    expect(planningSnapshotSchema.safeParse(JSON.parse(raw)).success).toBe(false);
    expect(readCompetitionLoadCategories(raw)).toMatchObject({ kind: "UNREADABLE", reason: "INVALID_PLURAL" });
  });

  it("singular と plural の二重authorityを拒否する", () => {
    const raw = JSON.stringify({ ...base(), competitionLoadCategory: "RACE", competitionLoadCategories: ["RACE"] });
    expect(readCompetitionLoadCategories(raw)).toEqual({ kind: "UNREADABLE", reason: "CONFLICTING_FIELDS" });
  });

  it("pluralを持つunknown versionはfail closed", () => {
    expect(readCompetitionLoadCategories(JSON.stringify({ ...base(), schemaVersion: 2, competitionLoadCategories: ["RACE"] })))
      .toEqual({ kind: "UNREADABLE", reason: "UNKNOWN_VERSION" });
  });

  it("legacy singularとhistorical fallbackを維持する", () => {
    expect(readCompetitionLoadCategories(JSON.stringify({ ...base(), competitionLoadCategory: "RELAY" })))
      .toEqual({ kind: "RESOLVED", source: "LEGACY_SINGULAR", categories: ["RELAY"] });
    for (const raw of [null, "{broken", JSON.stringify(base()), JSON.stringify({ old: true })]) {
      expect(readCompetitionLoadCategories(raw)).toEqual({ kind: "RESOLVED", source: "HISTORICAL_FALLBACK", categories: ["RACE"] });
    }
  });
});
