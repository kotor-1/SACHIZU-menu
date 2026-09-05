import type { ExerciseDraftPayload } from "./draft-schema";

/**
 * ============================================================================
 * AI 拡張ポイント（Phase 2 の差し替え口）
 * ============================================================================
 *
 * Phase 2 でやりたいこと:
 *   動画 → 動作内容を言語化 → メニュー情報を AI が下書き → コーチが修正 → 登録
 *
 * その「動画 → 下書き」の 1 手だけをこのインターフェースに閉じ込めてある。
 * アプリの他の層は VideoAnalyzer 型しか知らないので、
 * Qwen を追加するときに必要なのは
 *
 *   1. QwenVideoAnalyzer を実装する（このファイルは変更不要）
 *   2. src/domain/ai/analyzer.ts の getVideoAnalyzer() の返り値を差し替える
 *
 * の 2 つだけで済む。DB 側（VideoAsset / AnalysisJob / ExerciseDraft）と
 * 確定導線（下書き → Exercise 作成フォーム prefill → 登録）は Phase 1 で
 * 既に用意してあるため、スキーマ変更も画面の作り直しも発生しない。
 */

export type VideoAnalysisInput = {
  /** 解析対象の動画。ローカルパスでも署名付き URL でも良いよう抽象化する。 */
  videoUrl: string;
  mimeType?: string;
  durationSeconds?: number | null;
  /** コーチが与える補足プロンプト（「ハードルドリルです」など）。 */
  hint?: string | null;
};

export type VideoAnalysisResult = {
  draft: ExerciseDraftPayload;
  /** 0.0 〜 1.0。モデルが返さない場合は null。 */
  confidence: number | null;
  /** 監査・再解析のためにモデルの生出力を必ず残す。 */
  rawOutput: string;
  provider: string;
  model: string;
};

export interface VideoAnalyzer {
  readonly provider: string;
  readonly model: string;
  /** 利用可能か（API キー未設定なら false）。UI のボタン活性判定に使う。 */
  isAvailable(): boolean;
  analyze(input: VideoAnalysisInput): Promise<VideoAnalysisResult>;
}

/** アナライザ未設定時に投げるエラー。UI はこれを掴んで案内文を出す。 */
export class AnalyzerNotConfiguredError extends Error {
  constructor(message = "動画解析AIはまだ設定されていません（Phase 2 で追加予定です）") {
    super(message);
    this.name = "AnalyzerNotConfiguredError";
  }
}
