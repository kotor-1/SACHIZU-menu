import {
  runningSemanticIntentV2Schema, semanticReviewV2Schema, verifyPrimarySemanticIntentV2,
  type BareNumericRoleReviewV2, type RunningSemanticIntentV2, type SemanticReviewV2,
} from "@/application/running-menu/semantic-intent-v2";
import { callRunningStructuredResponse, type RunningSemanticClientOptions } from "./structured-response";

type Options = RunningSemanticClientOptions;
export type SemanticExtractionResult =
  | { ok: true; interpretation: RunningSemanticIntentV2; review: SemanticReviewV2 | null; numericRoleReview: BareNumericRoleReviewV2 | null }
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
    corrections: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { supersededClaimIndex: { type: "integer" }, finalClaimIndex: { type: "integer" }, sourceText: { type: "string" } },
      required: ["supersededClaimIndex", "finalClaimIndex", "sourceText"] } },
    unsupportedIntents: { type: "array", items: { type: "object", additionalProperties: false, properties: { meaning: { type: "string" }, sourceText: { type: "string" } }, required: ["meaning", "sourceText"] } },
    ambiguity: { anyOf: [{ type: "object", additionalProperties: false, properties: { question: { type: "string" }, sourceText: { type: "string" } }, required: ["question", "sourceText"] }, { type: "null" }] },
    exerciseIds: { type: "array", items: { type: "string" } },
  },
  required: ["interpreterVersion", "requestKind", "claims", "corrections", "unsupportedIntents", "ambiguity", "exerciseIds"],
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
    correctionsSupported: { type: "boolean" },
  },
  required: ["assessments", "activeClaimIndexes", "requestKindSupported", "missingCriticalClaim", "ambiguityCorrect", "unsupportedIntentsSupported", "correctionsSupported"],
} as const;

export const BARE_NUMERIC_ROLE_V2_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { roles: { type: "array", items: { type: "object", additionalProperties: false,
    properties: { sourceText: { type: "string" }, rawText: { type: "string" },
      role: { type: "string", enum: ["EVENT", "TRAINING_DISTANCE", "AMBIGUOUS", "OTHER"] } },
    required: ["sourceText", "rawText", "role"] } } },
  required: ["roles"],
} as const;

const EVENT_ROLE_CONTEXT = `発話の目的を区別する。本人の属性・専門種目を述べるプロフィール、競技参加の告知、練習で実施したい条件の依頼、役割を示さない将来予定の報告は別の意味。本人の年齢・学年・カテゴリと競技距離が一つのプロフィールとして連結された短縮自己紹介は、種目名・所属名詞・出場や専門という動詞が省略されてもEVENT。この自己紹介の関係には所属修飾・同定・助詞による結合・一体の名詞句などの根拠が必要。本人の種目を同定して名乗る名詞述語は、口語・方言の文末や語気表現が付いていてもEVENTを示す。名詞述語があれば、句読点や単位省略だけを理由に独立した数値列挙と見なさない。年齢属性、単位のない数値、距離希望の断片が同定述語も所属修飾もなく互いの役割を示さず独立して列挙されている場合は、勝手に一つのプロフィールにまとめずAMBIGUOUSとする。空白、助詞、距離単位の省略は既に示された自己紹介の関係を消さない。属性から続く距離が自己紹介の一部か、実施する練習の目的語かを文脈で判断する。距離が選手という所属名詞を修飾する場合もEVENT。競技参加の告知もEVENT。距離と本数が一つの実施条件として結び付く場合はTRAINING_DISTANCEであり、実施希望の述語や距離単位が省略されても曖昧ではない。競技プロフィールや大会日程が同じ文章にあっても、この距離と本数の関係を競技種目へ流さない。距離を明示して実施を希望し、その条件を依頼・訂正している場合もTRAINING_DISTANCE。すでに述べた競技プロフィールとは別の節での実施距離の依頼を、競技への参加予定へ読み替えない。希望を述べる述語と、その依頼の距離目的語を原文全体から結びつける。訂正前後の数値は同じ目的語の役割を共有し、訂正後だけが有効。単に将来走る予定の事実だけを述べて競技か練習か分からない場合、関係のない独立した数値の列挙、実施希望の述語のない距離だけの当日の指定はAMBIGUOUS。単位付き数値というだけで種目にしない。画面の用途だけを根拠に数値のroleを補わず、名詞句・述語・時制・依頼と事実報告の違い・周辺文脈で判断する。`;

const CLAIM_LIFECYCLE_CONTEXT = `訂正は競合や複数指定ではなく、同じfieldの旧claimを最終claimで置き換える関係。置き換えられたclaimをstatus=SUPERSEDED、最終claimをACTIVEとし、correctionsにsupersededClaimIndex、finalClaimIndex、訂正全体を裏付ける原文の連続引用sourceTextを記録する。indexはclaimsの0始まり。訂正関係の引用内に両claimのsourceTextが入るよう各claimの引用を選ぶ。連続した訂正では各旧claimから最後のACTIVE claimへ結ぶ。否定された選択肢はDISTANCE_PREFERENCEのvalueにその選択肢、polarity=NEGATED、status=ACTIVEとして表す。否定は撤回ではないので、対立する最終希望が明示されなければSUPERSEDEDにしない。否定制約と反対側の希望は別物。反対の希望や負荷増加を補わない。LOAD_REDUCTION=falseは軽減を断る最終状態で、重い練習を求める意味ではない。現在のpolicyで使えない有効な否定制約・技術改善などの希望はunsupportedIntentsとして原文とともに保持する。訂正前の意味をunsupportedIntentsに復活させない。`;


const INTERPRET = `あなたは日本語の練習依頼を意味で解釈する。方言、子どもの表現、誤字、省略、否定、訂正を文脈で読む。単語の有無だけで意味を決めない。
処方を決めない。距離・本数・休憩・目標タイムを生成しない。明示された練習距離、本数、休憩、利用可能時間だけをclaimにする。eventは競技種目であり、練習距離と別。競技への出場・専門種目という意味なら距離の単位が省略されてもevent。今日の練習で実施するという意味ならTRAINING_DISTANCE。学年と数値が関係を示さない独立した列挙の場合や、競技か練習か決まらない将来予定の事実報告の場合はAMBIGUOUS。距離の直後に本数が結びついている場合、その距離はTRAINING_DISTANCEでありEVENTではない。大会までの日数、学年、セット数は本数ではない。
claimsには最終的に有効な意味を含める。否定・訂正された過去の希望も意味を持つ場合はpolarity=NEGATEDやstatus=SUPERSEDEDのclaimとして原文根拠と共に残す。否定した距離希望から反対側の希望を推定しない。最終希望だけをACTIVEにする。疲労という現在の状態と、負荷を下げたいという希望を分離する。方言の短縮された否定も否定として読む。FATIGUEのNOT_FATIGUEDは回復・軽い動き・運動余力という肯定的な自己申告を表す。生理的疲労が厳密にゼロという断言を要求しない。現在の疲労が明示されている場合はその明示状態を優先し、相反する状態を余力から追加しない。単なる疲労感・重さ・張り・だるさの申告はFATIGUED。程度の強調だけからSTRONG_OR_UNWELLにしない。STRONG_OR_UNWELLは強い疲労や体調不良が明示されている場合、または運動不能や実施困難な身体状態が明示されている場合に限る。RUNNING_REQUEST、LOAD_REDUCTION、FATIGUEではvalue自体が否定の結果を表すためpolarityは必ずAFFIRMED。疲れていない、疲労が抜けて回復しすぎている、身体が軽く動く、まだ動けそうという前向きな身体状態はFATIGUE=NOT_FATIGUEDとして保持し、疲労・不調・軽減希望に反転しない。動きや記録が進まないという訴えだけでは、原因を強い疲労・不調と断定しない。対応fieldに収まらなければunsupportedIntentsへ保持する。量や本数を少なくしてほしい希望はLOAD_REDUCTION=true、軽くしない・疲れていても通常の量で行うという明示希望はLOAD_REDUCTION=false。単なる軽め希望は通常の負荷軽減依頼として読み、強度だけを避けたいと明記された場合と区別する。きつさ・強度を避けたい希望は現在の負荷軽減policyと同一視せずunsupportedIntentsへ保持する。「疲労を溜めたい」は負荷軽減希望ではない。
各claimのsourceTextは原文中の連続した完全一致引用。短すぎず、その意味を判断できる前後の文脈を含める。numericPartsはそのclaimを支える数値のみ。rawTextは原文そのままの数字表記、unitは直後に原文で明記された単位を分類し、単位が書かれていなければNONE。数字がないclaimでは空配列。EVENTの値は「200m」のように正規化。TRAINING_DISTANCE/REPS/REST/AVAILABLE_TIME/COMPETITION_DAYSのvalueは正の整数。COMPETITION_DAYSは日単位の大会間隔だけ。大会までの分・時間は別の未対応文脈として保持し、利用可能な練習時間や日数に変換しない。大会までの日数は日数と確信できる場合だけclaimにし、誤字で単位が欠けた数値のroleを推測で確定しない。処方に使わない日程情報の不確かさだけで、明確な他の意図をAMBIGUOUSにしない。その部分をunsupportedIntentsへ保持する。相対的な暦の表現には数字を含まないものもあり、COMPETITION_DAYSではその場合numericPartsを空にする。RESTとAVAILABLE_TIMEは秒へ換算する。時間量は休憩・練習に使える時間枠・予定までの残時間のどれかが文脈で明確な場合だけ対応fieldへ入れる。用途が省略され複数のroleが自然に読める時間量をAVAILABLE_TIMEやRESTに確定せずAMBIGUOUSとして確認する。距離希望はSHORT/LONG、疲労はFATIGUED/NOT_FATIGUED/STRONG_OR_UNWELL、年齢区分はELEMENTARY/JUNIOR_HIGH/HIGH_SCHOOL/ADULT。trueでないLOAD_REDUCTIONはfalseとして表せる。長いものを嫌がるだけでは短め希望、短いものを嫌がるだけでは長め希望と断定しない。
対応済みfieldで表せないが意味のある希望はunsupportedIntentsへ短く要約し、原文引用も残す。ACTIVEかつAFFIRMEDの対応済みclaimで表現できる意味はunsupportedIntentsに重複させない。反対側の希望が明示されていない否定の距離制約は現policyで表せないため、NEGATED claimとともにunsupportedIntentsへも保持する。第三者の学年や同行者などの背景情報を、本人への条件や希望に変換しない。少し追加で走りたいという追加量の希望をSHORT距離希望へ変換しない。長い距離を避ける希望をSHORT距離希望へ、短い距離を避ける希望をLONG距離希望へ自動変換しない。セット数や目標タイムなど現adapterにない明示条件も、他の数値roleへ流さずここへ保持する。そこから処方を推測しない。数字だけなど役割が本当に曖昧な時だけAMBIGUOUSにして質問を一つ作る。この入力は走メニュー作成画面から来る。種目や年齢が未入力でも疲労状態や負荷希望が明確ならrequestKind=RUNNINGにして理解できたclaimを保持し、不足する種目・年齢は後段Engineに任せる。この画面で本人の競技プロフィールが明確なら、実施希望の述語がなくてもrequestKind=RUNNINGとする。練習内容の追加説明を解釈のための確認として要求せず、処方には後段Engineの既定policyを使う。明示された補強・ドリルのみならEXERCISE_ONLY。exerciseIdsは提供されたREVIEWED catalogからのみ選ぶ。` + EVENT_ROLE_CONTEXT + CLAIM_LIFECYCLE_CONTEXT;

const REVIEW = `あなたは一次解釈とは独立した意味監査者。目的は原文にない生成、意味矛盾、数値roleの取り違え、否定の反転、最終訂正の取り落としを発見すること。自分が好む言い換え・引用範囲・claimの粒度との完全一致は要求しない。妥当な原文解釈を表現差だけでrejectしない。値の正規化・時間量の秒換算、rawTextに原文の単位を含む引用と数字だけの引用は、数値・単位・roleが同じなら意味の差ではない。引用の文字列形式だけを理由にsupported=falseにしない。年齢区分などのカテゴリclaimには、学年の数値注釈を必須にしない。原文とclaimsを照合し、各claimのfield/value/sourceTextが原文に意味的に支持されるか判定する。引用に数字があっても役割を取り違えていたらsupported=false。時間量が休憩・練習時間枠・予定までの残時間のどれか判別できないのにRESTやAVAILABLE_TIMEに確定したclaimはsupported=false、ambiguityCorrect=false。競技への参加・専門種目は距離単位が省略されてもEVENT。今日の実施距離はTRAINING_DISTANCE。役割不明の将来予定の事実報告はAMBIGUOUS。原文が距離の実施を希望し、その条件を依頼・訂正している場合はTRAINING_DISTANCE。将来の競技予定を想像してその希望をAMBIGUOUSにしない。距離が直後の本数に結びつく場合はTRAINING_DISTANCEであり、EVENT claimを支持しない。否定、訂正、現在状態と希望を特に確認。FATIGUEのNOT_FATIGUEDは回復・軽い動き・運動余力という肯定的な自己申告として判定し、生理的疲労ゼロの断言を要求しない。現在の疲労の明示があればその状態を優先する。方言の否定形や身体が軽く動く肯定的状態を、負荷軽減や強い疲労に反転しない。動きが進まないだけで強い疲労・不調と断定しない。通常の疲労感や身体の重さ・張り・だるさ、程度の強調だけからSTRONG_OR_UNWELLにしない。強い疲労や体調不良、運動不能・実施困難が明示されている場合だけSTRONG_OR_UNWELLを支持する。軽めという通常の負荷希望はLOAD_REDUCTION=true。強度を避けたいと明記された希望は別の未対応intent。疲れていても通常の量で行いたい希望はLOAD_REDUCTION=false。少し追加で走りたいという希望はSHORT距離指定ではない。この入力は走メニュー作成画面から来る。種目や年齢が未入力でも明確な疲労状態や負荷希望をAMBIGUOUSにせず、後段Engineの不足入力として扱う。この画面で明確な競技プロフィールだけの入力もRUNNINGであり、練習内容の省略だけからAMBIGUOUSにしない。requestKindが原文の意味と合うかrequestKindSupportedで判定。assessmentsはclaimsと同じ順にindex 0始まりで返す。activeClaimIndexesには最終的に有効なACTIVE claimのindexを全て入れる。有効なNEGATED制約も含める。現在状態のNOT_FATIGUEDや明示されたLOAD_REDUCTION=falseも、訂正されていなければACTIVEに含める。policy adapterがnullにすることは除外理由ではない。除くのはSUPERSEDED claimだけ。correctionsの置換関係・最終状態が原文で裏付けられればcorrectionsSupported=true。関係の捏造、置換fieldの混同、有効な条件を撤回した扱いにする場合はfalse。単に原文に複数の距離や本数があるだけでは競合とせず、訂正後の条件を監査する。長いのを嫌がるだけでは短め希望が確定したとは限らない。原文に明示された練習距離・本数・休憩・軽減希望・軽減を断る希望・現在の疲労や回復状態・強い不調がclaimsから欠落し、意味を落としたまま通常処方へ進む場合はmissingCriticalClaim=true。未対応の強度希望、単位を確信できない大会日数、未対応のセット数はここに含めない。有効な否定制約がclaimsにもunsupportedIntentsにも残らない場合はmissingCriticalClaim=true。処方に使わない日程情報の不確かさだけを理由に明確な他の意図をAMBIGUOUSにした場合はambiguityCorrect=false。ambiguityCorrectは両方向で判定する。曖昧でない文章をAMBIGUOUSにした場合も、本当に競技と練習が両義なのに一方のroleで確定した場合もfalse。後者では数値claimのsupportedもfalseにする。unsupportedIntentsは原文の意味と明らかに矛盾する場合だけunsupportedIntentsSupported=false。処方数値を提案しない。` + EVENT_ROLE_CONTEXT + CLAIM_LIFECYCLE_CONTEXT;

export async function extractRunningSemanticIntentV2(
  input: { requestText: string; exercises: readonly { id: string; name: string; category: string }[] },
  options: Options = {},
): Promise<SemanticExtractionResult> {
  const extracted = await callRunningStructuredResponse(input, INTERPRET, SEMANTIC_INTENT_V2_OUTPUT_SCHEMA,
    "running_semantic_intent_v2", runningSemanticIntentV2Schema, options);
  if (!extracted.ok) return extracted;
  const preflight = verifyPrimarySemanticIntentV2(input.requestText, extracted.value, input.exercises.map(x => x.id));
  // Structural rejection and grounded ambiguity go directly to the UI. No model decides them again.
  if (preflight.ok || preflight.reason !== "SEMANTIC_REVIEW_REQUIRED") {
    return { ok: true, interpretation: extracted.value, review: null, numericRoleReview: null };
  }
  const reviewed = await callRunningStructuredResponse({ requestText: input.requestText, interpretation: extracted.value },
    REVIEW, SEMANTIC_REVIEW_V2_OUTPUT_SCHEMA, "running_semantic_review_v2", semanticReviewV2Schema, options);
  if (!reviewed.ok) return reviewed;
  return { ok: true, interpretation: extracted.value, review: reviewed.value, numericRoleReview: null };
}
