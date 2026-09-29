"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, CardBody, CardHeader, Field, INPUT_CLASS, buttonClass, cn } from "@/components/ui";
import {
  generateMenuDraftAction,
  previewMenuDraftRunningAction,
  saveMenuDraftAction,
  type PreviewMenuDraftRunningActionResult,
} from "@/actions/menu-planner-actions";
import { generateRunningMenuPreviewAction, type RunningMenuPreviewActionResult } from "@/actions/running-menu-preview-actions";
import { saveRunningMenuPreviewAction } from "@/actions/running-menu-save-actions";
import { previewRunningCoachEditAction } from "@/actions/running-coach-preview-actions";
import { RunningPolicyCoachEditor, type CoachEditDraft, type CoachEditInitial } from "@/components/menu/running-policy-coach-editor";
import type { RunningActionResult } from "@/actions/running-actions";
import { SortableList } from "@/components/menu/sortable-list";
import { EMPTY_MENU_ITEM_FORM, MenuItemForm, type MenuItemFormValues } from "@/components/menu/menu-item-form";
import { RunningItemPanel, type RunningItemOperations } from "@/components/running/running-item-panel";
import { actionOk, type ActionResult } from "@/domain/shared/result";
import { formatPrescription, type Prescription } from "@/domain/shared/prescription";
import type { MenuPlannerPreview } from "@/presentation/menu-planner/preview";
import type { SavedRunningItemPresentation } from "@/presentation/running/server";
import { emptyContextDraft, emptyMemberDraft, buildRunningContextJson, type RunningContextDraft } from "@/presentation/running/menu-context";
import { AGE_BANDS } from "@/domain/running/types/subject";
import { AGE_BAND_LABEL_JA, PRIMARY_EVENT_LABEL_JA } from "@/presentation/running/labels";
import type { ExercisePickerItem } from "@/infra/repositories/exercise-repository";

/**
 * 統合メニュー Composer（R12 完成形）。
 *
 * - 自然文 → AI が構成を提案 → server の Running Engine / legacy ルールが数値処方 → 同じ画面に editable draft。
 * - 手動「＋種目を追加」も最初から並び、AI を使わずに組むこともできる。
 * - 保存前に: ドラッグ（マウス / タッチ）で並べ替え、追加・削除・種目差し替え・notes 編集、
 *   LEGACY / 手動項目の処方編集、RUNNING_V2 項目の処方調整（既存 RunningItemPanel と同じ検証）。
 * - 「メニューを保存」で初めて MenuTemplate を作り、成功したときだけ /menus/[id] へ遷移する。
 *
 * このコンポーネントは数値処方を計算しない。RUNNING_V2 の調整結果は server の dry-run
 * （保存と同じ処理を rollback 付きで実行）が返した表示 DTO をそのまま表示する。
 */
type PreviewItem = MenuPlannerPreview["blocks"][number]["items"][number];

type ComposedItem =
  | {
      key: string;
      kind: "AI";
      aiBlockIndex: number;
      previewIndex: number;
      preview: PreviewItem;
      /** undefined = AI のまま。文字列 = コーチが notes を編集した（空文字は notes なし）。 */
      note: string | undefined;
    }
  | { key: string; kind: "MANUAL"; values: MenuItemFormValues };

type ComposedBlock = { key: string; title: string; aiBlockIndex: number | null; items: ComposedItem[] };

type RunningOp = {
  aiBlockIndex: number;
  previewIndex: number;
  kind: "EDIT" | "OVERRIDE";
  entries: [string, string][];
};

type Phase = "IDLE" | "GENERATING" | "PREVIEW" | "SAVING" | "ERROR";

type ItemMode = { key: string; mode: "EDIT" | "REPLACE" | "NOTE" | "RUNNING" } | null;

const MANUAL_BLOCK_KEY = "__manual__";
type NewRunningPreview = Extract<RunningMenuPreviewActionResult, { ok: true }>;

function newRunningContext(draft: RunningContextDraft) {
  const member = draft.members[0];
  const ageGroup = ({ U12: "ELEMENTARY", U15: "JUNIOR_HIGH", U18: "HIGH_SCHOOL", ADULT: "ADULT" } as const)[member?.ageBandOverride as "U12" | "U15" | "U18" | "ADULT"];
  const event = member?.primaryEvent === "100m" || member?.primaryEvent === "200m" ? member.primaryEvent : undefined;
  const minutes = draft.availableMinutes.trim() === "" ? undefined : Number(draft.availableMinutes);
  return {
    ...(ageGroup ? { ageGroup } : {}),
    ...(event ? { event } : {}),
    ...(minutes !== undefined && Number.isInteger(minutes * 60) && minutes > 0 ? { availableTimeSeconds: minutes * 60 } : {}),
  };
}

/** 手動追加項目の client 側 key を一意にするための module スコープ counter。 */
let manualItemIdCounter = 0;
function nextManualItemKey(): string {
  return `m-${manualItemIdCounter++}`;
}

const ERROR_MESSAGES: Record<string, string> = {
  FEATURE_DISABLED: "この機能は現在準備中です。しばらくお待ちください。",
  INVALID_INPUT: "入力内容を確認してください。",
  AI_PROVIDER_UNAVAILABLE: "提案サービスを利用できません。時間をおいて再度お試しください。",
  AI_PROVIDER_FAILED: "提案を作成できませんでした。入力を見直して再度お試しください。",
  AI_OUTPUT_INVALID: "提案の内容を確認できませんでした。別の表現で再度お試しください。",
  STALE_PREVIEW: "このプレビューは現在の状態と一致しなくなりました。もう一度作成してください。",
  PLANNING_REJECTED: "この内容ではプレビューを作成できませんでした。条件を見直してください。",
  SAVE_FAILED: "メニューを保存できませんでした。内容を確認して再度お試しください。",
};

function messageFor(error: { kind: string; code?: string; message?: string }): string {
  // server の message はコーチ向けに書かれた日本語（内部コードは含まない）。条件の見直しに必要なので出す。
  if ((error.kind === "RUNNING_EDIT_REJECTED" || error.kind === "PLANNING_REJECTED" || error.kind === "STALE_PREVIEW") && error.message) {
    return error.message;
  }
  return ERROR_MESSAGES[error.kind] ?? ERROR_MESSAGES[error.code ?? ""] ?? "処理を完了できませんでした。時間をおいて再度お試しください。";
}

function runningKey(aiBlockIndex: number, previewIndex: number): string {
  return `${aiBlockIndex}:${previewIndex}`;
}

function isRunningAi(item: ComposedItem): item is Extract<ComposedItem, { kind: "AI" }> {
  return item.kind === "AI" && item.preview.dose !== null && item.preview.dose.kind === "RUNNING_V2";
}

function readMenuItemValues(formData: FormData): MenuItemFormValues {
  const str = (key: string) => String(formData.get(key) ?? "");
  return {
    exerciseId: str("exerciseId"),
    displayName: str("displayName"),
    sets: str("sets"),
    reps: str("reps"),
    distanceMeters: str("distanceMeters"),
    durationSeconds: str("durationSeconds"),
    restSeconds: str("restSeconds"),
    intensityPercent: str("intensityPercent"),
    loadKg: str("loadKg"),
    note: str("note"),
  };
}

/** AI の LEGACY 項目（EXERCISE）を手動編集フォームの初期値へ写す。 */
function valuesFromPreview(item: Extract<ComposedItem, { kind: "AI" }>): MenuItemFormValues {
  const str = (v: number | null | undefined) => (v == null ? "" : String(v));
  const exerciseId = item.preview.selection.kind === "EXERCISE" ? item.preview.selection.exerciseId : "";
  const dose = item.preview.dose;
  const note = item.note ?? "";
  if (dose !== null && dose.kind === "LEGACY") {
    return {
      exerciseId,
      displayName: "",
      sets: str(dose.prescription.sets),
      reps: str(dose.prescription.reps),
      distanceMeters: str(dose.prescription.distanceMeters),
      durationSeconds: str(dose.prescription.durationSeconds),
      restSeconds: str(dose.prescription.restSeconds),
      intensityPercent: str(dose.prescription.intensityPercent),
      loadKg: str(dose.prescription.loadKg),
      note,
    };
  }
  return { ...EMPTY_MENU_ITEM_FORM, exerciseId, note };
}

function manualPrescription(values: MenuItemFormValues): Prescription {
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return {
    sets: num(values.sets),
    reps: num(values.reps),
    distanceMeters: num(values.distanceMeters),
    durationSeconds: num(values.durationSeconds),
    restSeconds: num(values.restSeconds),
    intensityPercent: num(values.intensityPercent),
    loadKg: num(values.loadKg),
  };
}

/** server へ送る MenuItemInput（空文字は null。数値の検証は server の menuItemInputSchema）。 */
function manualInput(values: MenuItemFormValues) {
  const text = (s: string) => (s.trim() === "" ? null : s.trim());
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return {
    exerciseId: text(values.exerciseId),
    displayName: text(values.displayName),
    sets: num(values.sets),
    reps: num(values.reps),
    distanceMeters: num(values.distanceMeters),
    durationSeconds: num(values.durationSeconds),
    restSeconds: num(values.restSeconds),
    intensityPercent: num(values.intensityPercent),
    loadKg: num(values.loadKg),
    note: text(values.note),
  };
}

const ITEM_ACTION_CLASS =
  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800";

export function UnifiedMenuComposer({ exercises }: { exercises: ExercisePickerItem[] }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [menuName, setMenuName] = useState("");
  const [requestText, setRequestText] = useState("");
  const [runningContext, setRunningContext] = useState<RunningContextDraft>(emptyContextDraft());
  /** AI 生成に使った running context（保存時に再送し、署名済み fingerprint と照合される）。 */
  const [generatedContextJson, setGeneratedContextJson] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ComposedBlock[]>([]);
  const [acceptToken, setAcceptToken] = useState<string | null>(null);
  const [runningOps, setRunningOps] = useState<RunningOp[]>([]);
  const [runningViews, setRunningViews] = useState<Record<string, SavedRunningItemPresentation>>({});
  const [newRunningPreview, setNewRunningPreview] = useState<NewRunningPreview | null>(null);
  const [newRunningCoachEdit, setNewRunningCoachEdit] = useState<{
    edit: CoachEditDraft; finalPrescription: CoachEditInitial; finalFingerprint: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [addingBlockKey, setAddingBlockKey] = useState<string | null>(null);
  const [itemMode, setItemMode] = useState<ItemMode>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [runningLoading, setRunningLoading] = useState(false);
  const [, startTransition] = useTransition();

  const busy = phase === "GENERATING" || phase === "SAVING";
  const newRunningDisplay = newRunningPreview?.running?.status === "READY"
    ? newRunningCoachEdit?.finalPrescription ?? newRunningPreview.running.prescription
    : null;

  async function previewCoachEdit(edit: CoachEditDraft) {
    if (newRunningPreview?.running?.status !== "READY" || newRunningPreview.previewToken === null) {
      return { ok: false as const, message: "走処方を再生成してください。" };
    }
    const combined: CoachEditDraft = { ...newRunningCoachEdit?.edit, ...edit };
    if (edit.distanceMeters !== undefined) {
      if (edit.totalReps === undefined) delete combined.totalReps;
      if (edit.repRestSeconds === undefined) delete combined.repRestSeconds;
      if (edit.coachTargetTimeSeconds === undefined) delete combined.coachTargetTimeSeconds;
      if (edit.coachTargetTimeRange === undefined) delete combined.coachTargetTimeRange;
      if (edit.setReps === undefined) delete combined.setReps;
      if (edit.setRestSeconds === undefined) delete combined.setRestSeconds;
    }
    const result = await previewRunningCoachEditAction({
      previewToken: newRunningPreview.previewToken,
      previewPolicyVersion: newRunningPreview.running.prescription.policyVersion,
      previewPolicyHash: newRunningPreview.running.prescription.policyHash,
      previewPrescription: newRunningPreview.running.prescription,
      requestText: requestText.trim(), context: newRunningContext(runningContext), coachEdit: combined,
    });
    if (!result.ok) {
      const messages: Record<string, string> = {
        RANGE_OUTSIDE: "承認済みの本数・休憩の範囲で設定してください。",
        DISTANCE_REVIEW_REQUIRED: "この距離への変更にはコーチ確認が必要です。",
        TIME_ADJUSTMENT_REQUIRED: "指定された時間に必要な休憩が収まりません。",
        INVALID_EDIT: "本数・休憩・セット・目標タイムの指定を確認してください。",
      };
      return { ok: false as const, message: messages[result.code] ?? "コーチ調整を確認できませんでした。再生成してください。" };
    }
    setNewRunningCoachEdit({ edit: combined, finalPrescription: result.finalPrescription, finalFingerprint: result.finalFingerprint });
    return { ok: true as const };
  }

  function updateContext(patch: Partial<RunningContextDraft>) {
    setNewRunningPreview(null);
    setNewRunningCoachEdit(null);
    setRunningContext((d) => ({ ...d, ...patch }));
  }
  function ensureMember() {
    if (runningContext.members.length === 0) updateContext({ members: [emptyMemberDraft()] });
  }
  function updateMember(index: number, patch: Partial<RunningContextDraft["members"][number]>) {
    setNewRunningPreview(null);
    setNewRunningCoachEdit(null);
    setRunningContext((d) => ({ ...d, members: d.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) }));
  }

  // ---------------------------------------------------------------------------
  // server へ送る draft（保存・dry-run 共通）
  // ---------------------------------------------------------------------------

  function draftPayload(nextBlocks: readonly ComposedBlock[], ops: readonly RunningOp[]) {
    // AI 項目として残っている RUNNING_V2 項目への調整だけを送る（差し替え・削除済みのものは落とす）。
    const liveRunning = new Set(
      nextBlocks.flatMap((b) => b.items.filter(isRunningAi).map((it) => runningKey(it.aiBlockIndex, it.previewIndex))),
    );
    return {
      acceptToken,
      runningContextJson: acceptToken === null ? null : generatedContextJson,
      menuName: menuName.trim(),
      blocks: nextBlocks.map((b) => ({
        name: b.title,
        aiBlockIndex: b.aiBlockIndex,
        items: b.items.map((it) =>
          it.kind === "AI"
            ? {
                kind: "AI" as const,
                previewIndex: it.previewIndex,
                ...(it.note !== undefined ? { note: it.note.trim() === "" ? null : it.note.trim() } : {}),
              }
            : { kind: "MANUAL" as const, values: manualInput(it.values) },
        ),
      })),
      runningOps: ops.filter((op) => liveRunning.has(runningKey(op.aiBlockIndex, op.previewIndex))),
    };
  }

  function applyRunningViews(result: Extract<PreviewMenuDraftRunningActionResult, { ok: true }>) {
    setRunningViews(Object.fromEntries(result.running.map((v) => [runningKey(v.aiBlockIndex, v.previewIndex), v.presentation])));
  }

  // ---------------------------------------------------------------------------
  // AI 生成
  // ---------------------------------------------------------------------------

  function submitGenerate() {
    const normalizedName = menuName.trim();
    const normalizedRequest = requestText.trim();
    if (normalizedName.length === 0) return setErrorMessage("メニュー名を入力してください。");
    if (normalizedRequest.length === 0) return setErrorMessage("作りたい練習内容を入力してください。");
    if (runningContext.availableMinutes.trim() !== "" && newRunningContext(runningContext).availableTimeSeconds === undefined) return setErrorMessage("練習時間は0より大きい分数で入力してください。");

    startTransition(async () => {
      setPhase("GENERATING");
      setErrorMessage(null);
      try {
        const newResult = await generateRunningMenuPreviewAction({ requestText: normalizedRequest, context: newRunningContext(runningContext) });
        if (!newResult.ok) {
          setErrorMessage(newResult.message);
          setPhase("ERROR");
          return;
        }
        if (newResult.running !== null) {
          setNewRunningPreview(newResult);
          setNewRunningCoachEdit(null);
          setBlocks((prev) => prev.filter((b) => b.key === MANUAL_BLOCK_KEY));
          setAcceptToken(null);
          setGeneratedContextJson(null);
          setRunningOps([]);
          setRunningViews({});
          setPhase("PREVIEW");
          return;
        }
        // Exercise-only keeps the existing signed, editable, persistable flow.
        const context = buildRunningContextJson(runningContext);
        if (!context.ok) {
          setErrorMessage(context.message);
          setPhase("ERROR");
          return;
        }
        const result = await generateMenuDraftAction({
          schemaVersion: 1,
          menuName: normalizedName,
          runningContextJson: context.json,
          coachRequest: {
            schemaVersion: 1,
            requestText: normalizedRequest,
            constraints: { phase: null, targetEvents: [], purposes: [], availableMinutes: null, equipment: null, preferredExerciseIds: [], excludedExerciseIds: [] },
          },
        });
        if (!result.ok) {
          setErrorMessage(messageFor(result.error));
          setPhase("ERROR");
          return;
        }
        if (result.result.kind === "CLARIFICATION") {
          setErrorMessage(`AIから追加の確認があります：${result.result.question.text}`);
          setPhase("ERROR");
          return;
        }
        if (result.result.acceptToken === null) {
          setErrorMessage("この内容では保存できる下書きを作れませんでした。条件や表現を見直して再度お試しください。");
          setPhase("ERROR");
          return;
        }
        const aiBlocks: ComposedBlock[] = result.result.preview.blocks.map((block, aiBlockIndex) => ({
          key: block.blockKey,
          title: block.title,
          aiBlockIndex,
          items: block.items.map((item, previewIndex) => ({ key: item.itemKey, kind: "AI" as const, aiBlockIndex, previewIndex, preview: item, note: undefined })),
        }));
        // 手動で追加した項目は AI 生成後も末尾の「メニュー」ブロックとして残す。
        setBlocks((prev) => [...aiBlocks, ...prev.filter((b) => b.key === MANUAL_BLOCK_KEY)]);
        setNewRunningPreview(null);
        setNewRunningCoachEdit(null);
        setAcceptToken(result.result.acceptToken);
        setGeneratedContextJson(context.json);
        setRunningOps([]);
        setRunningViews({});
        setAddingBlockKey(null);
        setItemMode(null);
        setPhase("PREVIEW");
      } catch {
        setErrorMessage("処理を完了できませんでした。時間をおいて再度お試しください。");
        setPhase("ERROR");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 下書きの編集（ローカル state だけ。保存するまで DB には何も書かない）
  // ---------------------------------------------------------------------------

  /** 指定ブロックへ手動項目を追加する（ローカル action。MenuItemForm を再利用）。 */
  function addItemToBlock(blockKey: string): (prev: ActionResult<null> | null, formData: FormData) => Promise<ActionResult<null>> {
    return async (_prev, formData) => {
      const item: ComposedItem = { key: nextManualItemKey(), kind: "MANUAL", values: readMenuItemValues(formData) };
      setBlocks((prev) => {
        if (!prev.some((b) => b.key === blockKey)) {
          return [...prev, { key: blockKey, title: "メニュー", aiBlockIndex: null, items: [item] }];
        }
        return prev.map((b) => (b.key === blockKey ? { ...b, items: [...b.items, item] } : b));
      });
      return actionOk(null);
    };
  }

  /** 編集 / 差し替え（ローカル action）。AI 項目は手動項目に置き換わる（AI の処方は使わない）。 */
  function replaceItem(itemKey: string): (prev: ActionResult<null> | null, formData: FormData) => Promise<ActionResult<null>> {
    return async (_prev, formData) => {
      const values = readMenuItemValues(formData);
      setBlocks((prev) =>
        prev.map((b) => ({
          ...b,
          items: b.items.map((it) => (it.key === itemKey ? { key: it.key, kind: "MANUAL" as const, values } : it)),
        })),
      );
      setItemMode(null);
      return actionOk(null);
    };
  }

  function saveNote(itemKey: string) {
    setBlocks((prev) =>
      prev.map((b) => ({
        ...b,
        items: b.items.map((it) => (it.key === itemKey && it.kind === "AI" ? { ...it, note: noteDraft } : it)),
      })),
    );
    setItemMode(null);
  }

  function deleteItem(blockKey: string, itemKey: string) {
    setBlocks((bs) =>
      bs
        .map((b) => (b.key === blockKey ? { ...b, items: b.items.filter((i) => i.key !== itemKey) } : b))
        .filter((b) => !(b.key === MANUAL_BLOCK_KEY && b.items.length === 0)),
    );
    if (itemMode?.key === itemKey) setItemMode(null);
  }

  function reorderItems(blockKey: string, orderedItemKeys: string[]) {
    setBlocks((bs) =>
      bs.map((b) => {
        if (b.key !== blockKey) return b;
        const byKey = new Map(b.items.map((i) => [i.key, i]));
        return { ...b, items: orderedItemKeys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : [])) };
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // RUNNING_V2 の処方調整（保存前 dry-run。既存 RunningItemPanel と既存 Action の検証をそのまま使う）
  // ---------------------------------------------------------------------------

  function openRunning(item: Extract<ComposedItem, { kind: "AI" }>) {
    setItemMode({ key: item.key, mode: "RUNNING" });
    setAddingBlockKey(null);
    if (runningViews[runningKey(item.aiBlockIndex, item.previewIndex)] !== undefined) return;
    setRunningLoading(true);
    startTransition(async () => {
      try {
        const result = await previewMenuDraftRunningAction(draftPayload(blocks, runningOps));
        if (result.ok) applyRunningViews(result);
        else setErrorMessage(messageFor(result.error));
      } catch {
        setErrorMessage("処理を完了できませんでした。時間をおいて再度お試しください。");
      } finally {
        setRunningLoading(false);
      }
    });
  }

  function runningOperations(item: Extract<ComposedItem, { kind: "AI" }>): RunningItemOperations {
    const submit = (kind: RunningOp["kind"]) => async (form: FormData): Promise<RunningActionResult<unknown>> => {
      const op: RunningOp = {
        aiBlockIndex: item.aiBlockIndex,
        previewIndex: item.previewIndex,
        kind,
        entries: [...form.entries()].map(([key, value]) => [key, String(value)] as [string, string]),
      };
      const payload = draftPayload(blocks, [...runningOps, op]);
      const result = await previewMenuDraftRunningAction(payload);
      if (result.ok) {
        setRunningOps(payload.runningOps);
        applyRunningViews(result);
        return { ok: true, data: null, message: "保存前の下書きに反映しました（メニューを保存すると確定します）" };
      }
      if ("failure" in result && result.opIndex === payload.runningOps.length - 1) return result.failure;
      return { ok: false, kind: "REJECTED", message: messageFor(result.error) };
    };
    return {
      edit: submit("EDIT"),
      override: submit("OVERRIDE"),
      recalculate: async () => ({ ok: false, kind: "REJECTED", message: "保存前の下書きは現行ルールで計算されています。" }),
    };
  }

  // ---------------------------------------------------------------------------
  // 保存
  // ---------------------------------------------------------------------------

  function submitSave() {
    if (menuName.trim().length === 0) return setErrorMessage("メニュー名を入力してください。");
    if (newRunningPreview !== null && newRunningPreview.running !== null) {
      if (newRunningPreview.running.status !== "READY" || newRunningPreview.previewToken === null) {
        return setErrorMessage("この走処方はまだ保存できません。条件を確認して再生成してください。");
      }
      const previewToken = newRunningPreview.previewToken;
      const prescription = newRunningPreview.running.prescription;
      startTransition(async () => {
        setPhase("SAVING");
        setErrorMessage(null);
        try {
          const result = await saveRunningMenuPreviewAction({
            previewToken,
            previewPolicyVersion: prescription.policyVersion,
            previewPolicyHash: prescription.policyHash,
            previewPrescription: prescription,
            ...(newRunningCoachEdit ? { coachEdit: newRunningCoachEdit.edit, previewFinalFingerprint: newRunningCoachEdit.finalFingerprint } : {}),
            requestText: requestText.trim(),
            context: newRunningContext(runningContext),
            menuName: menuName.trim(),
            manualBlocks: blocks.map((block) => ({ name: block.title, items: block.items.filter((item): item is Extract<ComposedItem, { kind: "MANUAL" }> => item.kind === "MANUAL").map((item) => manualInput(item.values)) })),
          });
          if (!result.ok) {
            const messages: Record<string, string> = {
              STALE_PREVIEW: "プレビューの有効期限が切れたか、条件が変更されました。もう一度作成してください。",
              POLICY_MISMATCH: "走処方のルールが更新されました。もう一度作成してください。",
              ENGINE_RECOMPUTE_MISMATCH: "表示中の処方と保存時の処方が一致しません。もう一度作成してください。",
              COACH_EDIT_INVALID: "コーチ調整の値を確認して、もう一度プレビューしてください。",
              RUNNING_NOT_READY: "この走処方はまだ保存できません。条件を確認してください。",
              EXERCISE_CHANGED: "選ばれた種目が変更されました。もう一度作成してください。",
              SAVE_FAILED: "メニューを保存できませんでした。内容を確認して再度お試しください。",
            };
            setErrorMessage(messages[result.code] ?? messages.SAVE_FAILED);
            setPhase("PREVIEW");
            return;
          }
          router.push(`/menus/${result.menuId}`);
        } catch {
          setErrorMessage("メニューを保存できませんでした。もう一度お試しください。");
          setPhase("PREVIEW");
        }
      });
      return;
    }
    if (blocks.length === 0 || blocks.every((b) => b.items.length === 0)) {
      return setErrorMessage("保存する項目がありません。AIで作成するか、手動で種目を追加してください。");
    }

    startTransition(async () => {
      setPhase("SAVING");
      setErrorMessage(null);
      try {
        const payload = draftPayload(blocks, runningOps);
        const result = await saveMenuDraftAction(payload);
        if (!result.ok) {
          if ("failure" in result) {
            // 確認し直しが必要になった調整（以降の調整はその結果を前提にしている）を外す。
            // 何も保存されていないので、コーチが「処方を調整」から改めて確認して反映する。
            setRunningOps(payload.runningOps.slice(0, result.opIndex));
            setRunningViews({});
            setItemMode(null);
            setErrorMessage(`走トレーニングの調整を確認し直してください：${result.failure.message}`);
          } else {
            setErrorMessage(messageFor(result.error));
          }
          setPhase("PREVIEW");
          return;
        }
        router.push(`/menus/${result.menuId}`);
      } catch {
        setErrorMessage("保存を完了できませんでした。時間をおいて再度お試しください。");
        setPhase("PREVIEW");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 表示
  // ---------------------------------------------------------------------------

  function itemTitle(item: ComposedItem): string {
    if (item.kind === "AI") return item.preview.title;
    if (item.values.exerciseId) {
      const ex = exercises.find((e) => e.id === item.values.exerciseId);
      if (ex) return ex.name;
    }
    return item.values.displayName.trim() || "（名称未設定）";
  }

  function renderDose(item: ComposedItem): string | null {
    if (item.kind === "MANUAL") return formatPrescription(manualPrescription(item.values));
    const dose = item.preview.dose;
    if (dose === null) return null;
    if (dose.kind === "LEGACY") {
      return [
        dose.prescription.sets === null ? null : `${dose.prescription.sets}set`,
        dose.prescription.distanceMeters === null ? null : `${dose.prescription.distanceMeters}m`,
        dose.prescription.reps === null ? null : `${dose.prescription.reps}回`,
        dose.prescription.restSeconds === null ? null : `レスト${dose.prescription.restSeconds}秒`,
      ].filter((v): v is string => v !== null).join(" ");
    }
    return `${dose.dose.countsLabel}・${dose.dose.restLabel}`;
  }

  function itemNote(item: ComposedItem): string {
    return item.kind === "MANUAL" ? item.values.note.trim() : (item.note ?? "").trim();
  }

  const draftVisible = blocks.length > 0 && blocks.some((b) => b.items.length > 0);

  function renderItem(block: ComposedBlock, item: ComposedItem, dragHandle: ReactNode) {
    const mode = itemMode?.key === item.key ? itemMode.mode : null;

    if (mode === "EDIT" || mode === "REPLACE") {
      const initial =
        mode === "REPLACE"
          ? { ...EMPTY_MENU_ITEM_FORM, note: itemNote(item) }
          : item.kind === "MANUAL"
            ? item.values
            : valuesFromPreview(item);
      return (
        <div className="space-y-1 rounded-lg border border-indigo-200 bg-indigo-50/40 p-2">
          <p className="px-1 text-xs font-semibold text-indigo-800">
            {mode === "REPLACE" ? `「${itemTitle(item)}」を別の種目に差し替え` : `「${itemTitle(item)}」を編集`}
          </p>
          <MenuItemForm
            action={replaceItem(item.key)}
            exercises={exercises}
            initial={initial}
            submitLabel={mode === "REPLACE" ? "差し替える" : "反映する"}
            onCancel={() => setItemMode(null)}
            compact
          />
        </div>
      );
    }

    const dose = renderDose(item);
    const running = isRunningAi(item) ? item : null;
    const runningView = running === null ? undefined : runningViews[runningKey(running.aiBlockIndex, running.previewIndex)];
    const adjusted = running !== null && runningOps.some((op) => op.aiBlockIndex === running.aiBlockIndex && op.previewIndex === running.previewIndex);
    const note = itemNote(item);

    return (
      <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3" data-testid="composer-item" data-item-title={itemTitle(item)}>
        <div className="flex items-start gap-2">
          {dragHandle}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-sm font-semibold break-words text-slate-900">{itemTitle(item)}</p>
              {running !== null && <Badge className="border-indigo-200 bg-indigo-50 text-indigo-700">走トレーニング</Badge>}
              {adjusted && <Badge className="border-amber-200 bg-amber-50 text-amber-800">コーチ調整済み</Badge>}
              {item.kind === "MANUAL" && <Badge className="border-slate-200 bg-slate-50 text-slate-600">手動</Badge>}
            </div>
            {dose !== null && dose !== "" && !(runningView !== undefined && adjusted) && <p className="mt-0.5 font-mono text-xs text-slate-600">{dose}</p>}
            {note !== "" && <p className="mt-0.5 text-xs text-slate-500">メモ：{note}</p>}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 pl-10">
          {running !== null ? (
            <button type="button" className={ITEM_ACTION_CLASS} disabled={busy} onClick={() => (mode === "RUNNING" ? setItemMode(null) : openRunning(running))}>
              {mode === "RUNNING" ? "調整を閉じる" : "処方を調整"}
            </button>
          ) : (
            <button type="button" className={ITEM_ACTION_CLASS} disabled={busy} onClick={() => { setItemMode({ key: item.key, mode: "EDIT" }); setAddingBlockKey(null); }}>
              ✎ 編集
            </button>
          )}
          <button type="button" className={ITEM_ACTION_CLASS} disabled={busy} onClick={() => { setItemMode({ key: item.key, mode: "REPLACE" }); setAddingBlockKey(null); }}>
            ⇄ 差し替え
          </button>
          {item.kind === "AI" && (
            <button type="button" className={ITEM_ACTION_CLASS} disabled={busy} onClick={() => { setNoteDraft(item.note ?? ""); setItemMode({ key: item.key, mode: "NOTE" }); setAddingBlockKey(null); }}>
              メモ
            </button>
          )}
          <button type="button" className={cn(ITEM_ACTION_CLASS, "hover:text-rose-600")} title="削除" aria-label={`「${itemTitle(item)}」を削除`} disabled={busy} onClick={() => deleteItem(block.key, item.key)}>
            ✕ 削除
          </button>
        </div>

        {mode === "NOTE" && (
          <div className="space-y-2 pl-10">
            <textarea
              aria-label="メモ"
              className={`${INPUT_CLASS} min-h-16`}
              value={noteDraft}
              maxLength={1000}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="例：1本ごとに歩いて戻る"
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => saveNote(item.key)}>メモを反映</Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setItemMode(null)}>キャンセル</Button>
            </div>
          </div>
        )}

        {mode === "RUNNING" && running !== null && (
          <div className="pl-10">
            {runningView === undefined ? (
              <p role="status" className="text-xs text-slate-500">{runningLoading ? "処方を読み込み中…" : "処方を表示できませんでした。"}</p>
            ) : (
              <RunningItemPanel menuId="__draft__" presentation={runningView} operations={runningOperations(running)} />
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-bold text-slate-900">メニューを作成</h2>
          <p className="mt-1 text-sm text-slate-500">希望を自然文で伝えるか、手動で種目を追加して組み立てます。</p>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field label="メニュー名" required>
            <input id="composer-menu-name" className={INPUT_CLASS} value={menuName} onChange={(e) => setMenuName(e.target.value)} maxLength={120} placeholder="例：短距離ブロックの準備メニュー" disabled={busy} />
          </Field>

          <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-sm font-semibold text-slate-800">AIに練習メニューを作ってもらう</h3>
            <textarea
              id="composer-request"
              aria-label="作りたい練習内容"
              className={`${INPUT_CLASS} min-h-28 resize-y`}
              value={requestText}
              onChange={(e) => { setRequestText(e.target.value); setNewRunningPreview(null); setNewRunningCoachEdit(null); }}
              maxLength={2000}
              placeholder="例：中学生100m選手。今日は軽めに走るメニューを作って。最後に補強を少し。"
              disabled={busy}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-500">AIは種目の選択と構成だけを提案します。数値の処方はサーバー側のルールで決まります。</p>
              <Button type="button" size="lg" disabled={busy} onClick={submitGenerate}>
                {phase === "GENERATING" ? "作成中…" : "AIでメニューを作成"}
              </Button>
            </div>
          </section>

          <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-sm font-semibold text-slate-800">対象グループ・計画日（走りの処方に使います）</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="対象グループ名">
                <input id="composer-group-label" className={INPUT_CLASS} value={runningContext.label} onChange={(e) => updateContext({ label: e.target.value })} maxLength={80} disabled={busy} placeholder="例：短距離ブロック" />
              </Field>
              <Field label="計画日">
                <input id="composer-planned-date" type="date" className={INPUT_CLASS} value={runningContext.plannedDate} onChange={(e) => updateContext({ plannedDate: e.target.value })} disabled={busy} />
              </Field>
            </div>
            {runningContext.members.length === 0 ? (
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={ensureMember}>＋ 選手（年代・種目）を追加</Button>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="年代">
                  <select id="composer-age-band" className={INPUT_CLASS} value={runningContext.members[0]!.ageBandOverride} onChange={(e) => updateMember(0, { ageBandOverride: e.target.value })} disabled={busy}>
                    <option value="">指定なし</option>
                    {AGE_BANDS.map((band) => <option key={band} value={band}>{AGE_BAND_LABEL_JA[band]}</option>)}
                  </select>
                </Field>
                <Field label="主な種目">
                  <select id="composer-primary-event" className={INPUT_CLASS} value={runningContext.members[0]!.primaryEvent} onChange={(e) => updateMember(0, { primaryEvent: e.target.value })} disabled={busy}>
                    {Object.entries(PRIMARY_EVENT_LABEL_JA).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                </Field>
              </div>
            )}
          </section>

          <section className="space-y-2 rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-800">手動で種目を追加</h3>
              <p className="text-xs text-slate-500">AIを使わずに、種目を選んで処方を組み立てます。</p>
            </div>
            {addingBlockKey === MANUAL_BLOCK_KEY ? (
              <MenuItemForm
                action={addItemToBlock(MANUAL_BLOCK_KEY)}
                exercises={exercises}
                initial={EMPTY_MENU_ITEM_FORM}
                submitLabel="追加する"
                onCancel={() => setAddingBlockKey(null)}
                resetOnSuccess
                compact
              />
            ) : (
              <Button type="button" variant="secondary" size="sm" className="w-full border-dashed" disabled={busy} onClick={() => { setAddingBlockKey(MANUAL_BLOCK_KEY); setItemMode(null); }}>
                ＋ 種目を追加
              </Button>
            )}
          </section>
        </CardBody>
      </Card>

      {errorMessage !== null && (
        <div role="alert" data-testid="composer-error" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{errorMessage}</div>
      )}

      {newRunningPreview !== null && newRunningPreview.running !== null && (
        <Card data-testid="new-running-preview">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-slate-900">走る練習のプレビュー</h2>
              <Badge className="border-amber-200 bg-amber-50 text-amber-800">未保存</Badge>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            {newRunningDisplay !== null ? (
              <div role="status" className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="text-lg font-bold text-slate-900">{newRunningDisplay.distanceMeters}m × {newRunningDisplay.totalReps}本</p>
                {newRunningDisplay.repRestSeconds !== null && <p className="mt-1 text-sm text-slate-700">1本ごとの休憩 {newRunningDisplay.repRestSeconds / 60}分</p>}
                {newRunningDisplay.executionInstructionText && <p className="mt-1 text-sm text-slate-700">{newRunningDisplay.executionInstructionText}</p>}
                {newRunningDisplay.coachTargetTimeSeconds !== null && <p className="mt-1 text-sm text-slate-700">目標タイム {newRunningDisplay.coachTargetTimeSeconds}秒</p>}
                {newRunningDisplay.coachTargetTimeRange !== null && <p className="mt-1 text-sm text-slate-700">目標タイム {newRunningDisplay.coachTargetTimeRange.minSeconds}〜{newRunningDisplay.coachTargetTimeRange.maxSeconds}秒</p>}
                {newRunningDisplay.setReps !== null && <p className="mt-1 text-sm text-slate-700">{newRunningDisplay.setReps.join("本 + ")}本／セット間休憩 {newRunningDisplay.setRestSeconds! / 60}分</p>}
                {newRunningCoachEdit && <p className="mt-1 text-xs text-slate-500">コーチ調整済み</p>}
                {newRunningPreview.running.status === "READY" && newRunningPreview.running.message && <p className="mt-1 text-xs text-slate-500">{newRunningPreview.running.message}</p>}
              </div>
            ) : (
              <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{newRunningPreview.running.message}</div>
            )}
            {newRunningDisplay !== null && newRunningPreview.previewToken !== null && (
              <>
                <RunningPolicyCoachEditor
                  key={newRunningCoachEdit?.finalFingerprint ?? newRunningPreview.previewToken}
                  initial={newRunningDisplay}
                  onSubmit={previewCoachEdit}
                />
                {newRunningCoachEdit && <Button type="button" variant="secondary" size="sm" onClick={() => setNewRunningCoachEdit(null)}>コーチ調整を取り消す</Button>}
              </>
            )}
            {newRunningPreview.exercises.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-800">一緒に選ばれた種目（未保存）</h3>
                {newRunningPreview.exercises.map((exercise) => <p key={exercise.id} className="text-sm text-slate-700">{exercise.name}</p>)}
              </div>
            )}
            {newRunningPreview.unsupportedIntents.length > 0 && (
              <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p>希望として読み取りましたが、現在の自動処方には反映されません。</p>
                {newRunningPreview.unsupportedIntents.map((meaning, index) => <p key={`${index}-${meaning}`}>{meaning}</p>)}
              </div>
            )}
            {newRunningPreview.running.status === "READY" && newRunningPreview.previewToken !== null ? (
              <Button type="button" size="lg" disabled={busy} onClick={submitSave}>{phase === "SAVING" ? "保存中…" : "この内容で保存"}</Button>
            ) : <p className="text-xs text-slate-500">確認が必要な走処方は保存できません。条件を見直して再生成してください。</p>}
            <Button type="button" variant="secondary" size="sm" onClick={() => { setNewRunningPreview(null); setNewRunningCoachEdit(null); }}>プレビューを閉じる</Button>
          </CardBody>
        </Card>
      )}

      {blocks.map((block) => (
        <Card key={block.key}>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold text-slate-900">{block.title}</h2>
              <Badge className="border-slate-200 bg-slate-100 text-slate-700">保存前の下書き</Badge>
            </div>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="space-y-3" data-testid="composer-block" data-block-title={block.title}>
            {block.items.length === 0 && <p className="py-2 text-sm text-slate-400">まだ種目がありません。</p>}

            <SortableList
              items={block.items.map((i) => ({ id: i.key }))}
              onReorder={(orderedKeys) => reorderItems(block.key, orderedKeys)}
              renderItem={(entry, dragHandle) => renderItem(block, block.items.find((i) => i.key === entry.id)!, dragHandle)}
            />

            {block.key !== MANUAL_BLOCK_KEY && (addingBlockKey === block.key ? (
              <MenuItemForm
                action={addItemToBlock(block.key)}
                exercises={exercises}
                initial={EMPTY_MENU_ITEM_FORM}
                submitLabel="追加する"
                onCancel={() => setAddingBlockKey(null)}
                resetOnSuccess
                compact
              />
            ) : (
              <button
                type="button"
                className={cn(buttonClass("secondary", "sm"), "w-full border-dashed")}
                disabled={busy}
                onClick={() => { setAddingBlockKey(block.key); setItemMode(null); }}
              >
                ＋ このブロックに種目を追加
              </button>
            ))}
            </div>
          </CardBody>
        </Card>
      ))}

      {draftVisible && newRunningPreview === null && (
        <Card className="border-indigo-200 bg-indigo-50/60">
          <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-bold text-slate-900">この内容で保存</h2>
              <p className="mt-1 text-sm text-slate-600">保存すると正式なメニューとして登録され、メニュー画面へ移ります。保存するまでは何も登録されません。</p>
            </div>
            <Button type="button" size="lg" disabled={busy} onClick={submitSave}>
              {phase === "SAVING" ? "保存中…" : "メニューを保存"}
            </Button>
          </CardBody>
        </Card>
      )}

      {blocks.length === 0 && newRunningPreview === null && phase !== "GENERATING" && (
        <p role="status" className="text-center text-sm text-slate-500">AIに希望を伝えるか、手動で種目を追加すると、ここに編集できる下書きが表示されます。</p>
      )}
    </div>
  );
}
