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
import { daysBetween } from "./dateMath";

// ---------------------------------------------------------------------------
// Growth velocity（§4.3 rapidGrowthFlag の CHECK_ONLY 算出根拠）
// ---------------------------------------------------------------------------

export type HeightHistoryPoint = { date: IsoDate; heightCm: number };

/**
 * [ENGINE-POLICY / provisional] 「6か月以上間隔」の日数近似。暦月の厳密な
 * 6か月ではなく 182 日（≈365/2）を採用する。research-backed な閾値ではない。
 */
const MIN_GROWTH_INTERVAL_DAYS = 182;

/**
 * [CHECK_ONLY / provisional — secondary-report-derived]
 * 年間成長速度 > 7.2 cm/年を rapidGrowthFlag として記録する（Claude DR の
 * narrative review 由来）。これは male academy football の risk marker を
 * 監査・コーチ確認へ渡すための値であり、医学的診断値、hard stop、eligibility
 * cutoff、または自動的な maturity/tier 変更ではない。`>` であって `>=` ではない。
 */
export const RAPID_GROWTH_THRESHOLD_CM_PER_YEAR = 7.2;

export type GrowthVelocityResult =
  | { available: true; cmPerYear: number; oldest: HeightHistoryPoint; newest: HeightHistoryPoint }
  | { available: false; reason: "NO_HEIGHT_HISTORY" | "INSUFFICIENT_VALID_POINTS" | "INTERVAL_TOO_SHORT" };

export type HeightHistorySelection = {
  /** The exact endpoints used by growth calculation; empty unless the required span exists. */
  endpoints: readonly HeightHistoryPoint[];
  futurePoints: readonly HeightHistoryPoint[];
  unusedPastPoints: readonly HeightHistoryPoint[];
  reason: "AVAILABLE" | "NO_HEIGHT_HISTORY" | "INSUFFICIENT_VALID_POINTS" | "INTERVAL_TOO_SHORT";
};

/** Shared, date-aware endpoint selector for both maturity and F16 input assessment. */
export function selectHeightHistoryForGrowth(
  heightHistory: readonly HeightHistoryPoint[] | undefined,
  asOf: IsoDate,
): HeightHistorySelection {
  if (!heightHistory || heightHistory.length === 0) {
    return { endpoints: [], futurePoints: [], unusedPastPoints: [], reason: "NO_HEIGHT_HISTORY" };
  }
  const futurePoints = heightHistory.filter((point) => point.date > asOf);
  const past = heightHistory.map((point, index) => ({ point, index })).filter(({ point }) => point.date <= asOf);
  if (past.length < 2) {
    return { endpoints: [], futurePoints, unusedPastPoints: past.map(({ point }) => point), reason: "INSUFFICIENT_VALID_POINTS" };
  }
  const sorted = [...past].sort((a, b) => (a.point.date < b.point.date ? -1 : a.point.date > b.point.date ? 1 : a.index - b.index));
  const oldest = sorted[0]!;
  const newest = sorted[sorted.length - 1]!;
  const days = daysBetween(oldest.point.date, newest.point.date);
  if (days < MIN_GROWTH_INTERVAL_DAYS) {
    return { endpoints: [], futurePoints, unusedPastPoints: past.map(({ point }) => point), reason: "INTERVAL_TOO_SHORT" };
  }
  const endpointIndices = new Set([oldest.index, newest.index]);
  return {
    endpoints: [oldest.point, newest.point],
    futurePoints,
    unusedPastPoints: past.filter(({ index }) => !endpointIndices.has(index)).map(({ point }) => point),
    reason: "AVAILABLE",
  };
}

/**
 * [DEVIATION] 正式仕様は heightHistory が複数点あるときの集計方法を
 * 定義していない。F1では input policy と同じ date-aware selector で選んだ
 * **最古点と最新点の2点だけ**を使って年換算成長速度を計算する
 * （隠れた回帰・平滑化・複数区間の重み付け平均などは行わない）。
 */
export function computeGrowthVelocity(
  heightHistory: readonly HeightHistoryPoint[] | undefined,
  asOf: IsoDate,
): GrowthVelocityResult {
  const selection = selectHeightHistoryForGrowth(heightHistory, asOf);
  if (selection.reason !== "AVAILABLE") return { available: false, reason: selection.reason };
  const oldest = selection.endpoints[0]!;
  const newest = selection.endpoints[1]!;
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
    // E15: growth velocity は CHECK_ONLY。申告された maturity category や
    // confidence から決まった category を、成長速度だけで置換しない。
    constraintCategory: constraintCategoryIfNotRapid,
  };
}

/**
 * §4.3/§4.4 の正規化。`schoolGrade` は引数にすら取らない（誤って参照する
 * ことを構造的に防ぐ）。
 */
export function normalizeMaturity(input: MaturityNormalizationInput): NormalizedMaturity {
  const { ageBand, maturity, asOf } = input;

  // rapidGrowthFlag は method に関わらず heightHistory から独立に評価する。
  // E15ではCHECK_ONLYの監査情報として保持し、eligibility/tierの入力にはしない。
  const growth = computeGrowthVelocity(maturity.heightHistory, asOf);
  const growthVelocityCmPerYear = growth.available ? growth.cmPerYear : null;
  const rapidGrowthFlag = growth.available && growth.cmPerYear > RAPID_GROWTH_THRESHOLD_CM_PER_YEAR;

  // ADULT: ENGINE-POLICY で常に POST/HIGH（申告値・method に関わらず）。
  // rapidGrowthFlag が true でも normalizedStatus / constraintCategory は変更しない。
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
