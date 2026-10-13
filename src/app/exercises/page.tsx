import { LinkButton, EmptyState, PageHeader } from "@/components/ui";
import { currentAppViewer } from "@/infra/auth/current-app-user";
import { ExerciseCard } from "@/components/exercise/exercise-card";
import { ExerciseFilters } from "@/components/exercise/exercise-filters";
import { Pagination } from "@/components/pagination";
import { exerciseSearchSchema } from "@/domain/exercise/schema";
import { parseSearchParams, toBaseParams } from "@/lib/search-params";
import { searchExercises } from "@/infra/repositories/exercise-repository";
import { listTagsInUse } from "@/infra/repositories/tag-repository";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata = { title: "種目一覧｜SACHIZU" };

export default async function ExercisesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const raw = await searchParams;

  // tag だけは複数指定を許すため配列に正規化する。
  // 不正な値が来ても既定条件に落として 500 にしない。
  const search = parseSearchParams(exerciseSearchSchema, raw, ["tag"]);

  const [result, tags, viewer] = await Promise.all([searchExercises(search), listTagsInUse(), currentAppViewer()]);

  // ページ送りリンクに現在の検索条件を引き継ぐ
  const baseParams = toBaseParams(raw);

  return (
    <>
      <PageHeader
        title="種目・ドリル"
        description="登録した種目はメニュー作成でそのまま呼び出せます。"
        actions={viewer.isAdmin ? <LinkButton href="/exercises/new">＋ 種目を登録</LinkButton> : undefined}
      />

      <ExerciseFilters
        search={search}
        tags={tags.filter((t) => t._count.exercises > 0)}
        resultCount={result.total}
      />

      {result.items.length === 0 ? (
        <EmptyState
          title="該当する種目がありません"
          description={viewer.isAdmin ? "条件を変えるか、新しく種目を登録してください。" : "条件を変えてください。"}
          action={viewer.isAdmin ? <LinkButton href="/exercises/new">＋ 種目を登録</LinkButton> : undefined}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {result.items.map((exercise) => (
            <ExerciseCard key={exercise.id} exercise={exercise} canFavorite={viewer.isAdmin} />
          ))}
        </div>
      )}

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        baseParams={baseParams}
        basePath="/exercises"
      />
    </>
  );
}
