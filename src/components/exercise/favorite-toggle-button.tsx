import { toggleExerciseFavoriteAction } from "@/actions/exercise-actions";
import { cn } from "@/components/ui";

/**
 * お気に入りの ON/OFF トグル。
 *
 * 一覧カードでは `<Link>` と兄弟要素として置く（`<a>` の中に `<button>` を
 * 入れると無効な HTML になり、クリック判定も壊れるため）。
 */
export function FavoriteToggleButton({
  exerciseId,
  isFavorite,
  className,
}: {
  exerciseId: string;
  isFavorite: boolean;
  className?: string;
}) {
  return (
    <form action={toggleExerciseFavoriteAction} className={className}>
      <input type="hidden" name="id" value={exerciseId} />
      <button
        type="submit"
        title={isFavorite ? "お気に入りから外す" : "お気に入りに追加"}
        aria-pressed={isFavorite}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-full text-lg leading-none transition-colors",
          isFavorite
            ? "bg-amber-100 text-amber-500 hover:bg-amber-200"
            : "bg-white/80 text-slate-300 hover:bg-slate-100 hover:text-amber-400",
        )}
      >
        {isFavorite ? "★" : "☆"}
      </button>
    </form>
  );
}
