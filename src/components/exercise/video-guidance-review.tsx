"use client";

import { useActionState, useState } from "react";
import type { VideoGuidanceReviewPageData } from "@/application/menu-composition/video-guidance-review";
import { videoGuidanceReviewAction, type GuidanceReviewActionResult } from "@/actions/video-guidance-review-actions";
import { VIDEO_GUIDANCE_FIELDS } from "@/domain/exercise/video-guidance-persistence";
import { VIDEO_COUNTING_UNIT_LABEL, type VideoGuidanceObservation } from "@/domain/exercise/video-guidance";
import type { GuidanceReviewCommand } from "@/domain/exercise/video-guidance-review";
import { Button, Card, CardBody, CardHeader, INPUT_CLASS } from "@/components/ui";

const labels: Record<keyof VideoGuidanceObservation, string> = {
  executionSummary: "実施内容", movementPattern: "動き", countingUnit: "数え方", bilateralCounting: "左右の扱い",
  typicalStructure: "実施順序・構造", equipment: "器具", setup: "準備", keyCues: "意識する点", commonErrors: "注意する動き", doseObservations: "観察・コーチ判断の記録",
};
const text = (value: unknown) => Array.isArray(value) ? value.join("\n") : value == null ? "未記録" : String(value);
const observation = (guidance: VideoGuidanceObservation) => Object.fromEntries(VIDEO_GUIDANCE_FIELDS.map((field) => [field, guidance[field]])) as VideoGuidanceObservation;
const decisionLabels = { PENDING: "未確認", HELD: "保留", REJECTED: "却下済み", REVIEWED: "コーチ確認済み", PUBLISHED: "AI未承認のまま公開中" };
function videoLink(url: string | null) {
  if (!url) return null;
  try { return ["http:", "https:"].includes(new URL(url).protocol) ? url : null; } catch { return null; }
}

export function VideoGuidanceReviewPanel({ data, operationKey: initialKey, sourceBindingHash }: {
  data: VideoGuidanceReviewPageData; operationKey: string; sourceBindingHash: string | null;
}) {
  const { review, exercise } = data;
  const candidate = review.candidate;
  const initial = candidate ? observation(candidate.guidance) : null;
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState("");
  const [operationKey, setOperationKey] = useState(initialKey);
  const [resolutions, setResolutions] = useState<Record<string, { state: "KNOWN" | "NOT_APPLICABLE" | ""; reason: string }>>({});
  const unresolved = candidate?.fieldAssessment.filter((field) => field.state === "UNRESOLVED") ?? [];
  const complete = unresolved.every((field) => resolutions[field.field]?.state && resolutions[field.field]?.reason.trim()
    && JSON.stringify(draft?.[field.field]) !== JSON.stringify(candidate?.guidance[field.field]));
  const change = () => setOperationKey(crypto.randomUUID());
  const [result, submit, pending] = useActionState<GuidanceReviewActionResult | null, FormData>(async (previous, form) => {
    if (!candidate || !draft || !sourceBindingHash) return { ok: false, code: "INVALID_REVIEW", message: "候補を読み込み直してください。" };
    const operation = String(form.get("operation")) as GuidanceReviewCommand["operation"];
    const common = {
      ownerId: exercise.ownerId, exerciseId: exercise.id, operationKey: `${operationKey}:${operation}`,
      candidateRevisionId: candidate.revisionId, expectedRowVersion: review.head.rowVersion,
      expectedApprovedRevisionId: review.head.approvedRevisionId, expectedSourceBindingHash: sourceBindingHash, reason,
    };
    const payload = operation === "APPROVE" ? { ...common, operation, observation: draft,
      resolutions: unresolved.map((field) => ({ field: field.field, ...resolutions[field.field] })),
    } : { ...common, operation };
    const request = new FormData(); request.set("payload", JSON.stringify(payload));
    return videoGuidanceReviewAction(previous, request);
  }, null);
  const blocked = pending || result?.ok === true || !candidate || candidate.sourceStatus !== "CURRENT" || review.candidateDecision === "REJECTED" || !reason.trim();
  const allowed = (operation: GuidanceReviewCommand["operation"]) => data.allowedOperations === undefined || data.allowedOperations.includes(operation);
  const publishedCandidate = candidate?.revisionId === review.head.activeAiRevisionId;
  const source = candidate ?? review.effective;
  const originalUrl = videoLink(source?.sourceBinding.sourceUrl ?? exercise.videoUrl);

  return <div className="space-y-6">
    <Card><CardBody>
      <h1 className="text-xl font-semibold">{exercise.name}の動画ガイダンス</h1>
      <p className="mt-2">{originalUrl && <a className="text-indigo-700 underline" href={originalUrl} target="_blank" rel="noreferrer">元動画を開く</a>}</p>
      <p className="mt-2">動画の照合: {source?.sourceStatus === "CURRENT" ? "一致" : source ? "変更を検出・操作不可" : "対象なし"}</p>
      <p>カタログの参考値: セット {text(exercise.defaultSets)} / 回数 {text(exercise.defaultReps)} / 距離 {text(exercise.defaultDistanceMeters)} / 休憩 {text(exercise.defaultRestSeconds)}</p>
      <p className="text-sm text-slate-600">ここでの操作は動画ガイダンスの確認です。メニュー計画やカタログの参考値は変更しません。</p>
    </CardBody></Card>
    <div className="grid gap-4 lg:grid-cols-2">
      {([ ["現在採用している内容", review.effective], ["AI候補", candidate] ] as const).map(([title, revision]) => <Card key={title}>
        <CardHeader><h2 className="font-semibold">{title}</h2></CardHeader><CardBody>
          {!revision ? <p>まだありません。</p> : <>
            <p>{revision.guidance.videoAnalysisStatus === "COACH_REVIEWED" ? "コーチ確認済み" : "AI解析・未承認"}</p>
            <p>{revision.reviewerIdentity === "LEGACY_UNKNOWN" ? "過去の承認：承認者は記録されていません（LEGACY_UNKNOWN）"
              : revision.reviewerActorId ? `承認者: ${revision.reviewerActorId}` : "承認者: なし"}</p>
            <p className="text-sm">未確定: {revision.fieldAssessment.filter((field) => field.state === "UNRESOLVED").map((field) => labels[field.field]).join("、") || "明示された未確定項目なし"}</p>
            <dl className="mt-3 space-y-3">{VIDEO_GUIDANCE_FIELDS.map((field) => <div key={field}><dt className="font-medium">{labels[field]}</dt><dd className="whitespace-pre-wrap text-sm">{text(revision.guidance[field])}</dd></div>)}</dl>
            <details className="mt-3 text-sm"><summary>履歴と動画の識別情報</summary><p>Revision: {revision.revisionId}</p><p>解析: {revision.analyzedAt}</p><p>承認: {revision.reviewedAt ?? "なし"}</p><p className="break-all">SHA-256: {revision.sourceBinding.contentSha256}</p><p>{revision.reviewReason}</p></details>
          </>}
        </CardBody></Card>)}
    </div>
    {candidate && draft && <form action={submit} className="space-y-4">
      <Card><CardHeader><h2 className="font-semibold">候補の確認・修正</h2></CardHeader><CardBody>
        <p className="mb-4">未確定の項目は、内容を修正し、確認結果と理由をそれぞれ入力してください。</p>
        <p className="mb-3 text-sm">候補の状態: {review.candidateDecision ? decisionLabels[review.candidateDecision] : "候補なし"}</p>
        <div className="grid gap-4 md:grid-cols-2">{VIDEO_GUIDANCE_FIELDS.map((field) => <label key={field} className="block"><span className="font-medium">{labels[field]}</span>
          {field === "countingUnit" ? <select className={INPUT_CLASS} value={draft.countingUnit} onChange={(event) => { change(); setDraft({ ...draft, countingUnit: event.target.value as VideoGuidanceObservation["countingUnit"] }); }}>
            {Object.entries(VIDEO_COUNTING_UNIT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select> : <textarea className={INPUT_CLASS} rows={3} value={draft[field] == null ? "" : text(draft[field])} onChange={(event) => {
            change(); const value = event.target.value;
            setDraft({ ...draft, [field]: Array.isArray(draft[field]) ? value.split("\n").map((line) => line.trim()).filter(Boolean)
              : ["bilateralCounting", "typicalStructure", "setup"].includes(field) && !value ? null : value });
          }} />}
          {JSON.stringify(draft[field]) !== JSON.stringify(candidate.guidance[field]) && <span className="block text-sm text-slate-600">変更前: {text(candidate.guidance[field])}</span>}
        </label>)}</div>
        {unresolved.map((field) => <fieldset key={field.field} className="mt-4 rounded border border-amber-300 p-3">
          <legend>{labels[field.field]}：未確定</legend><p className="mb-2 text-sm">{field.reason}</p>
          <label>確認結果<select className={INPUT_CLASS} value={resolutions[field.field]?.state ?? ""} onChange={(event) => { change(); setResolutions({ ...resolutions, [field.field]: { reason: resolutions[field.field]?.reason ?? "", state: event.target.value as "KNOWN" | "NOT_APPLICABLE" | "" } }); }}>
            <option value="">未解決</option><option value="KNOWN">内容を確認した</option><option value="NOT_APPLICABLE">この種目には該当しない</option>
          </select></label>
          <label>確認理由<textarea className={INPUT_CLASS} value={resolutions[field.field]?.reason ?? ""} onChange={(event) => { change(); setResolutions({ ...resolutions, [field.field]: { state: resolutions[field.field]?.state ?? "", reason: event.target.value } }); }} /></label>
        </fieldset>)}
        <label className="mt-4 block">操作の理由<textarea className={INPUT_CLASS} required value={reason} onChange={(event) => { change(); setReason(event.target.value); }} /></label>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button name="operation" value="HOLD" variant="secondary" disabled={blocked || !allowed("HOLD")}>保留する</Button>
          <Button name="operation" value="REJECT" variant="danger" disabled={blocked || publishedCandidate || !allowed("REJECT")}>候補を却下する</Button>
          <Button name="operation" value="PUBLISH_AI" variant="secondary" disabled={blocked || review.head.approvedRevisionId !== null || !allowed("PUBLISH_AI")}>AI未承認のまま公開する</Button>
          <Button name="operation" value="APPROVE" disabled={blocked || !complete || !allowed("APPROVE")}>修正内容を承認する</Button>
        </div>
        {publishedCandidate && <p className="mt-3 text-sm text-slate-600">公開済みAI候補の却下には公開解除の手順が必要です。この画面からは却下できません。保留しても現在採用している内容は変わりません。</p>}
        {result && <p role="status" className="mt-3">{result.message}</p>}
        <a className="mt-3 inline-block text-indigo-700 underline" href={`/video-guidance/${encodeURIComponent(exercise.ownerId)}/${encodeURIComponent(exercise.id)}`}>最新の内容を読み込み直す</a>
      </CardBody></Card>
    </form>}
    <Card><CardHeader><h2 className="font-semibold">原文・変更履歴</h2></CardHeader><CardBody>
      <details><summary>承認の元となったAI出力</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(review.aiOriginal?.guidance ?? null, null, 2)}</pre></details>
      <details className="mt-3"><summary>前の承認版</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(review.previousApproved?.guidance ?? null, null, 2)}</pre></details>
      <ol className="mt-3 space-y-3">{review.auditEvents.map((event) => <li key={event.id} className="border-t pt-3 text-sm">
        <p>{event.timestamp} / {event.actorId ?? "記録なし"} / {event.operation}</p><p>{event.reason}</p>
        <details><summary>変更前・変更後</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ before: event.before, after: event.after }, null, 2)}</pre></details>
      </li>)}</ol>
    </CardBody></Card>
  </div>;
}
