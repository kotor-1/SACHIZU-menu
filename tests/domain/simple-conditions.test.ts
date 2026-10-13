import { describe, expect, it } from "vitest";
import { trainingConditionsSchema } from "@/domain/training-proposal/conditions";
import {
  conditionsFromSimple, DEFAULT_SIMPLE_CONDITIONS, SIMPLE_ATHLETES, SIMPLE_DISTANCES, SIMPLE_GOALS, SIMPLE_LOCATIONS, SIMPLE_STATES,
  simpleFromConditions, type SimpleConditions,
} from "@/domain/training-proposal/simple-conditions";
import { trainingCaseA } from "../fixtures/training-proposals";

describe("five-choice training conditions", () => {
  it("turns every combination into valid conditions and reads it back unchanged", () => {
    let combinations = 0;
    for (const location of SIMPLE_LOCATIONS) for (const straightMeters of SIMPLE_DISTANCES) for (const athlete of SIMPLE_ATHLETES)
      for (const goal of SIMPLE_GOALS) for (const state of SIMPLE_STATES) {
        const simple: SimpleConditions = { location, straightMeters, athlete, goal, state };
        const conditions = conditionsFromSimple(simple);
        expect(trainingConditionsSchema.safeParse(conditions).success).toBe(true);
        expect(simpleFromConditions(conditions)).toEqual(simple);
        combinations += 1;
      }
    expect(combinations).toBe(5 * 8 * 6 * 9 * 4);
  });

  it("assumes a confirmed safe place, a watching coach and no equipment, and takes the surface from the place", () => {
    const track = conditionsFromSimple(DEFAULT_SIMPLE_CONDITIONS);
    expect(track.environment).toMatchObject({ surface: "TRACK", straightMeters: 400, flatSafe: true, trafficFree: true, obstacleFree: true, equipment: [] });
    expect(track.athlete).toMatchObject({ ageGroup: "HIGH_SCHOOL", experience: "EXPERIENCED", supervised: true, familiarWithSprint: true });
    expect(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, location: "PARK", straightMeters: 30 }).environment.surface).toBe("DIRT");
    expect(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, location: "ROAD", straightMeters: 20 }).environment.surface).toBe("ASPHALT");
  });

  it("sets what each goal and state needs for running", () => {
    expect(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, goal: "PRECOMP" }).condition.competitionDays).toBe(1);
    expect(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, goal: "SPEED_ENDURANCE" }).condition.speedEnduranceMode).toBe("SPRINT_SPECIFIC");
    expect(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, goal: "RECOVERY" }).condition.load).toBe("LIGHT");
    expect(conditionsFromSimple(DEFAULT_SIMPLE_CONDITIONS).condition).toMatchObject({ competitionDays: null, speedEnduranceMode: null, load: "NORMAL" });
    expect(conditionsFromSimple({ ...DEFAULT_SIMPLE_CONDITIONS, state: "UNWELL" }).condition).toMatchObject({ health: "POOR", pain: "NONE" });
  });

  it("reads an earlier, detailed set of conditions as the nearest five choices", () => {
    expect(simpleFromConditions(trainingCaseA())).toEqual({ location: "TRACK", straightMeters: 100, athlete: "HIGH_SCHOOL", goal: "ACCEL", state: "GOOD" });
  });
});
