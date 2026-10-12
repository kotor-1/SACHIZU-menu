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
import { EMPTY_EXERCISE_DOSE, type ComposeMenuInput, type ComposerCatalogExercise, type EditableItem, type ExercisePlanItem } from "@/domain/menu-composition/contracts";
import { exerciseUsesPerSideCount, exerciseUsesTotalCount } from "@/domain/menu-composition/dose-counting";
import { isRunningExerciseForV2 } from "@/presentation/running/legacy-routing";
import { MenuDurationEditor } from "./menu-duration-editor";
import { calculateMenuDuration, type DurationPlan } from "@/domain/menu-composition/duration";
import { EXERCISE_CATEGORIES, EXERCISE_CATEGORY_LABEL } from "@/domain/exercise/constants";
import { UnprescribedRunningEditor } from "./unprescribed-running-editor";
import type { RunningScienceContext } from "@/domain/running-policy/science-contracts";

type MenuOverview = { title?: string; objective?: string; approach?: string };
type UiComposedMenuPreview = ComposedMenuPreview & {
  overview?: MenuOverview;
  athleteLabel?: string;
  durationPlan?: DurationPlan;
  confirmationQuestions?: string[];
};

function reordered<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const next = ids.flatMap((id) => { const item = items.find((row) => row.id === id); return item ? [item] : []; });
  return next.length === items.length && new Set(ids).size === items.length ? next : items;
}
function DoseEditor({ item, exercise, update, disabled }: { item: ExercisePlanItem; exercise?: ComposerCatalogExercise; update: (patch: Partial<ExercisePlanItem>) => void; disabled: boolean }) {
  const [unit, setUnit] = useState<"plannedDurationSeconds" | "plannedDistanceMeters" | "plannedReps">(item.plannedDurationSeconds !== null ? "plannedDurationSeconds" : item.plannedDistanceMeters !== null ? "plannedDistanceMeters" : "plannedReps");
  const perSide = exerciseUsesPerSideCount(item, exercise);
  const repsLabel = perSide ? "片側ごとの回数" : exerciseUsesTotalCount(exercise) ? "合計の回数" : "回数";
  const limits = { plannedSets: [1, 99], plannedReps: [1, 999], plannedDurationSeconds: [1, 86400], plannedDistanceMeters: [1, 100000], plannedRestSeconds: [0, 86400] };
  const field = (name: keyof typeof limits, label: string) => <label className="text-xs">{label}<input type="number" className={INPUT_CLASS} value={item[name] ?? ""} min={limits[name][0]} max={limits[name][1]} step={name === "plannedDistanceMeters" ? "any" : 1} disabled={disabled} onChange={(e) => update({ [name]: e.target.value === "" ? null : Number(e.target.value) })} /></label>;
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    <label className="text-xs">量の単位<select className={INPUT_CLASS} value={unit} disabled={disabled} onChange={(e) => { setUnit(e.target.value as typeof unit); update({ plannedReps: null, plannedDurationSeconds: null, plannedDistanceMeters: null }); }}>
      <option value="plannedReps">{repsLabel}</option><option value="plannedDurationSeconds">秒</option><option value="plannedDistanceMeters">距離（m）</option>
    </select></label>
    {field(unit, unit === "plannedDurationSeconds" ? "時間（秒）" : unit === "plannedDistanceMeters" ? "距離（m）" : repsLabel)}
    {field("plannedSets", "セット数")}{field("plannedRestSeconds", "休憩（秒）")}
  </div>;
}

function formatMinutes(seconds: number | null): string {
  if (seconds === null) return "未算出";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}分` : `${minutes}分${remainder}秒`;
}

function formatDifference(seconds: number): string {
  const sign = seconds > 0 ? "＋" : seconds < 0 ? "−" : "";
  return `${sign}${formatMinutes(Math.abs(seconds))}`;
}

function itemDoseSummary(item: ExercisePlanItem, exercise?: ComposerCatalogExercise): string {
  const amount = item.plannedDurationSeconds !== null ? `${item.plannedDurationSeconds}秒`
    : item.plannedDistanceMeters !== null ? `${item.plannedDistanceMeters}m`
      : item.plannedReps !== null ? `${exerciseUsesPerSideCount(item, exercise) ? "片側" : exerciseUsesTotalCount(exercise) ? "合計" : ""}${item.plannedReps}回` : "量未設定";
  const sets = item.plannedSets === null ? "" : `${item.plannedSets}セット・`;
  const rest = item.plannedRestSeconds === null ? "" : `・休憩${item.plannedRestSeconds}秒`;
  return `${sets}${amount}${rest}`;
}

export function FreeformMenuComposer({ exercises }: { exercises: ComposerCatalogExercise[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requestText, setRequestText] = useState("");
  const [ageGroup, setAgeGroup] = useState("");
  const [event, setEvent] = useState("");
  const [availableMinutes, setAvailableMinutes] = useState("");
  const [science, setScience] = useState<RunningScienceContext>({});
  const [durationPlan, setDurationPlan] = useState<DurationPlan>({ blocks: [], transitionSeconds: null });
  const [name, setName] = useState("今日のメニュー");
  const [preview, setPreview] = useState<UiComposedMenuPreview | null>(null);
  const [blocks, setBlocks] = useState<ComposedMenuPreview["composition"]["blocks"]>([]);
  const [running, setRunning] = useState<RunningMenuFinalPrescription | null>(null);
  const [coachEdit, setCoachEdit] = useState<RunningCoachEditRequest | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [catalogPick, setCatalogPick] = useState("");
  const [replacePick, setReplacePick] = useState("");
  const eligible = exercises.filter((row) => row.status === "REVIEWED" && !isRunningExerciseForV2(row));
  const originalItems = preview?.composition.blocks.flatMap((block) => block.items) ?? [];
  const originalIds = new Set(originalItems.map((item) => item.id));


  function clearPreview() { setPreview(null); setBlocks([]); setRunning(null); setCoachEdit(undefined); }
  function accept(next: UiComposedMenuPreview) {
    setPreview(next);
    setBlocks(next.composition.blocks);
    setRunning(next.runningPrescription);
    setCoachEdit(undefined);
    if (next.overview?.title) setName(next.overview.title);
    setDurationPlan(next.durationPlan ?? { blocks: next.composition.blocks.map(block => ({
      blockId: block.id,
      phase: block.items.length > 0 && block.items.every(item => item.type === "RUNNING_POLICY" || item.type === "UNPRESCRIBED_RUNNING") ? "RUNNING" : "OTHER",
      allocatedSeconds: null,
    })), transitionSeconds: null });
  }
  function generate(manual = false) {
    setError(null);
    startTransition(async () => {
      const context: ComposeMenuInput["context"] = {};
      if (event) context.event = event;
      if (ageGroup) context.ageGroup = ageGroup as NonNullable<ComposeMenuInput["context"]["ageGroup"]>;
      if (availableMinutes) context.availableTimeSeconds = Math.round(Number(availableMinutes) * 60);
      if (Object.keys(science).length > 0) context.science = science;
      const result = manual ? await createManualComposedMenuAction(context) : await generateComposedMenuAction({ requestText, context });
      if (result.ok) accept(result.preview); else setError(result.message);
    });
  }
  function setScienceNumber(field: "ageYears" | "hoursSinceHighIntensity" | "hoursUntilNextHighIntensity" | "highIntensitySessionsLast7Days" | "referenceDistanceMeters" | "referenceTimeSeconds", value: string) {
    setScience((current) => {
      const next = { ...current };
      if (value.trim() === "") delete next[field];
      else next[field] = Number(value) as never;
      return next;
    });
    clearPreview();
  }
  function setScienceChoice<K extends "experience" | "maturity" | "speedEnduranceMode", V extends RunningScienceContext[K]>(field: K, value: V | "") {
    setScience((current) => {
      const next = { ...current };
      if (value === "") delete next[field];
      else next[field] = value as never;
      return next;
    });
    clearPreview();
  }
  function setScienceBoolean(field: "supervised" | "symptomFree" | "familiarWithSprint", value: string) {
    setScience((current) => {
      const next = { ...current };
      if (value === "") delete next[field];
      else next[field] = value === "yes";
      return next;
    });
    clearPreview();
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
  function replaceWithCatalog(blockId: string, itemId: string, catalogId: string) {
    const exercise = eligible.find((row) => row.id === catalogId);
    if (!exercise) return;
    setBlocks((prior) => prior.map((block) => block.id !== blockId ? block : { ...block, items: block.items.map((item) => {
      if (item.id !== itemId || (item.type !== "CATALOG_EXERCISE" && item.type !== "FREEFORM")) return item;
      const replacement: Extract<EditableItem, { type: "CATALOG_EXERCISE" }> = { id: item.id, type: "CATALOG_EXERCISE", exerciseId: exercise.id, displayName: exercise.name,
        plannedSets: item.plannedSets, plannedReps: item.plannedReps, plannedDurationSeconds: item.plannedDurationSeconds,
        plannedDistanceMeters: item.plannedDistanceMeters, plannedRestSeconds: item.plannedRestSeconds,
        executionInstruction: "", plannedNote: item.plannedNote, reason: "" };
      return replacement;
    }) }));
    setReplacePick("");
  }
  function save() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      const result = await saveComposedMenuAction({ previewToken: preview.previewToken, menuName: name, composition: { blocks }, durationPlan: { ...durationPlan, blocks: durationPlan.blocks.filter(row => blocks.some(block => block.id === row.blockId)) },
        runningPrescription: coachEdit ? running : preview.runningPrescription, ...(coachEdit ? { coachEdit } : {}) });
      if (result.ok) router.push(`/menus/${result.menuId}`);
      else setError(result.code === "DOSE_COUNT_MISMATCH" ? "実施指示の回数と数値欄が一致していません。左右それぞれの回数か合計かを確認してください。" : result.code === "DURATION_UNDERSIZED_SLOT" ? "時間配分が処方済みの実施・休息時間より短くなっています。配分を見直してください。" : result.code === "INVALID_PLAN" ? "項目名・実施指示・量を確認してください。複数の単位を同時に設定しないでください。" : "保存できませんでした。項目・量、走の確認結果を見直してください。");
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

  const requestedSeconds = preview?.requestedTimeSeconds ?? preview?.context.availableTimeSeconds ?? null;
  const durationSummary = preview ? calculateMenuDuration({ blocks }, running, requestedSeconds, durationPlan) : null;
  const staleDurationBlockIds = new Set(durationSummary?.planIssues.filter((issue) => issue.code === "STALE_BASIS").map((issue) => issue.blockId) ?? []);
  const hasStaleDurationEstimate = staleDurationBlockIds.size > 0;
  const allocatedBlockCount = durationSummary?.blocks.filter((block) => block.allocatedSeconds !== null).length ?? 0;
  const allocatedBlockSeconds = durationSummary?.blocks.reduce((sum, block) => sum + (block.allocatedSeconds ?? 0), 0) ?? 0;

  return <div className="space-y-5">
    <details open={!preview} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <summary className="cursor-pointer font-semibold">希望・条件を入力・変更</summary>
      <div className="mt-3 space-y-3">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
        <label className="block text-sm font-medium">やりたい練習<textarea className={`${INPUT_CLASS} mt-1`} rows={3} maxLength={2000} value={requestText} disabled={pending} onChange={(e) => { setRequestText(e.target.value); clearPreview(); }} placeholder="今日は走らずに股関節の動きと接地を意識したい。最後に壁に手をついて膝を入れ替える練習も入れたい。" /></label>
        <div className="grid gap-2 sm:grid-cols-[minmax(9rem,12rem)_auto] lg:grid-cols-1 lg:content-start">
          <label className="block text-sm">希望時間（分・任意）<input type="number" min={1} max={1440} step={1} className={`${INPUT_CLASS} mt-1`} value={availableMinutes} disabled={pending} onChange={(e) => { setAvailableMinutes(e.target.value); clearPreview(); }} placeholder="文章で指定しても使えます" /></label>
          <div className="flex items-end gap-2"><Button type="button" disabled={pending || !requestText.trim()} onClick={() => generate()}>メニュー案を作る</Button><Button type="button" variant="secondary" disabled={pending} onClick={() => generate(true)}>手動で作る</Button></div>
        </div>
      </div>
      <details className="mt-3 text-sm"><summary className="cursor-pointer font-medium">対象・走の条件を補足する（任意）</summary><div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label>年齢<select className={INPUT_CLASS} value={ageGroup} disabled={pending} onChange={(e) => { setAgeGroup(e.target.value); clearPreview(); }}><option value="">希望の文章に任せる</option><option value="ELEMENTARY">小学生</option><option value="JUNIOR_HIGH">中学生</option><option value="HIGH_SCHOOL">高校生</option><option value="ADULT">成人</option></select></label>
        <label>種目<select className={INPUT_CLASS} value={event} disabled={pending} onChange={(e) => { setEvent(e.target.value); clearPreview(); }}><option value="">希望の文章に任せる</option><option value="100m">100m</option><option value="200m">200m</option></select></label>
      </div>
        <details className="mt-3 rounded border p-3"><summary>走の補足情報（わかる範囲で任意）</summary>
          <p className="my-2 text-xs text-slate-600">学年や年齢から成熟度・経験を推定しません。未入力の項目は未確認として扱います。</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs">年齢（歳・任意）<input aria-label="年齢（歳）" type="number" min={6} max={100} step={1} className={INPUT_CLASS} value={science.ageYears ?? ""} disabled={pending} onChange={(e) => setScienceNumber("ageYears", e.target.value)} /></label>
            <label className="text-xs">走の経験<select aria-label="走の経験" className={INPUT_CLASS} value={science.experience ?? ""} disabled={pending} onChange={(e) => setScienceChoice("experience", e.target.value as RunningScienceContext["experience"] | "")}><option value="">未指定</option><option value="BEGINNER">初心者</option><option value="EXPERIENCED">経験あり</option></select></label>
            <label className="text-xs">成熟度（自己申告・任意）<select aria-label="成熟度" className={INPUT_CLASS} value={science.maturity ?? ""} disabled={pending} onChange={(e) => setScienceChoice("maturity", e.target.value as RunningScienceContext["maturity"] | "")}><option value="">未指定</option><option value="PRE">未成熟（PRE）</option><option value="CIRCA">移行期（CIRCA）</option><option value="POST">成熟後（POST）</option><option value="UNKNOWN">不明</option></select></label>
            {([ ["supervised", "コーチ等の見守り"], ["symptomFree", "現在、痛みや体調不良がない"], ["familiarWithSprint", "スプリント練習に慣れている"] ] as const).map(([field, label]) => <label key={field} className="text-xs">{label}<select aria-label={label} className={INPUT_CLASS} value={science[field] === undefined ? "" : science[field] ? "yes" : "no"} disabled={pending} onChange={(e) => setScienceBoolean(field, e.target.value)}><option value="">未指定</option><option value="yes">はい</option><option value="no">いいえ</option></select></label>)}
            <label className="text-xs">直近の高強度練習から（時間）<input aria-label="直近の高強度練習からの時間" type="number" min={0} max={10000} step="any" className={INPUT_CLASS} value={science.hoursSinceHighIntensity ?? ""} disabled={pending} onChange={(e) => setScienceNumber("hoursSinceHighIntensity", e.target.value)} /></label>
            <label className="text-xs">次の高強度練習まで（時間）<input aria-label="次の高強度練習までの時間" type="number" min={0} max={10000} step="any" className={INPUT_CLASS} value={science.hoursUntilNextHighIntensity ?? ""} disabled={pending} onChange={(e) => setScienceNumber("hoursUntilNextHighIntensity", e.target.value)} /></label>
            <label className="text-xs">直近7日間の高強度練習（回）<input aria-label="直近7日間の高強度練習回数" type="number" min={0} max={30} step={1} className={INPUT_CLASS} value={science.highIntensitySessionsLast7Days ?? ""} disabled={pending} onChange={(e) => setScienceNumber("highIntensitySessionsLast7Days", e.target.value)} /></label>
            <label className="text-xs">スピード持久の方法<select aria-label="スピード持久の方法" className={INPUT_CLASS} value={science.speedEnduranceMode ?? ""} disabled={pending} onChange={(e) => setScienceChoice("speedEnduranceMode", e.target.value as RunningScienceContext["speedEnduranceMode"] | "")}><option value="">未指定</option><option value="SPRINT_SPECIFIC">スプリント特異的</option><option value="CONTROLLED_90_95">制御した90〜95%走</option></select></label>
            {science.speedEnduranceMode === "CONTROLLED_90_95" && <><label className="text-xs">参照距離（m・現在60mのみ）<input aria-label="参照距離（m）" type="number" min={60} max={60} step={1} className={INPUT_CLASS} value={science.referenceDistanceMeters ?? ""} disabled={pending} onChange={(e) => setScienceNumber("referenceDistanceMeters", e.target.value)} /></label><label className="text-xs">参照タイム（秒）<input aria-label="参照タイム（秒）" type="number" min={0.01} max={300} step="any" className={INPUT_CLASS} value={science.referenceTimeSeconds ?? ""} disabled={pending} onChange={(e) => setScienceNumber("referenceTimeSeconds", e.target.value)} /></label></>}
          </div>
        </details>
      </details>
      </div>
    </details>
    {pending && <p role="status" className="text-sm">処理しています…</p>}
    {error && <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
    {preview && durationSummary && <section className="space-y-4" aria-label="メニュー案の確認">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">メニューの概要</p>
            <label className="mt-1 block text-sm font-medium">メニュー名<input aria-label="メニュー名" className={`${INPUT_CLASS} mt-1 bg-white text-base font-semibold`} value={name} maxLength={120} disabled={pending} onChange={(e) => setName(e.target.value)} /></label>
            {preview.athleteLabel && <p className="mt-2 text-sm text-slate-700">対象：{preview.athleteLabel}</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_16rem]">
              <div className="rounded-lg border border-slate-200 bg-white p-3"><p className="text-xs font-semibold text-indigo-700">メニュー案のねらい・進め方</p><p className="mt-1 text-sm">{preview.overview?.objective ?? "提案のねらいは未設定です。内容を確認してください。"}</p>{preview.overview?.approach && <p className="mt-1 line-clamp-3 text-sm text-slate-700">{preview.overview.approach}</p>}</div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-1">
            <div className="rounded-lg border bg-white p-3"><p className="text-xs text-slate-500">希望時間</p><p className="text-lg font-semibold" data-testid="overview-requested-time">{formatMinutes(requestedSeconds)}</p></div>
            <div className="rounded-lg border bg-white p-3"><p className="text-xs text-slate-500">{hasStaleDurationEstimate ? "旧配分の合計（再見積もりが必要）" : "提案時間の目安"}</p><p className="text-lg font-semibold" data-testid="overview-planned-time">{durationSummary.plannedTotalSeconds === null ? allocatedBlockCount > 0 ? `部分配分 ${formatMinutes(allocatedBlockSeconds)}` : "未算出" : formatMinutes(durationSummary.plannedTotalSeconds)}</p><p className="text-xs text-slate-500">計画枠の合計。実測時間ではなく、実際の所要時間を保証しません。</p><p className="mt-1 text-xs text-slate-700">数値から分かる最低時間：{formatMinutes(durationSummary.knownMinimumSeconds)}</p><p className="mt-1 text-xs text-slate-700" data-testid="duration-planning-status" data-status={durationSummary.planningStatus}>{hasStaleDurationEstimate ? "内容変更前の見積もりは無効です。再見積もりが必要です。" : durationSummary.planningStatus === "ACCOUNTED_FOR" ? "配分内訳の合計は一致（計画上の推定・要確認）" : "時間配分の内訳は要確認・編集して保存できます"}</p>{durationSummary.plannedTotalSeconds === null && <p className="mt-1 text-xs text-amber-900">ブロック配分 {allocatedBlockCount}/{durationSummary.blocks.length}・移動準備 {durationPlan.transitionSeconds === null ? "未設定" : "入力済み"}。合計はまだ算出できません。</p>}{durationSummary.plannedTotalSeconds === null && requestedSeconds !== null && allocatedBlockCount === blocks.length && requestedSeconds > allocatedBlockSeconds && <p className="mt-1 text-xs text-amber-900">未配分：{formatMinutes(requestedSeconds - allocatedBlockSeconds)}（移動・準備を含めて要確認）</p>}{durationSummary.budgetDifferenceSeconds !== null && <p className="mt-1 text-xs text-slate-700">希望との差：{formatDifference(durationSummary.budgetDifferenceSeconds)}{durationSummary.budgetDifferenceSeconds > 0 ? "（超過）" : durationSummary.budgetDifferenceSeconds < 0 ? "（残り）" : "（一致）"}</p>}{durationSummary.unknownComponents.length > 0 && <p className="mt-1 text-xs text-amber-900">未確定事項：{durationSummary.unknownComponents.length}件</p>}</div>
              </div>
            </div>
          </div>
        </div>
        {preview.confirmationQuestions && preview.confirmationQuestions.length > 0 && <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3" aria-label="確認が必要なこと">
          <h3 className="text-sm font-semibold text-amber-950">確認が必要なこと</h3><ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-950">{preview.confirmationQuestions.map((question, index) => <li key={`${question}:${index}`}>{question}</li>)}</ul>
        </div>}
        {preview.unsupportedIntents.length > 0 && <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><strong>希望の一部は案に反映されていません（{preview.unsupportedIntents.length}件）。</strong> 未反映の例：{preview.unsupportedIntents[0]}。走の数値へは反映していません。</p>}
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="メニューの流れ">
        <div className="mb-3 flex items-end justify-between gap-2"><div><h2 className="font-semibold">メニューの流れ</h2><p className="text-xs text-slate-500">項目と順序を確認し、必要なところだけ編集してください。</p></div><span className="text-xs text-slate-500">{blocks.reduce((sum, block) => sum + block.items.length, 0)}項目</span></div>
        <SortableList items={blocks} onReorder={(ids) => !pending && setBlocks((prior) => reordered(prior, ids))} renderItem={(block, blockHandle) => {
          const allocation = durationPlan.blocks.find((row) => row.blockId === block.id);
          const blockSummary = durationSummary.blocks.find((row) => row.blockId === block.id);
          const estimateIsStale = staleDurationBlockIds.has(block.id);
          return <section key={block.id} className="relative rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
            <div className="flex items-start gap-2">
              {blockHandle}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{block.name}</h3><span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{allocation?.allocatedSeconds == null ? "時間未配分" : `${estimateIsStale ? "旧配分" : "計画"} ${formatMinutes(allocation.allocatedSeconds)}${estimateIsStale ? "・再見積もりが必要" : ""}`}</span></div>
                {blockSummary?.knownMinimumSeconds ? <p className="mt-1 text-xs text-slate-500">確認できる最低時間：{formatMinutes(blockSummary.knownMinimumSeconds)}</p> : null}{estimateIsStale ? <p className="mt-1 text-xs font-medium text-amber-900" data-testid="stale-duration-estimate">種目・実施量・実施指示が変わったため、以前の時間見積もりは無効です。</p> : allocation?.allocationBasis && <details className="mt-1 text-xs text-slate-600"><summary className="cursor-pointer">時間の内訳（計画上の推定・実測ではありません）</summary><p className="mt-1 whitespace-pre-wrap">{allocation.allocationBasis.explanation}</p><p className="mt-1">種目ごとの見積もり：{allocation.allocationBasis.itemEstimatesSeconds.map(formatMinutes).join(" / ")}。ブロック内の準備：{formatMinutes(allocation.allocationBasis.preparationSeconds)}。</p>{allocation.allocationBasis.preparationDescription && <p>{allocation.allocationBasis.preparationDescription}</p>}</details>}</div>
              <details className="shrink-0"><summary className="cursor-pointer rounded border px-2 py-1 text-xs">ブロック設定</summary><div className="mt-2 w-full space-y-2 rounded-lg border bg-slate-50 p-3 sm:w-72"><label className="block text-xs">ブロック名<input aria-label="ブロック名" className={INPUT_CLASS} value={block.name} maxLength={80} disabled={pending} onChange={(e) => setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, name: e.target.value } : row))} /></label><Button type="button" variant="secondary" size="sm" disabled={pending || blocks.length <= 1} onClick={() => setBlocks((prior) => prior.filter((row) => row.id !== block.id))}>ブロック削除</Button></div></details>
            </div>
            <SortableList items={block.items} onReorder={(ids) => !pending && setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, items: reordered(row.items, ids) } : row))} renderItem={(item, handle) => {
              const itemIsPending = item.type === "UNPRESCRIBED_RUNNING";
              const exerciseItem = item.type === "CATALOG_EXERCISE" || item.type === "FREEFORM" ? item : null;
              const catalogExercise = item.type === "CATALOG_EXERCISE" ? exercises.find((row) => row.id === item.exerciseId) : undefined;
              const isAiItem = originalIds.has(item.id) && JSON.stringify(originalItems.find((row) => row.id === item.id)) === JSON.stringify(item);
              const title = itemIsPending ? "走練習（内容を確認）" : item.type === "RUNNING_POLICY" ? "走練習" : item.displayName;
              const manualRunningDose = itemIsPending ? [item.plannedDistanceMeters !== null ? `${item.plannedDistanceMeters}m` : "", item.plannedReps !== null ? `${item.plannedReps}本` : "", item.plannedDurationSeconds !== null ? `${item.plannedDurationSeconds}秒/本` : "", item.plannedSets !== null ? `${item.plannedSets}セット` : "", item.plannedRestSeconds !== null ? `休息${item.plannedRestSeconds}秒` : "", item.plannedIntensityPercent !== null ? `強度${item.plannedIntensityPercent}%` : ""].filter(Boolean).join("・") : "";
              const amount = itemIsPending ? manualRunningDose ? `未処方・手入力 ${manualRunningDose}` : "未処方・数値未設定" : item.type === "RUNNING_POLICY" && running ? `${running.distanceMeters}m × ${running.totalReps}本` : exerciseItem ? itemDoseSummary(exerciseItem, catalogExercise) : "";
              return <article key={item.id} className="mt-2 rounded-lg border border-slate-200 p-3">
                <div className="flex items-start gap-2">{handle}<div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">{title}</h4><span className={`rounded-full px-2 py-0.5 text-xs ${itemIsPending ? "bg-amber-100 text-amber-950" : "bg-slate-100 text-slate-700"}`}>{amount}</span>{exerciseItem && <span className="text-xs text-slate-500">{exerciseItem.type === "FREEFORM" ? "今回だけ" : "カタログ"}{isAiItem ? "・提案" : "・手動"}</span>}</div>
                  {itemIsPending && <p className="mt-1 text-sm text-amber-950">{item.reasonMessage}</p>}
                  {item.type === "RUNNING_POLICY" && running && <div className="mt-1 space-y-1 text-xs text-slate-700">
                    <p>{[
                      running.sets !== null ? `${running.sets}セット` : null,
                      running.setReps?.length ? `セット内訳 ${running.setReps.join("・")}本` : null,
                      running.setRestSeconds !== null ? `セット間休息 ${running.setRestSeconds}秒` : null,
                      running.repRestSeconds !== null ? `本間休息 ${running.repRestSeconds}秒` : null,
                      running.coachTargetTimeSeconds !== null ? `目標 ${running.coachTargetTimeSeconds}秒` : running.coachTargetTimeRange ? `目標 ${running.coachTargetTimeRange.minSeconds}〜${running.coachTargetTimeRange.maxSeconds}秒` : running.science?.targetTimeRangeSeconds ? `目標 ${running.science.targetTimeRangeSeconds.min}〜${running.science.targetTimeRangeSeconds.max}秒` : null,
                      running.science?.intensityPercent ? `強度 ${running.science.intensityPercent.min}〜${running.science.intensityPercent.max}%` : null,
                    ].filter(Boolean).join(" ・ ")}</p>
                    {running.executionInstructionText && <p className="line-clamp-2 whitespace-pre-wrap">{running.executionInstructionText}</p>}
                    <p className="text-slate-500">{running.science ? running.scienceManualEdited ? "元の科学的根拠を参考にした数値（手動変更済み）" : "科学的根拠を参考にした暫定処方・承認前" : "標準処方（個別の希望に合わせた変更なし）"}</p>
                  </div>}
                  {exerciseItem && (exerciseItem.executionInstruction || exerciseItem.plannedNote) && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-600">{exerciseItem.executionInstruction || exerciseItem.plannedNote}</p>}
                </div>
                <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, items: row.items.filter((x) => x.id !== item.id) } : row))}>削除</Button>
                </div>
                <details className="mt-2 border-t pt-2"><summary className="cursor-pointer text-sm font-medium text-indigo-800">内容を確認・編集</summary><div className="space-y-3 pt-3">
                  <label className="block max-w-sm text-xs">配置するブロック<select aria-label={`${title}の配置`} className={INPUT_CLASS} value={block.id} disabled={pending} onChange={(e) => setBlocks((prior) => prior.map((row) => row.id === block.id ? { ...row, items: row.items.filter((x) => x.id !== item.id) } : row.id === e.target.value ? { ...row, items: [...row.items, item] } : row))}>{blocks.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
                  {item.type === "RUNNING_POLICY" && running ? <><p className="text-sm">{running.science ? running.science.stopInstruction : running.executionInstructionText}</p>{!pending && <RunningPolicyCoachEditor key={JSON.stringify(running)} initial={running} onSubmit={editRunning} />}<label className="block text-xs">メモ<textarea className={INPUT_CLASS} maxLength={1000} value={item.plannedNote} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { plannedNote: e.target.value })} /></label></>
                    : item.type === "UNPRESCRIBED_RUNNING" ? <><p className="text-xs text-amber-950">Engineの処方・推奨値はありません。必要な数値は手入力で確認してください。</p><UnprescribedRunningEditor item={item} disabled={pending} onChange={(patch) => updateItem(block.id, item.id, patch as Partial<EditableItem>)} /></>
                    : exerciseItem ? <><ComposedExerciseContent item={exerciseItem} exercise={catalogExercise} aiProposed={isAiItem} /><DoseEditor item={exerciseItem} exercise={catalogExercise} disabled={pending} update={(patch) => updateItem(block.id, item.id, patch)} />
                      <div className="flex flex-col gap-2 border-t pt-3 sm:max-w-lg sm:flex-row"><label className="flex-1 text-xs">別のカタログ種目に置き換える<select aria-label={`${exerciseItem.displayName}を置き換える種目`} className={INPUT_CLASS} value={replacePick} disabled={pending} onChange={(e) => setReplacePick(e.target.value)}><option value="">種目を選ぶ</option>{eligible.filter((row) => row.id !== (exerciseItem.type === "CATALOG_EXERCISE" ? exerciseItem.exerciseId : "")).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><Button type="button" variant="secondary" size="sm" className="self-end" disabled={pending || !replacePick} onClick={() => replaceWithCatalog(block.id, item.id, replacePick)}>置き換える</Button></div>
                      {exerciseItem.type === "FREEFORM" && <><label className="block text-xs">項目名<input className={INPUT_CLASS} value={exerciseItem.displayName} maxLength={160} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { displayName: e.target.value })} /></label>{!originalIds.has(item.id) && <label className="block text-xs">元の指示<textarea className={INPUT_CLASS} value={exerciseItem.originalUserInstruction} maxLength={350} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { originalUserInstruction: e.target.value })} /></label>}<label className="block text-xs">種目の種類<select className={INPUT_CLASS} value={exerciseItem.category} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { category: e.target.value as typeof exerciseItem.category })}>{EXERCISE_CATEGORIES.filter((category) => !isRunningExerciseForV2({ category })).map((category) => <option key={category} value={category}>{EXERCISE_CATEGORY_LABEL[category]}</option>)}</select></label></>}
                      <label className="block text-xs">実施指示<textarea className={INPUT_CLASS} value={exerciseItem.executionInstruction} maxLength={400} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { executionInstruction: e.target.value })} /></label><label className="block text-xs">メモ<textarea className={INPUT_CLASS} value={exerciseItem.plannedNote} maxLength={200} disabled={pending} onChange={(e) => updateItem(block.id, item.id, { plannedNote: e.target.value })} /></label></> : null}
                </div></details>
              </article>;
            }} />
            <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-indigo-800">項目を追加</summary><div className="mt-2 flex flex-col gap-2 sm:flex-row"><select aria-label="追加するカタログ種目" className={INPUT_CLASS} value={catalogPick} disabled={pending} onChange={(e) => setCatalogPick(e.target.value)}><option value="">種目を選ぶ</option>{eligible.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select><div className="flex gap-2"><Button type="button" variant="secondary" size="sm" disabled={pending || !catalogPick} onClick={() => addItem(block.id, catalogPick)}>カタログを追加</Button><Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => addItem(block.id, null)}>自由記入を追加</Button></div></div></details>
          </section>;
        }} />
        <Button type="button" variant="secondary" className="mt-3" disabled={pending} onClick={() => setBlocks((prior) => [...prior, { id: crypto.randomUUID(), name: "新しいブロック", items: [] }])}>ブロックを追加</Button>
      </section>

      <details className="rounded-xl border border-slate-200 bg-white p-4" aria-label="時間配分を調整">
        <summary className="cursor-pointer"><span className="flex flex-wrap items-center justify-between gap-2"><span><strong>時間配分を調整</strong><span className="ml-2 text-xs text-slate-500">任意・種目の量や休憩は変更しません</span></span><span className="text-sm" data-testid="duration-status-summary">{durationSummary.plannedTotalSeconds === null ? `未確定項目 ${durationSummary.unknownComponents.length}件` : `${formatMinutes(durationSummary.plannedTotalSeconds)}の${hasStaleDurationEstimate ? "旧配分・再見積もりが必要" : "計画枠"}${durationSummary.unknownComponents.length ? `・未確定 ${durationSummary.unknownComponents.length}件` : ""}`}</span></span></summary>
        <div className="pt-3"><MenuDurationEditor composition={{ blocks }} running={running} requestedSeconds={requestedSeconds} plan={durationPlan} onChange={setDurationPlan} disabled={pending} /></div>
      </details>
      <div className="sticky bottom-0 z-10 flex justify-end rounded-xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur"><Button type="button" disabled={pending || !name.trim() || !blocks.some((block) => block.items.length)} onClick={save}>確認して保存</Button></div>
    </section>}
  </div>;
}
