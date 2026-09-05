import type { z } from "zod";

export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * URL のクエリを検索条件に変換する。
 *
 * 手打ちや古いブックマークで不正な値が来ても 500 にせず、既定の条件へ落とす。
 * `arrayKeys` に挙げたキーは、1 個でも複数でも配列に正規化する。
 */
export function parseSearchParams<S extends z.ZodTypeAny>(
  schema: S,
  raw: RawSearchParams,
  arrayKeys: string[] = [],
): z.infer<S> {
  const normalized: RawSearchParams = { ...raw };
  for (const key of arrayKeys) {
    const value = raw[key];
    normalized[key] = value === undefined ? [] : Array.isArray(value) ? value : [value];
  }

  const parsed = schema.safeParse(normalized);
  if (parsed.success) return parsed.data;

  // 不正な値は捨てて、既定値だけで組み直す
  return schema.parse(
    Object.fromEntries(arrayKeys.map((k) => [k, [] as string[]])),
  );
}

/** ページ送りリンク用に、page を除いた現在のクエリを組み直す。 */
export function toBaseParams(raw: RawSearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (key === "page" || value === undefined) continue;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else params.set(key, value);
  }
  return params;
}
