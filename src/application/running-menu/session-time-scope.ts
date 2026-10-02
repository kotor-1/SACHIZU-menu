/**
 * Conservative acceptance grammar, not a time-role extractor. Units alone do
 * not establish a session budget. A quantity needs an aggregate/session subject,
 * an availability restriction, or a completion predicate in the same clause.
 * Unrecognized wording is rejected, never converted to an item prescription.
 */
export function hasSessionTimeBasis(sourceText: string, rawParts: readonly string[]): boolean {
  if (!rawParts.length) return false;
  let offset = 0;
  let first = -1;
  for (const raw of rawParts) {
    const at = sourceText.indexOf(raw, offset);
    if (at < 0) return false;
    if (first < 0) first = at;
    offset = at + raw.length;
  }
  const prefix = sourceText.slice(0, first).replace(/\s/gu, "");
  // numericParts may quote a numeral with or without its written unit.
  const suffix = sourceText.slice(offset).replace(/\s/gu, "").replace(/^(?:時間|分|秒)/u, "");
  const sessionSubject = /(?:全体|全部|(?:練習|メニュー|セッション)(?:の)?時間)(?:は|を|が|で|:|：)?$/u.test(prefix);
  const availabilityRestriction = /^(?:しか(?:ない|なく|ありません)|だけ(?:ある|使える|取れる))/u.test(suffix);
  const completion = /^で(?:終(?:わ|え)|終了)/u.test(suffix);
  const sessionActivity = /^で(?:練習|メニュー|セッション)(?:したい|を(?:したい|組|作))/u.test(suffix);
  return sessionSubject || availabilityRestriction || completion || sessionActivity;
}
