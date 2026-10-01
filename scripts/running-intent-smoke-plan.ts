/** Planning only: no provider imports, credentials, fetch, or live execution. */
export const RUNNING_INTENT_SMOKE_PLAN = {
  liveExecutionAllowedThisPhase: false,
  model: "gpt-6-luna",
  effort: "low",
  repeatPerInput: 1,
  cases: [
    { id: "A", input: "中学生100m、今日は軽めにしたい", expected: "60m x 3, rest 240s", plannedStages: 1 },
    { id: "B", input: "100m選手。60mで、いや50mを走りたい", expected: "ACTIVE distance 50; SUPERSEDED 60", plannedStages: 1 },
    { id: "C", input: "中1で100、長いのはやだ", expected: "JUNIOR_HIGH, event100, preference NONE, negative LONG retained", plannedStages: 1 },
    { id: "D", input: "100m選手。フォームをきれいにしたい", expected: "event100; unsupported wish retained", plannedStages: 1 },
    { id: "EVENT", input: "200出る", expected: "event200; no training distance", plannedStages: 1 },
    { id: "DISTANCE_REPS", input: "60を3本", expected: "distance60, reps3; no event", plannedStages: 1 },
    { id: "CORRECTION", input: "中学生200m選手。短めじゃなくて長めがいい", expected: "ACTIVE LONG; correction resolved", plannedStages: 1 },
    { id: "ORIGINAL", input: "今週に２００mのレースがある。\n中学2年男子です。\nあと3日で試合ですが、\n疲労が抜けすぎています。\n少し疲労を溜めるメニューを消化したい", expected: "120m x 3, rest900s; unsupported wish retained", plannedStages: 1 },
    { id: "SAFETY", input: "中学生100m選手。走れないほど体調が悪い", expected: "selective safety review; coach review, no automatic prescription", plannedStages: 2 },
    { id: "AMBIGUITY", input: "200", expected: "clarification; no unnecessary review", plannedStages: 1 },
  ],
  plannedRequests: 11,
  // Any primary can be routed to one secondary. Existing transport recovery
  // remains at most one retry per stage: 10 inputs x 2 stages x 2 attempts.
  maximumRequestsIncludingSelectiveReviewAndTransportRetry: 40,
  optionalSolComparison: { requiresExplicitHumanApproval: true, maximumInputs: 2, repeatPerInput: 1,
    plannedPrimaryRequests: 2, maximumRequestsIncludingReviewAndRetry: 8 },
} as const;
