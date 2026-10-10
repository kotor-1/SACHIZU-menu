"use client";

import { useId, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/**
 * ドラッグ&ドロップで縦に並べ替える汎用リスト（@dnd-kit）。
 *
 * - マウス / トラックパッド / タッチ（長押し）のすべてで動く。
 * - ドラッグは専用のハンドル（グリップ）で開始し、カード自体のスクロール・タップと競合しない。
 * - ハンドルは最低 44px のタップ領域（指で操作可能）。`touch-action: none` でタッチ中にページが
 *   スクロールしないようにする。
 * - 並べ替えは optimistic にせず、dragEnd で「新しい ID 順」だけを callback に渡す。
 *   永続化の整合（集合一致・重複なし・atomic）は server（repository）が検証する。
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
}: {
  items: readonly T[];
  /** 新しい順序の ID 配列を受け取る（呼び出し側が server action へ渡す）。 */
  onReorder: (orderedIds: string[]) => void;
  /** 各項目の内容を描画する。第2引数の drag handle をカード内に置くこと。 */
  renderItem: (item: T, dragHandle: ReactNode) => ReactNode;
}) {
  const contextId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const oldIndex = items.findIndex((item) => item.id === active.id);
    const newIndex = items.findIndex((item) => item.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove([...items], oldIndex, newIndex);
    onReorder(next.map((item) => item.id));
  };

  return (
    <DndContext
      id={contextId}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <SortableRow key={item.id} item={item} renderItem={renderItem} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableRow<T extends { id: string }>({
  item,
  renderItem,
}: {
  item: T;
  renderItem: (item: T, dragHandle: ReactNode) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const dragHandle = (
    <button
      type="button"
      aria-label="並べ替え"
      className="grid h-11 w-8 shrink-0 cursor-grab touch-none select-none place-items-center rounded-md text-slate-400 no-print hover:bg-slate-100 hover:text-slate-600 active:cursor-grabbing"
      style={{ touchAction: "none" }}
      {...attributes}
      {...listeners}
    >
      <span aria-hidden="true" className="text-lg leading-none">⠿</span>
    </button>
  );

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "relative z-10 opacity-60" : undefined}>
      {renderItem(item, dragHandle)}
    </div>
  );
}
