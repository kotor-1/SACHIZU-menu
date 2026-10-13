import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  LinkButton,
  PageHeader,
} from "@/components/ui";
import { ConfirmSubmitButton } from "@/components/confirm-submit-button";
import { currentAppViewer } from "@/infra/auth/current-app-user";
import { SubmitButton } from "@/components/submit-button";
import {
  CategoryBadge,
  DifficultyBadge,
  EnergySystemBadge,
  EventBadge,
  PurposeBadge,
  StatusBadge,
  TargetBadge,
} from "@/components/exercise/exercise-badges";
import { FavoriteToggleButton } from "@/components/exercise/favorite-toggle-button";
import {
  archiveExerciseAction,
  deleteExerciseAction,
  duplicateExerciseAction,
  restoreExerciseAction,
} from "@/actions/exercise-actions";
import { findExercise } from "@/infra/repositories/exercise-repository";
import { formatPrescription } from "@/domain/shared/prescription";
import { METRIC_TYPE_LABEL, TAG_KIND_LABEL, type MetricType, type TagKind } from "@/domain/exercise/constants";
import { CONTENT_SOURCE_LABEL, type ContentSource } from "@/domain/shared/constants";

export default async function ExerciseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // 種目の編集・複製・アーカイブ・削除とお気に入りは、管理者だけに出す（メンバーは見るだけ）。
  const viewer = await currentAppViewer();
  const exercise = await findExercise(id);
  if (!exercise) notFound();

  const prescription = formatPrescription({
    sets: exercise.defaultSets,
    reps: exercise.defaultReps,
    distanceMeters: exercise.defaultDistanceMeters,
    durationSeconds: exercise.defaultDurationSeconds,
    restSeconds: exercise.defaultRestSeconds,
  });

  // 同じメニューに複数回出てくることがあるので、メニュー単位に畳む
  const usedInMenus = [
    ...new Map(
      exercise.menuItems.map((item) => [
        item.menuBlock.menuTemplate.id,
        item.menuBlock.menuTemplate,
      ]),
    ).values(),
  ];

  const tagsByKind = exercise.tags.reduce<Record<string, string[]>>((acc, t) => {
    (acc[t.tag.kind] ??= []).push(t.tag.name);
    return acc;
  }, {});

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {viewer.isAdmin && <FavoriteToggleButton
              exerciseId={exercise.id}
              isFavorite={exercise.isFavorite}
              className="-ml-1"
            />}
            {exercise.name}
            <StatusBadge status={exercise.status} />
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <CategoryBadge category={exercise.category} />
            <DifficultyBadge level={exercise.difficulty} />
            <EnergySystemBadge energySystem={exercise.energySystem} />
            {exercise.nameKana && (
              <span className="text-xs text-slate-400">{exercise.nameKana}</span>
            )}
          </span>
        }
        actions={viewer.isAdmin && (
          <>
            <LinkButton href={`/exercises/${exercise.id}/edit`} variant="secondary">
              編集
            </LinkButton>
            <form action={duplicateExerciseAction}>
              <input type="hidden" name="id" value={exercise.id} />
              <SubmitButton variant="secondary">複製</SubmitButton>
            </form>
            {exercise.status === "ARCHIVED" ? (
              <form action={restoreExerciseAction}>
                <input type="hidden" name="id" value={exercise.id} />
                <SubmitButton variant="secondary">アーカイブから戻す</SubmitButton>
              </form>
            ) : (
              <form action={archiveExerciseAction}>
                <input type="hidden" name="id" value={exercise.id} />
                <SubmitButton variant="secondary">アーカイブ</SubmitButton>
              </form>
            )}
            <form action={deleteExerciseAction}>
              <input type="hidden" name="id" value={exercise.id} />
              <ConfirmSubmitButton
                size="md"
                message={
                  usedInMenus.length > 0
                    ? `この種目は ${usedInMenus.length} 件のメニューで使われています。削除の代わりにアーカイブされます。よろしいですか？`
                    : "この種目を削除します。よろしいですか？"
                }
              >
                削除
              </ConfirmSubmitButton>
            </form>
          </>
        )}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {exercise.description && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-semibold text-slate-700">説明・実施手順</h2>
              </CardHeader>
              <CardBody>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-700">
                  {exercise.description}
                </p>
              </CardBody>
            </Card>
          )}

          {exercise.coachingPoint && (
            <Card className="border-indigo-200 bg-indigo-50/40">
              <CardHeader className="border-indigo-100">
                <h2 className="text-sm font-semibold text-indigo-800">
                  コーチングポイント
                </h2>
              </CardHeader>
              <CardBody>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-indigo-900">
                  {exercise.coachingPoint}
                </p>
              </CardBody>
            </Card>
          )}

          {exercise.commonMistake && (
            <Card className="border-amber-200 bg-amber-50/40">
              <CardHeader className="border-amber-100">
                <h2 className="text-sm font-semibold text-amber-800">ありがちな失敗</h2>
              </CardHeader>
              <CardBody>
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-amber-900">
                  {exercise.commonMistake}
                </p>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-slate-700">
                使われているメニュー
              </h2>
            </CardHeader>
            <CardBody>
              {usedInMenus.length === 0 ? (
                <p className="text-sm text-slate-400">
                  まだどのメニューでも使われていません。
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {usedInMenus.map((menu) => (
                    <li key={menu.id}>
                      <Link
                        href={`/menus/${menu.id}`}
                        className="text-sm text-indigo-600 hover:underline"
                      >
                        {menu.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-slate-700">推奨負荷</h2>
            </CardHeader>
            <CardBody className="space-y-2">
              {prescription ? (
                <p className="font-mono text-sm text-slate-800">{prescription}</p>
              ) : (
                <p className="text-sm text-slate-400">未設定</p>
              )}
              <p className="text-xs text-slate-400">
                測り方：{METRIC_TYPE_LABEL[exercise.metricType as MetricType] ?? exercise.metricType}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-sm font-semibold text-slate-700">分類</h2>
            </CardHeader>
            <CardBody className="space-y-3">
              <div>
                <p className="mb-1 text-xs text-slate-400">対象能力</p>
                <div className="flex flex-wrap gap-1.5">
                  {exercise.targets.length === 0 ? (
                    <span className="text-sm text-slate-400">未設定</span>
                  ) : (
                    exercise.targets.map((t) => (
                      <TargetBadge key={t.target} target={t.target} />
                    ))
                  )}
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs text-slate-400">練習目的</p>
                <div className="flex flex-wrap gap-1.5">
                  {exercise.purposes.length === 0 ? (
                    <span className="text-sm text-slate-400">未設定</span>
                  ) : (
                    exercise.purposes.map((p) => (
                      <PurposeBadge key={p.purpose} purpose={p.purpose} />
                    ))
                  )}
                </div>
              </div>

              <div>
                <p className="mb-1 text-xs text-slate-400">対象競技</p>
                <div className="flex flex-wrap gap-1.5">
                  {exercise.events.length === 0 ? (
                    <span className="text-sm text-slate-400">未設定</span>
                  ) : (
                    exercise.events.map((e) => <EventBadge key={e.event} event={e.event} />)
                  )}
                </div>
              </div>

              {Object.entries(tagsByKind).map(([kind, names]) => (
                <div key={kind}>
                  <p className="mb-1 text-xs text-slate-400">
                    {TAG_KIND_LABEL[kind as TagKind] ?? kind}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {names.map((n) => (
                      <Badge key={n}>{n}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>

          {exercise.videoUrl && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-semibold text-slate-700">参考動画</h2>
              </CardHeader>
              <CardBody>
                <a
                  href={exercise.videoUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-sm break-all text-indigo-600 hover:underline"
                >
                  {exercise.videoUrl}
                </a>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardBody className="space-y-1 text-xs text-slate-400">
              <p>
                登録元：{CONTENT_SOURCE_LABEL[exercise.source as ContentSource] ?? exercise.source}
              </p>
              <p>更新：{exercise.updatedAt.toLocaleString("ja-JP")}</p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
