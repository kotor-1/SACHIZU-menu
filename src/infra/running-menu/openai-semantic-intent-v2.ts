import {
  bareNumericRoleReviewV2Schema, runningSemanticIntentV2Schema, semanticReviewV2Schema,
  type BareNumericRoleReviewV2, type RunningSemanticIntentV2, type SemanticReviewV2,
} from "@/application/running-menu/semantic-intent-v2";

type Fetcher = typeof fetch;
type Options = { apiKey?: string; model?: string; fetchImpl?: Fetcher };
export type SemanticExtractionResult =
  | { ok: true; interpretation: RunningSemanticIntentV2; review: SemanticReviewV2; numericRoleReview: BareNumericRoleReviewV2 }
  | { ok: false; reason: "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT" };

const claimSchema = {
  type: "object", additionalProperties: false,
  properties: {
    field: { type: "string", enum: ["RUNNING_REQUEST", "EVENT", "AGE_GROUP", "TRAINING_DISTANCE", "REPS", "REST", "AVAILABLE_TIME", "DISTANCE_PREFERENCE", "LOAD_REDUCTION", "FATIGUE", "COMPETITION_DAYS"] },
    value: { anyOf: [{ type: "string" }, { type: "integer" }, { type: "boolean" }] },
    sourceText: { type: "string" },
    polarity: { type: "string", enum: ["AFFIRMED", "NEGATED"] },
    temporalScope: { type: "string", enum: ["CURRENT", "DESIRED", "FUTURE", "PAST"] },
    status: { type: "string", enum: ["ACTIVE", "SUPERSEDED"] },
    numericParts: { type: "array", items: { type: "object", additionalProperties: false, properties: { rawText: { type: "string" }, unit: { type: "string", enum: ["METER", "REP", "SECOND", "MINUTE", "HOUR", "DAY", "SET", "GRADE", "NONE"] } }, required: ["rawText", "unit"] } },
  },
  required: ["field", "value", "sourceText", "polarity", "temporalScope", "status", "numericParts"],
} as const;

/** Claims are observations about the user text, never generated prescription numbers. */
export const SEMANTIC_INTENT_V2_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    interpreterVersion: { type: "string", enum: ["running-intent-v2"] },
    requestKind: { type: "string", enum: ["RUNNING", "EXERCISE_ONLY", "AMBIGUOUS"] },
    claims: { type: "array", items: claimSchema },
    unsupportedIntents: { type: "array", items: { type: "object", additionalProperties: false, properties: { meaning: { type: "string" }, sourceText: { type: "string" } }, required: ["meaning", "sourceText"] } },
    ambiguity: { anyOf: [{ type: "object", additionalProperties: false, properties: { question: { type: "string" }, sourceText: { type: "string" } }, required: ["question", "sourceText"] }, { type: "null" }] },
    exerciseIds: { type: "array", items: { type: "string" } },
  },
  required: ["interpreterVersion", "requestKind", "claims", "unsupportedIntents", "ambiguity", "exerciseIds"],
} as const;

export const SEMANTIC_REVIEW_V2_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    assessments: { type: "array", items: { type: "object", additionalProperties: false, properties: { index: { type: "integer" }, supported: { type: "boolean" } }, required: ["index", "supported"] } },
    activeClaimIndexes: { type: "array", items: { type: "integer" } },
    requestKindSupported: { type: "boolean" },
    missingCriticalClaim: { type: "boolean" },
    ambiguityCorrect: { type: "boolean" },
    unsupportedIntentsSupported: { type: "boolean" },
  },
  required: ["assessments", "activeClaimIndexes", "requestKindSupported", "missingCriticalClaim", "ambiguityCorrect", "unsupportedIntentsSupported"],
} as const;

export const BARE_NUMERIC_ROLE_V2_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { roles: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { sourceText: { type: "string" }, rawText: { type: "string" },
      role: { type: "string", enum: ["EVENT", "TRAINING_DISTANCE", "AMBIGUOUS", "OTHER"] } },
    required: ["sourceText", "rawText", "role"] } } },
  required: ["roles"],
} as const;

const EVENT_ROLE_CONTEXT = `競技名を省略した自己紹介でも、本人の種目・所属を示す名詞句や同定述語として数値が結びついていればEVENT。競技予定の存在を告知する意味もEVENT。属性と数値が関係を示さない独立した列挙であれば、種目・所属を推定しない。本人の種目を示す連体修飾の名詞句や名乗りでは、専門・出場という動詞を必須にしない。学年と数値が関係を示さない独立した列挙の場合や、競技か練習か決まらない将来の実施動詞だけの場合はAMBIGUOUS。画面の用途だけを根拠にroleを補わず、名詞句・述語・時制・周辺文脈の関係で判断する。`;

const BARE_NUMERIC_ROLE = `あなたは一次解釈を見ない独立した数値role監査者。日本語の依頼原文だけを読む。走距離に関係する数値を、単位の有無や文字・音声表記にかかわらずrolesに列挙する。各数字について競技種目ならEVENT、今日実施する練習距離ならTRAINING_DISTANCE、両方に自然に読めるならAMBIGUOUS、それ以外ならOTHERとする。出場・専門という意味なら種目、今日の実施や本数と結びつくなら練習。学年、本数、休憩、セット数、大会までの期間など走距離ではない文脈の数値は列挙する必要がなく、列挙する場合はOTHER。期間の単位に誤字や欠落があっても、走距離を指す根拠がない数値をEVENT/TRAINING_DISTANCE/AMBIGUOUSにしない。方言や省略は意味で判断し、固定表現に照合しない。sourceTextはその数字と役割を判断できる原文の連続した完全一致引用、rawTextはその中の数字の原文そのまま。処方を作らない。` + EVENT_ROLE_CONTEXT;

const INTERPRET = `あなたは日本語の練習依頼を意味で解釈する。方言、子どもの表現、誤字、省略、否定、訂正を文脈で読む。単語の有無だけで意味を決めない。
処方を決めない。距離・本数・休憩・目標タイムを生成しない。明示された練習距離、本数、休憩、利用可能時間だけをclaimにする。eventは競技種目であり、練習距離と別。競技への出場・専門種目という意味なら距離の単位が省略されてもevent。今日の練習で実施するという意味ならTRAINING_DISTANCE。学年と数値が関係を示さない独立した列挙の場合や、競技か練習か決まらない将来の実施動詞だけの場合はAMBIGUOUS。距離の直後に本数が結びついている場合、その距離はTRAINING_DISTANCEでありEVENTではない。大会までの日数、学年、セット数は本数ではない。
claimsには最終的に有効な意味を含める。否定・訂正された過去の希望も意味を持つ場合はpolarity=NEGATEDやstatus=SUPERSEDEDのclaimとして原文根拠と共に残す。否定した距離希望から反対側の希望を推定しない。最終希望だけをACTIVEにする。疲労という現在の状態と、負荷を下げたいという希望を分離する。方言の短縮された否定も否定として読む。FATIGUEのNOT_FATIGUEDは回復・軽い動き・運動余力という肯定的な自己申告を表す。生理的疲労が厳密にゼロという断言を要求しない。現在の疲労が明示されている場合はその明示状態を優先し、相反する状態を余力から追加しない。単なる疲労感・重さ・張り・だるさの申告はFATIGUED。程度の強調だけからSTRONG_OR_UNWELLにしない。STRONG_OR_UNWELLは強い疲労や体調不良が明示されている場合、または運動不能や実施困難な身体状態が明示されている場合に限る。RUNNING_REQUEST、LOAD_REDUCTION、FATIGUEではvalue自体が否定の結果を表すためpolarityは必ずAFFIRMED。疲れていない、疲労が抜けて回復しすぎている、身体が軽く動く、まだ動けそうという前向きな身体状態はFATIGUE=NOT_FATIGUEDとして保持し、疲労・不調・軽減希望に反転しない。動きや記録が進まないという訴えだけでは、原因を強い疲労・不調と断定しない。対応fieldに収まらなければunsupportedIntentsへ保持する。量や本数を少なくしてほしい希望はLOAD_REDUCTION=true、軽くしない・疲れていても通常の量で行うという明示希望はLOAD_REDUCTION=false。単なる軽め希望は通常の負荷軽減依頼として読み、強度だけを避けたいと明記された場合と区別する。きつさ・強度を避けたい希望は現在の負荷軽減policyと同一視せずunsupportedIntentsへ保持する。「疲労を溜めたい」は負荷軽減希望ではない。
各claimのsourceTextは原文中の連続した完全一致引用。短すぎず、その意味を判断できる前後の文脈を含める。numericPartsはそのclaimを支える数値のみ。rawTextは原文そのままの数字表記、unitは直後に原文で明記された単位を分類し、単位が書かれていなければNONE。数字がないclaimでは空配列。EVENTの値は「200m」のように正規化。TRAINING_DISTANCE/REPS/REST/AVAILABLE_TIME/COMPETITION_DAYSのvalueは正の整数。COMPETITION_DAYSは日単位の大会間隔だけ。大会までの分・時間は別の未対応文脈として保持し、利用可能な練習時間や日数に変換しない。大会までの日数は日数と確信できる場合だけclaimにし、誤字で単位が欠けた数値のroleを推測で確定しない。処方に使わない日程情報の不確かさだけで、明確な他の意図をAMBIGUOUSにしない。その部分をunsupportedIntentsへ保持する。相対的な暦の表現には数字を含まないものもあり、COMPETITION_DAYSではその場合numericPartsを空にする。RESTとAVAILABLE_TIMEは秒へ換算する。時間量は休憩・練習に使える時間枠・予定までの残時間のどれかが文脈で明確な場合だけ対応fieldへ入れる。用途が省略され複数のroleが自然に読める時間量をAVAILABLE_TIMEやRESTに確定せずAMBIGUOUSとして確認する。距離希望はSHORT/LONG、疲労はFATIGUED/NOT_FATIGUED/STRONG_OR_UNWELL、年齢区分はELEMENTARY/JUNIOR_HIGH/HIGH_SCHOOL/ADULT。trueでないLOAD_REDUCTIONはfalseとして表せる。長いものを嫌がるだけでは短め希望、短いものを嫌がるだけでは長め希望と断定しない。
対応済みfieldで表せないが意味のある希望はunsupportedIntentsへ短く要約し、原文引用も残す。ACTIVEかつAFFIRMEDの対応済みclaimで表現できる意味はunsupportedIntentsに重複させない。反対側の希望が明示されていない否定の距離制約は現policyで表せないため、NEGATED claimとともにunsupportedIntentsへも保持する。第三者の学年や同行者などの背景情報を、本人への条件や希望に変換しない。少し追加で走りたいという追加量の希望をSHORT距離希望へ変換しない。長い距離を避ける希望をSHORT距離希望へ、短い距離を避ける希望をLONG距離希望へ自動変換しない。セット数や目標タイムなど現adapterにない明示条件も、他の数値roleへ流さずここへ保持する。そこから処方を推測しない。数字だけなど役割が本当に曖昧な時だけAMBIGUOUSにして質問を一つ作る。この入力は走メニュー作成画面から来る。種目や年齢が未入力でも疲労状態や負荷希望が明確ならrequestKind=RUNNINGにして理解できたclaimを保持し、不足する種目・年齢は後段Engineに任せる。明示された補強・ドリルのみならEXERCISE_ONLY。exerciseIdsは提供されたREVIEWED catalogからのみ選ぶ。` + EVENT_ROLE_CONTEXT;

const REVIEW = `あなたは一次解釈とは独立した意味監査者。原文とclaimsを照合し、各claimのfield/value/sourceTextが原文に意味的に支持されるか判定する。引用に数字があっても役割を取り違えていたらsupported=false。時間量が休憩・練習時間枠・予定までの残時間のどれか判別できないのにRESTやAVAILABLE_TIMEに確定したclaimはsupported=false、ambiguityCorrect=false。競技への参加・専門種目は距離単位が省略されてもEVENT。今日の実施距離はTRAINING_DISTANCE。将来走るとだけ述べ、競技か練習か判別できない場合はAMBIGUOUS。距離が直後の本数に結びつく場合はTRAINING_DISTANCEであり、EVENT claimを支持しない。否定、訂正、現在状態と希望を特に確認。FATIGUEのNOT_FATIGUEDは回復・軽い動き・運動余力という肯定的な自己申告として判定し、生理的疲労ゼロの断言を要求しない。現在の疲労の明示があればその状態を優先する。方言の否定形や身体が軽く動く肯定的状態を、負荷軽減や強い疲労に反転しない。動きが進まないだけで強い疲労・不調と断定しない。通常の疲労感や身体の重さ・張り・だるさ、程度の強調だけからSTRONG_OR_UNWELLにしない。強い疲労や体調不良、運動不能・実施困難が明示されている場合だけSTRONG_OR_UNWELLを支持する。軽めという通常の負荷希望はLOAD_REDUCTION=true。強度を避けたいと明記された希望は別の未対応intent。疲れていても通常の量で行いたい希望はLOAD_REDUCTION=false。少し追加で走りたいという希望はSHORT距離指定ではない。この入力は走メニュー作成画面から来る。種目や年齢が未入力でも明確な疲労状態や負荷希望をAMBIGUOUSにせず、後段Engineの不足入力として扱う。requestKindが原文の意味と合うかrequestKindSupportedで判定。assessmentsはclaimsと同じ順にindex 0始まりで返す。activeClaimIndexesには最終的に有効なclaimのindexだけを入れる。現在状態のNOT_FATIGUEDや明示されたLOAD_REDUCTION=falseも、訂正されていなければACTIVEに含める。policy adapterがnullにすることは除外理由ではない。否定された希望と訂正前の希望は除く。例えば「短め、いや長め」ならSHORTを除きLONGだけを選ぶ。長いのを嫌がるだけでは短め希望が確定したとは限らない。原文に明示された練習距離・本数・休憩・軽減希望・軽減を断る希望・現在の疲労や回復状態・強い不調がclaimsから欠落し、意味を落としたまま通常処方へ進む場合はmissingCriticalClaim=true。未対応の強度希望、単位を確信できない大会日数、未対応のセット数はここに含めない。有効な否定制約がclaimsにもunsupportedIntentsにも残らない場合はmissingCriticalClaim=true。処方に使わない日程情報の不確かさだけを理由に明確な他の意図をAMBIGUOUSにした場合はambiguityCorrect=false。ambiguityCorrectは両方向で判定する。曖昧でない文章をAMBIGUOUSにした場合も、本当に競技と練習が両義なのに一方のroleで確定した場合もfalse。後者では数値claimのsupportedもfalseにする。unsupportedIntentsは原文の意味と明らかに矛盾する場合だけunsupportedIntentsSupported=false。処方数値を提案しない。` + EVENT_ROLE_CONTEXT;

function outputText(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("status" in payload) || payload.status !== "completed" || !("output" in payload) || !Array.isArray(payload.output)) return null;
  const messages = payload.output.filter((item): item is { type: string; role: string; content: unknown } => typeof item === "object" && item !== null && "type" in item && item.type === "message" && "role" in item && item.role === "assistant" && "content" in item);
  if (messages.length !== 1 || !Array.isArray(messages[0].content) || messages[0].content.length !== 1) return null;
  const content = messages[0].content[0] as { type?: unknown; text?: unknown };
  if (content.type !== "output_text" || typeof content.text !== "string") return null;
  try { return JSON.parse(content.text); } catch { return null; }
}

async function call(input: unknown, instructions: string, schema: object, name: string, options: Options): Promise<{ ok: true; value: unknown } | { ok: false; reason: "UNAVAILABLE" | "FAILED" | "INVALID_OUTPUT" }> {
  const apiKey = (options.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
  if (!apiKey) return { ok: false, reason: "UNAVAILABLE" };
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ model: options.model ?? process.env.MENU_PLANNER_OPENAI_MODEL ?? "gpt-6-luna", reasoning: { effort: "low" }, instructions, input: JSON.stringify(input), text: { format: { type: "json_schema", name, strict: true, schema } }, store: false, max_output_tokens: 3000 }),
      });
    } catch {
      if (attempt === 2) return { ok: false, reason: "UNAVAILABLE" };
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }
    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      return { ok: false, reason: response.status === 429 || response.status >= 500 ? "UNAVAILABLE" : "FAILED" };
    }
    try {
      const value = outputText(await response.json());
      return value === null ? { ok: false, reason: "INVALID_OUTPUT" } : { ok: true, value };
    } catch { return { ok: false, reason: "INVALID_OUTPUT" }; }
  }
  return { ok: false, reason: "UNAVAILABLE" };
}

export async function extractRunningSemanticIntentV2(
  input: { requestText: string; exercises: readonly { id: string; name: string; category: string }[] },
  options: Options = {},
): Promise<SemanticExtractionResult> {
  const extracted = await call(input, INTERPRET, SEMANTIC_INTENT_V2_OUTPUT_SCHEMA, "running_semantic_intent_v2", options);
  if (!extracted.ok) return extracted;
  const interpretation = runningSemanticIntentV2Schema.safeParse(extracted.value);
  if (!interpretation.success) return { ok: false, reason: "INVALID_OUTPUT" };
  const checkedRoles = await call({ requestText: input.requestText }, BARE_NUMERIC_ROLE, BARE_NUMERIC_ROLE_V2_OUTPUT_SCHEMA, "running_bare_numeric_role_v2", options);
  if (!checkedRoles.ok) return checkedRoles;
  const numericRoleReview = bareNumericRoleReviewV2Schema.safeParse(checkedRoles.value);
  if (!numericRoleReview.success) return { ok: false, reason: "INVALID_OUTPUT" };
  const reviewed = await call({ requestText: input.requestText, interpretation: interpretation.data }, REVIEW, SEMANTIC_REVIEW_V2_OUTPUT_SCHEMA, "running_semantic_review_v2", options);
  if (!reviewed.ok) return reviewed;
  const review = semanticReviewV2Schema.safeParse(reviewed.value);
  return review.success ? { ok: true, interpretation: interpretation.data, review: review.data, numericRoleReview: numericRoleReview.data } : { ok: false, reason: "INVALID_OUTPUT" };
}
