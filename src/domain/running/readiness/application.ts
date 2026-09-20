/** R5 item application semantics, shared by planning and execution. No replanning or numeric policy. */
import type { RuleSet, LoadClass } from "../rules/schema";
import type { RunningTrainingMethod } from "../types/method";
import type { ReadinessActionCode } from "../types/readiness";
import type { ReadinessDecision } from "./schema";
import { resolveSwapTargets } from "./swap";

export function resolveReadinessApplication(args: {
  readiness: ReadinessDecision;
  ruleSet: RuleSet;
  method: RunningTrainingMethod;
  loadClass: LoadClass;
  isCoach: boolean;
  canOverrideCancel: boolean;
}) {
  const { readiness, ruleSet, method, loadClass, isCoach, canOverrideCancel } = args;
  const highIntensity = loadClass === "HIGH_NEURAL" || loadClass === "HIGH_METABOLIC";
  const swapKeepsCurrent = resolveSwapTargets(ruleSet, method).outcome === "KEEP_CURRENT";
  const pool = readiness.triggers.map((t) => new Set(t.actions));
  const union = () => new Set(pool.flatMap((actions) => [...actions]));
  const drop = (action: ReadinessActionCode) => pool.forEach((actions) => actions.delete(action));
  const effects: ("READINESS_CHECK_REQUIRED" | "READINESS_CANCEL_NOT_APPLICABLE" | "READINESS_CANCEL_OVERRIDDEN" | "READINESS_SWAP_KEEP_CURRENT")[] = [];
  let safetyOutcome = readiness.safetyOutcome;
  let overrideConsumed = false;
  let reviewRequired = false;
  const swapRecommended = union().has("SWAP_TO_LOWER_LOAD_METHOD") && !swapKeepsCurrent;
  const result = (kind: "STOP" | "CHECK_REQUIRED" | "CANCELLED" | "SWAP" | "PROCEED") => ({
    kind, remaining: union(), effects, safetyOutcome, overrideConsumed, reviewRequired, swapRecommended,
  });
  if (readiness.stopPlanning) return result("STOP");
  if (highIntensity && readiness.highIntensityAllowedToday === "UNKNOWN") {
    if (!isCoach) return result("CHECK_REQUIRED");
    reviewRequired = true;
    effects.push("READINESS_CHECK_REQUIRED");
  }
  for (;;) {
    const actions = union();
    if (actions.has("CANCEL_HIGH_INTENSITY")) {
      if (!highIntensity) {
        drop("CANCEL_HIGH_INTENSITY");
        effects.push("READINESS_CANCEL_NOT_APPLICABLE");
        continue;
      }
      if (canOverrideCancel && !overrideConsumed) {
        overrideConsumed = true;
        for (const trigger of pool) {
          if (trigger.delete("CANCEL_HIGH_INTENSITY")) trigger.delete("SWAP_TO_LOWER_LOAD_METHOD");
        }
        safetyOutcome = "COACH_REVIEW";
        reviewRequired = true;
        effects.push("READINESS_CANCEL_OVERRIDDEN");
        continue;
      }
      return result("CANCELLED");
    }
    if (actions.has("SWAP_TO_LOWER_LOAD_METHOD")) {
      if (swapKeepsCurrent) {
        drop("SWAP_TO_LOWER_LOAD_METHOD");
        effects.push("READINESS_SWAP_KEEP_CURRENT");
        continue;
      }
      return result("SWAP");
    }
    return result("PROCEED");
  }
}
