import { runningIntentClaimsSchema, type RunningIntentClaims } from "@/application/running-menu/intent";

type Fetcher = typeof fetch;
export type ExtractorResult =
  | { ok: true; claims: RunningIntentClaims }
  | { ok: false; reason: "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT" };

const sourced = (value: Record<string, unknown>) => ({
  anyOf: [{ type: "object", additionalProperties: false, properties: { value, sourceText: { type: "string" } }, required: ["value", "sourceText"] }, { type: "null" }],
});
const sourcedNumber = { type: "object", additionalProperties: false, properties: { value: { type: "integer" }, sourceText: { type: "string" } }, required: ["value", "sourceText"] };

/** No generated distance, reps, rest, intensity, or target-time fields exist in this schema. */
export const RUNNING_INTENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    runningRequested: { type: "boolean" },
    event: sourced({ type: "string" }),
    ageGroup: sourced({ type: "string", enum: ["ELEMENTARY", "JUNIOR_HIGH", "HIGH_SCHOOL", "ADULT"] }),
    explicitDistances: { type: "array", items: sourcedNumber },
    distancePreference: sourced({ type: "string", enum: ["SHORT", "LONG"] }),
    loadReductionRequested: sourced({ type: "boolean", enum: [true] }),
    fatigueState: sourced({ type: "string", enum: ["REPORTED", "STRONG_OR_UNWELL"] }),
    availableTimeSeconds: sourced({ type: "integer" }),
    humanExplicitReps: sourced({ type: "integer" }),
    humanExplicitRestSeconds: sourced({ type: "integer" }),
    exerciseIds: { type: "array", items: { type: "string" } },
  },
  required: ["runningRequested", "event", "ageGroup", "explicitDistances", "distancePreference", "loadReductionRequested", "fatigueState", "availableTimeSeconds", "humanExplicitReps", "humanExplicitRestSeconds", "exerciseIds"],
} as const;

const INSTRUCTIONS = `あなたは日本語の練習依頼から明示条件を抽出するだけです。処方を作らず、距離・本数・休憩・タイムを新規に決めません。
sourceText は必ず依頼文の連続した原文を引用します。依頼文にない条件は null または空配列にします。
event は「100m選手」「200m選手」等の選手種目で、explicitDistances は「60mを走る」「80mをやりたい」等、今日実施する距離だけです。選手種目を実施距離に転記しません。
数値は周囲の文脈と単位で区別します。「200mのレースがある」「200mに出ます」「200mに出場する」「200mが専門」は event="200m" の根拠であり、explicitDistances には入れません。
「今日は200mを走りたい」「200mを2本」「練習は200mで」は練習距離です。「200mのレースがある。今日は60m」は event="200m", explicitDistances=[60] です。sourceTextには判断できる前後の語も原文のまま引用してください。
「あと3日」「3日後」「試合まで3日」は大会文脈で、本数でも練習時間でもありません。本数は「3本」、休憩は「休憩3分」、利用可能時間は「30分で練習」のように役割と単位が明示された場合だけ抽出します。学年・年齢・日付を本数や時間へ転記しません。
全角数字「２００m」と半角「200m」は同じ値ですが、sourceTextは全角を含めて原文を引用します。eventの値は "200m" のように半角にします。
「短め」「長め」だけを距離希望にします。「しっかり」「走り込み」「フォーム確認」だけでは距離希望を作りません。
「疲れている」だけでは loadReductionRequested を true にしません。「軽め」「本数を抑えたい」「量を抑えたい」「疲労を残したくない」等の明示依頼が必要です。
「疲労が抜けすぎている」「疲れていない」「少し疲労を溜めたい」は現在の疲労申告や負荷軽減希望ではありません。fatigueStateとloadReductionRequestedはnullです。大会日数・疲労を溜めたい意図から数値や調整を作りません。未対応の文脈は依頼原文に残し、別の条件へ変換しません。
強い不調は STRONG_OR_UNWELL にします。明示された本数・休憩・時間は原文にある場合だけ抽出します。明示されたセット分割や目標タイムは現段階で処方に使わないため exerciseIds 等に変換しません。
runningRequested は走メニュー依頼または走選手の一般的なメニュー依頼で true、補強やストレッチだけの明示依頼では false です。
Exercise は入力 catalog にある REVIEWED ID から選択できます。明示的な補強・ドリル等の希望がなければ空配列にします。旧Running TemplateやMethodは使いません。`;

export async function extractRunningMenuIntent(
  input: { requestText: string; exercises: readonly { id: string; name: string; category: string }[] },
  options: { apiKey?: string; model?: string; fetchImpl?: Fetcher } = {},
): Promise<ExtractorResult> {
  const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) return { ok: false, reason: "UNAVAILABLE" };
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model ?? process.env.MENU_PLANNER_OPENAI_MODEL ?? "gpt-5.6-luna",
        reasoning: { effort: "low" },
        instructions: INSTRUCTIONS,
        input: JSON.stringify(input),
        text: { format: { type: "json_schema", name: "running_intent_extract", strict: true, schema: RUNNING_INTENT_OUTPUT_SCHEMA } },
        store: false,
        max_output_tokens: 1800,
      }),
    });
  } catch {
    return { ok: false, reason: "UNAVAILABLE" };
  }
  if (!response.ok) return { ok: false, reason: response.status === 429 || response.status >= 500 ? "UNAVAILABLE" : "FAILED" };
  try {
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("status" in payload) || payload.status !== "completed" || !("output" in payload) || !Array.isArray(payload.output)) return { ok: false, reason: "INVALID_OUTPUT" };
    const messages = payload.output.filter((item): item is { type: string; role: string; content: unknown } => typeof item === "object" && item !== null && "type" in item && item.type === "message" && "role" in item && item.role === "assistant" && "content" in item);
    if (messages.length !== 1 || !Array.isArray(messages[0].content) || messages[0].content.length !== 1) return { ok: false, reason: "INVALID_OUTPUT" };
    const content = messages[0].content[0] as { type?: unknown; text?: unknown };
    if (content.type !== "output_text" || typeof content.text !== "string") return { ok: false, reason: "INVALID_OUTPUT" };
    const parsed = runningIntentClaimsSchema.safeParse(JSON.parse(content.text));
    return parsed.success ? { ok: true, claims: parsed.data } : { ok: false, reason: "INVALID_OUTPUT" };
  } catch {
    return { ok: false, reason: "INVALID_OUTPUT" };
  }
}
