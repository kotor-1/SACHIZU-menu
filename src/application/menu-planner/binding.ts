import { createHash } from "node:crypto";

import {
  canonicalStringify,
  canonicalizeMenuPlannerContextPayload,
  canonicalizeMenuPlannerMaterializationPayload,
  type MenuPlannerContextBindingInput,
  type MenuPlannerMaterializationDigestInput,
} from "@/domain/menu-planner/preview";

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

/** Server-only hash wrapper. Canonicalization itself remains a pure domain function. */
export function buildMenuPlannerContextFingerprint(input: MenuPlannerContextBindingInput): string {
  return sha256Canonical(canonicalizeMenuPlannerContextPayload(input));
}

/** previewId / itemKey / blockKey / timestamp は input type に存在しないため digest に入らない。 */
export function buildMenuPlannerMaterializationDigest(input: MenuPlannerMaterializationDigestInput): string {
  return sha256Canonical(canonicalizeMenuPlannerMaterializationPayload(input));
}
