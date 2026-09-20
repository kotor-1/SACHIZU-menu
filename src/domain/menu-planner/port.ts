import type { MenuPlannerProviderRequest } from "./contracts";

export const MENU_PLANNER_PROVIDER_OUTPUT_MAX_BYTES = 64 * 1_024;
export const MENU_INTENT_PARSER_TIMEOUT_POLICY =
  "BOUNDED_CONFIG_REQUIRED" as const;

export const MENU_INTENT_PARSER_FAILURE_KINDS = [
  "UNAVAILABLE",
  "FAILED",
  "TIMEOUT",
  "ABORTED",
  "OUTPUT_TOO_LARGE",
] as const;

export type MenuIntentParserFailureKind =
  (typeof MENU_INTENT_PARSER_FAILURE_KINDS)[number];

export type MenuIntentParserResult =
  | {
      ok: true;
      output: unknown;
    }
  | {
      ok: false;
      kind: MenuIntentParserFailureKind;
    };

export interface MenuIntentParser {
  propose(
    request: MenuPlannerProviderRequest,
    options?: {
      signal?: AbortSignal;
    },
  ): Promise<MenuIntentParserResult>;
}
