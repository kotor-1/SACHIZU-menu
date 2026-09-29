"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, buttonClass, cn } from "@/components/ui";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import {
  EMPTY_MENU_ITEM_FORM,
  MenuItemForm,
  type MenuItemFormValues,
} from "./menu-item-form";
import { SortableList } from "./sortable-list";
import {
  addMenuItemAction,
  deleteBlockAction,
  deleteMenuItemAction,
  moveBlockAction,
  moveMenuItemAction,
  reorderMenuItemsAction,
} from "@/actions/menu-actions";
import { updateMenuItemAction } from "@/actions/menu-actions";
import { RunningItemCreateForm } from "@/components/running/running-item-create-form";
import { RunningItemPanel } from "@/components/running/running-item-panel";
import { presentRunningMenuSnapshot } from "@/application/running-menu/persistence";
import { finalRunningMenuPrescription, parseRunningMenuEnvelope } from "@/application/running-menu/persistence";
import { editRunningPolicyMenuItemAction } from "@/actions/running-coach-edit-actions";
import { RunningPolicyCoachEditor } from "@/components/menu/running-policy-coach-editor";
import type { TemplatePickerProviderResult } from "@/actions/_running-template-options";
import type { SavedRunningItemPresentation } from "@/presentation/running/server";
import { formatPrescription } from "@/domain/shared/prescription";
import type { TrainingPhase } from "@/domain/menu/constants";
import type { MenuBlockDetail } from "@/infra/repositories/menu-repository";
import type { ExercisePickerItem } from "@/infra/repositories/exercise-repository";

const str = (v: number | null) => (v == null ? "" : String(v));

function toFormValues(item: MenuBlockDetail["items"][number]): MenuItemFormValues {
  return {
    exerciseId: item.exerciseId ?? "",
    displayName: item.displayName ?? "",
    sets: str(item.sets),
    reps: str(item.reps),
    distanceMeters: str(item.distanceMeters),
    durationSeconds: str(item.durationSeconds),
    restSeconds: str(item.restSeconds),
    intensityPercent: str(item.intensityPercent),
    loadKg: str(item.loadKg),
    note: item.note ?? "",
  };
}

/** 移動・削除など「押すだけ」の操作をまとめた小さなフォーム。 */
function IconForm({
  action,
  fields,
  label,
  title,
  disabled,
}: {
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  label: string;
  title: string;
  disabled?: boolean;
}) {
  return (
    <form action={action}>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button
        type="submit"
        title={title}
        disabled={disabled}
        className="grid h-8 w-8 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30"
      >
        {label}
      </button>
    </form>
  );
}

/**
 * [R10-B4B] 走トレーニング（Running v2）の表示に必要な DTO。
 * `null` = feature flag OFF。そのとき、このコンポーネントは B4B 前とまったく同じ表示・操作になる。
 */
export type MenuBlockRunningView = {
  /** MenuItem.id → 保存済み走項目の表示。 */
  items: Record<string, SavedRunningItemPresentation>;
  picker: TemplatePickerProviderResult;
};

export function MenuBlockEditor({
  menuId,
  block,
  exercises,
  isFirst,
  isLast,
  phase = null,
  running = null,
  runningCoachFingerprints = {},
}: {
  menuId: string;
  block: MenuBlockDetail;
  exercises: ExercisePickerItem[];
  isFirst: boolean;
  isLast: boolean;
  /** メニューの期分け。推奨処方の計算に渡す。 */
  phase?: TrainingPhase | null;
  /** [R10-B4B] Running v2 の表示 DTO（flag OFF なら null）。 */
  running?: MenuBlockRunningView | null;
  runningCoachFingerprints?: Record<string, string>;
}) {
  const [adding, setAdding] = useState(false);
  const [addingRunning, setAddingRunning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // ドラッグ&ドロップ用の optimistic な項目順序。親は保存済みMenuの指紋が変わると再マウントする。
  const [orderedItems, setOrderedItems] = useState<MenuBlockDetail["items"]>(block.items);

  /** ドラッグ&ドロップ後の項目並べ替え。optimistic に反映し、server が整合を検証して永続化する。 */
  async function handleItemReorder(orderedItemIds: string[]) {
    const byId = new Map(block.items.map((item) => [item.id, item]));
    const next = orderedItemIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    if (next.length !== block.items.length) return; // 集合不一致は無視（server が最終検証）
    setOrderedItems(next);
    try {
      await reorderMenuItemsAction(menuId, block.id, orderedItemIds);
    } catch {
      setOrderedItems(block.items);
    }
  }

  /**
   * 編集フォームの種目リスト。
   *
   * ピッカーはアーカイブ済みの種目を含まないため、
   * アーカイブされた種目を参照している項目を編集すると
   * select が「一致する option なし」になり、保存時に参照が消えてしまう。
   * その項目自身の種目だけは必ず選択肢に足しておく。
   */
  function optionsFor(item: MenuBlockDetail["items"][number]): ExercisePickerItem[] {
    const ex = item.exercise;
    if (!ex || exercises.some((e) => e.id === ex.id)) return exercises;
    return [
      {
        id: ex.id,
        name: `${ex.name}（アーカイブ済み）`,
        category: ex.category,
        metricType: ex.metricType,
        difficulty: ex.difficulty,
        energySystem: null,
        isFavorite: false,
        defaultSets: null,
        defaultReps: null,
        defaultDistanceMeters: null,
        defaultDurationSeconds: null,
        defaultRestSeconds: null,
        targets: [],
        events: [],
      },
      ...exercises,
    ];
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-900">{block.name}</h3>
          {block.note && <p className="mt-0.5 text-xs text-slate-500">{block.note}</p>}
        </div>
        <div className="flex items-center gap-1 no-print">
          <IconForm
            action={moveBlockAction}
            fields={{ menuId, blockId: block.id, direction: "up" }}
            label="↑"
            title="ブロックを上へ"
            disabled={isFirst}
          />
          <IconForm
            action={moveBlockAction}
            fields={{ menuId, blockId: block.id, direction: "down" }}
            label="↓"
            title="ブロックを下へ"
            disabled={isLast}
          />
          <form action={deleteBlockAction}>
            <input type="hidden" name="menuId" value={menuId} />
            <input type="hidden" name="blockId" value={block.id} />
            <ConfirmSubmitButton
              variant="ghost"
              size="sm"
              message={`「${block.name}」を、中の ${block.items.length} 項目ごと削除します。よろしいですか？`}
            >
              削除
            </ConfirmSubmitButton>
          </form>
        </div>
      </CardHeader>

      <CardBody className="space-y-2">
        {block.items.length === 0 && !adding && (
          <p className="py-2 text-sm text-slate-400">まだ種目がありません。</p>
        )}

        <SortableList
          items={orderedItems}
          onReorder={handleItemReorder}
          renderItem={(item, dragHandle) => {
            const index = orderedItems.findIndex((candidate) => candidate.id === item.id);
            const prescription = formatPrescription(item);
            const name = item.exercise?.name ?? item.displayName ?? "（名称未設定）";
            const runningItem = running?.items[item.id] ?? null;
            const newRunningItem = presentRunningMenuSnapshot(item.prescriptionKind, item.prescriptionJson);
            const newRunningEnvelope = parseRunningMenuEnvelope(item.prescriptionKind, item.prescriptionJson);

            if (newRunningItem.status !== "NOT_RUNNING_POLICY") {
              return (
                <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2" data-testid="saved-running-policy-item">
                  {dragHandle}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-900">{newRunningItem.title}</p>
                    {newRunningItem.status === "OK" ? (
                      <>
                        {newRunningItem.restText && <p className="mt-1 text-sm text-slate-700">{newRunningItem.restText}</p>}
                        {newRunningItem.instruction && <p className="mt-1 text-sm text-slate-600">{newRunningItem.instruction}</p>}
                        {newRunningItem.targetTimeText && <p className="mt-1 text-sm text-slate-600">{newRunningItem.targetTimeText}</p>}
                        {newRunningItem.setText && <p className="mt-1 text-sm text-slate-600">{newRunningItem.setText}</p>}
                        {newRunningItem.coachEdited && <p className="mt-1 text-xs text-slate-500">コーチ調整済み</p>}
                      </>
                    ) : <p className="mt-1 text-xs text-amber-800">保存済み処方を確認してください。</p>}
                    {item.note && <p className="mt-1 text-xs text-slate-500">{item.note}</p>}
                    {newRunningEnvelope && runningCoachFingerprints[item.id] && (
                      <RunningPolicyCoachEditor
                        key={runningCoachFingerprints[item.id]}
                        initial={finalRunningMenuPrescription(newRunningEnvelope)}
                        onSubmit={async (edit) => {
                          const result = await editRunningPolicyMenuItemAction({
                            menuId, itemId: item.id, expectedFingerprint: runningCoachFingerprints[item.id], edit,
                          });
                          if (result.ok) { window.location.reload(); return { ok: true }; }
                          const messages: Record<string, string> = {
                            RANGE_OUTSIDE: "承認済みの本数・休憩の範囲で設定してください。",
                            DISTANCE_REVIEW_REQUIRED: "この距離への変更にはコーチ確認が必要です。",
                            TIME_ADJUSTMENT_REQUIRED: "指定された時間に必要な休憩が収まりません。",
                            STALE_ITEM: "メニューが変更されました。再読込してから調整してください。",
                            INVALID_EDIT: "本数・休憩・セット・目標タイムの指定を確認してください。",
                          };
                          return { ok: false, message: messages[result.code] ?? "調整を保存できませんでした。内容を確認してください。" };
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            }

            // [R10-B4B] 走トレーニングの項目は専用の表示・編集で出す（legacy の汎用編集は使えない）。
            if (runningItem !== null) {
              return (
                <div className="flex items-start gap-2">
                  {dragHandle}
                  <div className="min-w-0 flex-1">
                    <RunningItemPanel menuId={menuId} presentation={runningItem} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1 no-print">
                    <IconForm
                      action={moveMenuItemAction}
                      fields={{ menuId, itemId: item.id, direction: "up" }}
                      label="↑"
                      title="上へ"
                      disabled={index === 0}
                    />
                    <IconForm
                      action={moveMenuItemAction}
                      fields={{ menuId, itemId: item.id, direction: "down" }}
                      label="↓"
                      title="下へ"
                      disabled={index === orderedItems.length - 1}
                    />
                    <form action={deleteMenuItemAction}>
                      <input type="hidden" name="menuId" value={menuId} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <ConfirmSubmitButton variant="ghost" size="sm" message={`「${name}」を削除します。よろしいですか？`}>
                        ✕
                      </ConfirmSubmitButton>
                    </form>
                  </div>
                </div>
              );
            }

            if (editingId === item.id) {
              return (
                <MenuItemForm
                  action={updateMenuItemAction.bind(null, menuId, item.id)}
                  exercises={optionsFor(item)}
                  initial={toFormValues(item)}
                  submitLabel="保存"
                  onCancel={() => setEditingId(null)}
                  onSuccess={() => setEditingId(null)}
                  compact
                  phase={phase}
                />
              );
            }

            return (
              <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
                {dragHandle}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.exercise ? (
                      <Link
                        href={`/exercises/${item.exercise.id}`}
                        className="text-sm font-medium text-slate-900 hover:text-indigo-600 hover:underline"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium text-slate-900">{name}</span>
                    )}
                    {!item.exercise && (
                      <Badge className="border-slate-200 bg-white text-slate-400">
                        カタログ外
                      </Badge>
                    )}
                  </div>

                  {prescription && (
                    <p className="mt-0.5 font-mono text-xs text-slate-600">{prescription}</p>
                  )}
                  {item.note && (
                    <p className="mt-0.5 text-xs text-slate-500">{item.note}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1 no-print">
                  <IconForm
                    action={moveMenuItemAction}
                    fields={{ menuId, itemId: item.id, direction: "up" }}
                    label="↑"
                    title="上へ"
                    disabled={index === 0}
                  />
                  <IconForm
                    action={moveMenuItemAction}
                    fields={{ menuId, itemId: item.id, direction: "down" }}
                    label="↓"
                    title="下へ"
                    disabled={index === orderedItems.length - 1}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(item.id);
                      setAdding(false);
                    }}
                    className="grid h-8 w-8 place-items-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                    title="編集"
                  >
                    ✎
                  </button>
                  <form action={deleteMenuItemAction}>
                    <input type="hidden" name="menuId" value={menuId} />
                    <input type="hidden" name="itemId" value={item.id} />
                    <ConfirmSubmitButton
                      variant="ghost"
                      size="sm"
                      message={`「${name}」を削除します。よろしいですか？`}
                    >
                      ✕
                    </ConfirmSubmitButton>
                  </form>
                </div>
              </div>
            );
          }}
        />

        {adding ? (
          <MenuItemForm
            action={addMenuItemAction.bind(null, menuId, block.id)}
            exercises={exercises}
            initial={EMPTY_MENU_ITEM_FORM}
            submitLabel="追加する"
            onCancel={() => setAdding(false)}
            resetOnSuccess
            compact
            phase={phase}
            runningV2Enabled={running !== null}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
              setAddingRunning(false);
            }}
            className={cn(
              buttonClass("secondary", "sm"),
              "w-full border-dashed no-print",
            )}
          >
            ＋ このブロックに種目を追加
          </button>
        )}

        {running !== null &&
          (addingRunning ? (
            <RunningItemCreateForm
              menuId={menuId}
              blockId={block.id}
              picker={running.picker}
              onCancel={() => setAddingRunning(false)}
              onCreated={() => setAddingRunning(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setAddingRunning(true);
                setAdding(false);
                setEditingId(null);
              }}
              className={cn(buttonClass("secondary", "sm"), "w-full border-dashed no-print")}
            >
              ＋ 走トレーニングを追加
            </button>
          ))}
      </CardBody>
    </Card>
  );
}
