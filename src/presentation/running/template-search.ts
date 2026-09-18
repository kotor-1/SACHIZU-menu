/**
 * Running Prescription Engine v2 — R10-B3 template picker の検索（client でも使う純粋関数）。
 *
 * 検索対象は SessionTemplate の日本語名（labelJa）と coachingAliases だけ。内部の Method / template id は
 * 検索語にも表示にも使わない。domain の schema を import しない（client bundle を軽く保つ）。
 */
import type { RunningTemplateGroupDto } from "./dto";

export function normalizeSearchText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

export function filterTemplateGroups(groups: readonly RunningTemplateGroupDto[], query: string): RunningTemplateGroupDto[] {
  const q = normalizeSearchText(query);
  if (q === "") return [...groups];
  return groups
    .map((g) => ({ ...g, options: g.options.filter((o) => [o.label, ...o.aliases].some((text) => normalizeSearchText(text).includes(q))) }))
    .filter((g) => g.options.length > 0);
}
