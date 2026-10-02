/** Rebind whitespace differences only. No Unicode folding, punctuation repair or paraphrase. */
export function resolveWhitespaceQuote(source: string, quote: string): { sourceText: string; start: number; end: number } | null {
  let compact = "";
  const positions: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (/\s/u.test(source[index])) continue;
    compact += source[index];
    positions.push(index);
  }
  const needle = quote.replace(/\s/gu, "");
  if (!needle) return null;
  const at = compact.indexOf(needle);
  // Even an exact quote cannot identify a span if its whitespace-equivalent
  // form occurs elsewhere. Do not silently pick the first occurrence.
  if (at < 0 || compact.indexOf(needle, at + 1) >= 0) return null;
  const start = positions[at];
  const end = positions[at + needle.length - 1] + 1;
  return { sourceText: source.slice(start, end), start, end };
}
