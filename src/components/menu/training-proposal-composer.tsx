"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, INPUT_CLASS } from "@/components/ui";
import { TrainingConditionsForm } from "./training-conditions-form";
import { RunningPolicyCoachEditor } from "./running-policy-coach-editor";
import { safeExerciseVideoUrl } from "./composed-item-content";
import { generateTrainingProposalAction, saveTrainingProposalAction, previewTrainingRunningCoachEditAction } from "@/actions/training-proposal-actions";
import { DEFAULT_TRAINING_CONDITIONS, TRAINING_LOCATION_LABELS, TRAINING_GOAL_LABELS, trainingConditionsSchema, trainingRunningGoal, type TrainingConditions } from "@/domain/training-proposal/conditions";
import { explainTrainingIssue } from "@/domain/training-proposal/messages";
import { TRAINING_SECTION_NAMES, type TrainingProposalPreview, type TrainingItemAnnotation } from "@/domain/training-proposal/contracts";
import { assessExerciseEligibility } from "@/domain/training-proposal/eligibility";
import { suggestCatalogItem } from "@/domain/training-proposal/dose";
import type { ComposerCatalogExercise, EditableComposition, EditableItem, ExercisePlanItem } from "@/domain/menu-composition/contracts";
import { exerciseUsesPerSideCount, exerciseUsesTotalCount } from "@/domain/menu-composition/dose-counting";
import type { RunningCoachEditRequest } from "@/application/running-menu/coach-edit";
import type { RunningMenuFinalPrescription } from "@/application/running-menu/persistence";

type ExerciseItem = Extract<EditableItem, { type: "CATALOG_EXERCISE" | "FREEFORM" }>;
const labelClass = "block space-y-1 text-xs font-medium text-slate-600";
const emptyAnnotation: TrainingItemAnnotation = { intensity: "未指定", stage: null, family: "MANUAL", relationship: "COMBINABLE", alternativeGroup: null };
const sectionDescriptions: Record<typeof TRAINING_SECTION_NAMES[number], string> = {
  動きづくり: "動作を確認する候補から、今回取り組むものを選びます。",
  走練習: "提案された距離・本数・休息を確認し、今回の練習に採用します。",
  補強トレーニング: "必要な部位・動作に合わせて、補助する種目を選びます。",
};

const STAGE_LABELS = ["可動域・身体操作", "姿勢・支持・協調", "基本のスプリント動作", "リズム・接地", "疾走への接続"] as const;
// Proposal edits may only lower reps or lengthen rest, so the signed intensity,
// geometry and target-time basis stay valid after a coach adjustment.
function runningIntensity(prescription: RunningMenuFinalPrescription) {
  const science = prescription.science;
  if (!science) return prescription.executionInstructionText ?? "未指定。実施前に強度を確認してください。";
  const reference = science.intensityReference === "MAX_INTENT" ? "全力を出す意図で、動作の質を保つ"
    : science.intensityReference === "RELAXED_SUBMAX" ? "力みを抑えた準最大の走り"
      : "同距離の平均速度を基準にする";
  return science.intensityPercent ? `${science.intensityPercent.min}〜${science.intensityPercent.max}%（${reference}）` : reference;
}
function runningPurpose(prescription: RunningMenuFinalPrescription, requested: TrainingConditions["primaryGoal"]) {
  const purpose = prescription.science?.purpose;
  return purpose && Object.hasOwn(TRAINING_GOAL_LABELS, purpose)
    ? TRAINING_GOAL_LABELS[purpose as TrainingConditions["primaryGoal"]] : TRAINING_GOAL_LABELS[requested];
}

function doseSummary(item: ExercisePlanItem, exercise?: ComposerCatalogExercise) {
  const amount = item.plannedReps !== null ? `${exerciseUsesPerSideCount(item, exercise) ? "片側" : exerciseUsesTotalCount(exercise) ? "合計" : ""}${item.plannedReps}回`
    : item.plannedDistanceMeters !== null ? `${item.plannedDistanceMeters}m`
      : item.plannedDurationSeconds !== null ? `${item.plannedDurationSeconds}秒` : "量未設定";
  const rest = item.plannedRestSeconds === null ? "" : item.plannedRestSeconds === 0 ? " / 休息なし（続けて行う）" : ` / 休息 ${item.plannedRestSeconds}秒`;
  return `${amount}${item.plannedSets !== null ? ` × ${item.plannedSets}セット` : "・セット未設定"}${rest}`;
}
function ExerciseDoseEditor({ item, exercise, update }: { item: ExerciseItem; exercise?: ComposerCatalogExercise; update: (patch: Partial<ExerciseItem>) => void }) {
  const [freeUnit, setUnit] = useState<"plannedReps" | "plannedDistanceMeters" | "plannedDurationSeconds">(item.plannedDistanceMeters !== null ? "plannedDistanceMeters" : item.plannedDurationSeconds !== null ? "plannedDurationSeconds" : "plannedReps");
  const unit = exercise ? exercise.metricType === "TIME" ? "plannedDurationSeconds" : exercise.metricType === "DISTANCE" ? "plannedDistanceMeters" : "plannedReps" : freeUnit;
  const repsLabel = exerciseUsesPerSideCount(item, exercise) ? "片側の回数" : exerciseUsesTotalCount(exercise) ? "左右合計の回数" : "回数";
  function field(name: "plannedSets" | "plannedReps" | "plannedDistanceMeters" | "plannedDurationSeconds" | "plannedRestSeconds", label: string, max: number, min = 1) {
    return <label className={labelClass}>{label}<input className={INPUT_CLASS} type="number" min={min} max={max} step={name === "plannedDistanceMeters" ? "any" : 1}
      value={item[name] ?? ""} placeholder="未設定" onChange={event => update({ [name]: event.target.value === "" ? null : Number(event.target.value) })} /></label>;
  }
  return <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
    <label className={labelClass}>量の単位<select className={INPUT_CLASS} value={unit} disabled={!!exercise} onChange={event => { setUnit(event.target.value as typeof unit); update({ plannedReps: null, plannedDistanceMeters: null, plannedDurationSeconds: null }); }}>
      <option value="plannedReps">回数</option><option value="plannedDistanceMeters">距離</option><option value="plannedDurationSeconds">秒数</option>
    </select></label>
    {field(unit, unit === "plannedReps" ? repsLabel : unit === "plannedDistanceMeters" ? "距離（m）" : "実施時間（秒）", unit === "plannedReps" ? 999 : unit === "plannedDistanceMeters" ? 100000 : 86400)}
    {field("plannedSets", "セット数", 99)}{field("plannedRestSeconds", "セット間休息（秒）", 86400, 0)}
    {exercise && <p className="col-span-2 text-xs text-slate-500 sm:col-span-4">登録された{unit === "plannedReps" ? "回数" : unit === "plannedDistanceMeters" ? "距離" : "秒数"}で量を指定します。量・セット数・休息をすべて入力してください。</p>}
  </div>;
}
function CatalogPicker({ rows, label, onPick, disabled }: { rows: ComposerCatalogExercise[]; label: string; onPick: (id: string) => void; disabled: boolean }) {
  const [value, setValue] = useState("");
  const [query, setQuery] = useState("");
  const filtered = rows.filter(row => `${row.name} ${row.description ?? ""}`.normalize("NFKC").toLowerCase().includes(query.normalize("NFKC").toLowerCase()));
  return <details className="rounded-lg border border-dashed border-slate-300 bg-white p-3">
    <summary className="cursor-pointer text-sm font-medium text-indigo-700">{label}</summary>
    <div className="mt-3 space-y-2">
      <label className={labelClass}>種目を検索<input className={INPUT_CLASS} value={query} onChange={event => { setQuery(event.target.value); setValue(""); }} placeholder="種目名・動作で検索" disabled={disabled} /></label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end"><label className={`${labelClass} min-w-0 flex-1`}>条件に合う登録種目<select className={INPUT_CLASS} value={value} onChange={event => setValue(event.target.value)} disabled={disabled}>
        <option value="">種目を選択</option>{filtered.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
      </select></label><Button type="button" variant="secondary" disabled={disabled || !value} onClick={() => { onPick(value); setValue(""); }}>{label}</Button></div>
      {!rows.length && <p className="text-xs text-slate-500">現在の環境・状態で追加できる登録種目はありません。条件を確認してください。</p>}
    </div>
  </details>;
}

export function TrainingProposalComposer({ catalog, initialPreview }: { catalog: ComposerCatalogExercise[]; initialPreview?: TrainingProposalPreview }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [conditions, setConditions] = useState<TrainingConditions>(() => structuredClone(initialPreview?.conditions ?? DEFAULT_TRAINING_CONDITIONS));
  const [preview, setPreview] = useState<TrainingProposalPreview | null>(initialPreview ?? null);
  const [composition, setComposition] = useState<EditableComposition>(() => structuredClone(initialPreview?.composition ?? { blocks: [] }));
  const [annotations, setAnnotations] = useState<Record<string, TrainingItemAnnotation>>(() => structuredClone(initialPreview?.annotations ?? {}));
  const [selected, setSelected] = useState<string[]>(initialPreview?.selectedItemIds ?? []);
  const [name, setName] = useState(initialPreview?.menuName ?? "今日の練習メニュー");
  const [coachEdit, setCoachEdit] = useState<RunningCoachEditRequest | undefined>(initialPreview?.coachEdit);
  const [runningFinal, setRunningFinal] = useState<RunningMenuFinalPrescription | null>(initialPreview?.runningPrescription ?? null);
  const [coachPending, setCoachPending] = useState(false);
  const [savedEditStatus, setSavedEditStatus] = useState<"IDLE" | "CHECKING" | "FAILED">(initialPreview?.coachEdit ? "CHECKING" : "IDLE");
  const [showConditions, setShowConditions] = useState(!initialPreview);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const resultsRef = useRef<HTMLDivElement>(null);
  const conditionsRef = useRef<HTMLDivElement>(null);
  const previewTokenRef = useRef(initialPreview?.previewToken);
  const busy = pending || coachPending || savedEditStatus === "CHECKING";
  const items = composition.blocks.flatMap(block => block.items);
  const selectedItems = items.filter(item => selected.includes(item.id));
  const conditionsChanged = preview !== null && JSON.stringify(conditions) !== JSON.stringify(preview.conditions);
  const activeConditions = preview?.conditions ?? conditions;
  const selectedRunning = selectedItems.some(item => item.type === "RUNNING_POLICY") ? runningFinal : null;
  const selectedExerciseCount = selectedItems.filter(item => item.type !== "RUNNING_POLICY" && item.type !== "UNPRESCRIBED_RUNNING").length;

  useEffect(() => {
    if (!preview?.coachEdit) return;
    let active = true;
    previewTrainingRunningCoachEditAction({ previewToken: preview.previewToken, coachEdit: preview.coachEdit }).then(result => {
      if (!active) return;
      if (result.ok) { setRunningFinal(result.finalPrescription); setSavedEditStatus("IDLE"); }
      else { setSavedEditStatus("FAILED"); setError(explainTrainingIssue(result.message)); }
    }).catch(() => { if (active) { setSavedEditStatus("FAILED"); setError("保存済みの走調整を確認できませんでした。再読込して確認してください。"); } });
    return () => { active = false; };
  }, [preview]);

  function eligibleRows(blockName: string, replacementId?: string) {
    const section = blockName === "動きづくり" ? "MOVEMENT" : blockName === "補強トレーニング" ? "STRENGTH" : null;
    const existingIds = new Set(items.filter(item => item.type === "CATALOG_EXERCISE" && item.id !== replacementId).map(item => item.type === "CATALOG_EXERCISE" ? item.exerciseId : ""));
    return section === null ? [] : catalog.filter(row => { const result = assessExerciseEligibility(row, activeConditions); return !existingIds.has(row.id) && result.eligible && result.section === section; });
  }
  function accept(next: TrainingProposalPreview) {
    previewTokenRef.current = next.previewToken;
    setPreview(next); setComposition(structuredClone(next.composition)); setAnnotations(structuredClone(next.annotations));
    setSelected([...next.selectedItemIds]); setName(next.menuName ?? "今日の練習メニュー");
    setRunningFinal(next.runningPrescription); setCoachEdit(next.coachEdit); setSavedEditStatus(next.coachEdit ? "CHECKING" : "IDLE"); setShowConditions(false);
    requestAnimationFrame(() => resultsRef.current?.focus());
  }
  function generate() {
    if (busy) return;
    setError(null); setIssues([]);
    const validated = trainingConditionsSchema.safeParse(conditions);
    if (!validated.success) { setError("入力した条件を確認してください。"); setIssues([...new Set(validated.error.issues.map(issue => explainTrainingIssue(issue.message)))]); return; }
    startTransition(async () => {
      try {
        const result = await generateTrainingProposalAction(validated.data);
        if (result.ok) accept(result.preview);
        else { setError(explainTrainingIssue(result.message)); setIssues([...new Set((result.issues ?? []).map(explainTrainingIssue))]); }
      } catch { setError("提案を取得できませんでした。通信状態を確認してください。"); }
    });
  }
  function toggle(id: string, checked: boolean) { setSelected(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id)); }
  function selectBlock(blockId: string, checked: boolean) {
    const ids = composition.blocks.find(block => block.id === blockId)?.items.filter(item => item.type !== "UNPRESCRIBED_RUNNING").map(item => item.id) ?? [];
    setSelected(current => checked ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id)));
  }
  function updateItem(blockId: string, id: string, patch: Partial<ExerciseItem> | { plannedNote: string }) {
    setComposition(current => ({ blocks: current.blocks.map(block => block.id !== blockId ? block : { ...block,
      items: block.items.map(item => item.id !== id ? item : { ...item, ...patch } as EditableItem) }) }));
  }
  function annotation(id: string, patch: Partial<TrainingItemAnnotation>) {
    setAnnotations(current => ({ ...current, [id]: { ...(current[id] ?? emptyAnnotation), ...patch } }));
  }
  function remove(blockId: string, id: string) {
    setComposition(current => ({ blocks: current.blocks.map(block => block.id !== blockId ? block : { ...block, items: block.items.filter(item => item.id !== id) }) }));
    setSelected(current => current.filter(value => value !== id));
    setAnnotations(current => { const next = { ...current }; delete next[id]; return next; });
  }
  function move(blockId: string, id: string, direction: -1 | 1) {
    setComposition(current => ({ blocks: current.blocks.map(block => {
      if (block.id !== blockId) return block;
      const next = [...block.items]; const from = next.findIndex(item => item.id === id); const to = from + direction;
      if (from < 0 || to < 0 || to >= next.length) return block;
      [next[from], next[to]] = [next[to], next[from]];
      return { ...block, items: next };
    }) }));
  }
  function pick(blockId: string, rowId: string, replacementId?: string) {
    const block = composition.blocks.find(row => row.id === blockId);
    const row = block && eligibleRows(block.name, replacementId).find(item => item.id === rowId);
    if (!row) return;
    const id = replacementId ?? crypto.randomUUID();
    const proposed = suggestCatalogItem(row, activeConditions, id);
    setComposition(current => ({ blocks: current.blocks.map(block => block.id !== blockId ? block : { ...block,
      items: replacementId ? block.items.map(item => item.id === replacementId ? proposed.item : item) : [...block.items, proposed.item] }) }));
    annotation(id, proposed.annotation);
    if (!replacementId) toggle(id, true);
  }
  function restoreRunning(blockId: string) {
    const original = preview?.composition.blocks.flatMap(block => block.items).find(item => item.type === "RUNNING_POLICY");
    if (!original || items.some(item => item.type === "RUNNING_POLICY")) return;
    setComposition(current => ({ blocks: current.blocks.map(block => block.id === blockId ? { ...block, items: [...block.items, structuredClone(original)] } : block) }));
    setAnnotations(current => { const next = { ...current }; delete next[original.id]; return next; }); toggle(original.id, true);
  }
  async function editRunning(edit: RunningCoachEditRequest) {
    if (!preview?.runningPrescription || busy) return { ok: false as const, message: "走の処方を確認できません。" };
    const combined = { ...coachEdit, ...edit };
    const token = preview.previewToken;
    setCoachPending(true);
    try {
      const result = await previewTrainingRunningCoachEditAction({ previewToken: token, coachEdit: combined });
      if (previewTokenRef.current !== token) return { ok: false as const, message: "提案が更新されました。現在の走練習を確認してください。" };
      if (!result.ok) return { ok: false as const, message: explainTrainingIssue(result.message) };
      setCoachEdit(combined); setRunningFinal(result.finalPrescription); setSavedEditStatus("IDLE");
      return { ok: true as const };
    } catch { return { ok: false as const, message: "調整を確認できませんでした。通信状態を確認してください。" }; }
    finally { setCoachPending(false); }
  }
  function save() {
    if (busy || !preview || conditionsChanged || !selectedItems.length || !name.trim() || savedEditStatus !== "IDLE") return;
    setError(null); setIssues([]);
    startTransition(async () => {
      try {
        const result = await saveTrainingProposalAction({ previewToken: preview.previewToken, menuName: name.trim(), composition,
          selectedItemIds: selectedItems.map(item => item.id), annotations, runningPrescription: preview.runningPrescription, ...(coachEdit ? { coachEdit } : {}) });
        if (result.ok) { router.push(`/menus/${result.menuId}`); router.refresh(); }
        else setError(explainTrainingIssue(result.message));
      } catch { setError("保存できませんでした。通信状態を確認してください。"); }
    });
  }
  return <div className="space-y-6">
    {showConditions && <div ref={conditionsRef}><form onSubmit={event => { event.preventDefault(); generate(); }} className="space-y-4">
      <TrainingConditionsForm value={conditions} onChange={setConditions} disabled={busy} />
      <div className="flex flex-wrap items-center gap-3"><Button type="submit" size="lg" disabled={busy}>{pending ? "提案を準備しています…" : preview ? "この条件でもう一度提案する" : "この条件で練習を提案する"}</Button>
        {preview && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setShowConditions(false); requestAnimationFrame(() => resultsRef.current?.focus()); }}>提案に戻る</Button>}
      </div>
    </form></div>}
    {error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><p>{error}</p>{issues.length > 0 && <ul className="mt-2 list-inside list-disc space-y-1">{issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</div>}
    {preview && <div ref={resultsRef} tabIndex={-1} className="space-y-5 outline-none" aria-label="練習の提案">
      <div className="rounded-2xl border border-indigo-100 bg-indigo-50/60 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div>
          <p className="text-xs font-semibold tracking-wide text-indigo-600">今回の練習候補</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">組み合わせを選んで、メニューにする</h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">すべて実施する必要はありません。採用した種目だけが練習記録へ引き継がれます。量や順序も調整できます。</p>
        </div><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setShowConditions(true); requestAnimationFrame(() => conditionsRef.current?.scrollIntoView({ block: "start" })); }}>条件を見直す</Button></div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-indigo-800"><span className="rounded-full bg-white px-3 py-1">{TRAINING_LOCATION_LABELS[preview.conditions.location]}</span><span className="rounded-full bg-white px-3 py-1">{preview.conditions.athlete.event}</span><span className="rounded-full bg-white px-3 py-1">{TRAINING_GOAL_LABELS[preview.conditions.primaryGoal]}</span><span className="rounded-full bg-white px-3 py-1">疲労度 {preview.conditions.condition.fatigue} / 10</span></div>
      </div>
      {conditionsChanged && <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">条件が変更されています。新しい条件で再提案するか、元の条件に戻してから保存してください。</p>}
      {savedEditStatus === "CHECKING" && <p role="status" className="text-sm text-slate-500">保存済みの走調整を確認しています…</p>}
      {coachPending && <p role="status" className="text-sm text-slate-500">走の調整を確認しています…</p>}
      {preview.messages.length > 0 && <div className={`rounded-xl border p-4 text-sm leading-relaxed ${preview.quality === "LIMITED" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-600"}`}>
        <ul className="space-y-1.5">{preview.messages.map((message, index) => <li key={index}>{explainTrainingIssue(message)}</li>)}</ul>
      </div>}
      <fieldset disabled={busy} className="min-w-0 space-y-5"><legend className="sr-only">練習候補の選択と編集</legend>
        <div className="flex flex-wrap items-center gap-2"><p className="mr-auto text-sm text-slate-600"><strong className="text-slate-900">{selectedItems.length}</strong> / {items.length}項目を採用</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setSelected(items.filter(item => item.type !== "UNPRESCRIBED_RUNNING").map(item => item.id))}>すべて選択</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSelected([])}>すべて解除</Button>
        </div>
        {TRAINING_SECTION_NAMES.map((section, sectionIndex) => {
          const block = composition.blocks.find(row => row.name === section);
          const count = block?.items.filter(item => selected.includes(item.id)).length ?? 0;
          const eligible = eligibleRows(section);
          return <section key={section} aria-labelledby={`training-section-${sectionIndex}`} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-4 py-4 sm:px-5"><div>
              <h3 id={`training-section-${sectionIndex}`} className="font-semibold text-slate-900">{section}<span className="ml-2 text-xs font-normal text-slate-500">{count}項目を採用</span></h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{sectionDescriptions[section]}</p>
            </div>{block && block.items.length > 0 && <div className="flex gap-1"><Button type="button" size="sm" variant="ghost" onClick={() => selectBlock(block.id, true)}>全選択</Button><Button type="button" size="sm" variant="ghost" onClick={() => selectBlock(block.id, false)}>解除</Button></div>}</div>
            <div className="space-y-3 p-3 sm:p-5">
              {section === "走練習" && preview.runningStatusReason && <p className="rounded-lg bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">{explainTrainingIssue(preview.runningStatusReason)}</p>}
              {!block?.items.length && !(section === "走練習" && preview.runningStatusReason) && <p className="py-4 text-sm text-slate-500">{section === "走練習" ? "採用できる走練習はありません。条件と確認事項を見直してください。"
                : eligible.length ? "この条件ではまだ候補がありません。登録種目から追加できます。" : "現在の環境・体調で提案・追加できる種目はありません。上の確認事項を見直してください。"}</p>}
              {block?.items.map((item, index) => {
                const exercise = item.type === "CATALOG_EXERCISE" ? catalog.find(row => row.id === item.exerciseId) : undefined;
                const meta = annotations[item.id] ?? emptyAnnotation;
                const isRunning = item.type === "RUNNING_POLICY";
                const isUnprescribed = item.type === "UNPRESCRIBED_RUNNING";
                const title = isRunning || isUnprescribed ? "走練習" : item.displayName;
                const selectedItem = selected.includes(item.id);
                const exerciseItem = !isRunning && !isUnprescribed ? item : null;
                const video = safeExerciseVideoUrl(exercise?.videoUrl ?? null);
                return <article key={item.id} data-training-item={item.id} className={`rounded-xl border p-3 sm:p-4 ${selectedItem ? "border-indigo-200 bg-white" : "border-slate-200 bg-slate-50/60"}`}>
                  <div className="flex items-start gap-3"><label className="-m-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-indigo-50"><input type="checkbox" aria-label={`${title}を採用`} className="h-6 w-6 accent-indigo-600" checked={selectedItem} disabled={isUnprescribed} onChange={event => toggle(item.id, event.target.checked)} /></label>
                    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="break-words text-sm font-semibold text-slate-900">{title}</h4>
                      {meta.stage !== null && !isRunning && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{meta.stage + 1}. {STAGE_LABELS[Math.min(Math.max(meta.stage, 0), 4)]}</span>}
                      {video && <span className="rounded bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">お手本動画あり</span>}
                      {meta.relationship === "ALTERNATIVE" && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">選び替える候補</span>}
                    </div>
                    {isRunning && runningFinal ? <div className="mt-1 space-y-1.5 text-xs leading-relaxed text-slate-600" data-running-summary>
                      <p className="text-sm font-semibold text-indigo-800">{runningFinal.distanceMeters}m × 計{runningFinal.totalReps}本</p>
                      <p>目的：{runningPurpose(runningFinal, trainingRunningGoal(preview.conditions) ?? preview.conditions.primaryGoal)}</p>
                      <p>{runningFinal.setReps ? `${runningFinal.sets}セット（${runningFinal.setReps.join("本・")}本）` : "1セット"}
                        {runningFinal.repRestSeconds !== null ? ` / 本間休息 ${runningFinal.repRestSeconds}秒` : " / 本間休息なし（1本）"}
                        {runningFinal.setRestSeconds !== null && ` / セット間休息 ${runningFinal.setRestSeconds}秒`}</p>
                      {runningFinal.setRestSeconds !== null && <p>セット間休息は、前セット最後の走から次セット最初の走までです。</p>}
                      <p>強度：{runningIntensity(runningFinal)}</p>
                      {runningFinal.science && runningFinal.science.flyMeters > 0 && <p>1本の内訳：助走 {runningFinal.science.buildupMeters}m ＋ フライ {runningFinal.science.flyMeters}m ＋ 減速 {runningFinal.science.decelerationMeters}m</p>}
                      {runningFinal.executionInstructionText && runningFinal.executionInstructionText !== runningIntensity(runningFinal) && <p className="whitespace-pre-wrap">実施指示：{runningFinal.executionInstructionText}</p>}
                      {runningFinal.coachTargetTimeSeconds !== null ? <p>目標タイム：{runningFinal.coachTargetTimeSeconds}秒</p>
                        : runningFinal.coachTargetTimeRange ? <p>目標タイム：{runningFinal.coachTargetTimeRange.minSeconds}〜{runningFinal.coachTargetTimeRange.maxSeconds}秒</p>
                          : runningFinal.science?.targetTimeRangeSeconds ? <p>目標タイムの目安：{runningFinal.science.targetTimeRangeSeconds.min.toFixed(2)}〜{runningFinal.science.targetTimeRangeSeconds.max.toFixed(2)}秒</p> : null}
                      <p className="text-slate-500">出典：{coachEdit ? "コーチによる調整（元の提案は保持）" : runningFinal.science ? "研究知見を参考にした暫定提案・コーチ承認前" : "登録された走練習の標準処方"}</p>
                      {runningFinal.science?.stopInstruction && <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-900">実施中の確認：{runningFinal.science.stopInstruction}</p>}
                    </div>
                      : exerciseItem ? <p className="mt-1 text-xs font-medium text-slate-700">{doseSummary(exerciseItem, exercise)}</p> : <p className="mt-1 text-xs text-slate-500">量・強度・休息は未設定</p>}
                    {exerciseItem?.reason && <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{exerciseItem.reason}</p>}
                    {!isRunning && <p className="mt-1.5 text-xs leading-relaxed text-slate-500">強度：{meta.intensity}</p>}
                  </div></div>
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-1">
                    <Button type="button" size="sm" variant="ghost" aria-label={`${title}を上へ`} disabled={index === 0} onClick={() => move(block.id, item.id, -1)}>↑ 上へ</Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={`${title}を下へ`} disabled={index === block.items.length - 1} onClick={() => move(block.id, item.id, 1)}>↓ 下へ</Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={`${title}を削除`} onClick={() => remove(block.id, item.id)}>削除</Button>
                  </div>
                  <details className="mt-2 border-t border-slate-100 pt-3"><summary className="cursor-pointer text-sm font-medium text-indigo-700">詳しい内容・編集</summary>
                    <div className="mt-4 space-y-4">
                      {exerciseItem && <>
                        <ExerciseDoseEditor key={`${item.id}-${exercise?.id ?? "free"}`} item={exerciseItem} exercise={exercise} update={patch => updateItem(block.id, item.id, patch)} />
                        <label className={labelClass}>強度の目安<input className={INPUT_CLASS} maxLength={240} value={meta.intensity} onChange={event => annotation(item.id, { intensity: event.target.value })} /></label>
                        <label className={labelClass}>実施指示<textarea className={INPUT_CLASS} rows={3} maxLength={400} value={exerciseItem.executionInstruction} onChange={event => updateItem(block.id, item.id, { executionInstruction: event.target.value })} /></label>
                        <label className={labelClass}>メモ<textarea className={INPUT_CLASS} rows={2} maxLength={200} value={exerciseItem.plannedNote} onChange={event => updateItem(block.id, item.id, { plannedNote: event.target.value })} /></label>
                        <CatalogPicker rows={eligibleRows(section, item.id)} label="別の種目に入れ替える" onPick={id => pick(block.id, id, item.id)} disabled={busy} />
                      </>}
                      {isRunning && runningFinal && <div className="space-y-3">
                        {runningFinal.executionInstructionText && <p className="whitespace-pre-wrap text-sm text-slate-700">{runningFinal.executionInstructionText}</p>}
                        {runningFinal.coachTargetTimeSeconds !== null && <p className="text-sm">目標タイム：{runningFinal.coachTargetTimeSeconds}秒</p>}
                        {runningFinal.coachTargetTimeRange && <p className="text-sm">目標タイム：{runningFinal.coachTargetTimeRange.minSeconds}〜{runningFinal.coachTargetTimeRange.maxSeconds}秒</p>}
                        {runningFinal.setReps && <p className="text-sm">セット構成：{runningFinal.setReps.join("本 / ")}本・セット間休息 {runningFinal.setRestSeconds ?? "未指定"}秒</p>}
                        <RunningPolicyCoachEditor key={JSON.stringify(runningFinal)} initial={runningFinal} onSubmit={editRunning} proposalSafety />
                        <label className={labelClass}>走練習のメモ<textarea className={INPUT_CLASS} rows={2} maxLength={1000} value={item.plannedNote} onChange={event => updateItem(block.id, item.id, { plannedNote: event.target.value })} /></label>
                      </div>}
                      {exercise && <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm leading-relaxed text-slate-600"><p className="font-medium text-slate-800">種目の基本説明</p><p className="whitespace-pre-wrap">{exercise.description}</p>
                        {exercise.coachingPoint && <p className="whitespace-pre-wrap">{exercise.coachingPoint}</p>}
                        {exercise.videoGuidance?.bilateralCounting && <p className="whitespace-pre-wrap">数え方：{exercise.videoGuidance.bilateralCounting}</p>}
                        <div className="flex flex-wrap gap-4 pt-1"><a href={`/exercises/${exercise.id}`} target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline underline-offset-2">種目ページ</a>{video && <a href={video} target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline underline-offset-2">参考動画を見る ↗</a>}</div>
                      </div>}
                    </div>
                  </details>
                </article>;
              })}
              {block && section !== "走練習" && <CatalogPicker rows={eligible} label="登録種目を追加" onPick={id => pick(block.id, id)} disabled={busy} />}
              {block && section === "走練習" && !block.items.some(item => item.type === "RUNNING_POLICY") && preview.runningPrescription && <Button type="button" variant="secondary" size="sm" onClick={() => restoreRunning(block.id)}>走の候補を戻す</Button>}
            </div>
          </section>;
        })}
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5">
          <h3 className="text-sm font-semibold text-slate-900">採用する内容</h3>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600"><span>動きづくり・補強 <strong className="text-slate-900">{selectedExerciseCount}種目</strong></span>
            {selectedRunning ? <span>走 <strong className="text-slate-900">{selectedRunning.totalReps}本・計{selectedRunning.totalDistanceMeters}m</strong></span> : <span>走は未選択</span>}
          </div>
          <p className="mt-2 text-xs text-slate-500">選択した項目だけが、実施するメニューに入ります。</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"><label className={`${labelClass} min-w-0 flex-1`}>メニュー名<input className={INPUT_CLASS} value={name} maxLength={100} required onChange={event => setName(event.target.value)} /></label>
            <Button type="button" size="lg" disabled={busy || conditionsChanged || !selectedItems.length || !name.trim() || savedEditStatus !== "IDLE"} onClick={save}>{pending ? "処理しています…" : "選択した内容を保存"}</Button></div>
          {!selectedItems.length && <p className="mt-2 text-xs text-slate-500">採用する項目を1つ以上選んでください。</p>}
        </div>
      </fieldset>
    </div>}
  </div>;
}
