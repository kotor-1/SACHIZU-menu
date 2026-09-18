import { notFound } from "next/navigation";
import {
  Badge,
  Card,
  CardBody,
  LinkButton,
  PageHeader,
} from "@/components/ui";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { SubmitButton } from "@/components/submit-button";
import { MenuBlockEditor } from "@/components/menu/menu-block-editor";
import { AddBlockForm } from "@/components/menu/add-block-form";
import { StartSessionForm } from "@/components/session/start-session-form";
import { RunningMenuPanel } from "@/components/running/running-menu-panel";
import { buildRunningMenuView } from "@/actions/_running-menu-view";
import { isRunningV2UiEnabled } from "@/lib/feature-flags";
import { deleteMenuAction, duplicateMenuAction } from "@/actions/menu-actions";
import { findMenu } from "@/infra/repositories/menu-repository";
import { listExercisesForPicker } from "@/infra/repositories/exercise-repository";
import { estimateSeconds } from "@/domain/shared/prescription";
import { TRAINING_PHASE_LABEL, type TrainingPhase } from "@/domain/menu/constants";
import { REVIEW_STATUS_LABEL, type ReviewStatus } from "@/domain/shared/constants";
import { formatMinutes } from "@/lib/format";

export default async function MenuDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [menu, exercises] = await Promise.all([findMenu(id), listExercisesForPicker()]);
  if (!menu) notFound();

  // [R10-B4B] feature flag が OFF なら Running v2 の読み込み・評価を一切行わない
  // （ここが null のあいだ、この画面は B4B 前とまったく同じ表示・操作になる）。
  const running = isRunningV2UiEnabled() ? await buildRunningMenuView(menu) : null;

  const allItems = menu.blocks.flatMap((b) => b.items);
  const estimatedFromItems = Math.round(
    allItems.reduce((sum, item) => sum + estimateSeconds(item), 0) / 60,
  );

  return (
    <>
      <PageHeader
        title={menu.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {menu.phase && (
              <Badge className="border-sky-200 bg-sky-50 text-sky-700">
                {TRAINING_PHASE_LABEL[menu.phase as TrainingPhase] ?? menu.phase}
              </Badge>
            )}
            {menu.status !== "REVIEWED" && (
              <Badge className="border-amber-200 bg-amber-50 text-amber-700">
                {REVIEW_STATUS_LABEL[menu.status as ReviewStatus] ?? menu.status}
              </Badge>
            )}
            <span className="text-xs text-slate-500">
              {menu.blocks.length} ブロック / {allItems.length} 種目 ・ 目安{" "}
              {formatMinutes(menu.estimatedMinutes ?? Math.max(1, estimatedFromItems))}
            </span>
            {menu.tags.map((t) => (
              <span key={t.tagId} className="text-xs text-slate-400">
                #{t.tag.name}
              </span>
            ))}
          </span>
        }
        actions={
          <>
            <LinkButton href={`/menus/${menu.id}/edit`} variant="secondary">
              メニュー情報を編集
            </LinkButton>
            <form action={duplicateMenuAction}>
              <input type="hidden" name="id" value={menu.id} />
              <SubmitButton variant="secondary">複製</SubmitButton>
            </form>
            <form action={deleteMenuAction}>
              <input type="hidden" name="id" value={menu.id} />
              <ConfirmSubmitButton
                size="md"
                message="このメニューを削除します。過去の練習記録は残ります。よろしいですか？"
              >
                削除
              </ConfirmSubmitButton>
            </form>
          </>
        }
      />

      {menu.purpose && (
        <Card className="mb-4 border-slate-200 bg-white">
          <CardBody>
            <p className="text-xs font-medium text-slate-400">狙い</p>
            <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
              {menu.purpose}
            </p>
            {menu.description && (
              <p className="mt-3 border-t border-slate-100 pt-3 text-sm leading-relaxed whitespace-pre-wrap text-slate-600">
                {menu.description}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {menu.blocks.map((block, index) => (
            <MenuBlockEditor
              key={block.id}
              menuId={menu.id}
              block={block}
              exercises={exercises}
              isFirst={index === 0}
              isLast={index === menu.blocks.length - 1}
              phase={menu.phase as TrainingPhase | null}
              running={running === null ? null : { items: running.items, picker: running.picker }}
            />
          ))}
          <AddBlockForm menuId={menu.id} />
        </div>

        <div className="space-y-4 no-print">
          <StartSessionForm menuId={menu.id} menuName={menu.name} />

          {running !== null && <RunningMenuPanel menuId={menu.id} view={running} />}

          <Card>
            <CardBody className="space-y-2 text-xs text-slate-500">
              <p className="font-medium text-slate-600">メモ</p>
              <p>
                ここで設定した負荷は「このメニューでの処方」です。種目そのものの推奨値は変わりません。
              </p>
              <p>
                練習を作ると、その時点の内容がコピーされます。あとでメニューを直しても、
                作成済みの練習記録は変わりません。
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
