import { describe, expect, it } from "vitest";
import { parseOptionalNumberInput, parseRequiredNumberInput } from "@/presentation/running/execution-input";

describe("R11-B4B4 execution form numeric parsing", () => {
  it("keeps an optional empty value unknown instead of converting it to zero", () => {
    expect(parseOptionalNumberInput("")).toBeNull();
    expect(parseOptionalNumberInput("   ")).toBeNull();
  });

  it("leaves an invalid required value for the formal schema to reject", () => {
    expect(Number.isNaN(parseRequiredNumberInput(""))).toBe(true);
    expect(Number.isNaN(parseRequiredNumberInput("invalid"))).toBe(true);
  });

  it("preserves valid decimal input without client-side rounding", () => {
    expect(parseOptionalNumberInput("10.375")).toBe(10.375);
    expect(parseRequiredNumberInput("2.5")).toBe(2.5);
  });
});
