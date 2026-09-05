import { describe, expect, it } from "vitest";
import {
  CURRENT_DRAFT_SCHEMA_VERSION,
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

/**
 * schemaVersion は「将来 Prompt / モデルを変えても、
 * どの世代の下書きかを後から判別できるように」という要求への対応。
 * 過去に保存された（version フィールドを持たない）下書きも
 * 引き続き読めることが前提になる。
 */
describe("exerciseDraftPayloadSchema: schemaVersion (Phase 2 audit item: prompt/model provenance)", () => {
  it("defaults to the current version when omitted (reading a pre-versioning draft)", () => {
    const result = exerciseDraftPayloadSchema.parse({ name: "旧データ" });
    expect(result.schemaVersion).toBe(CURRENT_DRAFT_SCHEMA_VERSION);
  });

  it("preserves an explicit version so old drafts stay distinguishable from new ones", () => {
    const result = exerciseDraftPayloadSchema.parse({ schemaVersion: 1 });
    expect(result.schemaVersion).toBe(1);
  });

  it("falls back to the current version for a garbage value instead of throwing", () => {
    expect(exerciseDraftPayloadSchema.parse({ schemaVersion: "not-a-number" }).schemaVersion).toBe(
      CURRENT_DRAFT_SCHEMA_VERSION,
    );
    expect(exerciseDraftPayloadSchema.parse({ schemaVersion: -1 }).schemaVersion).toBe(
      CURRENT_DRAFT_SCHEMA_VERSION,
    );
    expect(exerciseDraftPayloadSchema.parse({ schemaVersion: null }).schemaVersion).toBe(
      CURRENT_DRAFT_SCHEMA_VERSION,
    );
  });
});

describe("parseDraftPayload: never throws on malformed stored JSON", () => {
  it("parses a well-formed payload", () => {
    const payload = parseDraftPayload(JSON.stringify({ name: "テスト", category: "DRILL" }));
    expect(payload.name).toBe("テスト");
    expect(payload.category).toBe("DRILL");
  });

  it("returns an (almost) empty payload for invalid JSON instead of throwing", () => {
    // schemaVersion だけは常に埋まる（型上 required なので、既定値として current を使う）
    const empty = { schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION };
    expect(parseDraftPayload("{not valid json")).toEqual(empty);
    expect(parseDraftPayload("")).toEqual(empty);
  });

  it("returns an (almost) empty payload when the JSON is valid but not an object (e.g. an array)", () => {
    const empty = { schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION };
    expect(parseDraftPayload("[1,2,3]")).toEqual(empty);
    expect(parseDraftPayload('"just a string"')).toEqual(empty);
    expect(parseDraftPayload("42")).toEqual(empty);
  });
});
