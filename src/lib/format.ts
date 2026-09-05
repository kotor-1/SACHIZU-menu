const DATE_FMT = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "short",
  day: "numeric",
  weekday: "short",
});

const DATE_SHORT_FMT = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
});

export function formatDate(date: Date): string {
  return DATE_FMT.format(date);
}

export function formatDateShort(date: Date): string {
  return DATE_SHORT_FMT.format(date);
}

/** <input type="date"> に入れる YYYY-MM-DD（ローカル時刻基準）。 */
export function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayInputValue(): string {
  return toDateInputValue(new Date());
}

/** 「3日前」「今日」など。一覧の補助表示用。 */
export function relativeDays(date: Date): string {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(date) - startOf(new Date())) / 86_400_000);
  if (diff === 0) return "今日";
  if (diff === 1) return "明日";
  if (diff === -1) return "昨日";
  return diff > 0 ? `${diff}日後` : `${-diff}日前`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}分`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}
