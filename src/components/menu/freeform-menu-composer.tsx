"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, INPUT_CLASS } from "@/components/ui";
import { SortableList } from "./sortable-list";
import { ComposedExerciseContent } from "./composed-item-content";
import { RunningPolicyCoachEditor } from "./running-policy-coach-editor";
import { generateComposedMenuAction, saveComposedMenuAction, createManualComposedMenuAction } from "@/actions/menu-composition-actions";
import { previewRunningCoachEditAction } from "@/actions/running-coach-preview-actions";
import type { ComposedMenuPreview } from "@/application/menu-composition/generate";
import type { RunningCoachEditRequest } from "@/application/running-menu/coach-edit";
import type { RunningMenuFinalPrescription } from "@/application/running-menu/persistence";
import { EMPTY_EXERCISE_DOSE, exercisePlanValues, type ComposeMenuInput, type ComposerCatalogExercise, type EditableItem, type ExercisePlanItem } from "@/domain/menu-composition/contracts";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";
import { runningMinimumPlannedSeconds } from "@/presentation/menu-composition/planned-time";
import { estimateSeconds } from "@/domain/shared/prescription";
import { EXERCISE_CATEGORIES, EXERCISE_CATEGORY_LABEL } from "@/domain/exercise/constants";

function reordered<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const next = ids.flatMap((id) => { const item = items.find((row) => row.id === id); return item ? [item] : []; });
  return next.length === items.length && new Set(ids).size === items.length ? next : items;
}
function DoseEditor({ item, update, disabled }: { item: ExercisePlanItem; update: (patch: Partial<ExercisePlanItem>) => void; disabled: boolean }) {
  const [unit, setUnit] = useState<"plannedDurationSeconds" | "plannedDistanceMeters" | "plannedReps">(item.plannedDurationSeconds !== null ? "plannedDurationSeconds" : item.plannedDistanceMeters !== null ? "plannedDistanceMeters" : "plannedReps");
  const limits = { plannedSets: [1, 99], plannedReps: [1, 999], plannedDurationSeconds: [1, 86400], plannedDistanceMeters: [1, 100000], plannedRestSeconds: [0, 86400] };
  const field = (name: keyof typeof limits, label: string) => <label className="text-xs">{label}<input type="number" className={INPUT_CLASS} value={item[name] ?? ""} min={limits[name][0]} max={limits[name][1]} step={name === "plannedDistanceMeters" ? "any" : 1} disabled={disabled} onChange={(e) => update({ [name]: e.target.value === "" ? null : Number(e.target.value) })} /></label>;
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    <label className="text-xs">量の単位<select className={INPUT_CLASS} value={unit} disabled={disabled} onChange={(e) => { setUnit(e.target.value as typeof unit); update({ plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: null }); }}>
      <option value="plannedReps">回数</option><option value="plannedDurationSeconds">秒</option><option value="plannedDistanceMeters">距離（m）</option>
    </select></label>
    {field(unit, unit === "plannedDurationSeconds" ? "時間（秒）" : unit === "plannedDistanceMeters" ? "距離（m）" : "回数")}
    {field("plannedSets", "セット数")}{field("plannedRestSeconds", "休憩（秒）")}
  </div>;
}

export function FreeformMenuComposer({ exercises }: { exercises: ComposerCatalogExercise[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requestText, setRequestText] = useState("");
  const [ageGroup, setAgeGroup] = useState("");
  const [event, setEvent] = useState("");
  const [name, setName] = useState("今日のメニュー");
  const [preview, setPreview] = useState<ComposedMenuPreview | null>(null);
  const [blocks, setBlocks] = useState<ComposedMenuPreview["composition"]["blocks"]>([]);
  const [running, setRunning] = useState<RunningMenuFinalPrescription | null>(null);
  const [coachEdit, setCoachEdit] = useState<RunningCoachEditRequest | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [catalogPick, setCatalogPick] = useState("");
  const eligible = exercises.filter((row) => row.status === "REVIEWED" && !isRunningExerciseForV2(row));
  const originalItems = preview?.composition.blocks.flatMap((block) => block.items) ?? [];
  const originalIds = new Set(originalItems.map((item) => item.id));
  const knownSeconds = blocks.flatMap((block) => block.items).reduce((sum, item) => {
    if (item.type === "RUNNING_POLICY") return sum + (running ? runningMinimumPlannedSeconds(running) : 0);
    if (item.plannedReps === null && item.plannedDurationSeconds === null && item.plannedDistanceMeters === null) return sum;
    return sum + estimateSeconds(exercisePlanValues(item));
  }, 0);

  function clearPreview() { setPreview(null); setBlocks([]); setRunning(null); setCoachEdit(undefined); }
  function accept(next: ComposedMenuPreview) { setPreview(next); setBlocks(next.composition.blocks); setRunning(next.runningPrescription); setCoachEdit(undefined); }
  function generate(manual = false) {
    setError(null);
    startTransition(async () => {
      const context: ComposeMenuInput["context"] = {};
      if (event) context.event = event;
      if (ageGroup) context.ageGroup = ageGroup as NonNullable<ComposeMenuInput["context"]["ageGroup"]>;
      const result = manual ? await createManualComposedMenuAction() : await generateComposedMenuAction({ requestText, context });
      if (result.ok) accept(result.preview); else setError(result.message);
    });
  }
  function updateItem(blockId: string, itemId: string, patch: Partial<EditableItem>) {
    setBlocks((prior) => prior.map((block) => block.id !== blockId ? block : { ...block, items: block.items.map((item) => item.id !== itemId ? item : { ...item, ...patch } as EditableItem) }));
  }
  function addItem(blockId: string, catalogId: string | null) {
    const exercise = eligible.find((row) => row.id === catalogId);
    const item: EditableItem = exercise ? { id: crypto.randomUUID(), type: "CATALOG_EXERCISE", exerciseId: exercise.id, displayName: exercise.name,
      ...EMPTY_EXERCISE_DOSE, executionInstruction: "", plannedNote: "", reason: "" }
      : { id: crypto.randomUUID(), type: "FREEFORM", category: "OTHER", displayName: "", originalUserInstruction: "", ...EMPTY_EXERCISE_DOSE, executionInstruction: "", plannedNote: "", reason: "" };
    setBlocks((prior) => prior.map((block) => block.id === blockId ? { ...block, items: [...block.items, item] } : block));
  }
  function save() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await saveComposedMenuAction({ previewToken: preview.previewToken, menuName: name, composition: { blocks },
        runningPrescription: coachEdit ? running : preview.runningPrescription, ...(coachEdit ? { coachEdit } : {}) });
      if (result.ok) router.push(`/menus/${result.menuId}`);
      else setError(result.code === "INVALID_PLAN" ? "項目名・実施指示・量を確認してください。複数の単位を同時に設定しないでください。" : "保存できませんでした。項目・量、走の確認結果を見直してください。");
    });
  }
  async function editRunning(edit: RunningCoachEditRequest) {
    if (!preview?.runningToken || !preview.runningPrescription) return { ok: false as const, message: "走の確認結果がありません。" };
    const combined = { ...coachEdit, ...edit };
    const result = await previewRunningCoachEditAction({ previewToken: preview.runningToken,
      previewPolicyVersion: preview.runningPrescription.policyVersion, previewPolicyHash: preview.runningPrescription.policyHash,
      requestText: preview.requestText, context: preview.context, previewPrescription: preview.runningPrescription, coachEdit: combined });
    if (!result.ok) return { ok: false as const, message: "この調整は走のPolicyで受理できません。" };
    setCoachEdit(combined); setRunning(result.finalPrescription);
    return { ok: true as const };
  }

  return <div className="space-y-6">
    <section className="space-y-3 rounded-xl border bg-white p-4">
      <label className="block text-sm font-medium">やりたい練習<textarea className={INPUT_CLASS} rows={5} maxLength={2000} value={requestText} disabled={pending} onChange={(e) => { setRequestText(e.target.value); clearPreview(); }} placeholder="今日は走らずに股関節の動きと接地を意識したい。最後に壁に手をついて膝を入れ替える練習も入れたい。" /></label>
      <details className="text-sm"><summary className="cursor-pointer">年齢・種目を補足する（任意）</summary><div className="mt-2 grid grid-cols-2 gap-2">
        <label>年齢<select className={INPUT_CLASS} value={ageGroup} disabled={pending} onChange={(e) => { setAgeGroup(e.target.value); clearPreview(); }}><option value="">希望の文章に任せる</option><option value="ELEMENTARY">小学生</option><option value="JUNIOR_HIGH">中学生</option><option value="HIGH_SCHOOL">高校生</option><option value="ADULT">成人</option></select></label>
        <label>種目<select className={INPUT_CLASS} value={event} disabled={pending} onChange={(e) => { setEvent(e.target.value); clearPreview(); }}><option value="">希望の文章に任せる</option><option value="100m">100m</option><option value="200m">200m</option></select></label>
      </div></details>
      <div className="flex gap-2"><Button type="button" disabled={pending || !requestText.trim()} onClick={() => generate()}>メニュー案を作る</Button><Button type="button" variant="secondary" disabled={pending} onClick={() => generate(true)}>手動で作る</Button></div>
    </section>
    {pending && <p role="status" className="text-sm">処理しています…</p>}
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    {preview && <section className="space-y-4">
      <label className="block text-sm">メニュー名<input className={INPUT_CLASS} value={name} maxLength={120} disabled={pending} onChange={(e) => setName(e.target.value)} /></label>
      <p className="text-sm text-slate-600">項目は並べ替え・削除・編集できます。量未設定でも保存できます。{knownSeconds > 0 && ` 所要時間の目安：少なくとも約${Math.ceil(knownSeconds / 60)}分（走の実施時間・量未設定の項目は未算入）`}</p>
      {preview.unsupportedIntents.length > 0 && <p className="text-xs text-slate-500">希望として保持：{preview.unsupportedIntents.join(" / ")}</p>}
      <SortableList items={blocks} onReorder={(ids) => !pending && setBlocks((prior) => reordered(prior, ids))} renderItem={(block, blockHandle) => <section className="space-y-3 rounded-xl border bg-white p-4">
        <div className="flex items-center gap-2">{blockHandle}<input aria-label="ブロック名" className={INPUT_CLASS} value={block.name} maxLength={80} disabled={pending} onChange={(e) => setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, name: e.target.value } : row))} /><Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setBlocks((prior) => prior.filter((row) => row.id !== block.id))}>ブロック削除</Button></div>
        <SortableList items={block.items} onReorder={(ids) => !pending && setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, items: reordered(row.items, ids) } : row))} renderItem={(item, handle) => <article className="space-y-3 rounded-lg border border-slate-200 p-3">
          <div className="flex items-center gap-2">{handle}<label className="flex-1 text-xs">配置<select className={INPUT_CLASS} value={block.id} disabled={pending} onChange={(e) => setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, items: row.items.filter((x) => x.id !== item.id) } : row.id === e.target.value ? { ...row, items: [...row.items, item] } : row))}>{blocks.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, items: row.items.filter((x) => x.id !== item.id) } : row))}>削除</Button></div>
          {item.type === "RUNNING_POLICY" && running ? <><h4 className="font-medium">{running.distanceMeters}m × {running.totalReps}本</h4><p className="text-sm">1本ごとの休憩：{running.repRestSeconds ?? 0}秒</p><p className="text-xs text-slate-500">走の数値は確認済みの処方です。</p>{running.executionInstructionText && <p>{running.executionInstructionText}</p>}{!pending && <RunningPolicyCoachEditor key={JSON.stringify(running)} initial={running} onSubmit={editRunning} />}<label className="block text-xs">メモ<textarea className={INPUT_CLASS} maxLength={1000} value={item.plannedNote} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { plannedNote: e.target.value })} /></label></>
            : item.type !== "RUNNING_POLICY" ? <>
              <ComposedExerciseContent item={item} exercise={item.type === "CATALOG_EXERCISE" ? exercises.find((row) => row.id === item.exerciseId) : undefined} aiProposed={originalIds.has(item.id) && JSON.stringify(originalItems.find((row) => row.id === item.id)) === JSON.stringify(item)} />
              <DoseEditor item={item} disabled={pending} update={(patch) => updateItem(block.id, item.id, patch)} />
              {item.type === "FREEFORM" && <><label className="block text-xs">項目名<input className={INPUT_CLASS} value={item.displayName} maxLength={160} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { displayName: e.target.value })} /></label>{!originalIds.has(item.id) && <label className="block text-xs">元の指示<textarea className={INPUT_CLASS} value={item.originalUserInstruction} maxLength={350} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { originalUserInstruction: e.target.value })} /></label>}<label className="block text-xs">種目の種類<select className={INPUT_CLASS} value={item.category} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { category: e.target.value as typeof item.category })}>{EXERCISE_CATEGORIES.filter((category) => !isRunningExerciseForV2({ category })).map((category) => <option key={category} value={category}>{EXERCISE_CATEGORY_LABEL[category]}</option>)}</select></label></>}
              <label className="block text-xs">実施指示<textarea className={INPUT_CLASS} value={item.executionInstruction} maxLength={400} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { executionInstruction: e.target.value })} /></label>
              <label className="block text-xs">メモ<textarea className={INPUT_CLASS} value={item.plannedNote} maxLength={200} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { plannedNote: e.target.value })} /></label>
            </> : null}
        </article>} />
        <div className="flex flex-wrap gap-2"><select aria-label="追加するカタログ種目" className={INPUT_CLASS} value={catalogPick} disabled={pending} onChange={(e) => setCatalogPick(e.target.value)}><option value="">種目を選ぶ</option>{eligible.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select><Button type="button" variant="secondary" size="sm" disabled={pending || !catalogPick} onClick={() => addItem(block.id, catalogPick)}>種目を追加</Button><Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => addItem(block.id, null)}>自由記入を追加</Button></div>
      </section>} />
      <div className="flex gap-2"><Button type="button" variant="secondary" disabled={pending} onClick={() => setBlocks((prior) => [...prior, { id: crypto.randomUUID(), name: "新しいブロック", items: [] }])}>ブロックを追加</Button><Button type="button" disabled={pending || !name.trim() || !blocks.some((block) => block.items.length)} onClick={save}>確認して保存</Button></div>
    </section>}
  </div>;
}
