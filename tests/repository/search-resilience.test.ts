import { beforeEach, describe, expect, it } from "vitest";
import { exerciseSearchSchema } from "@/domain/exercise/schema";
import { menuSearchSchema } from "@/domain/menu/schema";
import { sessionSearchSchema } from "@/domain/session/schema";
import { parseSearchParams } from "@/lib/search-params";
import { searchExercises } from "@/infra/repositories/exercise-repository";
import { searchMenus } from "@/infra/repositories/menu-repository";
import { searchSessions } from "@/infra/repositories/session-repository";
import { resetDb } from "../helpers";

/**
 * "不正query で 500 にならない" を、URL クエリ → 検索条件 → 実際の DB 問い合わせ
 * まで通しで確認する。schema レベルの防御は tests/domain/search-params.test.ts で
 * 確認済みなので、ここでは repository まで到達させて例外が飛ばないことを見る。
 *
 * Phase 1.2 で Purpose（練習目的）/ Event（対象競技）/ Favorite（お気に入り）
 * フィルタを追加したため、これらも Category / Target / Tag / Status と
 * 同様に不正値耐性を確認する。
 */
describe("search: malformed queries never throw all the way to the database", () => {
  beforeEach(resetDb);

  it("exercises: garbage category/target/purpose/event/favorite/status/difficulty/page resolve to an empty, non-throwing result", async () => {
    const raw = {
      category: "NOT_A_CATEGORY",
      target: "NOT_A_TARGET",
      purpose: "NOT_A_PURPOSE",
      event: "NOT_AN_EVENT",
      favorite: "yes-please",
      status: "NOT_A_STATUS",
      difficulty: "999",
      page: "-1",
      tag: ["", "also-garbage"],
    };
    const search = parseSearchParams(exerciseSearchSchema, raw, ["tag"]);
    await expect(searchExercises(search)).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("menus: garbage phase/status/tag resolve to an empty, non-throwing result", async () => {
    const raw = { phase: "NOT_A_PHASE", status: "NOT_A_STATUS", tag: "does-not-exist" };
    const search = parseSearchParams(menuSearchSchema, raw, ["tag"]);
    await expect(searchMenus(search)).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("sessions: garbage status/date range resolve to an empty, non-throwing result", async () => {
    const raw = { status: "NOT_A_STATUS", from: "not-a-date", to: "also-not-a-date" };
    const search = parseSearchParams(sessionSearchSchema, raw);
    await expect(searchSessions(search)).resolves.toMatchObject({ items: [], total: 0 });
  });

  it("sessions: an unparsable from/to date is ignored rather than crashing the date filter", async () => {
    // buildWhere() は Date.parse で妥当性を見てから絞り込みに使う。
    // 壊れた日付はフィルタごと無視されるだけで、例外にはならない。
    const search = sessionSearchSchema.parse({ from: "banana", to: "🍌" });
    await expect(searchSessions(search)).resolves.toBeDefined();
  });
});
