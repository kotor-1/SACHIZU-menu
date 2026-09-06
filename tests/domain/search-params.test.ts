import { describe, expect, it } from "vitest";
import { parseSearchParams } from "@/lib/search-params";
import { exerciseSearchSchema } from "@/domain/exercise/schema";
import { menuSearchSchema } from "@/domain/menu/schema";
import { sessionSearchSchema } from "@/domain/session/schema";

/**
 * 一覧画面の検索条件は URL クエリから直接組み立てるため、
 * 手打ちや壊れたブックマークで来た不正な値が例外を投げないことが重要。
 * （投げると Next.js のページが 500 になる）
 */
describe("parseSearchParams: never throws on invalid query strings", () => {
  it("falls back to defaults for an unknown exercise category / target / status", () => {
    const search = parseSearchParams(
      exerciseSearchSchema,
      { category: "BOGUS", target: "NOPE", status: "WEIRD", difficulty: "99", page: "abc" },
      ["tag"],
    );
    expect(search.category).toBe("");
    expect(search.target).toBe("");
    expect(search.status).toBe("");
    expect(search.difficulty).toBe("");
    expect(search.page).toBe(1);
  });

  it("falls back to defaults for an unknown purpose / event / favorite value", () => {
    const search = parseSearchParams(
      exerciseSearchSchema,
      { purpose: "NOT_A_PURPOSE", event: "NOT_AN_EVENT", favorite: "yes-please" },
      ["tag"],
    );
    expect(search.purpose).toBe("");
    expect(search.event).toBe("");
    expect(search.favorite).toBe("");
  });

  it("accepts a valid purpose / event / favorite combination", () => {
    const search = parseSearchParams(
      exerciseSearchSchema,
      { purpose: "GROUND_CONTACT", event: "HURDLE", favorite: "1" },
      ["tag"],
    );
    expect(search.purpose).toBe("GROUND_CONTACT");
    expect(search.event).toBe("HURDLE");
    expect(search.favorite).toBe("1");
  });

  it("accepts a valid exercise category and a real difficulty", () => {
    const search = parseSearchParams(
      exerciseSearchSchema,
      { category: "SPRINT", difficulty: "4" },
      ["tag"],
    );
    expect(search.category).toBe("SPRINT");
    expect(search.difficulty).toBe(4);
  });

  it("normalizes a single tag value and multiple tag values into an array", () => {
    const single = parseSearchParams(exerciseSearchSchema, { tag: "t1" }, ["tag"]);
    expect(single.tag).toEqual(["t1"]);

    const multi = parseSearchParams(exerciseSearchSchema, { tag: ["t1", "t2"] }, ["tag"]);
    expect(multi.tag).toEqual(["t1", "t2"]);

    const none = parseSearchParams(exerciseSearchSchema, {}, ["tag"]);
    expect(none.tag).toEqual([]);
  });

  it("falls back to defaults for an unknown menu phase / status", () => {
    const search = parseSearchParams(menuSearchSchema, { phase: "あ", status: "XXX" }, ["tag"]);
    expect(search.phase).toBe("");
    expect(search.status).toBe("");
  });

  it("falls back to defaults for an unknown session status", () => {
    const search = parseSearchParams(sessionSearchSchema, { status: "XXX" });
    expect(search.status).toBe("");
  });

  it("does not reject a non-date string for session from/to (validated later, not at parse time)", () => {
    const search = parseSearchParams(sessionSearchSchema, { from: "notadate", to: "also-not-a-date" });
    expect(search.from).toBe("notadate");
    expect(search.to).toBe("also-not-a-date");
  });

  it("clamps an out-of-range page back to the default instead of throwing", () => {
    const search = parseSearchParams(exerciseSearchSchema, { page: "-5" }, ["tag"]);
    expect(search.page).toBe(1);
  });
});
