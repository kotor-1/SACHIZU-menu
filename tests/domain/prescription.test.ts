import { describe, expect, it } from "vitest";
import {
  estimateSeconds,
  fieldsForMetric,
  formatPrescription,
  hasPrescription,
} from "@/domain/shared/prescription";

describe("hasPrescription", () => {
  it("is false for null / undefined / empty object", () => {
    expect(hasPrescription(null)).toBe(false);
    expect(hasPrescription(undefined)).toBe(false);
    expect(hasPrescription({})).toBe(false);
  });

  it("is true when any field is set", () => {
    expect(hasPrescription({ sets: 3 })).toBe(true);
    expect(hasPrescription({ restSeconds: 0 })).toBe(true); // 0 は「未設定」ではない
  });
});

describe("formatPrescription", () => {
  it("returns empty string when nothing is set", () => {
    expect(formatPrescription({})).toBe("");
    expect(formatPrescription(null)).toBe("");
  });

  it("formats sets × reps", () => {
    expect(formatPrescription({ sets: 3, reps: 10 })).toBe("3set × 10回");
  });

  it("labels reps as per side only when asked", () => {
    expect(formatPrescription({ sets: 3, reps: 15, restSeconds: 60 }, { perSideReps: true })).toBe("3set × 片側15回 / レスト 1分");
    expect(formatPrescription({ sets: 3, distanceMeters: 30 }, { perSideReps: true })).toBe("3set × 30m");
  });

  it("formats distance in meters and kilometers", () => {
    expect(formatPrescription({ distanceMeters: 60 })).toBe("60m");
    expect(formatPrescription({ distanceMeters: 3000 })).toBe("3km");
    expect(formatPrescription({ distanceMeters: 1200 })).toBe("1.2km");
  });

  it("formats duration in seconds and minutes", () => {
    expect(formatPrescription({ durationSeconds: 45 })).toBe("45秒");
    expect(formatPrescription({ durationSeconds: 120 })).toBe("2分");
    expect(formatPrescription({ durationSeconds: 90 })).toBe("1分30秒");
  });

  it("appends load and intensity to the head, and rest as a trailing segment", () => {
    const result = formatPrescription({
      sets: 4,
      distanceMeters: 150,
      intensityPercent: 90,
      restSeconds: 480,
    });
    expect(result).toBe("4set × 150m @90% / レスト 8分");
  });

  it("includes weight for strength exercises", () => {
    expect(formatPrescription({ sets: 4, reps: 5, loadKg: 80 })).toBe(
      "4set × 5回 80kg",
    );
  });
});

describe("fieldsForMetric", () => {
  it("shows reps + weight for REPS metric", () => {
    expect(fieldsForMetric("REPS")).toEqual(["sets", "restSeconds", "reps", "loadKg"]);
  });

  it("shows distance + intensity for DISTANCE metric", () => {
    expect(fieldsForMetric("DISTANCE")).toEqual([
      "sets",
      "restSeconds",
      "distanceMeters",
      "intensityPercent",
    ]);
  });

  it("shows duration + intensity for TIME metric", () => {
    expect(fieldsForMetric("TIME")).toEqual([
      "sets",
      "restSeconds",
      "durationSeconds",
      "intensityPercent",
    ]);
  });
});

describe("estimateSeconds", () => {
  it("is 0 for an empty prescription", () => {
    expect(estimateSeconds(null)).toBe(0);
    expect(estimateSeconds({})).toBe(45); // sets のデフォルトは 1、work は 45 秒仮定
  });

  it("multiplies sets by work time and adds rest between sets (not after the last)", () => {
    // 3 セット、各 20 秒、レスト 60 秒 → 20*3 + 60*2 = 180
    expect(estimateSeconds({ sets: 3, durationSeconds: 20, restSeconds: 60 })).toBe(180);
  });

  it("falls back to the 45s assumption when duration is unknown", () => {
    expect(estimateSeconds({ sets: 2, restSeconds: 10 })).toBe(45 * 2 + 10);
  });
});
