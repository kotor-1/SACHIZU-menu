import { AnalyzerNotConfiguredError } from "@/domain/ai/ports";
import type { FakeBehavior, IsolatedProvider, ProviderResult, Usage } from "@/domain/video-batch/contracts";

/** Fictional integer cost units. No pricing, SDK, HTTP, media decoder or real-provider fallback. */
export class FakeVideoObservationProvider implements IsolatedProvider {
  readonly capability = "SYNTHETIC_ONLY" as const;
  calls = 0;
  readonly dispatchKeys: string[] = [];
  private pending: (() => void)[] = [];
  constructor(private readonly behaviors: FakeBehavior[] = ["SUCCESS"], enabled = false) {
    if (process.env.NODE_ENV !== "test" || !enabled) throw new AnalyzerNotConfiguredError();
  }
  release() { this.pending.shift()?.(); }
  async dispatch(dispatchKey: string): Promise<ProviderResult> {
    if (process.env.NODE_ENV !== "test") throw new AnalyzerNotConfiguredError();
    const behavior = this.behaviors[Math.min(this.calls, this.behaviors.length - 1)] ?? "SUCCESS";
    this.calls++; this.dispatchKeys.push(dispatchKey);
    if (behavior === "DELAYED_SUCCESS") await new Promise<void>(resolve => this.pending.push(resolve));
    const usage: Usage = { requests: 1, inputTokens: 20, cachedTokens: 5, outputTokens: 10, reasoningTokens: 2, cost: 7 };
    if (behavior === "UNKNOWN_AFTER_SEND") return { kind: "unknown", code: "REQUEST_OUTCOME_UNKNOWN" };
    if (["HTTP_429", "HTTP_500", "TIMEOUT_BEFORE_SEND", "FAILURE_CONFIRMED_AFTER_SEND"].includes(behavior)) {
      const before = behavior === "TIMEOUT_BEFORE_SEND";
      return { kind: "confirmed-failure", code: behavior, retryable: true,
        usage: before ? { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, cost: 0 } : usage,
        requestId: before ? null : `fake:${dispatchKey}` };
    }
    return { kind: "response", requestId: `fake:${dispatchKey}`, usage,
      raw: JSON.stringify(behavior === "SCHEMA_INVALID" ? { COACH_REVIEWED: true } : {
        schemaVersion: "neutral-v1", quality: behavior === "PARTIAL" ? "PARTIAL" : "COMPLETE",
        events: [{ atMs: 10, kind: "CONTACT", evidenceRef: "synthetic:frame-1" }],
        unresolved: behavior === "PARTIAL" ? ["MISSING_AUDIO"] : [],
      }) };
  }
}
