/**
 * [R12-A3A] accept token の claim contract（pure domain）。
 *
 * ここで確認するのは「何を token に載せてよいか」「payload bytes が決定的か」「freshness 判定が両 gate を要求するか」。
 * crypto も DB も持たない。
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MENU_PLANNER_ACCEPT_TOKEN_SCHEMA_VERSION,
  canonicalizeMenuPlannerAcceptClaims,
  evaluatePreviewAcceptFreshness,
  isMenuPlannerAcceptClaimsExpired,
  menuPlannerAcceptClaimsSchema,
  type MenuPlannerAcceptClaims,
} from "@/domain/menu-planner/accept-token";
import { canonicalStringify } from "@/domain/menu-planner/preview";

function claims(): MenuPlannerAcceptClaims {
  return menuPlannerAcceptClaimsSchema.parse({
    schemaVersion: MENU_PLANNER_ACCEPT_TOKEN_SCHEMA_VERSION,
    previewId: "preview-1",
    targetMenuId: "target-1",
    ownerId: "default-coach",
    contextMenuTemplateId: "menu-ctx-1",
    menuName: "コーチ作成メニュー",
    constraints: {
      phase: "PREPARATION",
      targetEvents: [],
      purposes: [],
      availableMinutes: null,
      equipment: null,
      preferredExerciseIds: [],
      excludedExerciseIds: [],
    },
    requestDigest: "c".repeat(64),
    proposal: {
      schemaVersion: 1,
      items: [
        {
          kind: "RUNNING",
          proposal: {
            blockName: "主運動",
            method: "ACCELERATION",
            templateId: "ACC_BLOCK_20",
            positionPreference: null,
            reason: "加速の質を確認するため",
          },
        },
      ],
      question: null,
    },
    reasonSanitized: [false],
    contextFingerprint: "a".repeat(64),
    materializationDigest: "b".repeat(64),
    ruleSet: { version: "rs-2026.09.0", contentHash: "rules-a", status: "DRAFT" },
    planner: {
      policyId: "R12_MENU_INTENT_V1",
      previewSchemaVersion: 1,
      engineId: "R12_A2_DETERMINISTIC_PREVIEW",
      runningEngineId: "RUNNING_PRESCRIPTION_ENGINE_V2",
      legacyEngineId: "LEGACY_PRESCRIPTION_ENGINE_V1",
      provider: "VALIDATED_PROPOSAL",
      model: "DETERMINISTIC_PREVIEW_V1",
      requestId: "r12-a2-preview",
    },
    issuedAt: "2026-09-20T07:00:00.000Z",
    expiresAt: "2026-09-20T09:00:00.000Z",
  });
}

describe("R12-A3A accept token claims", () => {
  it("claim schema は strict（未知 claim を silent strip しない）", () => {
    const withExtra = { ...claims(), extraClaim: "x" };
    expect(menuPlannerAcceptClaimsSchema.safeParse(withExtra).success).toBe(false);
    const withNestedExtra = { ...claims(), planner: { ...claims().planner, extraNested: 1 } };
    expect(menuPlannerAcceptClaimsSchema.safeParse(withNestedExtra).success).toBe(false);
  });

  it("schemaVersion は literal", () => {
    expect(menuPlannerAcceptClaimsSchema.safeParse({ ...claims(), schemaVersion: 2 }).success).toBe(false);
    expect(menuPlannerAcceptClaimsSchema.safeParse({ ...claims(), schemaVersion: "1" }).success).toBe(false);
  });

  it("raw intent claim は受け付けない", () => {
    expect(
      menuPlannerAcceptClaimsSchema.safeParse({
        ...claims(),
        intent: { schemaVersion: 1, requestText: "raw", constraints: claims().constraints },
      }).success,
    ).toBe(false);
  });

  it("reasonSanitized の長さは proposal の item 数と一致しなければならない", () => {
    expect(menuPlannerAcceptClaimsSchema.safeParse({ ...claims(), reasonSanitized: [false, true] }).success).toBe(false);
    expect(menuPlannerAcceptClaimsSchema.safeParse({ ...claims(), reasonSanitized: [] }).success).toBe(false);
    expect(menuPlannerAcceptClaimsSchema.safeParse({ ...claims(), reasonSanitized: [true] }).success).toBe(true);
  });

  it("expiresAt は issuedAt より後でなければならない", () => {
    const invalid = { ...claims(), expiresAt: "2026-09-20T07:00:00.000Z" };
    expect(menuPlannerAcceptClaimsSchema.safeParse(invalid).success).toBe(false);
  });

  it("日時は UTC ISO へ正規化され、入力表記に依存しない", () => {
    const withOffset = { ...claims(), issuedAt: "2026-09-20T16:00:00+09:00" };
    const parsed = menuPlannerAcceptClaimsSchema.parse(withOffset);
    expect(parsed.issuedAt).toBe("2026-09-20T07:00:00.000Z");
  });

  it("canonical payload は key の挿入順に依存せず決定的", () => {
    const base = claims();
    const reordered = {
      expiresAt: base.expiresAt,
      issuedAt: base.issuedAt,
      planner: base.planner,
      ruleSet: base.ruleSet,
      materializationDigest: base.materializationDigest,
      contextFingerprint: base.contextFingerprint,
      proposal: base.proposal,
      reasonSanitized: base.reasonSanitized,
      requestDigest: base.requestDigest,
      constraints: base.constraints,
      menuName: base.menuName,
      contextMenuTemplateId: base.contextMenuTemplateId,
      ownerId: base.ownerId,
      targetMenuId: base.targetMenuId,
      previewId: base.previewId,
      schemaVersion: base.schemaVersion,
    } as MenuPlannerAcceptClaims;

    const a = canonicalStringify(canonicalizeMenuPlannerAcceptClaims(base));
    const b = canonicalStringify(canonicalizeMenuPlannerAcceptClaims(reordered));
    expect(a).toBe(b);
    expect(a).toBe(canonicalStringify(canonicalizeMenuPlannerAcceptClaims(claims())));
  });

  it("canonicalizer は claim 集合を閉じる（余計な field を payload へ通さない）", () => {
    const polluted = { ...claims(), injected: "must-not-appear" } as unknown as MenuPlannerAcceptClaims;
    const payload = canonicalStringify(canonicalizeMenuPlannerAcceptClaims(polluted));
    expect(payload).not.toContain("injected");
    expect(payload).not.toContain("must-not-appear");
  });

  it("binding が変われば payload bytes が変わる", () => {
    const base = canonicalStringify(canonicalizeMenuPlannerAcceptClaims(claims()));
    expect(canonicalStringify(canonicalizeMenuPlannerAcceptClaims({ ...claims(), contextFingerprint: "c".repeat(64) }))).not.toBe(base);
    expect(canonicalStringify(canonicalizeMenuPlannerAcceptClaims({ ...claims(), materializationDigest: "d".repeat(64) }))).not.toBe(base);
    expect(canonicalStringify(canonicalizeMenuPlannerAcceptClaims({ ...claims(), targetMenuId: "target-2" }))).not.toBe(base);
  });

  it("期限判定: 境界は「期限切れ」側", () => {
    const c = claims();
    expect(isMenuPlannerAcceptClaimsExpired(c, new Date("2026-09-20T08:59:59.999Z"))).toBe(false);
    expect(isMenuPlannerAcceptClaimsExpired(c, new Date("2026-09-20T09:00:00.000Z"))).toBe(true);
    expect(isMenuPlannerAcceptClaimsExpired(c, new Date("2026-09-20T09:00:00.001Z"))).toBe(true);
  });

  it("freshness は両 gate を要求する", () => {
    const same = {
      signedContextFingerprint: "a".repeat(64),
      signedMaterializationDigest: "b".repeat(64),
      recomputedContextFingerprint: "a".repeat(64),
      recomputedMaterializationDigest: "b".repeat(64),
    };
    expect(evaluatePreviewAcceptFreshness(same)).toEqual({ fresh: true });

    const contextOnly = evaluatePreviewAcceptFreshness({ ...same, recomputedContextFingerprint: "c".repeat(64) });
    expect(contextOnly).toEqual({ fresh: false, mismatchedGates: ["CONTEXT_FINGERPRINT"] });

    const digestOnly = evaluatePreviewAcceptFreshness({ ...same, recomputedMaterializationDigest: "d".repeat(64) });
    expect(digestOnly).toEqual({ fresh: false, mismatchedGates: ["MATERIALIZATION_DIGEST"] });

    const both = evaluatePreviewAcceptFreshness({
      ...same,
      recomputedContextFingerprint: "c".repeat(64),
      recomputedMaterializationDigest: "d".repeat(64),
    });
    expect(both).toEqual({ fresh: false, mismatchedGates: ["CONTEXT_FINGERPRINT", "MATERIALIZATION_DIGEST"] });
  });

  it("domain は node 標準 / infra / actions へ依存しない（lint が動的 import を見ないための source audit）", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "src/domain/menu-planner/accept-token.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["']node:/u);
    expect(source).not.toMatch(/from\s+["']@\/infra\//u);
    expect(source).not.toMatch(/from\s+["']@\/actions\//u);
    expect(source).not.toMatch(/require\s*\(\s*["']node:/u);
    expect(source).not.toMatch(/import\s*\(/u);
  });
});
