/** R11-B2: transient assessment -> snapshot-local execution state. No Menu reads or replanning. */
import { z } from "zod";
import { getActiveRuleSet } from "@/domain/running/rules/loader";
import { parseJsonColumn } from "@/domain/running/persistence/jsonColumn";
import { planningSnapshotSchema } from "@/domain/running/persistence/sessionSnapshot";
import { provenanceSchema } from "@/domain/running/persistence/provenance";
import { readRepLogStartState } from "@/domain/running/persistence/repLog";
import { resolveReadinessAction } from "@/domain/running/readiness";
import { deriveReadinessExecutionDirective, projectReadinessExecutionState, readinessPersistedStateSchema } from "@/domain/running/readiness/execution";
import { runningPrescriptionSchema } from "@/domain/running/types/prescription";
import { isoDateSchema } from "@/domain/running/types/primitives";
import { readinessReportSchema } from "@/domain/running/types/readiness";
import { evaluateWeeklyContext } from "@/domain/running/weekly";
import { findSessionForReadiness, applySessionReadinessResults, SessionReadinessStaleError } from "@/infra/repositories/session-repository";
import { presentFindings } from "@/presentation/running/findings";
import { weeklyHistoryAsOf } from "./_running-load-history";

export const sessionReadinessInputSchema = z.object({
  sessionId: z.string().min(1),
  readinessReport: readinessReportSchema,
}).strict();

export type SessionReadinessRejectionCode =
  | "INVALID_INPUT" | "SESSION_NOT_FOUND" | "NO_RUNNING_V2_ITEMS"
  | "SESSION_NOT_EXECUTABLE" | "SESSION_ALREADY_IN_PROGRESS" | "SESSION_CLOSED" | "SNAPSHOT_UNREADABLE"
  | "READINESS_RULESET_UNAVAILABLE" | "READINESS_RULESET_MISMATCH" | "SESSION_ITEMS_CHANGED";

export class SessionReadinessError extends Error {
  constructor(readonly code: SessionReadinessRejectionCode) { super(code); this.name = "SessionReadinessError"; }
}
function reject(code: SessionReadinessRejectionCode): never { throw new SessionReadinessError(code); }

export async function evaluateSessionReadiness(raw: unknown) {
  const input = sessionReadinessInputSchema.safeParse(raw);
  if (!input.success) reject("INVALID_INPUT");
  const { sessionId, readinessReport } = input.data;
  const session = await findSessionForReadiness(sessionId);
  if (session === null) reject("SESSION_NOT_FOUND");
  if (session.sessionKind !== "TRAINING") reject("SESSION_NOT_EXECUTABLE");
  if (session.status === "COMPLETED" || session.status === "CANCELLED") reject("SESSION_CLOSED");
  const items = session.items.filter((item) => item.prescriptionKind === "RUNNING_V2");
  if (items.length === 0) reject("NO_RUNNING_V2_ITEMS");

  // Validate the entire set before evaluating or writing any item.
  const snapshots = items.map((item) => {
    const start = readRepLogStartState(item.actualRepLogJson);
    if (start === "STARTED") reject("SESSION_ALREADY_IN_PROGRESS");
    if (start === "UNREADABLE") reject("SNAPSHOT_UNREADABLE");
    const prescription = parseJsonColumn(item.plannedPrescriptionJson, runningPrescriptionSchema, { rejectHealthKeys: false });
    const provenance = parseJsonColumn(item.plannedProvenanceJson, provenanceSchema, { rejectHealthKeys: true });
    if (!prescription.ok || !provenance.ok || prescription.value.loadSnapshot === undefined) reject("SNAPSHOT_UNREADABLE");
    if (item.runningMethod !== null && item.runningMethod !== prescription.value.method) reject("SNAPSHOT_UNREADABLE");
    return { item, method: prescription.value.method, loadClass: prescription.value.loadSnapshot.loadClass, ageBand: provenance.value.inputsDigest.ageBand };
  });
  const sessionDate = isoDateSchema.parse(session.date.toISOString().slice(0, 10));
  const planning = session.planningSnapshotJson === null ? null
    : parseJsonColumn(session.planningSnapshotJson, planningSnapshotSchema, { rejectHealthKeys: true });
  if (planning !== null && !planning.ok) reject("SNAPSHOT_UNREADABLE");
  const plannedAt = planning?.ok ? planning.value.plannedAt : null;
  if (plannedAt !== null && new Date(plannedAt).toISOString().slice(0, 10) !== sessionDate) reject("SNAPSHOT_UNREADABLE");

  // The loader's official DRAFT fallback is allowed; never use the stored prescription identity.
  let selected: ReturnType<typeof getActiveRuleSet>;
  try { selected = getActiveRuleSet(sessionDate); } catch { reject("READINESS_RULESET_UNAVAILABLE"); }
  const history = plannedAt === null ? null : await weeklyHistoryAsOf(new Date(plannedAt), sessionId);
  const results = snapshots.map(({ item, method, loadClass, ageBand }) => {
    const weekly = evaluateWeeklyContext(history, {
      ruleSet: selected.ruleSet, evaluatedAt: plannedAt, method, loadClass, ageBand,
      hasExistingReadinessDecision: false,
    });
    let decision: ReturnType<typeof resolveReadinessAction>;
    try {
      decision = resolveReadinessAction(readinessReport, {
        planningDate: sessionDate, method, loadClass, ageBand,
        readinessWindowState: weekly.evaluatedAt === null ? "NOT_EVALUATED" : weekly.readinessRequired ? "ACTIVE" : "INACTIVE",
      });
      if (decision.ruleSet.version !== selected.ruleSet.ruleSetVersion || decision.ruleSet.contentHash !== selected.contentHash) reject("READINESS_RULESET_MISMATCH");
    } catch { reject("READINESS_RULESET_MISMATCH"); }
    const state = readinessPersistedStateSchema.parse({
      readinessExecutionStateV1: projectReadinessExecutionState(decision, selected.ruleSet),
      safetyOutcome: decision.safetyOutcome,
    });
    return {
      sessionItemId: item.id, state,
      view: {
        sessionItemId: item.id,
        actions: state.readinessExecutionStateV1.actions,
        safetyOutcome: state.safetyOutcome,
        executionDirective: deriveReadinessExecutionDirective(state),
        findings: presentFindings(decision.transientFindings),
      },
    };
  });
  try {
    await applySessionReadinessResults(sessionId, results.map(({ sessionItemId, state }) => ({ sessionItemId, state })), session);
  } catch (error) {
    if (error instanceof SessionReadinessStaleError) reject(error.code);
    throw error;
  }
  return {
    sessionId, items: results.map((result) => result.view),
    findings: presentFindings(selected.ruleSet.status === "DRAFT"
      ? [{ code: "RULESET_DRAFT", severity: "INFO", scope: "SESSION", evidenceIds: [] }] : []),
  };
}
export type SessionReadinessEvaluation = Awaited<ReturnType<typeof evaluateSessionReadiness>>;
