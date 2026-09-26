/**
 * R11-B1 / R11-B1.1 — 確認 challenge の canonicalization と digest（純粋関数）。
 *
 * 「コーチが見た planning evaluation」と「保存直前の evaluation」が同じであることだけを照合する値なので、
 *   - 同じ policy 評価なら必ず同じ値（時刻・乱数・確認記録を含めない）
 *   - Finding の中身（value / limit / metric / scope）が変われば別の値
 *   - メニュー内容（sourceMenuFingerprint）が変われば別の値
 *   - [B1.1] R6 集計 / R7 週次 / 全 Finding / 評価不能の理由 / RuleSet identity が変われば別の値
 *   - [B1.1] raw 履歴（LoadEvent）や evaluatedAt だけが違い policy 結果が同一なら同じ値
 *   - 配列順の違いでは変わらない（安定ソート）。重複の増減では変わる
 * を固定する。
 */
import { describe, expect, it } from "vitest";
import {
  canonicalConfirmationChallengePayload,
  canonicalSessionConfirmationEvaluationPayload,
  type SessionPlanningEvaluationInput,
} from "@/domain/running/persistence/sessionSnapshot";
import type { Finding } from "@/domain/running/types/findings";
import {
  buildConfirmationChallenge,
  buildSessionConfirmationEvaluationDigest,
  confirmationFindingsOf,
  evaluateSessionConfirmation,
} from "@/actions/_session-confirmation";
import { planAcc } from "../../repository/running/fixtures";
import { evaluateSessionAggregation } from "@/domain/running/aggregation";
import { productionRuleSet } from "../../presentation/running/helpers";

const BASE = { menuTemplateId: "menu-1", sessionDate: "2026-09-20", sourceMenuFingerprint: "fp-1", evaluationDigest: "digest-1" };

function confirmFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    code: "AGG_TOTAL_RUNNING_CONFIRM",
    severity: "REQUIRE_CONFIRMATION",
    scope: "SESSION",
    metric: "PLA_MENU_TOTAL_DISTANCE",
    evidenceIds: [],
    ...overrides,
  } as Finding;
}

const withValue = (lower: number, upper: number): Finding =>
  confirmFinding({ value: { lower, upper, unit: "m", source: "RULE_DEFINITION", confidence: "HIGH" } as Finding["value"] });

const RULE_SET = { version: "rs-2026.09.0", contentHash: "c7533c64cf2d51fc84ecb2dc32b551a84b938c492f5ec55c139fc27b65ebd8d8" };

/** 本物の R6 集計結果（`SessionAggregate`）。fixture を手書きしない。 */
function aggregateResult(competitionDay = false) {
  return evaluateSessionAggregation([{ kind: "RUNNING_V2", prescription: planAcc() }], {
    ruleSet: productionRuleSet(),
    tier: "ADVANCED",
    availableMinutes: null,
    competitionDay,
    mode: "PLANNING",
  });
}

type WeeklyResultInput = Extract<SessionPlanningEvaluationInput["weeklyContext"], { status: "EVALUATED" }>["items"][number]["result"];

function weeklyResult(overrides: Partial<WeeklyResultInput> = {}): WeeklyResultInput {
  return {
    evaluatedAt: "2026-09-20T16:00:00+09:00",
    coverage72h: "PARTIAL",
    events48h: [],
    events72h: [],
    highSessions7d: 1,
    readinessRequired: false,
    weeklyPositionCap: null,
    autogenBlockedMethods: [],
    findings: [],
    ...overrides,
  } as WeeklyResultInput;
}

/** 現実の evaluation と同じ形（`sessionPlanningEvaluationInputSchema` を満たす）。 */
function evaluationInput(overrides: {
  findings?: Finding[];
  fingerprint?: string;
  aggregation?: SessionPlanningEvaluationInput["aggregation"];
  weeklyContext?: SessionPlanningEvaluationInput["weeklyContext"];
} = {}): SessionPlanningEvaluationInput {
  return {
    aggregation: overrides.aggregation ?? { status: "EVALUATED", ruleSet: RULE_SET, result: aggregateResult() },
    weeklyContext:
      overrides.weeklyContext ?? { status: "EVALUATED", ruleSet: RULE_SET, items: [{ menuItemId: "item-1", result: weeklyResult() }] },
    findings: overrides.findings ?? [],
    sourceMenuFingerprint: overrides.fingerprint ?? "fp-1",
  } as SessionPlanningEvaluationInput;
}

describe("R11-B1: canonical payload", () => {
  it("確認が必要な Finding だけを含める（WARN / REQUIRE_COACH_REVIEW / BLOCK_AUTOGEN は含めない）", () => {
    const payload = canonicalConfirmationChallengePayload({
      ...BASE,
      findings: [
        confirmFinding(),
        confirmFinding({ code: "WEEKLY_HIGH_WITHIN_48H", severity: "REQUIRE_COACH_REVIEW" }),
        confirmFinding({ code: "AGG_REST_INFEASIBLE", severity: "WARN" }),
        confirmFinding({ code: "AUTOGEN", severity: "BLOCK_AUTOGEN" }),
      ],
    });
    expect(payload.requiredFindings.map((f) => f.code)).toEqual(["AGG_TOTAL_RUNNING_CONFIRM"]);
    expect(payload).toMatchObject({
      schemaVersion: 2,
      menuTemplateId: "menu-1",
      sessionDate: "2026-09-20",
      sourceMenuFingerprint: "fp-1",
      evaluationDigest: "digest-1",
    });
  });

  it("Finding schema に実在する field だけを canonical 化する（未設定は null。存在しない field を作らない）", () => {
    const payload = canonicalConfirmationChallengePayload({ ...BASE, findings: [confirmFinding({ metric: undefined })] });
    expect(payload.requiredFindings[0]).toEqual({
      code: "AGG_TOTAL_RUNNING_CONFIRM",
      severity: "REQUIRE_CONFIRMATION",
      scope: "SESSION",
      metric: null,
      value: null,
      limit: null,
    });
    expect(Object.keys(payload.requiredFindings[0]!).sort()).toEqual(["code", "limit", "metric", "scope", "severity", "value"]);
  });

  it("時刻・乱数を含めない（同じ入力なら payload も digest も同じ）", () => {
    const args = { ...BASE, findings: [confirmFinding()] };
    expect(canonicalConfirmationChallengePayload(args)).toEqual(canonicalConfirmationChallengePayload(args));
    expect(buildConfirmationChallenge(args)).toBe(buildConfirmationChallenge(args));
    expect(JSON.stringify(canonicalConfirmationChallengePayload(args))).not.toMatch(/20\d\d-\d\d-\d\dT/);
    expect(buildConfirmationChallenge(args)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("配列順が違うだけなら同じ digest（安定ソート）", () => {
    const a = confirmFinding();
    const b = confirmFinding({ code: "PLAUSIBILITY_REQUIRE_CONFIRMATION", scope: "ITEM", metric: "PLA_ITEM_TOTAL_DISTANCE" });
    expect(buildConfirmationChallenge({ ...BASE, findings: [a, b] })).toBe(buildConfirmationChallenge({ ...BASE, findings: [b, a] }));
  });

  it("同じ Finding の重複件数が変われば別の digest（重複を黙って1件に潰さない）", () => {
    const f = confirmFinding();
    expect(buildConfirmationChallenge({ ...BASE, findings: [f] })).not.toBe(buildConfirmationChallenge({ ...BASE, findings: [f, f] }));
  });

  it("同じ code でも value / limit / metric / scope が変われば別の digest", () => {
    const base = buildConfirmationChallenge({ ...BASE, findings: [withValue(9000, 9000)] });
    expect(buildConfirmationChallenge({ ...BASE, findings: [withValue(15000, 15000)] })).not.toBe(base);
    expect(
      buildConfirmationChallenge({
        ...BASE,
        findings: [confirmFinding({ value: { lower: 9000, upper: 9000, unit: "m", source: "RULE_DEFINITION", confidence: "HIGH" } as Finding["value"], limit: { min: 0, max: 8000, unit: "m" } as Finding["limit"] })],
      }),
    ).not.toBe(base);
    expect(buildConfirmationChallenge({ ...BASE, findings: [confirmFinding({ metric: "OTHER_RULE" })] })).not.toBe(
      buildConfirmationChallenge({ ...BASE, findings: [confirmFinding()] }),
    );
    expect(buildConfirmationChallenge({ ...BASE, findings: [confirmFinding({ scope: "ITEM" })] })).not.toBe(
      buildConfirmationChallenge({ ...BASE, findings: [confirmFinding()] }),
    );
  });

  it("メニュー内容（指紋）・メニュー・日付・評価 digest が変われば別の challenge", () => {
    const args = { ...BASE, findings: [confirmFinding()] };
    expect(buildConfirmationChallenge({ ...args, sourceMenuFingerprint: "fp-2" })).not.toBe(buildConfirmationChallenge(args));
    expect(buildConfirmationChallenge({ ...args, menuTemplateId: "menu-2" })).not.toBe(buildConfirmationChallenge(args));
    expect(buildConfirmationChallenge({ ...args, sessionDate: "2026-09-21" })).not.toBe(buildConfirmationChallenge(args));
    // [R11-B1.1] MenuItem が同じでも planning evaluation が変われば challenge が変わる
    expect(buildConfirmationChallenge({ ...args, evaluationDigest: "digest-2" })).not.toBe(buildConfirmationChallenge(args));
  });

  it("健康情報を入力に持たない（Finding / 指紋 / メニュー・日付だけ）", () => {
    const json = JSON.stringify(canonicalConfirmationChallengePayload({ ...BASE, findings: [withValue(9000, 9000)] }));
    for (const key of ["pain", "redFlag", "soreness", "fatigue", "sleep", "readiness", "birthDate", "sexForNorms", "reporter"]) {
      expect(json).not.toContain(key);
    }
  });
});

describe("R11-B1.1: evaluation digest（policy 評価結果の currentness）", () => {
  const digest = (o: Parameters<typeof evaluationInput>[0] = {}) => buildSessionConfirmationEvaluationDigest(evaluationInput(o));

  it("同じ policy 評価なら同じ digest（hex 64 桁）", () => {
    expect(digest()).toBe(digest());
    expect(digest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("R6 集計の結果が変われば別の digest（MenuItem が同じでも）", () => {
    const withCompetitionDay = digest({
      aggregation: { status: "EVALUATED", ruleSet: RULE_SET, result: aggregateResult(true) },
    });
    expect(withCompetitionDay).not.toBe(digest());
  });

  it("評価できなかった理由（status / reasons）が変われば別の digest", () => {
    const notEvaluated = digest({ aggregation: { status: "NOT_EVALUATED", reasons: ["RUNNING_CONTEXT_UNAVAILABLE"] } });
    const otherReason = digest({ aggregation: { status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS"] } });
    expect(notEvaluated).not.toBe(digest());
    expect(notEvaluated).not.toBe(otherReason);
    // 理由の並び順では変わらない
    expect(digest({ aggregation: { status: "NOT_EVALUATED", reasons: ["MIXED_RULESET_VERSIONS", "SNAPSHOT_JSON_INVALID"] } })).toBe(
      digest({ aggregation: { status: "NOT_EVALUATED", reasons: ["SNAPSHOT_JSON_INVALID", "MIXED_RULESET_VERSIONS"] } }),
    );
  });

  it("R7 週次の policy 結果が変われば別の digest（weekly finding / cap / readiness）", () => {
    const base = digest();
    const withFinding = digest({
      weeklyContext: {
        status: "EVALUATED",
        ruleSet: RULE_SET,
        items: [{ menuItemId: "item-1", result: weeklyResult({ findings: [confirmFinding({ code: "WEEKLY_HIGH_WITHIN_48H", severity: "REQUIRE_COACH_REVIEW", scope: "WEEK" })] }) }],
      },
    });
    const withCap = digest({
      weeklyContext: { status: "EVALUATED", ruleSet: RULE_SET, items: [{ menuItemId: "item-1", result: weeklyResult({ weeklyPositionCap: "LOWER_BOUND" }) }] },
    });
    const withReadiness = digest({
      weeklyContext: { status: "EVALUATED", ruleSet: RULE_SET, items: [{ menuItemId: "item-1", result: weeklyResult({ readinessRequired: true }) }] },
    });
    expect(new Set([base, withFinding, withCap, withReadiness]).size).toBe(4);
  });

  it("確認対象でない Finding（WARN / REQUIRE_COACH_REVIEW / BLOCK_AUTOGEN）の変化でも digest が変わる", () => {
    const base = digest();
    for (const severity of ["WARN", "REQUIRE_COACH_REVIEW", "BLOCK_AUTOGEN"] as const) {
      expect(digest({ findings: [confirmFinding({ code: "AGG_OTHER", severity })] }), severity).not.toBe(base);
    }
  });

  it("RuleSet identity（版 / hash）が変われば別の digest", () => {
    expect(
      digest({ aggregation: { status: "EVALUATED", ruleSet: { version: "rs-2026.08.0", contentHash: RULE_SET.contentHash }, result: aggregateResult() } }),
    ).not.toBe(digest());
    expect(
      digest({ aggregation: { status: "EVALUATED", ruleSet: { version: RULE_SET.version, contentHash: "0".repeat(64) }, result: aggregateResult() } }),
    ).not.toBe(digest());
  });

  it("メニュー内容の指紋が変われば別の digest（MenuItem 変更は既存 fingerprint が検知する）", () => {
    expect(digest({ fingerprint: "fp-2" })).not.toBe(digest());
  });

  it("raw 履歴（LoadEvent）と evaluatedAt だけが違い policy 結果が同一なら同じ digest（§14/§21）", () => {
    const event = {
      at: "2026-09-19T16:00:00+09:00",
      sessionKey: "s-1",
      category: "RUNNING_HIGH_INTENSITY",
      method: null,
      templateId: null,
      intensityTag: "HIGH",
      magnitude: {},
      source: "SESSION_RECORD",
      completion: "DONE",
    } as WeeklyResultInput["events48h"][number];
    const a = digest({
      weeklyContext: { status: "EVALUATED", ruleSet: RULE_SET, items: [{ menuItemId: "item-1", result: weeklyResult() }] },
    });
    const b = digest({
      weeklyContext: {
        status: "EVALUATED",
        ruleSet: RULE_SET,
        items: [
          {
            menuItemId: "item-1",
            result: weeklyResult({ evaluatedAt: "2026-09-20T18:30:00+09:00", events48h: [event], events72h: [event] }),
          },
        ],
      },
    });
    expect(b).toBe(a);
  });

  it("確認記録（findingConfirmations）は digest の対象にしない（確認を入力へ循環させない）", () => {
    const withConfirmations = {
      ...evaluationInput(),
      findingConfirmations: [{ code: "AGG_TOTAL_RUNNING_CONFIRM", at: "2026-09-20T16:00:00+09:00" }],
    } as SessionPlanningEvaluationInput;
    expect(buildSessionConfirmationEvaluationDigest(withConfirmations)).toBe(digest());
  });

  it("canonical payload に時刻・生履歴・確認記録・健康情報を含めない", () => {
    const json = JSON.stringify(canonicalSessionConfirmationEvaluationPayload(evaluationInput()));
    for (const key of ["evaluatedAt", "events48h", "events72h", "findingConfirmations", "pain", "soreness", "sleep", "readinessReport", "athleteReport"]) {
      expect(json, key).not.toContain(key);
    }
    expect(json).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it("weekly items の並び順では変わらない（menuItemId で安定ソート）", () => {
    const items = [
      { menuItemId: "item-b", result: weeklyResult({ highSessions7d: 2 }) },
      { menuItemId: "item-a", result: weeklyResult() },
    ];
    const forward = digest({ weeklyContext: { status: "EVALUATED", ruleSet: RULE_SET, items } });
    const reversed = digest({ weeklyContext: { status: "EVALUATED", ruleSet: RULE_SET, items: [...items].reverse() } });
    expect(forward).toBe(reversed);
  });
});

describe("R11-B1: evaluateSessionConfirmation", () => {
  const findings = [confirmFinding(), confirmFinding({ code: "PLAUSIBILITY_REQUIRE_CONFIRMATION", scope: "ITEM" })];
  const evaluation = evaluationInput({ findings });
  const challenge = buildConfirmationChallenge({
    menuTemplateId: BASE.menuTemplateId,
    sessionDate: BASE.sessionDate,
    sourceMenuFingerprint: evaluation.sourceMenuFingerprint,
    evaluationDigest: buildSessionConfirmationEvaluationDigest(evaluation),
    findings,
  });
  const call = (submitted: { confirmedFindingCodes: string[]; confirmationChallenge: string | null }) =>
    evaluateSessionConfirmation({
      menuTemplateId: BASE.menuTemplateId,
      sessionDate: BASE.sessionDate,
      evaluation,
      confirmationFindings: findings,
      submitted,
    });

  it("確認対象が無ければ NOT_REQUIRED", () => {
    expect(
      evaluateSessionConfirmation({
        menuTemplateId: BASE.menuTemplateId,
        sessionDate: BASE.sessionDate,
        evaluation: evaluationInput({ findings: [] }),
        confirmationFindings: [confirmFinding({ severity: "REQUIRE_COACH_REVIEW" })],
        submitted: { confirmedFindingCodes: [], confirmationChallenge: null },
      }),
    ).toEqual({ status: "NOT_REQUIRED" });
  });

  it("不足は CONFIRMATION_REQUIRED、過剰は CONFIRMATION_STATE_STALE、重複入力は dedupe", () => {
    expect(call({ confirmedFindingCodes: [], confirmationChallenge: null }).status).toBe("CONFIRMATION_REQUIRED");
    expect(call({ confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM"], confirmationChallenge: challenge }).status).toBe("CONFIRMATION_REQUIRED");
    expect(
      call({ confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION", "OLD_CODE"], confirmationChallenge: challenge }).status,
    ).toBe("CONFIRMATION_STATE_STALE");
    const dedup = call({
      confirmedFindingCodes: ["AGG_TOTAL_RUNNING_CONFIRM", "AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION"],
      confirmationChallenge: challenge,
    });
    expect(dedup).toEqual({ status: "CONFIRMED", confirmedCodes: ["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION"] });
  });

  it("code が揃っていても challenge 無し / 不一致は作成させない", () => {
    const codes = ["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION"];
    expect(call({ confirmedFindingCodes: codes, confirmationChallenge: null }).status).toBe("CONFIRMATION_REQUIRED");
    expect(call({ confirmedFindingCodes: codes, confirmationChallenge: "0".repeat(64) }).status).toBe("CONFIRMATION_STATE_STALE");
  });

  it("要求の内容は現在の評価から作る（確認が必要な Finding と challenge を返す）", () => {
    const outcome = call({ confirmedFindingCodes: [], confirmationChallenge: null });
    if (outcome.status !== "CONFIRMATION_REQUIRED") throw new Error("unreachable");
    expect(outcome.requirement.requiredFindingCodes).toEqual(["AGG_TOTAL_RUNNING_CONFIRM", "PLAUSIBILITY_REQUIRE_CONFIRMATION"]);
    expect(outcome.requirement.findings).toEqual(confirmationFindingsOf(findings));
    expect(outcome.requirement.challenge).toBe(challenge);
  });
});
