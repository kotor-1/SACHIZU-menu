import { Badge } from "@/components/ui";
import type { ConfidencePresentationDto, ConfidenceTone } from "@/presentation/running/dto";

const TONE_CLASS: Record<ConfidenceTone, string> = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-800",
  moderate: "border-sky-200 bg-sky-50 text-sky-800",
  low: "border-amber-300 bg-amber-50 text-amber-900",
  policy: "border-amber-300 bg-amber-50 text-amber-900",
};

/**
 * 処方の確信度（「確信度 中」「暫定ルール」）と、RuleSet の状態（「ルールセット 暫定版」）を別々のバッジで出す。
 * 2つは別の事実なので、片方だけで両方を表さない。色だけに頼らず必ずテキストで表す。
 */
export function ConfidenceBadge({ confidence }: { confidence: ConfidencePresentationDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge className={TONE_CLASS[confidence.prescriptionTone]}>{confidence.prescriptionLabel}</Badge>
      {confidence.ruleSetNoticeLabel !== null && (
        <Badge className="border-slate-300 bg-white text-slate-700">{confidence.ruleSetNoticeLabel}</Badge>
      )}
    </span>
  );
}
