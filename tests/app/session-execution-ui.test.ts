import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const files = {
  page: "src/app/sessions/[id]/page.tsx",
  row: "src/components/session/session-item-row.tsx",
  panel: "src/components/running/session-execution-panel.tsx",
  readiness: "src/components/running/readiness-form.tsx",
  rep: "src/components/running/rep-logger.tsx",
  monitor: "src/components/running/monitor-banner.tsx",
  ack: "src/components/running/runtime-coach-review-panel.tsx",
} as const;

describe("R11-B4B3 execution UI integration", () => {
  it("keeps the exact server-only feature flag boundary and leaves LEGACY/flag-off on the existing row path", () => {
    const page = read(files.page);
    const row = read(files.row);
    expect(page).toContain("const runningV2UiEnabled = isRunningV2UiEnabled()");
    expect(page).toContain("runningExecutionUiEnabled={runningV2UiEnabled}");
    expect(row).toContain("runningExecutionUiEnabled && runningExecution !== null");
    expect(row).toContain("!useRunningExecutionUi && <form action={toggleSessionItemAction}");
    expect(row).toContain("!useRunningExecutionUi && open &&");
    expect(row).toContain("useRunningExecutionUi && runningExecution &&");
    expect(row).not.toMatch(/RUNNING_V2_UI_ENABLED|process\.env|feature-flags/);
  });

  it("uses DTO capabilities for all three controls and one item-level mutation lock", () => {
    const panel = read(files.panel);
    expect(panel).toContain("execution.capabilities.canSubmitReadiness");
    expect(panel).toContain("execution.capabilities.canRecordRep");
    expect(panel).toContain("execution.capabilities.canAcknowledgeCoachReview && execution.pendingCoachReview");
    expect(panel).toContain("lockRef.current");
    expect(panel).toContain("if (lockRef.current) return false");
    expect(panel).toContain("router.refresh()");
    expect(panel).not.toMatch(/resolveReadinessAction|monitorRunningPrescription|getActiveRuleSet|getRuleSetByIdentity/);
  });

  it("submits only the formal readiness report, clears sensitive state on success, and has no client policy", () => {
    const source = read(files.readiness);
    expect(source).toContain("readinessReportSchema.safeParse");
    expect(source).toContain("evaluateSessionReadinessAction({ sessionId, readinessReport: parsed.data })");
    for (const key of ["pain", "soreness", "fatigue", "sleepQuality", "performanceStatus", "reporter", "reportedAt"]) {
      expect(source).toContain(key);
    }
    expect(source).toContain("clearSensitiveState()");
    expect(source).toContain('setReporter("COACH")');
    expect(source).toContain('setReportedAtLocal("")');
    expect(source).toContain('autoComplete="off"');
    expect(source).not.toMatch(/soreness\s*[><=]|fatigue\s*[><=]|sleepQuality\s*[><=]/);
  });

  it("submits the strict RepObservation shape without automatic rep sequencing or fps inference", () => {
    const source = read(files.rep);
    expect(source).toContain("repObservationSchema.safeParse");
    expect(source).toContain("recordRepAction({ sessionItemId, repObservation:");
    expect(source).toContain("setIndex: parseRequiredNumberInput(setIndex)");
    expect(source).toContain("repIndex: parseRequiredNumberInput(repIndex)");
    expect(source).toContain('timing === "VIDEO" ? { videoFps: parseOptionalNumberInput(videoFps) } : {}');
    expect(source).toContain("未入力時は自動推定しません");
    expect(source).not.toMatch(/completedRepCount\s*\+\s*1|videoFps:\s*60/);
    expect(source).not.toMatch(/monitorRunningPrescription|resolveReadinessAction/);
  });

  it("keeps health reports transient and resets them after a recorded rep", () => {
    const source = read(files.rep);
    expect(source).toContain("athleteReport");
    expect(source).toContain("setHasAthleteReport(false)");
    expect(source).toContain("setPainNow(false)");
    expect(source).toContain("setPainRegion(\"\")");
    expect(source).toContain("setRedFlags([])");
    expect(source).toContain("setRequestsStop(false)");
  });

  it("acknowledges only through an explicit button with the exact persisted review identity", () => {
    const source = read(files.ack);
    expect(source).toContain("acknowledgeRuntimeCoachReviewAction({");
    expect(source).toContain("sessionItemId,");
    expect(source).toContain("reviewIdentity: review.reviewIdentity");
    expect(source).toContain("内容を確認して次へ進む");
    expect(source).not.toMatch(/acknowledgedAt|acknowledgedBy|安全確認済み|問題なし|治った/);
  });

  it("separates persisted monitor information from transient next-rest guidance", () => {
    const monitor = read(files.monitor);
    const rep = read(files.rep);
    expect(monitor).toContain("最新保存済みの実施中判定");
    expect(monitor).toContain("latest.nextRepRestMessage");
    expect(rep).toContain("今回の送信直後の追加指示");
    expect(rep).toContain("result.data.monitor.nextRepRestS");
  });

  it("renders all persisted reasons and never invents a primary reason", () => {
    const monitor = read(files.monitor);
    expect(monitor).toContain("latest.reasons.map");
    expect(monitor).not.toMatch(/reasons\[0\]|primaryReason/);
  });

  it("has mobile touch targets, labels, fieldsets, live results, and keyboard focus handling", () => {
    const sources = [files.readiness, files.rep, files.ack].map(read).join("\n");
    expect(sources).toContain("min-h-11");
    expect(sources).toContain("<fieldset");
    expect(sources).toContain("<legend");
    expect(sources).toContain('aria-live="polite"');
    expect(sources).toContain("useEffect(() =>");
    expect(sources).toContain("resultRef.current?.focus()");
    expect(sources).not.toContain("queueMicrotask");
    expect(read(files.rep)).toContain('inputMode="numeric"');
    expect(read(files.rep)).toContain('inputMode="decimal"');
    expect(read(files.rep)).toContain('<summary className="flex min-h-11');
  });

  it("uses per-instance accessible ids and requires an explicit readiness report time", () => {
    const readiness = read(files.readiness);
    const rep = read(files.rep);
    expect(readiness).toContain("const privacyNoteId = useId()");
    expect(readiness).toContain("const resultId = useId()");
    expect(readiness).toContain("const painStatusName = useId()");
    expect(rep).toContain("const helpId = useId()");
    expect(rep).toContain("const resultId = useId()");
    expect(readiness).not.toContain('id="readiness-privacy-note"');
    expect(rep).not.toContain('id="rep-entry-help"');
    expect(readiness).toContain('type="datetime-local"');
    expect(readiness).toContain("value={reportedAtLocal}");
    expect(readiness).not.toContain("new Date().toISOString()");
  });

  it("keeps the item lock through the router refresh transition", () => {
    const panel = read(files.panel);
    expect(panel).toContain("const [isRefreshing, startRefresh] = useTransition()");
    expect(panel).toContain('setPending("REFRESH")');
    expect(panel).toContain("startRefresh(() => router.refresh())");
    expect(panel).toContain("if (refreshObservedRef.current)");
    expect(panel).toContain("lockRef.current = false");
  });

  it("keeps each row's forms, errors, and lock in its own component instance without nested mutation forms", () => {
    const row = read(files.row);
    const panel = read(files.panel);
    expect(row).toContain("<SessionExecutionPanel sessionId={sessionId} execution={runningExecution} />");
    expect(panel).toContain("const lockRef = useRef(false)");
    expect(panel).not.toContain("<form");
    expect(read(files.ack)).not.toContain("<form");
  });

  it("sends only the minimal server action payloads", () => {
    const readiness = read(files.readiness);
    const rep = read(files.rep);
    const ack = read(files.ack);
    expect(readiness).toContain("evaluateSessionReadinessAction({ sessionId, readinessReport: parsed.data })");
    expect(rep).toContain("recordRepAction({ sessionItemId, repObservation: parsed.data");
    expect(ack).toContain("sessionItemId,\n        reviewIdentity: review.reviewIdentity");
    for (const source of [readiness, rep, ack]) {
      expect(source).not.toMatch(/plannedPrescriptionJson|actualRepLogJson|readinessActionsJson|safetyOutcome:\s/);
    }
  });

  it("does not persist browser state, leak through URLs/logs, or import persistence and policy services", () => {
    const sources = Object.values(files).map(read).join("\n");
    const clientSources = [files.row, files.panel, files.readiness, files.rep, files.monitor, files.ack].map(read).join("\n");
    for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "IndexedDB", "document.cookie", "console.log", "console.debug", "console.info", "URLSearchParams", "history.pushState"]) {
      expect(sources).not.toContain(forbidden);
    }
    expect(clientSources).not.toMatch(/@\/infra\/|@prisma\/client|rules\/loader/);
    expect(sources).not.toMatch(/method=["']get["']|window\.location/);
  });

  it("does not render internal enum tokens as user-facing text", () => {
    const sources = [files.monitor, files.readiness, files.rep, files.ack, files.panel].map(read).join("\n");
    for (const raw of ["COACH_REVIEW", "STOP_SAFETY", "END_SESSION_QUALITY", "TIMING_FAIL", "MEDICAL_EVALUATION_RECOMMENDED"]) {
      expect(sources).not.toMatch(new RegExp(`>\\s*${raw}\\s*<`));
    }
  });
});
