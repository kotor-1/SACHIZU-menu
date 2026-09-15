/**
 * Running Prescription Engine v2 — Maturity normalization（§4.3, §4.4）。
 *
 * 絶対にしないこと（R3 の最重要禁止事項）:
 *   - Mirwald 式・PHV 推定・身長/脚長/座高/年齢からの成長算出は実装しない
 *     （§4.3「Mirwald 等の推定式は v2 初期ルールセットに実装しない」）。
 *     `equation.offsetYears` は外部から入力済みの値をそのまま保持できるが、
 *     それを使って PRE/CIRCA/POST を自動算出することはしない
 *     （confidence は最大 MEDIUM に留める）。
 *   - `schoolGrade` を一切参照しない（DR 全件一致の禁止事項。§4.2）。
 *   - 「本人が PRE/CIRCA/POST と申告したから」だけで method=NONE の場合に
 *     その値を信用しない（§4.3 のケース NONE→UNKNOWN 強制）。
 */
import type { MaturityAssessment, MaturityConfidence, MaturityStatus } from "../types/subject";
import type { IsoDate } from "../types/primitives";
import type { RuleSet } from "../rules/schema";
import type { ResolvedAgeBand } from "./ageBand";
import { CONTEXT_PLAUSIBILITY_RULE_IDS, evaluateInputPlausibility } from "./plausibility";
import { daysBetween } from "./dateMath";

// ---------------------------------------------------------------------------
// Growth velocity（§4.3 rapidGrowthFlag の算出根拠）
// ---------------------------------------------------------------------------

export type HeightHistoryPoint = { date: IsoDate; heightCm: number };

/**
 * [ENGINE-POLICY / provisional] 「6か月以上間隔」の日数近似。暦月の厳密な
 * 6か月ではなく 182 日（≈365/2）を採用する。research-backed な閾値ではない。
 */
const MIN_GROWTH_INTERVAL_DAYS = 182;

/**
 * [ENGINE-POLICY / provisional — secondary-report-derived]
 * 年間成長速度 > 7.2 cm/年 を rapidGrowthFlag の閾値とする（Claude DR の
 * narrative review 由来。§4.3）。医学的診断値ではない。`>` であって `>=`
 * ではない（仕様の表現どおり）。
 */
export const RAPID_GROWTH_THRESHOLD_CM_PER_YEAR = 7.2;

export type GrowthVelocityResult =
  | { available: true; cmPerYear: number; oldest: HeightHistoryPoint; newest: HeightHistoryPoint }
  | { available: false; reason: "NO_HEIGHT_HISTORY" | "INSUFFICIENT_VALID_POINTS" | "INTERVAL_TOO_SHORT" };

/**
 * [DEVIATION] 正式仕様は heightHistory が複数点あるときの集計方法を
 * 定義していない。R3 では ENGINE-POLICY として最小限の決定的な方法を採る:
 * BLOCK plausibility の点・未来日付の点を除外した「有効な点」のうち
 * **最古点と最新点の2点だけ**を使って年換算成長速度を計算する
 * （隠れた回帰・平滑化・複数区間の重み付け平均などは行わない）。
 */
export function computeGrowthVelocity(
  heightHistory: readonly HeightHistoryPoint[] | undefined,
  asOf: IsoDate,
  ruleSet: RuleSet,
): GrowthVelocityResult {
  if (!heightHistory || heightHistory.length === 0) {
    return { available: false, reason: "NO_HEIGHT_HISTORY" };
  }
  const validPoints = heightHistory.filter((p) => {
    if (p.date > asOf) return false; // 未来の記録は使わない（§4.6 と同じ方針）
    return evaluateInputPlausibility(ruleSet, CONTEXT_PLAUSIBILITY_RULE_IDS.HEIGHT, p.heightCm) !== "BLOCK";
  });
  if (validPoints.length < 2) {
    return { available: false, reason: "INSUFFICIENT_VALID_POINTS" };
  }
  const sorted = [...validPoints].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const days = daysBetween(oldest.date, newest.date);
  if (days < MIN_GROWTH_INTERVAL_DAYS) {
    return { available: false, reason: "INTERVAL_TOO_SHORT" };
  }
  const cmPerYear = ((newest.heightCm - oldest.heightCm) / days) * 365;
  return { available: true, cmPerYear, oldest, newest };
}

// ---------------------------------------------------------------------------
// Confidence cap（§4.3 の method 別上限）
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: Record<MaturityConfidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function capConfidence(value: MaturityConfidence, cap: MaturityConfidence): MaturityConfidence {
  return CONFIDENCE_ORDER[value] <= CONFIDENCE_ORDER[cap] ? value : cap;
}

// ---------------------------------------------------------------------------
// NormalizedMaturity
// ---------------------------------------------------------------------------

/**
 * §4.4 の実効カテゴリ（PRE / EFFECTIVE_UNKNOWN / CIRCA / POST）。
 *
 * [DEVIATION] §4.4 は「status=UNKNOWN または confidence=LOW → EFFECTIVE_UNKNOWN
 * （status=POST & confidence=LOW も含む）」と書いているが、表のヘッダーは
 * 「POST（≥MEDIUM）」とだけ confidence条件を明示しており、PRE/CIRCA 列には
 * confidence条件が付いていない。額面どおり「confidence=LOW なら常に
 * EFFECTIVE_UNKNOWN」と読むと、PRE（既に最も保守的な区分）が confidence=LOW
 * のときに EFFECTIVE_UNKNOWN へ「格上げ」され、Method によっては
 * （例: SPRINT_ENDURANCE_SHORT は PRE=不適格・EFFECTIVE_UNKNOWN=手動+REVIEW）
 * 意図に反して制約が緩む逆転が起きる。本実装は表のヘッダー表記を優先し、
 * **confidence による格下げは POST 判定のときだけ適用する**
 * （PRE・CIRCA は confidence に関わらずそのまま）。
 */
export type MaturityConstraintCategory = "PRE" | "EFFECTIVE_UNKNOWN" | "CIRCA" | "POST";

export type NormalizedMaturity = {
  /** 申告された（生の）status/confidence。表示・監査用にそのまま残す。 */
  declaredStatus: MaturityStatus;
  declaredConfidence: MaturityConfidence;
  method: MaturityAssessment["method"];
  /** method=NONE、または GROWTH_VELOCITY でデータ不十分なら "UNKNOWN" に強制。 */
  normalizedStatus: MaturityStatus;
  /** ageBand=ADULT のときのみ HIGH になりうる。それ以外は最大 MEDIUM。 */
  effectiveConfidence: MaturityConfidence;
  rapidGrowthFlag: boolean;
  /** 参考値。医学的診断値ではない（provisional）。算出不能なら null。 */
  growthVelocityCmPerYear: number | null;
  /** Eligibility / Constraint 解決に使う実効カテゴリ。 */
  constraintCategory: MaturityConstraintCategory;
};

export type MaturityNormalizationInput = {
  ageBand: ResolvedAgeBand;
  maturity: MaturityAssessment;
  asOf: IsoDate;
  ruleSet: RuleSet;
};

function resultWith(
  input: MaturityNormalizationInput,
  normalizedStatus: MaturityStatus,
  effectiveConfidence: MaturityConfidence,
  rapidGrowthFlag: boolean,
  growthVelocityCmPerYear: number | null,
  constraintCategoryIfNotRapid: MaturityConstraintCategory,
): NormalizedMaturity {
  return {
    declaredStatus: input.maturity.status,
    declaredConfidence: input.maturity.confidence,
    method: input.maturity.method,
    normalizedStatus,
    effectiveConfidence,
    rapidGrowthFlag,
    growthVelocityCmPerYear,
    constraintCategory: rapidGrowthFlag ? "CIRCA" : constraintCategoryIfNotRapid,
  };
}

/**
 * §4.3/§4.4 の正規化。`schoolGrade` は引数にすら取らない（誤って参照する
 * ことを構造的に防ぐ）。
 */
export function normalizeMaturity(input: MaturityNormalizationInput): NormalizedMaturity {
  const { ageBand, maturity, asOf, ruleSet } = input;

  // rapidGrowthFlag は method に関わらず heightHistory から独立に評価する
  // （§4.3: 「flag=true のとき、申告 status に関係なく CIRCA の制約を適用」）。
  const growth = computeGrowthVelocity(maturity.heightHistory, asOf, ruleSet);
  const growthVelocityCmPerYear = growth.available ? growth.cmPerYear : null;
  const rapidGrowthFlag = growth.available && growth.cmPerYear > RAPID_GROWTH_THRESHOLD_CM_PER_YEAR;

  // ADULT: ENGINE-POLICY で常に POST/HIGH（申告値・method に関わらず）。
  // rapidGrowthFlag が true でも normalizedStatus は POST のまま
  // （raw/resolved maturity と constraint category を混同しない。§4.3 要件）。
  if (ageBand === "ADULT") {
    return resultWith(input, "POST", "HIGH", rapidGrowthFlag, growthVelocityCmPerYear, "POST");
  }

  // method=NONE → normalized status=UNKNOWN・confidence=LOW（申告を信用しない）。
  if (maturity.method === "NONE") {
    return resultWith(input, "UNKNOWN", "LOW", rapidGrowthFlag, growthVelocityCmPerYear, "EFFECTIVE_UNKNOWN");
  }

  // GROWTH_VELOCITY だがデータ不十分 → method=NONE と同様、UNKNOWN/LOW に落とす
  // （confidence を MEDIUM へ上げない。§4.3 の「有効な履歴条件」を満たさない場合）。
  if (maturity.method === "GROWTH_VELOCITY" && !growth.available) {
    return resultWith(input, "UNKNOWN", "LOW", rapidGrowthFlag, growthVelocityCmPerYear, "EFFECTIVE_UNKNOWN");
  }

  // 残り: COACH_OBSERVATION / PARENT_REPORT / MATURITY_OFFSET_EQUATION /
  // 十分なデータのある GROWTH_VELOCITY。
  // ageBand≠ADULT なので confidence は最大 MEDIUM（HIGH は ADULT のみ）。
  // MATURITY_OFFSET_EQUATION でも equation.offsetYears から status を
  // 自動算出しない（保持のみ。Mirwald 式は実装しない）。
  const effectiveConfidence = capConfidence(maturity.confidence, "MEDIUM");
  const normalizedStatus = maturity.status;

  let constraintCategory: MaturityConstraintCategory;
  switch (normalizedStatus) {
    case "UNKNOWN":
      constraintCategory = "EFFECTIVE_UNKNOWN";
      break;
    case "POST":
      constraintCategory = effectiveConfidence === "LOW" ? "EFFECTIVE_UNKNOWN" : "POST";
      break;
    case "PRE":
      constraintCategory = "PRE";
      break;
    case "CIRCA":
      constraintCategory = "CIRCA";
      break;
  }

  return resultWith(
    input,
    normalizedStatus,
    effectiveConfidence,
    rapidGrowthFlag,
    growthVelocityCmPerYear,
    constraintCategory,
  );
}
