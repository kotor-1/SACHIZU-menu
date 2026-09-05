/**
 * ドメイン全体で共有する列挙値。
 *
 * SQLite は enum を持てないため DB 上は String で保存し、
 * 型の正しさはこの const union で担保する。
 * PostgreSQL へ移行する際は、ここの値をそのまま enum 定義に写せる。
 */

// --- レビュー状態 -----------------------------------------------------------
// AI 下書き由来のデータを「未確認」のまま扱うために必要。
export const REVIEW_STATUSES = ["DRAFT", "REVIEWED", "ARCHIVED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  DRAFT: "下書き",
  REVIEWED: "確認済み",
  ARCHIVED: "アーカイブ",
};

// --- データの出どころ -------------------------------------------------------
export const CONTENT_SOURCES = ["MANUAL", "AI_DRAFT", "IMPORTED"] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

export const CONTENT_SOURCE_LABEL: Record<ContentSource, string> = {
  MANUAL: "手動登録",
  AI_DRAFT: "AI下書き由来",
  IMPORTED: "インポート",
};

/** Phase 1 は単一コーチ運用。将来のマルチユーザー化に備えて 1 箇所に閉じ込めておく。 */
export const DEFAULT_OWNER_ID = "default-coach";
