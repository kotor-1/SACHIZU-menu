import {
  AnalyzerNotConfiguredError,
  type VideoAnalysisInput,
  type VideoAnalysisResult,
  type VideoAnalyzer,
} from "./ports";

/**
 * Phase 1 の既定実装。常に「未設定」として振る舞う。
 *
 * これがあることで、UI とサーバーアクションは
 * 「解析機能が存在する前提」のコードを今から書ける。
 * Phase 2 では QwenVideoAnalyzer に置き換えるだけで動き出す。
 */
class NullVideoAnalyzer implements VideoAnalyzer {
  readonly provider = "none";
  readonly model = "none";

  isAvailable(): boolean {
    return false;
  }

  async analyze(_input: VideoAnalysisInput): Promise<VideoAnalysisResult> {
    void _input;
    throw new AnalyzerNotConfiguredError();
  }
}

let cached: VideoAnalyzer | null = null;

/**
 * 唯一の取得口。
 *
 * Phase 2 の追加手順:
 *   1. src/infra/ai/qwen-analyzer.ts に QwenVideoAnalyzer を実装
 *   2. 下の分岐に `if (process.env.QWEN_API_KEY) return new QwenVideoAnalyzer()` を足す
 * これ以外の変更は不要。
 */
export function getVideoAnalyzer(): VideoAnalyzer {
  if (!cached) {
    cached = new NullVideoAnalyzer();
  }
  return cached;
}

/** テスト用の差し替え口。 */
export function setVideoAnalyzer(analyzer: VideoAnalyzer | null): void {
  cached = analyzer;
}
