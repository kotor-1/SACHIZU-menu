import { describe, expect, it } from "vitest";
import {
  checkbox,
  optionalNumber,
  optionalText,
  parseCsvInput,
  requiredText,
} from "@/domain/shared/zod-helpers";

describe("optionalNumber", () => {
  const schema = optionalNumber({ min: 1, max: 99, int: true });

  it("treats empty string / null / undefined as null", () => {
    expect(schema.parse("")).toBeNull();
    expect(schema.parse(null)).toBeNull();
    expect(schema.parse(undefined)).toBeNull();
  });

  it("coerces numeric strings from form input", () => {
    expect(schema.parse("42")).toBe(42);
    expect(schema.parse("  7  ")).toBe(7);
  });

  it("silently treats non-numeric garbage as \"not provided\" (null), it does not throw", () => {
    // 実装は Number("abc") が NaN になった時点で null に丸めてしまうため、
    // フォーム側のバリデーションエラーにはならない（値なし扱いになる）。
    const result = optionalNumber().safeParse("abc");
    expect(result.success).toBe(true);
    expect(result.success && result.data).toBeNull();
  });

  it("enforces min / max / int", () => {
    expect(schema.safeParse("0").success).toBe(false); // < min
    expect(schema.safeParse("100").success).toBe(false); // > max
    expect(schema.safeParse("3.5").success).toBe(false); // not int
    expect(schema.safeParse("50").success).toBe(true);
  });
});

describe("optionalText", () => {
  it("converts empty / whitespace-only strings to null", () => {
    const schema = optionalText();
    expect(schema.parse("")).toBeNull();
    expect(schema.parse("   ")).toBeNull();
  });

  it("trims and keeps non-empty text", () => {
    expect(optionalText().parse("  hello  ")).toBe("hello");
  });

  it("enforces max length", () => {
    const schema = optionalText(5);
    expect(schema.safeParse("123456").success).toBe(false);
    expect(schema.safeParse("12345").success).toBe(true);
  });
});

describe("requiredText", () => {
  it("rejects empty / whitespace-only input", () => {
    const schema = requiredText("種目名");
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("   ").success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    expect(requiredText("種目名").parse("  Aスキップ  ")).toBe("Aスキップ");
  });

  it("enforces max length", () => {
    const schema = requiredText("種目名", 3);
    expect(schema.safeParse("あいうえ").success).toBe(false);
    expect(schema.safeParse("あいう").success).toBe(true);
  });
});

describe("checkbox", () => {
  const schema = checkbox();

  it('is false when the hidden fallback ("") is the only value', () => {
    expect(schema.parse("")).toBe(false);
  });

  it('is true only when "true" is present, not merely non-empty', () => {
    expect(schema.parse("true")).toBe(true);
    expect(schema.parse("on")).toBe(true);
    // これが checkbox() を作った理由: z.coerce.boolean() だと "false" が true になってしまう
    expect(schema.parse("false")).toBe(false);
  });

  it("handles the [hidden, checkbox] duplicate-name array form used by <form>", () => {
    // 未チェック: hidden("") のみ届く
    expect(schema.parse([""])).toBe(false);
    // チェック済み: hidden("") + checkbox("true") の 2 値が届く
    expect(schema.parse(["", "true"])).toBe(true);
  });
});

describe("parseCsvInput", () => {
  it("splits on commas (half/full-width) and newlines", () => {
    expect(parseCsvInput("スパイク, ハードル、ミニハードル\n台")).toEqual([
      "スパイク",
      "ハードル",
      "ミニハードル",
      "台",
    ]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseCsvInput(" a ,, b ,")).toEqual(["a", "b"]);
  });

  it("de-duplicates", () => {
    expect(parseCsvInput("a, a, b")).toEqual(["a", "b"]);
  });

  it("drops overly long segments", () => {
    const long = "x".repeat(41);
    expect(parseCsvInput(`ok,${long}`)).toEqual(["ok"]);
  });

  it("returns an empty array for non-string input", () => {
    expect(parseCsvInput(null)).toEqual([]);
    expect(parseCsvInput(undefined)).toEqual([]);
    expect(parseCsvInput(42)).toEqual([]);
  });
});
