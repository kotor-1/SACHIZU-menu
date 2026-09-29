/** Text evidence only: these roles never select a training prescription. */
export type NumericRole = "EVENT_DISTANCE" | "TRAINING_DISTANCE" | "REPS" | "REST" | "TIME_AVAILABLE" | "COMPETITION_DAYS" | "OTHER";
export type NumericEvidence = { role: NumericRole; value: number; start: number; end: number };
export const normalizeIntentText = (text: string) => text.normalize("NFKC").replace(/\s+/gu, "");

/** Offsets refer to normalized text; the original sourceText is retained by the verifier. */
export function numericEvidence(text: string): NumericEvidence[] {
  const input = normalizeIntentText(text);
  const evidence: NumericEvidence[] = [];
  for (const match of input.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(メートル|m|本|時間|分|秒|日|年)?/giu)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = input.slice(0, start).split(/[。、,.!?！？\n]/u).at(-1) ?? "";
    const after = input.slice(end).split(/[。、,.!?！？\n]/u)[0];
    const unit = match[2]?.toLowerCase();
    let value = Number(match[1]);
    let role: NumericRole = "OTHER";
    if (unit === "m" || unit === "メートル") {
      // Race participation and specialty are events, including a quoted bare
      // distance whose surrounding words were omitted by the extractor.
      if (/^(?:選手|が専門|専門|種目|の(?:レース|試合|大会|競技)|に(?:出場|出ます|出る|エントリー)|を専門)/u.test(after)
        || /(?:種目|専門)(?:は|が|:)?$/u.test(before)
        || (start === 0 && /^。今日は/u.test(input.slice(end)))) {
        role = "EVENT_DISTANCE";
      } else if (/^(?:を(?:走|や|\d+本)|で(?:走|練習|や|お願い)|中心|走|やりたい|にする|[×x]\d|\d+本)/iu.test(after)
        || /(?:今日(?:は|の練習は)?|練習は|走る距離は)$/u.test(before)
        || (before === "" && /^(?:で)?$/u.test(after))) {
        role = "TRAINING_DISTANCE";
      } else if (/(?:小学生|小学\d+年|中学生|中学\d+年|高校生|高校\d+年|成人)$/u.test(before)) {
        role = "EVENT_DISTANCE";
      }
    } else if (unit === "本") {
      if (!/^(?:ごと|毎|あたり|目)/u.test(after)) role = "REPS";
    } else if (unit === "日" && (/(?:あと|まで)$/u.test(before) || /(?:試合|大会|レース)/u.test(before + after))) {
      role = "COMPETITION_DAYS";
    } else if (unit === "時間" || unit === "分" || unit === "秒") {
      value *= { 時間: 3600, 分: 60, 秒: 1 }[unit];
      if (/(?:休憩|レスト|本間)(?:は|を|が|:)?$/u.test(before) || /^(?:の)?(?:休憩|レスト)/u.test(after)) role = "REST";
      else if (/(?:練習時間|利用可能時間|あと)(?:は|が|:)?$/u.test(before) || (unit !== "秒" && /^(?:で|しか|以内|だけ)/u.test(after))) role = "TIME_AVAILABLE";
    }
    evidence.push({ role, value, start, end });
  }
  return evidence;
}

/** A source quote must contain an occurrence with this role in the full input.
 * Checking the quote alone would accept "200m" clipped from "200mのレース".
 */
export function hasNumericEvidence(inputText: string, sourceText: string, role: NumericRole, value: number): boolean {
  const input = normalizeIntentText(inputText);
  const source = normalizeIntentText(sourceText);
  if (source.length === 0) return false;
  const matches = numericEvidence(input).filter((entry) => entry.role === role && entry.value === value);
  for (let at = input.indexOf(source); at !== -1; at = input.indexOf(source, at + 1)) {
    if (matches.some((entry) => entry.start >= at && entry.end <= at + source.length)) return true;
  }
  return false;
}

// A recovered state or a wish to accumulate fatigue is not a fatigue report.
export function hasReportedFatigue(text: string): boolean {
  return /疲れて(?:いる|います|る)|疲れた|疲労(?:が|は|を)(?:残|溜ま|たま|蓄積|感じ|ある|あります)|疲労あり|疲労感がある/u.test(normalizeIntentText(text));
}
