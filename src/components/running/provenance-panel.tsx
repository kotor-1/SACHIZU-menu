import type { ReactNode } from "react";
import type { ProvenanceChangesDto, ProvenancePresentationDto } from "@/presentation/running/dto";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="min-w-0 text-sm break-words text-slate-800">{children}</dd>
    </div>
  );
}

function Changes({ changes }: { changes: ProvenanceChangesDto }) {
  return (
    <>
      <span>{changes.summaryLabel}</span>
      {changes.items.length > 0 && (
        <ul className="mt-1 space-y-1 text-xs text-slate-600">
          {changes.items.map((item, i) => (
            <li key={i} className="break-words">
              {[item.label, item.detail, item.atLabel].filter((v): v is string => v !== null).join(" ／ ")}
              {item.reason !== null && <span className="block text-slate-700">理由: {item.reason}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * 作成経緯と根拠（表示専用。hooks を持たない）。
 * contentHash / engineVersion / requestId / evidenceId / 内部 enum は DTO に含まれず、ここでも描画しない。
 * AI の提案理由は、エンジンの処方根拠とは別の枠で表示する。
 */
export function ProvenancePanel({ provenance }: { provenance: ProvenancePresentationDto }) {
  if (provenance.status === "UNAVAILABLE") {
    return <p className="text-sm text-slate-600">{provenance.message}</p>;
  }
  const { confidence, evidence } = provenance;
  return (
    <div className="min-w-0 space-y-3">
      <dl className="space-y-2">
        <Row label="ルールセット">
          {provenance.ruleSetVersionLabel}（{provenance.ruleSetStatusLabel}）
        </Row>
        <Row label="処方の確信度">
          {confidence.prescriptionLabel}
          <span className="block text-xs text-slate-600">{confidence.prescriptionDescription}</span>
        </Row>
        <Row label="根拠と対象の近さ">
          {confidence.directnessLabel}
          <span className="block text-xs text-slate-600">{confidence.directnessDescription}</span>
        </Row>
        <Row label="選手の記録データ">{confidence.inputDataLabel}</Row>
        <Row label="作成方法">{provenance.generatedByLabel}</Row>
        <Row label="作成者">{provenance.createdByLabel}</Row>
        <Row label="コーチの承認">{provenance.acceptanceLabel}</Row>
        <Row label="根拠の出典の種類">
          {evidence.status === "AVAILABLE" ? (
            <>
              {evidence.sourceTypes.length === 0 ? (
                <span>確認できる出典はありません</span>
              ) : (
                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                  {evidence.sourceTypes.map((t) => (
                    <li key={t.label}>
                      {t.label}（{t.count}件）
                    </li>
                  ))}
                </ul>
              )}
              {evidence.unresolvedMessage !== null && <span className="block text-xs text-slate-600">{evidence.unresolvedMessage}</span>}
            </>
          ) : (
            <span>{evidence.message}</span>
          )}
        </Row>
        <Row label="コーチによる数値の調整">
          <Changes changes={provenance.coachEdits} />
        </Row>
        <Row label="例外設定">
          <Changes changes={provenance.overrides} />
        </Row>
      </dl>
      {provenance.aiProposal !== null && (
        <section className="space-y-1 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2">
          <h5 className="text-sm font-semibold text-violet-900">{provenance.aiProposal.heading}</h5>
          <p className="text-sm break-words text-slate-800">{provenance.aiProposal.reason ?? "AIの説明文はありません。"}</p>
          <p className="text-xs text-slate-600">{provenance.aiProposal.engineBasisNote}</p>
        </section>
      )}
    </div>
  );
}
