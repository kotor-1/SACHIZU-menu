/**
 * Running Prescription Engine v2 — RationaleLine の日本語レンダラ（§1.4, §22 R4 完了条件）。
 *
 * 完了条件「rationale にエンジン内部の enum キーが出ない」を満たすため:
 *   - コードごとに自然文を組み立てる（コード名そのものは出さない）
 *   - params の enum 値はラベル表で必ず日本語へ変換し、表に無い値は汎用表現に落とす
 *     （未知の値を生のまま埋め込まない）
 *   - StopPolicy の `ruleDescriptionJa` は英語のアクションキー（EXTEND_REST 等）を
 *     含むため、そのまま表示しない（ここで独自に自然文化する。判定ロジックではない）
 */
import type { RationaleLine } from "../types/findings";
import type { RationaleCode } from "./codes";

const FIELD_LABEL_JA: Record<string, string> = {
  repDistanceM: "1本の距離",
  buildUpM: "助走（加速）区間",
  flyZoneM: "計測（フライ）区間",
  decelerationM: "減速区間",
  repDurationS: "1本の時間",
  repsPerSet: "1セットの本数",
  sets: "セット数",
  totalReps: "総本数",
  repRestS: "本間のレスト",
  setRestS: "セット間のレスト",
  intraRepRestS: "分割走の区間休息",
  sessionVolumeM: "この項目の総距離",
  flyVolumeM: "フライ区間の合計距離",
  intensityPercent: "強度（最高速度に対する割合）",
  attempts: "試技数",
  vdecPercent: "速度低下率",
  approachDistanceM: "助走距離",
};

const TIER_LABEL_JA: Record<string, string> = {
  DEVELOPMENTAL: "育成段階向けの範囲",
  ADVANCED: "上級者向けの範囲",
};

const POSITION_LABEL_JA: Record<string, string> = {
  LOWER_BOUND: "推奨範囲の下限",
  LOWER_HALF: "推奨範囲の下半分",
  MIDDLE: "推奨範囲の中央",
  UPPER_HALF: "推奨範囲の上半分",
};

const REFERENCE_LABEL_JA: Record<string, string> = {
  MAX_INTENT: "全力で走ること（数値の目標タイムは設けない）",
  MEASURED_VMAX: "測定された最高速度",
  FLY_SPLIT: "フライ区間の計測タイム",
  SAME_DISTANCE_BEST: "同じ距離の自己ベスト",
  RACE_PACE: "コーチが入力したレースペース",
  TARGET_SPLIT: "コーチが入力した目標スプリット",
  VELOCITY_DECREMENT: "負荷による速度低下の目安",
  RELAXED_SUBMAX: "リラックスして徐々に上げる走り（全力にしない）",
  COACH_DEFINED: "コーチが定義した強度",
};

const PRESCRIPTION_CONFIDENCE_LABEL_JA: Record<string, string> = {
  HIGH: "高",
  MODERATE: "中",
  LOW: "低",
  POLICY_ONLY: "暫定ルールのみ",
};

const DIRECTNESS_LABEL_JA: Record<string, string> = {
  DIRECT: "この選手に近い対象での知見",
  PARTIAL: "競技レベルが異なる対象での知見を含む",
  INDIRECT: "年齢・成熟度・競技が異なる対象での知見を含む",
  NOT_APPLICABLE: "研究ではなくアプリの運用方針のみ",
};

const INPUT_DATA_LABEL_JA: Record<string, string> = {
  HIGH: "十分",
  MEDIUM: "ある程度",
  LOW: "限られている",
  NONE: "無い",
  NOT_REQUIRED: "この方式では不要",
};

const RECOVERY_LABEL_JA: Record<string, string> = {
  FULL: "1本ごとに十分回復してから走る構成",
  INCOMPLETE: "回復が不完全なまま続けて走る分割走の構成",
};

const ELIGIBILITY_MODE_LABEL_JA: Record<string, string> = {
  AUTO: "この選手の年齢・成熟度・トレーニング歴の条件で自動作成が認められている方式です。",
  MANUAL: "この方式はコーチが明示的に選んだ場合にだけ使えます。",
  OVERRIDDEN: "本来は選べない条件ですが、コーチが理由を記録したうえで例外として選択しています。",
};

const STOP_POLICY_LABEL_JA: Record<string, string> = {
  SP_ACC: "同じ距離のその日のベストより明らかに遅い本が続いたら、その日の質の練習は終えます（1回目はレストを延ばして様子を見ます）。",
  SP_MV: "その日のフライ区間のベストより明らかに遅い本が続いたら、その日の質の練習は終えます（1回目はレストを延ばして様子を見ます）。",
  SP_SES: "目標から明らかに遅れた本が2回続いたら、その日の質の練習は終えます。",
  SP_LSR_FULL: "目標スプリットから明らかに遅れた本が2回続いたら、その日の練習は終えます。",
  SP_LSR_INCOMPLETE_ADV: "分割走の途中でタイムが落ちることは想定内として止めませんが、目標超過が2回続いたらコーチが確認します。痛みなどの安全上の中止基準は常に有効です。",
  SP_LSR_INCOMPLETE_STRICT: "分割走でも疲労を許容する扱いはせず、目標スプリットから明らかに遅れた本が2回続いたら練習を終えます。",
  SP_TE: "タイムによる自動の中止基準はありません。速く走りすぎる本が続いたらテンポ走の目的から外れている合図です。",
  SP_TI: "目標から明らかに遅れた本が2回続いたら、そのセットを終えます。",
  SP_RS: "速度低下の目安から外れたら、コーチが負荷を調整します。",
  SP_AS: "動きが崩れたら安全のためただちに中止します。",
  SP_EA: "中止の判断はコーチが行います。予定の試技数に達したら終えます。",
  SP_STRIDE: "タイムによる中止基準はありません。全力走になっているとコーチが判断したら見直します。",
};

const UNIT_LABEL_JA: Record<string, string> = {
  m: "m",
  s: "秒",
  reps: "本",
  sets: "セット",
  percent: "%",
};

function label(table: Record<string, string>, value: string | number | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return table[String(value)] ?? fallback;
}

function num(value: string | number | undefined): string {
  if (value === undefined) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function seconds(value: string | number | undefined): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n < 60) return `${num(n)}秒`;
  const m = Math.floor(n / 60);
  const s = Math.round(n - m * 60);
  return s === 0 ? `${m}分` : `${m}分${s}秒`;
}

type Params = Record<string, string | number> | undefined;

const RENDERERS: Record<RationaleCode, (p: Params) => string> = {
  RULESET_DRAFT: () => "この処方は、まだ正式版として確定していない暫定のルールセットに基づいています。",
  TEMPLATE_SELECTED: (p) => `練習の型は「${p?.templateLabelJa ?? "選択されたテンプレート"}」です。`,
  TIER: (p) => `数値は${label(TIER_LABEL_JA, p?.tier, "該当する範囲")}から決めています。`,
  ELIGIBILITY: (p) => {
    const base = label(ELIGIBILITY_MODE_LABEL_JA, p?.mode, "この方式の選択条件を確認しました。");
    return Number(p?.review) === 1 ? `${base}コーチによる確認が必要です。` : base;
  },
  ENVELOPE_EVIDENCE: (p) =>
    `使った推奨範囲のうち、文献・実践例に基づくものが${num(p?.sourceBacked)}項目、アプリの運用方針によるものが${num(p?.enginePolicy)}項目、根拠が未確定のものが${num(p?.open)}項目です。`,
  POSITION: (p) => `回数・距離・時間は${label(POSITION_LABEL_JA, p?.position, "推奨範囲の中")}を目安に置いています。`,
  POSITION_CAP_CONFIDENCE: (p) =>
    `処方の確からしさが「${label(PRESCRIPTION_CONFIDENCE_LABEL_JA, p?.confidence, "低")}」のため、推奨範囲の上側には置いていません。`,
  POSITION_CAP_PREFERENCE: () => "控えめな量の希望があったため、推奨範囲の下半分に置いています。",
  POSITION_CAP_ELIGIBILITY: () => "この選手の成熟度の条件では、推奨範囲の下半分までに限定しています。",
  COUNTS_RESOLVED: (p) =>
    p?.source === "COACH"
      ? `${num(p?.sets)}セット×${num(p?.repsPerSet)}本（合計${num(p?.totalReps)}本）です。回数はコーチの入力に基づいています。`
      : `${num(p?.sets)}セット×${num(p?.repsPerSet)}本（合計${num(p?.totalReps)}本）です。総本数と総距離が推奨範囲に収まる組み合わせのうち、セット数が最も少ないものにしています。`,
  STRUCTURAL_SINGLE_SET: () =>
    "この方式はセットで区切らないため、表示上は1セットとして表しています（セット数の推奨ではありません）。",
  TEMPLATE_FIXED_VALUE: (p) =>
    `${label(FIELD_LABEL_JA, p?.field, "この項目")}は練習の型で決まっているため${num(p?.value)}${label(UNIT_LABEL_JA, p?.unit, "")}にしています。`,
  COACH_MANUAL_INPUT: (p) => `${label(FIELD_LABEL_JA, p?.field, "この項目")}はコーチが入力した値です。`,
  COACH_OVERRIDE_APPLIED: (p) =>
    `${label(FIELD_LABEL_JA, p?.field, "この項目")}はコーチが理由を記録したうえで、通常の編集範囲の外の値にしています。`,
  REFERENCE: (p) => `強度の基準は${label(REFERENCE_LABEL_JA, p?.kind, "コーチの判断")}です。`,
  TARGET_INTERVAL: (p) => {
    const range =
      Number(p?.lower) === Number(p?.upper) ? `${num(p?.lower)}` : `${num(p?.lower)}〜${num(p?.upper)}`;
    if (p?.unit === "percent") return `強度の目安は${range}%です。`;
    return p?.source === "COACH_ENTERED"
      ? `1本の目標タイムはコーチが入力した${range}秒です。`
      : `1本の目標タイムは${range}秒の範囲です（記録の計時誤差と強度の幅を含め、外側に丸めています）。`;
  },
  NO_NUMERIC_TARGET: (p) =>
    `数値の目標タイムは出していません（強度の基準: ${label(REFERENCE_LABEL_JA, p?.kind, "コーチの判断")}）。`,
  CONFIDENCE: (p) =>
    `処方の確からしさは「${label(PRESCRIPTION_CONFIDENCE_LABEL_JA, p?.prescription, "低")}」です（根拠: ${label(DIRECTNESS_LABEL_JA, p?.directness, "運用方針")}／選手の記録データ: ${label(INPUT_DATA_LABEL_JA, p?.inputData, "限られている")}）。`,
  REST_FROM_ENVELOPE: (p) =>
    p?.setRestS !== undefined
      ? `レストは推奨範囲から決めており、本間は最低${seconds(p?.repRestS)}、セット間は最低${seconds(p?.setRestS)}空けます。`
      : `レストは推奨範囲から決めており、本間は最低${seconds(p?.repRestS)}空けます。`,
  REST_NOT_SHORTENED: () =>
    "レストは練習時間や人数に合わせて短くしていません。表示は「最低この時間は空ける」という意味です。",
  REST_EXCEEDS_AVAILABLE_TIME: (p) =>
    `必要なレスト（と時間が決まっている走り）だけで少なくとも${seconds(p?.minimumSeconds)}かかり、練習に使える時間（${num(p?.availableMinutes)}分）を超えます。本数や項目の見直しを検討してください（レストは短くしません）。`,
  DECELERATION_EXCLUDED: (p) =>
    `計測区間の後の減速区間（${num(p?.decelerationM)}m）は安全のための距離で、高速で走る量には数えていません。`,
  STRIDE_RELAXED: () => "流しはリラックスして徐々に上げる走りです。全力走や加速走としては扱いません。",
  LONG_RECOVERY_STRUCTURE: (p) => `この練習は${label(RECOVERY_LABEL_JA, p?.structure, "指定された回復の構成")}です。`,
  STOP_POLICY: (p) => label(STOP_POLICY_LABEL_JA, p?.stopPolicyId, "この方式の中止基準に従います。"),
  EXPOSURE_ESTIMATED: () =>
    "高速で走る距離は加速の個人差が大きいため、確定値ではなく推定の幅（わからない側は空欄）で扱っています。",
  PHASE_NOT_EVALUATED: () => "期分けや大会日程による調整は、この段階ではまだ反映していません。",
  WEEKLY_NOT_EVALUATED: () => "直近の練習や試合の負荷による調整は、この段階ではまだ反映していません。",
  READINESS_NOT_EVALUATED: () => "当日の体調・痛みの確認による調整は、この段階ではまだ反映していません。",
};

/** RationaleLine[] を日本語の文の配列に変換する。未知のコードは内部キーを出さずに汎用文にする。 */
export function renderRationaleJa(lines: readonly RationaleLine[]): string[] {
  return lines.map((line) => {
    const renderer = (RENDERERS as Record<string, ((p: Params) => string) | undefined>)[line.code];
    return renderer ? renderer(line.params) : "（この根拠の表示にはまだ対応していません）";
  });
}
