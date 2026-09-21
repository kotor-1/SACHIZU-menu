import { describe, expect, it } from "vitest";

import { createMenuPlannerOperationCoordinator } from "@/components/menu-planner/operation-coordinator";

describe("MenuPlanner operation coordinator", () => {
  it("rejects duplicate and cross-operation starts while one operation is pending", () => {
    const coordinator = createMenuPlannerOperationCoordinator();
    const generate = coordinator.begin();
    const duplicate = coordinator.begin();

    expect(generate).toBe(1);
    expect(duplicate).toBeNull();
    expect([generate, duplicate].filter((generation) => generation !== null)).toHaveLength(1);
    expect(coordinator.isInFlight()).toBe(true);
    expect(coordinator.isCurrent(generate!)).toBe(true);

    coordinator.finish(generate!);
    expect(coordinator.begin()).toBe(2);
  });

  it("invalidates an older generation after a newer operation begins", () => {
    const coordinator = createMenuPlannerOperationCoordinator();
    const first = coordinator.begin();
    coordinator.finish(first!);
    const second = coordinator.begin();

    let staleResponseWrites = 0;
    if (coordinator.isCurrent(first!)) staleResponseWrites += 1;

    expect(staleResponseWrites).toBe(0);
    expect(coordinator.isCurrent(first!)).toBe(false);
    expect(coordinator.isCurrent(second!)).toBe(true);
  });

  it("does not let an older completion release a newer operation", () => {
    const coordinator = createMenuPlannerOperationCoordinator();
    const first = coordinator.begin();
    coordinator.finish(first!);
    const second = coordinator.begin();

    coordinator.finish(first!);
    expect(coordinator.isCurrent(second!)).toBe(true);
    expect(coordinator.begin()).toBeNull();
  });
});
