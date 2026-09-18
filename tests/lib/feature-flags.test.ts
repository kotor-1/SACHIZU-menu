/**
 * R10-B1 §3 — `isRunningV2UiEnabled()`: 厳密に `"true"` のときだけ ON。既定は OFF。
 */
import { afterEach, describe, expect, it } from "vitest";
import { isRunningV2UiEnabled } from "@/lib/feature-flags";

const ORIGINAL = process.env.RUNNING_V2_UI_ENABLED;

describe("isRunningV2UiEnabled", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RUNNING_V2_UI_ENABLED;
    else process.env.RUNNING_V2_UI_ENABLED = ORIGINAL;
  });

  it("未設定なら OFF", () => {
    delete process.env.RUNNING_V2_UI_ENABLED;
    expect(isRunningV2UiEnabled()).toBe(false);
  });

  it.each(["1", "TRUE", "True", "yes", "on", "false", ""])("%s は OFF（厳密に \"true\" 以外はすべて OFF）", (value) => {
    process.env.RUNNING_V2_UI_ENABLED = value;
    expect(isRunningV2UiEnabled()).toBe(false);
  });

  it('"true" のときだけ ON', () => {
    process.env.RUNNING_V2_UI_ENABLED = "true";
    expect(isRunningV2UiEnabled()).toBe(true);
  });
});
