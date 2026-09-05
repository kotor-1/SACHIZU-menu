import { describe, expect, it } from "vitest";
import {
  exerciseDraftPayloadSchema,
  parseDraftPayload,
} from "@/domain/ai/draft-schema";

/**
 * これらのテストは AI 拡張境界（Phase 2 監査項目 B・C）を直接支える。
 *
 * VLM は自由な文字列・型ゆれのある JSON を返しうるが、
 * そのすべてが「例外を投げずに、既知の値へ丸められるか、無視される」ことを保証する。
 * ここが壊れると、解析失敗や想定外の出力が Exercise テーブルへそのまま
 * 汚染データとして流れ込みかねない。
 */
describe("exerciseDraftPayloadSchema: unknown/invalid model output never throws", () => {
  it("accepts a fully well-formed payload as-is", () => {
    const result = exerciseDraftPayloadSchema.parse({
      name: "ミニハードル・クイックステップ",
      category: "DRILL",
      metricType: "DISTANCE",
      difficulty: 2,
      targets: ["COORDINATION", "TECHNIQUE"],
      defaultSets: 3,
      defaultDistanceMeters: 15,
    });
    expect(result.category).toBe("DRILL");
    expect(result.targets).toEqual(["COORDINATION", "TECHNIQUE"]);
  });

  it("falls back an unknown category string to OTHER instead of rejecting the draft", () => {
    const result = exerciseDraftPayloadSchema.parse({ category: "banana" });
    expect(result.category).toBe("OTHER");
  });

  it("is case-insensitive for category / metricType (model may return lowercase)", () => {
    const result = exerciseDraftPayloadSchema.parse({
      category: "drill",
      metricType: "distance",
    });
    expect(result.category).toBe("DRILL");
    expect(result.metricType).toBe("DISTANCE");
  });

  it("falls back a wrong-typed category (e.g. a number) instead of throwing", () => {
    const result = exerciseDraftPayloadSchema.parse({ category: 123 });
    expect(result.category).toBe("OTHER");
  });

  it("falls back an unknown metricType to REPS", () => {
    const result = exerciseDraftPayloadSchema.parse({ metricType: "weight" });
    expect(result.metricType).toBe("REPS");
  });

  it("clamps an out-of-range or garbage difficulty to the default (3)", () => {
    expect(exerciseDraftPayloadSchema.parse({ difficulty: 999 }).difficulty).toBe(3);
    expect(exerciseDraftPayloadSchema.parse({ difficulty: "not-a-number" }).difficulty).toBe(3);
  });

  it("filters unknown target values out instead of rejecting the whole draft", () => {
    const result = exerciseDraftPayloadSchema.parse({
      targets: ["speed", "COORDINATION", "made-up-target"],
    });
    expect(result.targets).toEqual(["COORDINATION"]);
  });

  it("falls back a non-array targets value to an empty array", () => {
    const result = exerciseDraftPayloadSchema.parse({ targets: "COORDINATION" });
    expect(result.targets).toEqual([]);
  });

  it("accepts a completely empty object (a draft can be partially filled)", () => {
    expect(() => exerciseDraftPayloadSchema.parse({})).not.toThrow();
  });

  it("rejects fields that are clearly wrong shape only where there is no catch (unknown extra keys are simply dropped by default)", () => {
    // 未知のフィールドは静かに無視される（strict() ではない）
    const result = exerciseDraftPayloadSchema.parse({ unknownField: "whatever" });
    expect(result).not.toHaveProperty("unknownField");
  });
});

describe("parseDraftPayload: never throws on malformed stored JSON", () => {
  it("parses a well-formed payload", () => {
    const payload = parseDraftPayload(JSON.stringify({ name: "テスト", category: "DRILL" }));
    expect(payload.name).toBe("テスト");
    expect(payload.category).toBe("DRILL");
  });

  it("returns an empty object for invalid JSON instead of throwing", () => {
    expect(parseDraftPayload("{not valid json")).toEqual({});
    expect(parseDraftPayload("")).toEqual({});
  });

  it("returns an empty object when the JSON is valid but not an object (e.g. an array)", () => {
    expect(parseDraftPayload("[1,2,3]")).toEqual({});
    expect(parseDraftPayload('"just a string"')).toEqual({});
    expect(parseDraftPayload("42")).toEqual({});
  });
});
