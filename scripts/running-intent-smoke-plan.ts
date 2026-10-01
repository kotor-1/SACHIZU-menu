/** Planning only: no provider imports, credentials, fetch, or live execution. */
export const ORIGINAL_RUNNING_INTENT_SENTENCE = "今週に２００mのレースがある。\n中学2年男子です。\nあと3日で試合ですが、\n疲労が抜けすぎています。\n少し疲労を溜めるメニューを消化したい";

export const RUNNING_INTENT_SMOKE_PLAN = {
  liveExecutionAllowedThisPhase: false,
  model: "gpt-6-luna",
  effort: "low",
  repeatPerInput: 1,
  timeoutMs: 20_000,
  maxOutputTokens: 3_000,
  transportRetriesPerStage: 1,
  maximumUserInputs: 5,
  apiRequestHardCap: 8,
  solRequests: 0,
  cases: [
    { id: "CASE7", input: "中学生200m選手。今日のメニューを作って。ぶちしんどいけぇ、今日は本数を少なくしたい", expected: "REPORTED fatigue; reduction=true; 120m x 2, rest900s", plannedStages: 1 },
    { id: "INTENSE", input: "中学生200m選手。今日はめちゃくちゃ疲れてる。本数減らしたい", expected: "REPORTED fatigue, no safety escalation; 120m x 2, rest900s", plannedStages: 1 },
    { id: "LEGS", input: "中学生200m選手。脚パンパン。本数減らしたい", expected: "REPORTED fatigue; reduction=true; 120m x 2, rest900s", plannedStages: 1 },
    { id: "NORMAL_LOAD", input: "中学生200m選手。今日はだるいけど普通にやる", expected: "REPORTED fatigue; reduction=false; 120m x 3, rest900s", plannedStages: 1 },
    { id: "SAFETY", input: "中学生200m選手。足が痛くて走れない", expected: "Grounded safety evidence plus selective review; coach review, no prescription", plannedStages: 2 },
  ],
  plannedRequests: 6,
  // A future runner must count every stage/retry BEFORE dispatch and stop at 8.
  // Unexpected reviews/retries may leave some of the five inputs unexecuted.
  maximumRequestsWithoutBudgetEnforcement: 20,
  requiresRequestCountReportBeforeExecution: true,
} as const;
