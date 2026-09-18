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
import {
  addMenuItemAction,
  deleteBlockAction,
  deleteMenuItemAction,
  moveBlockAction,
  moveMenuItemAction,
} from "@/actions/menu-actions";
import { updateMenuItemAction } from "@/actions/menu-actions";
import { RunningItemCreateForm } from "@/components/running/running-item-create-form";
import { RunningItemPanel } from "@/components/running/running-item-panel";
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
}) {
  const [adding, setAdding] = useState(false);
  const [addingRunning, setAddingRunning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

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

        <ol className="space-y-2">
          {block.items.map((item, index) => {
            const prescription = formatPrescription(item);
            const name = item.exercise?.name ?? item.displayName ?? "（名称未設定）";
            const runningItem = running?.items[item.id] ?? null;

            // [R10-B4B] 走トレーニングの項目は専用の表示・編集で出す（legacy の汎用編集は使えない）。
            if (runningItem !== null) {
              return (
                <li key={item.id} className="flex items-start gap-2">
                  <span className="mt-2 w-5 shrink-0 text-xs font-medium text-slate-400">{index + 1}.</span>
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
                      disabled={index === block.items.length - 1}
                    />
                    <form action={deleteMenuItemAction}>
                      <input type="hidden" name="menuId" value={menuId} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <ConfirmSubmitButton variant="ghost" size="sm" message={`「${name}」を削除します。よろしいですか？`}>
                        ✕
                      </ConfirmSubmitButton>
                    </form>
                  </div>
                </li>
              );
            }

            if (editingId === item.id) {
              return (
                <li key={item.id}>
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
                </li>
              );
            }

            return (
              <li
                key={item.id}
                className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2"
              >
                <span className="mt-0.5 w-5 shrink-0 text-xs font-medium text-slate-400">
                  {index + 1}.
                </span>

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
                    disabled={index === block.items.length - 1}
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
              </li>
            );
          })}
        </ol>

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
