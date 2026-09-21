export type MenuPlannerOperationCoordinator = ReturnType<typeof createMenuPlannerOperationCoordinator>;

/**
 * Coordinates the single client-side MenuPlanner lineage operation.
 *
 * The synchronous lock closes duplicate/cross-operation starts before React
 * can commit another render. The monotonically increasing generation is a
 * second boundary: callers must check isCurrent before applying any async
 * result to UI state.
 */
export function createMenuPlannerOperationCoordinator() {
  let nextGeneration = 0;
  let activeGeneration: number | null = null;

  return {
    isInFlight(): boolean {
      return activeGeneration !== null;
    },

    begin(): number | null {
      if (activeGeneration !== null) return null;
      nextGeneration += 1;
      activeGeneration = nextGeneration;
      return nextGeneration;
    },

    isCurrent(generation: number): boolean {
      return activeGeneration === generation;
    },

    finish(generation: number): void {
      if (activeGeneration === generation) activeGeneration = null;
    },
  };
}
