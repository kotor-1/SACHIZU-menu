export const AI_REASON_MAX_CHARACTERS = 300;
export const AI_REASON_SANITIZED = "AI_REASON_SANITIZED" as const;

export type AiReasonSanitizationResult =
  | {
      ok: true;
      reason: string;
      sanitized: false;
      findings: [];
    }
  | {
      ok: true;
      reason: string;
      sanitized: true;
      findings: [typeof AI_REASON_SANITIZED];
    }
  | {
      ok: false;
      kind: "INVALID_REASON";
    };

const CONTROL_OR_BIDI_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const HTML_PATTERN = /<\/?[a-z][^>]*>/iu;
const MARKDOWN_OR_CODE_PATTERN = /```|`|\[[^\]]*\]\([^)]*\)/u;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/iu;
const NUMERIC_DOSE_PATTERN =
  /[\p{N}一二三四五六七八九十百千万〇零]+(?:[.,][\p{N}]+)?\s*(?:m|km|メートル|秒|分|時間|本|回|セット|sets?|reps?|%|％|kg|キロ|m\/s|秒\/本)/iu;
const ROLE_IMPERSONATION_PATTERN =
  /(?:^|\s)(?:system|developer|assistant|システム|開発者|アシスタント)\s*[:：]/iu;
const INSTRUCTION_OVERRIDE_PATTERN =
  /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?|system\s+prompt|override\s+(?:the\s+)?system|以前の指示を無視|前の指示を無視|システムプロンプト|命令を上書き)/iu;
const SOURCE_LIKE_PATTERN =
  /(?:et\s+al\.?|doi\b|論文|研究によると|エビデンス|evidence|meta-analysis|メタ分析)/iu;
const STOP_INSTRUCTION_PATTERN = /フォーム.*(?:崩|乱).*(?:中止|終了|やめ)/u;

function splitSentences(value: string): string[] {
  return (
    value.match(/.*?(?:[。！？]+|[.!?]+(?=\s|$)|[\r\n]+|$)/gu) ?? []
  ).map((sentence) => sentence.trim());
}

function isProhibitedSentence(sentence: string): boolean {
  return (
    CONTROL_OR_BIDI_PATTERN.test(sentence) ||
    HTML_PATTERN.test(sentence) ||
    MARKDOWN_OR_CODE_PATTERN.test(sentence) ||
    URL_PATTERN.test(sentence) ||
    NUMERIC_DOSE_PATTERN.test(sentence) ||
    ROLE_IMPERSONATION_PATTERN.test(sentence) ||
    INSTRUCTION_OVERRIDE_PATTERN.test(sentence) ||
    SOURCE_LIKE_PATTERN.test(sentence) ||
    STOP_INSTRUCTION_PATTERN.test(sentence)
  );
}

export function sanitizeAiReason(rawReason: string): AiReasonSanitizationResult {
  if (rawReason.length > AI_REASON_MAX_CHARACTERS) {
    return { ok: false, kind: "INVALID_REASON" };
  }

  const normalized = rawReason.normalize("NFKC").trim();
  const keptSentences = splitSentences(normalized).filter(
    (sentence) => sentence.length > 0 && !isProhibitedSentence(sentence),
  );
  const reason = keptSentences.join(" ").replace(/\s+/gu, " ").trim();
  const sanitized = reason !== rawReason;

  return sanitized
    ? {
        ok: true,
        reason,
        sanitized: true,
        findings: [AI_REASON_SANITIZED],
      }
    : { ok: true, reason, sanitized: false, findings: [] };
}
