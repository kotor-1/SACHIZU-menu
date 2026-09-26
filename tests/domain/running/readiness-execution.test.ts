import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveReadinessAction } from "@/domain/running/readiness";
import { deriveReadinessActions } from "@/domain/running/readiness/actions";
import { READINESS_WINDOW_STATES, type ReadinessContext } from "@/domain/running/readiness/schema";
import { projectReadinessExecutionState, readReadinessExecutionState, readinessExecutionStateV1Schema } from "@/domain/running/readiness/execution";
import { findForbiddenHealthKeys, PRESCRIPTION_JSON_MAX_BYTES } from "@/domain/running/persistence/limits";
import { READINESS_ACTION_CODES, type ReadinessReport, type PainReport } from "@/domain/running/types/readiness";
import * as loader from "@/domain/running/rules/loader";
import { READINESS_ACTION_LABEL_JA, READINESS_SAFETY_LABEL_JA, readinessStateMessageJa } from "@/presentation/running/readiness";
import { readinessReport, readinessContext } from "../../fixtures/running/readiness-execution";
import { readinessPlanningRegressionDigest } from "../../fixtures/running/readiness-planning-regression";

const selected = loader.getActiveRuleSet("2026-09-20");
afterEach(() => vi.restoreAllMocks());

describe("R11-B2 production equivalence classes", () => {
  it("120 complete planning results match the current F1 DRAFT RuleSet golden", () => {
    expect(readinessPlanningRegressionDigest()).toEqual({ count: 120, sha256: "4dffae662e18d34e83ef966c8a6427fcce087da30762287dd7e623e291973d06" });
  });
  it("all 580 R5 outputs / 19 tuples / 30 item states survive versioned round-trip", () => {
    // Exhaust the finite wellness grid, then quotient only by complete R5 wellness outputs
    // for ALL window states. No clinical thresholds are duplicated in the fixture reducer.
    const representatives = new Map<string, ReadinessReport>();
    const scores = [null, 1, 2, 3, 4, 5] as const;
    for (const soreness of scores) for (const fatigue of scores) for (const sleepQuality of scores) {
      for (const performanceStatus of ["NORMAL", "DOWN", "UNKNOWN"] as const) {
        const report = readinessReport({ soreness, fatigue, sleepQuality, performanceStatus });
        const key = JSON.stringify(READINESS_WINDOW_STATES.map((windowState) =>
          deriveReadinessActions({ report, windowState, rules: selected.ruleSet.readinessRules })));
        representatives.set(key, report);
      }
    }
    // Pain gate classes: no report, negative report, present, growth guidance, coach STOP, medical STOP.
    const pains: PainReport[] = [
      { status: "NONE_REPORTED", regions: [], redFlags: [] },
      { status: "NOT_ASKED", regions: [], redFlags: [] },
      { status: "PRESENT", regions: [], redFlags: [] },
      { status: "PRESENT", regions: ["HEEL"], redFlags: [] },
      { status: "PRESENT", regions: [], redFlags: ["SUDDEN_SHARP_PAIN"] },
      { status: "PRESENT", regions: [], redFlags: ["SWELLING"] },
    ];
    const complete = new Set<string>(), withoutContext = new Set<string>(), tuples = new Set<string>(), states = new Set<string>();
    for (const ageBand of ["U12", "U15", "U18", "ADULT", "UNKNOWN"] as const) {
      for (const meta of selected.ruleSet.methods) for (const readinessWindowState of READINESS_WINDOW_STATES) {
        for (const pain of pains) for (const report of representatives.values()) {
          const decision = resolveReadinessAction({ ...report, pain }, readinessContext({ ageBand, method: meta.method, loadClass: meta.loadClass, readinessWindowState }));
          complete.add(JSON.stringify(decision));
          const { ruleSet, evaluatedFor, ...rest } = decision;
          expect(ruleSet).toEqual({ version: selected.ruleSet.ruleSetVersion, contentHash: selected.contentHash, status: selected.ruleSet.status });
          expect(evaluatedFor).toEqual({ method: meta.method, loadClass: meta.loadClass });
          withoutContext.add(JSON.stringify(rest));
          tuples.add(JSON.stringify([decision.actions, decision.safetyOutcome]));
          // Independent reference: direct formal applicability, not the new application helper.
          const high = meta.loadClass === "HIGH_NEURAL" || meta.loadClass === "HIGH_METABOLIC";
          const keep = selected.ruleSet.readinessRules.some((r) => r.kind === "SWAP_TARGET" && r.fromMethods.includes(meta.method) && r.outcome === "KEEP_CURRENT");
          const swapRecommended = decision.actions.includes("SWAP_TO_LOWER_LOAD_METHOD") && !keep;
          const blocked = decision.stopPlanning || (high && decision.actions.includes("CANCEL_HIGH_INTENSITY")) || swapRecommended;
          const review = decision.actions.includes("REQUIRE_COACH_REVIEW") || decision.safetyOutcome !== "NONE" || (high && decision.highIntensityAllowedToday === "UNKNOWN");
          const executionGate = blocked ? "NO" : review ? "REQUIRES_COACH_DECISION" : "YES";
          const payload = projectReadinessExecutionState(decision, selected.ruleSet);
          expect(payload).toEqual({ schemaVersion: 1, actions: decision.actions, executionGate, swapRecommended });
          expect(findForbiddenHealthKeys(payload)).toEqual([]);
          const read = readReadinessExecutionState(JSON.stringify(payload), decision.safetyOutcome);
          expect(read.kind).toBe("READY_V1");
          if (read.kind !== "READY_V1") throw new Error("round-trip failed");
          expect(read.readinessExecutionStateV1).toEqual(payload);
          expect(read.executionDirective).toEqual({ executionGate, swapRecommended, coachReviewRequired: review,
            useLowerBound: decision.actions.includes("USE_LOWER_BOUND"), increaseRest: decision.actions.includes("INCREASE_REST") });
          states.add(JSON.stringify([payload, decision.safetyOutcome]));
        }
      }
    }
    expect(complete.size).toBe(580);
    expect(withoutContext.size).toBe(72);
    expect(tuples.size).toBe(19);
    expect(states.size).toBe(30);
  }, 120000);

  it("same LOW SWAP tuple: STRIDE keeps current, TEMPO_EXTENSIVE does not", () => {
    const evaluate = (method: ReadinessContext["method"]) => {
      const decision = resolveReadinessAction(readinessReport({ soreness: 4 }), readinessContext({ method, loadClass: "LOW" }));
      return projectReadinessExecutionState(decision, selected.ruleSet);
    };
    expect(evaluate("STRIDE")).toMatchObject({ executionGate: "YES", swapRecommended: false });
    expect(evaluate("TEMPO_EXTENSIVE")).toMatchObject({ executionGate: "NO", swapRecommended: true });
  });

  it.each(["STRIDE", "TEMPO_INTENSIVE", "MAX_VELOCITY", "SPRINT_ENDURANCE_SHORT"] as const)("CANCEL applicability: %s", (method) => {
    const decision = resolveReadinessAction(readinessReport({ pain: { status: "PRESENT", regions: [], redFlags: [] } }), readinessContext({ method }));
    const high = decision.evaluatedFor.loadClass.startsWith("HIGH_");
    expect(projectReadinessExecutionState(decision, selected.ruleSet).executionGate).toBe(high ? "NO" : "REQUIRES_COACH_DECISION");
  });

  it("LOW pain negative and not-asked differ only in transient metadata", () => {
    const a = resolveReadinessAction(readinessReport(), readinessContext({ method: "STRIDE", ageBand: "U15" }));
    const b = resolveReadinessAction(readinessReport({ pain: { status: "NOT_ASKED", regions: [], redFlags: [] } }), readinessContext({ method: "STRIDE", ageBand: "U15" }));
    expect(a.highIntensityAllowedToday).toBe(true);
    expect(b.highIntensityAllowedToday).toBe("UNKNOWN");
    expect(projectReadinessExecutionState(a, selected.ruleSet)).toEqual(projectReadinessExecutionState(b, selected.ruleSet));
    expect(projectReadinessExecutionState(b, selected.ruleSet)).not.toHaveProperty("allowsHighIntensity");
  });

  it("reload never calls a loader even if policy changes", () => {
    const decision = resolveReadinessAction(readinessReport({ soreness: 4 }), readinessContext({ method: "STRIDE" }));
    const raw = JSON.stringify(projectReadinessExecutionState(decision, selected.ruleSet));
    const spy = vi.spyOn(loader, "getActiveRuleSet").mockImplementation(() => { throw new Error("changed policy"); });
    expect(readReadinessExecutionState(raw, "NONE")).toMatchObject({ kind: "READY_V1", executionDirective: { executionGate: "YES" } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("read contract and presentation", () => {
  it.each([
    [null, "NOT_EVALUATED"], ['["NO_CHANGE"]', "LEGACY_UNVERSIONED"],
    ['["SWAP_TO_LOWER_LOAD_METHOD"]', "LEGACY_UNVERSIONED"],
    ["{", "UNREADABLE"], ['{"schemaVersion":99}', "UNREADABLE"],
    ['["UNKNOWN"]', "UNREADABLE"], ['["NO_CHANGE","NO_CHANGE"]', "UNREADABLE"],
    [" ".repeat(PRESCRIPTION_JSON_MAX_BYTES + 1), "UNREADABLE"],
  ])("safe reader case %#", (raw, kind) => {
    const result = readReadinessExecutionState(raw, "NONE");
    expect(result.kind).toBe(kind);
    expect(result).not.toHaveProperty("executionDirective");
    expect(readinessStateMessageJa(result)).not.toMatch(/NO_CHANGE|SWAP_TO_LOWER_LOAD_METHOD|schemaVersion/);
  });

  it("strict payload, health guard, consistency and unused outcome rejection", () => {
    const value = { schemaVersion: 1, actions: ["NO_CHANGE"], executionGate: "YES", swapRecommended: false };
    for (const key of ["pain", "reporter", "reportedAt", "fatigue", "note"]) {
      expect(readinessExecutionStateV1Schema.safeParse({ ...value, [key]: "secret" }).success).toBe(false);
      expect(readReadinessExecutionState(JSON.stringify({ ...value, [key]: "secret" }), "NONE").kind).toBe("UNREADABLE");
    }
    expect(readReadinessExecutionState(JSON.stringify(value), "STOP").kind).toBe("UNREADABLE");
    expect(readReadinessExecutionState(JSON.stringify(value), "COACH_REVIEW").kind).toBe("UNREADABLE");
    expect(readReadinessExecutionState(JSON.stringify({ ...value, swapRecommended: true }), "NONE").kind).toBe("UNREADABLE");
  });

  it("all exported actions and generated safety outcomes have Japanese labels", () => {
    expect(Object.keys(READINESS_ACTION_LABEL_JA).sort()).toEqual([...READINESS_ACTION_CODES].sort());
    expect(Object.keys(READINESS_SAFETY_LABEL_JA).sort()).toEqual(["NONE", "COACH_REVIEW", "MEDICAL_EVALUATION_RECOMMENDED"].sort());
    for (const label of [...Object.values(READINESS_ACTION_LABEL_JA), ...Object.values(READINESS_SAFETY_LABEL_JA)]) expect(label).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });
});
