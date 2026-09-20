import { readinessReportSchema, type ReadinessReport } from "@/domain/running/types/readiness";
import type { ReadinessContext } from "@/domain/running/readiness/schema";
import { isoDateSchema } from "@/domain/running/types/primitives";

export function readinessReport(overrides: Partial<ReadinessReport> = {}): ReadinessReport {
  return readinessReportSchema.parse({ pain: { status: "NONE_REPORTED", regions: [], redFlags: [] }, soreness: 1, fatigue: 1,
    sleepQuality: 5, performanceStatus: "NORMAL", reporter: "ATHLETE", reportedAt: "2026-09-20T08:00:00Z", ...overrides });
}
export function readinessContext(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return { planningDate: isoDateSchema.parse("2026-09-20"), ageBand: "ADULT", method: "ACCELERATION", readinessWindowState: "NOT_EVALUATED", ...overrides };
}
