/** UI文字列を正式schemaへ渡す前の機械的変換。domainの閾値・補完は持たない。 */
export function parseOptionalNumberInput(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

/** 必須欄の空文字を0へ変換しない。NaNは後段の正式schemaが拒否する。 */
export function parseRequiredNumberInput(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}
