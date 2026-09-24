/**
 * R9 — RUNNING_V2 MenuItem の保存・読込（§15.2・§16.3・§19.2）と T-RV-02。
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/infra/db/prisma";
import { menuItemInputSchema } from "@/domain/menu/schema";
import { addMenuItem } from "@/infra/repositories/menu-repository";
import {
  RunningPersistenceError,
  createRunningMenuItem,
  findMenuRunningContext,
  findRunningMenuItem,
  saveMenuRunningContext,
  updateRunningMenuItem,
} from "@/infra/repositories/running-item-repository";
import {
  ACTUAL_REP_LOG_JSON_MAX_BYTES,
  PRESCRIPTION_JSON_MAX_BYTES,
  PROVENANCE_JSON_MAX_BYTES,
  actualRepLogJsonByteLimitIssue,
  utf8ByteLength,
} from "@/domain/running/persistence/limits";
import { collectPrescriptionEvidenceIds, provenanceSchema } from "@/domain/running/persistence/provenance";
import {
  buildRunningMenuItemRecord,
  projectRunningPrescription,
  validateRunningMenuItemRecord,
} from "@/domain/running/persistence/runningItem";
import { runningPrescriptionSchema, type RunningPrescriptionValue } from "@/domain/running/types/prescription";
import { resetDb } from "../../helpers";
import {
  makeMenuWithBlock,
  padJsonToBytes,
  persistInputFor,
  planAcc,
  planAssisted,
  planEa,
  planLsrIncomplete,
  planMvFly20,
  planSes,
  planStride,
  planTi,
  provenanceFor,
} from "./fixtures";

function expectPersistenceError(fn: () => unknown, pattern: RegExp) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RunningPersistenceError);
    expect((e as RunningPersistenceError).issues.join("\n")).toMatch(pattern);
    return;
  }
  throw new Error("RunningPersistenceError が投げられませんでした");
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RunningPersistenceError);
  expect((error as RunningPersistenceError).issues.join("\n")).toMatch(pattern);
  expect(await prisma.menuItem.count()).toBe(0);
}

const clone = (p: RunningPrescriptionValue) => structuredClone(p);

describe("RUNNING_V2 MenuItem: 保存と読込", () => {
  beforeEach(resetDb);

  it("完成済みの処方を保存し、列へ投影する。JSON と rationale は入力文字列のまま保存する", async () => {
    const p = planAcc();
    const { block } = await makeMenuWithBlock();
    // 保存する文字列は parse → stringify したものではなく「入力そのもの」（整形済みでも変えない）
    const input = persistInputFor(p, { prescriptionJson: JSON.stringify(p, null, 2), note: "スタート姿勢を毎本確認" });

    const saved = await createRunningMenuItem(block.id, input);

    expect(saved.prescriptionJson).toBe(input.prescriptionJson);
    expect(saved.provenanceJson).toBe(input.provenanceJson);
    expect(saved.rationale).toBe(input.rationale);
    expect(saved).toMatchObject({
      prescriptionKind: "RUNNING_V2",
      exerciseId: null,
      sets: 1,
      reps: 5,
      distanceMeters: 30,
      durationSeconds: null,
      restSeconds: 300,
      intensityPercent: null,
      loadKg: null,
      note: "スタート姿勢を毎本確認",
      runningMethod: "ACCELERATION",
      sessionTemplateId: "ACC_BLOCK_30",
      recoveryStructure: null,
      buildUpDistanceMeters: null,
      flyZoneDistanceMeters: null,
      setRestSeconds: null,
      intraRepRestSeconds: null,
      intensityReferenceKind: "MAX_INTENT",
      prescriptionConfidence: p.confidence.prescription,
      ruleSetVersion: p.ruleSet.version,
      ruleSetContentHash: p.ruleSet.contentHash,
    });
    // note はコーチの自由記述だけ（rationale を書き込まない）
    expect(saved.note).not.toContain(input.rationale.slice(0, 10));
    expect(saved.displayName).toBe("ブロックスタート30m（30m・1セット×5本）");

    const read = await findRunningMenuItem(saved.id);
    expect(read?.status).toBe("VALID");
    if (read?.status !== "VALID") throw new Error("unreachable");
    expect(read.prescription).toEqual(runningPrescriptionSchema.parse(p));
    expect(read.item.prescriptionJson).toBe(input.prescriptionJson);
  });

  it("displayName は template の日本語ラベル + 主要値で、enum キーを出さない", () => {
    for (const p of [planAcc(), planMvFly20(), planSes(), planTi(), planStride(), planEa(), planLsrIncomplete(), planAssisted()]) {
      const { displayName } = projectRunningPrescription(p);
      expect(displayName, p.templateId).not.toMatch(/[A-Z]{2,}_[A-Z0-9_]+/);
      expect(displayName).not.toContain(p.templateId);
      expect(displayName).not.toContain(p.method);
    }
  });

  it("legacy projection: FLY は build-up + fly（減速は足さない）、DURATION は距離 null・時間あり", () => {
    const mv = planMvFly20();
    if (mv.rep.kind !== "FLY") throw new Error("fixture");
    const mvCols = projectRunningPrescription(mv);
    expect(mv.rep.decelerationDistanceM).toBeGreaterThan(0);
    expect(mvCols.distanceMeters).toBe(mv.rep.buildUpDistanceM.value + mv.rep.flyZoneDistanceM.value);
    expect(mvCols.buildUpDistanceMeters).toBe(mv.rep.buildUpDistanceM.value);
    expect(mvCols.flyZoneDistanceMeters).toBe(mv.rep.flyZoneDistanceM.value);
    expect(mvCols.durationSeconds).toBeNull();

    const ses = planSes();
    if (ses.rep.kind !== "DURATION") throw new Error("fixture");
    const sesCols = projectRunningPrescription(ses);
    expect(sesCols.distanceMeters).toBeNull();
    expect(sesCols.durationSeconds).toBe(ses.rep.durationS.value);
  });

  it("legacy projection: SPLIT は区間合計、ATTEMPTS は助走距離か null、set/intra rest は構造化列へ", () => {
    const lsr = planLsrIncomplete();
    if (lsr.rep.kind !== "SPLIT") throw new Error("fixture");
    const lsrCols = projectRunningPrescription(lsr);
    expect(lsrCols.distanceMeters).toBe(400);
    expect(lsrCols.recoveryStructure).toBe("INCOMPLETE");
    expect(lsrCols.intraRepRestSeconds).toBe(lsr.rest.intraRepRestS?.value ?? null);
    expect(lsrCols.restSeconds).toBe(lsr.rest.repRestS.value);

    const ea = planEa();
    const withoutApproach = clone(ea);
    if (withoutApproach.rep.kind !== "ATTEMPTS") throw new Error("fixture");
    withoutApproach.rep.approachDistanceM = null; // historical projection remains nullable
    expect(projectRunningPrescription(withoutApproach).distanceMeters).toBeNull();
    const withApproach = clone(withoutApproach);
    if (withApproach.rep.kind !== "ATTEMPTS") throw new Error("fixture");
    withApproach.rep.approachDistanceM = { value: 35, unit: "m", source: "COACH_ENTERED" };
    expect(projectRunningPrescription(withApproach).distanceMeters).toBe(35);

    const ti = planTi();
    expect(projectRunningPrescription(ti).setRestSeconds).toBe(ti.rest.setRestS?.value);
    expect(ti.rest.setRestS).not.toBeNull();
  });

  it("intensityPercent: 数値%目標があるときだけ区間中央値を整数化。秒の目標・MAX_INTENT・RELAXED_SUBMAX は null", () => {
    const as = planAssisted();
    expect(as.intensity.target?.unit).toBe("percent");
    expect(projectRunningPrescription(as).intensityPercent).toBe(103);
    const widened = clone(as);
    widened.intensity.target = { lower: 100, upper: 103, unit: "percent", source: "COACH_ENTERED", confidence: "HIGH" };
    expect(projectRunningPrescription(runningPrescriptionSchema.parse(widened)).intensityPercent).toBe(102);

    const ti = planTi();
    expect(ti.intensity.target?.unit).toBe("s");
    expect(projectRunningPrescription(ti).intensityPercent).toBeNull();
    expect(planAcc().intensity.reference.kind).toBe("MAX_INTENT");
    expect(projectRunningPrescription(planAcc()).intensityPercent).toBeNull();
    expect(planStride().intensity.reference.kind).toBe("RELAXED_SUBMAX");
    expect(projectRunningPrescription(planStride()).intensityPercent).toBeNull();
  });

  it("updateRunningMenuItem は RUNNING_V2 項目を新しい処方で置き換える（provenance は入力のまま）", async () => {
    const { block } = await makeMenuWithBlock();
    const saved = await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    const next = planStride();
    const input = persistInputFor(next);
    const updated = await updateRunningMenuItem(saved.id, input);
    expect(updated).toMatchObject({ runningMethod: "STRIDE", sessionTemplateId: "ST_RELAXED", provenanceJson: input.provenanceJson, sortOrder: saved.sortOrder });
  });

  it("保存済みの値が壊れていても読込は例外にしない（INVALID を返す）", async () => {
    const { block } = await makeMenuWithBlock();
    const saved = await createRunningMenuItem(block.id, persistInputFor(planAcc()));
    await prisma.menuItem.update({ where: { id: saved.id }, data: { prescriptionJson: "{broken" } });
    const read = await findRunningMenuItem(saved.id);
    expect(read?.status).toBe("INVALID");
  });
});

describe("RUNNING_V2 MenuItem: 書込み前の拒否（§19.2）", () => {
  beforeEach(resetDb);

  it("exerciseId が非 null なら拒否", () => {
    const { record } = buildRunningMenuItemRecord(persistInputFor(planAcc()));
    expectPersistenceError(() => validateRunningMenuItemRecord({ ...record, exerciseId: "ex-1" }), /exerciseId/);
  });

  it.each(["runningMethod", "sessionTemplateId", "ruleSetVersion", "ruleSetContentHash", "prescriptionJson", "provenanceJson", "rationale", "sets", "reps"])(
    "必須列 %s が null なら拒否",
    (column) => {
      const { record } = buildRunningMenuItemRecord(persistInputFor(planAcc()));
      expectPersistenceError(() => validateRunningMenuItemRecord({ ...record, [column]: null }), new RegExp(`${column} は RUNNING_V2 で必須`));
    },
  );

  it("prescriptionJson が JSON として読めない / schema に合わないなら拒否（DB に書かない）", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: "{not json" })), /JSON_SYNTAX_ERROR/);
    const noSets = JSON.parse(JSON.stringify(p));
    delete noSets.sets;
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: JSON.stringify(noSets) })), /SCHEMA_INVALID/);
  });

  it("provenanceJson が JSON として読めない / strict schema に合わないなら拒否", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: "[" })), /provenanceJson JSON_SYNTAX_ERROR/);
    const extraKey = { ...provenanceFor(p), note: "unknown key" };
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify(extraKey) })), /provenanceJson SCHEMA_INVALID/);
    const noEngine = { ...provenanceFor(p) } as Record<string, unknown>;
    delete noEngine.engineVersion;
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify(noEngine) })), /provenanceJson SCHEMA_INVALID/);
  });

  it("prescriptionJson: 32KB = 32 * 1024 bytes ちょうどは保存でき、1 byte 超えると拒否（ASCII）", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    const exact = padJsonToBytes(JSON.stringify(p), PRESCRIPTION_JSON_MAX_BYTES);
    expect(PRESCRIPTION_JSON_MAX_BYTES).toBe(32768);
    const saved = await createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: exact }));
    expect(saved.prescriptionJson).toBe(exact);
    await prisma.menuItem.deleteMany();
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: `${exact} ` })), /prescriptionJson: UTF-8 で 32769 bytes/);
  });

  it("prescriptionJson: 日本語（1文字 3 bytes）は文字数ではなく UTF-8 バイト数で上限判定する", async () => {
    const { block } = await makeMenuWithBlock();
    const p = clone(planAcc());
    p.rationale.push({ code: "PADDING_FOR_TEST", params: { text: "あ".repeat(8500) } });
    const exact = padJsonToBytes(JSON.stringify(p), PRESCRIPTION_JSON_MAX_BYTES);
    expect(utf8ByteLength(exact)).toBe(PRESCRIPTION_JSON_MAX_BYTES);
    await createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: exact }));
    await prisma.menuItem.deleteMany();

    const over = `${exact} `;
    // 文字列の length（UTF-16）では上限の半分程度しかないが、バイト数では超えている
    expect(over.length).toBeLessThan(PRESCRIPTION_JSON_MAX_BYTES);
    expect(utf8ByteLength(over)).toBe(PRESCRIPTION_JSON_MAX_BYTES + 1);
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { prescriptionJson: over })), /prescriptionJson: UTF-8 で 32769 bytes/);
  });

  it("provenanceJson: 16KB ちょうどは保存でき、超えると拒否（ASCII と日本語）", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    expect(PROVENANCE_JSON_MAX_BYTES).toBe(16384);
    const ascii = padJsonToBytes(JSON.stringify(provenanceFor(p)), PROVENANCE_JSON_MAX_BYTES);
    await createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: ascii }));
    await prisma.menuItem.deleteMany();
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: `${ascii} ` })), /provenanceJson: UTF-8 で 16385 bytes/);

    const reason = "コーチ判断で本日の例外として実施する".padEnd(1000, "。");
    const overrides = Array.from({ length: 4 }, () => ({
      at: "2026-09-15T09:00:00+09:00",
      target: { kind: "READINESS", action: "CANCEL_HIGH_INTENSITY" },
      reason,
    }));
    const japanese = padJsonToBytes(JSON.stringify(provenanceFor(p, { overrides: overrides as never })), PROVENANCE_JSON_MAX_BYTES);
    expect(utf8ByteLength(japanese)).toBe(PROVENANCE_JSON_MAX_BYTES);
    await createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: japanese }));
    await prisma.menuItem.deleteMany();
    const over = `${japanese} `;
    expect(over.length).toBeLessThan(PROVENANCE_JSON_MAX_BYTES);
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: over })), /provenanceJson: UTF-8 で 16385 bytes/);
  });

  it("rationale: 4000 文字（code point）までは保存でき、4001 文字は拒否。空も拒否", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    // サロゲートペア（UTF-16 で 2 unit）でも 1 文字として数える
    const surrogate = "𠮷".repeat(4000);
    expect(surrogate.length).toBe(8000);
    await createRunningMenuItem(block.id, persistInputFor(p, { rationale: surrogate }));
    await createRunningMenuItem(block.id, persistInputFor(p, { rationale: "あ".repeat(4000) }));
    await prisma.menuItem.deleteMany();
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { rationale: "あ".repeat(4001) })), /rationale は 4000 文字以内/);
    await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { rationale: "   " })), /rationale は空にできません/);
  });

  it("構造化列 / legacy 列が prescriptionJson と一致しない入力は保存しない", () => {
    const { record } = buildRunningMenuItemRecord(persistInputFor(planAcc()));
    const mismatches: Record<string, unknown> = {
      runningMethod: "STRIDE",
      sessionTemplateId: "ACC_BLOCK_20",
      ruleSetVersion: "rs-2099.01.0",
      ruleSetContentHash: "0".repeat(64),
      prescriptionConfidence: "HIGH",
      intensityReferenceKind: "MEASURED_VMAX",
      sets: 2,
      reps: 6,
      distanceMeters: 40,
      restSeconds: 200,
      buildUpDistanceMeters: 30,
      intensityPercent: 95,
      recoveryStructure: "FULL",
    };
    for (const [column, value] of Object.entries(mismatches)) {
      expectPersistenceError(() => validateRunningMenuItemRecord({ ...record, [column]: value }), new RegExp(`${column} が prescriptionJson から導出される値と一致しません`));
    }
    expectPersistenceError(() => validateRunningMenuItemRecord({ ...record, loadKg: 20 }), /loadKg/);
    expectPersistenceError(() => validateRunningMenuItemRecord({ ...record, restSeconds: 300.5 }), /restSeconds は整数/);
    expectPersistenceError(() => validateRunningMenuItemRecord({ ...record, prescriptionKind: "LEGACY" }), /prescriptionKind/);
  });

  it("provenance の ruleSet / confidence / evidenceIds が処方と一致しなければ拒否（§19.2・T-RV-02）", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    const base = provenanceFor(p);
    const cases: [string, object, RegExp][] = [
      ["version", { ...base, ruleSet: { ...base.ruleSet, version: "rs-2099.01.0" } }, /ruleSet.version/],
      ["hash", { ...base, ruleSet: { ...base.ruleSet, contentHash: "f".repeat(64) } }, /ruleSet.contentHash/],
      ["status", { ...base, ruleSet: { ...base.ruleSet, status: "ACTIVE" } }, /ruleSet.status/],
      ["confidence", { ...base, confidence: { ...base.confidence, prescription: "HIGH" } }, /confidence/],
      ["evidence missing", { ...base, evidenceIds: base.evidenceIds.slice(1) }, /evidenceIds/],
      ["evidence extra", { ...base, evidenceIds: [...base.evidenceIds, "EV_NOT_USED"] }, /evidenceIds/],
      ["evidence duplicate", { ...base, evidenceIds: [...base.evidenceIds, base.evidenceIds[0]] }, /evidenceIds/],
    ];
    expect(base.evidenceIds.length).toBeGreaterThan(0);
    for (const [label, provenance, pattern] of cases) {
      await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify(provenance) })), pattern).catch((e) => {
        throw new Error(`${label}: ${e}`);
      });
    }
  });

  it("provenance に健康情報のキーがあれば拒否（どの階層でも）", async () => {
    const { block } = await makeMenuWithBlock();
    const p = planAcc();
    const base = provenanceFor(p);
    const withHealth: object[] = [
      { ...base, inputsDigest: { ...base.inputsDigest, pain: { status: "PRESENT" } } },
      { ...base, inputsDigest: { ...base.inputsDigest, painRegion: "KNEE" } },
      { ...base, redFlag: ["LIMPING"] },
      { ...base, inputsDigest: { ...base.inputsDigest, soreness: 4 } },
      { ...base, inputsDigest: { ...base.inputsDigest, fatigue: 4 } },
      { ...base, inputsDigest: { ...base.inputsDigest, sleepQuality: 2 } },
      { ...base, inputsDigest: { ...base.inputsDigest, birthDate: "2012-01-01" } },
      { ...base, inputsDigest: { ...base.inputsDigest, sexForNorms: "FEMALE" } },
      { ...base, generatedBy: { ...base.generatedBy, proposer: { kind: "ENGINE", athleteReport: { painNow: true } } } },
      { ...base, readinessReport: { reporter: "PARENT" } },
    ];
    for (const provenance of withHealth) {
      await expectRejected(createRunningMenuItem(block.id, persistInputFor(p, { provenanceJson: JSON.stringify(provenance) })), /HEALTH_DATA_PRESENT/);
    }
    // readinessActions（enum）は保存してよい
    const actions = { ...base, inputsDigest: { ...base.inputsDigest, readinessActions: ["USE_LOWER_BOUND", "INCREASE_REST"] } };
    expect(provenanceSchema.safeParse(actions).success).toBe(true);
  });

  it("LEGACY の経路には影響しない（既定 LEGACY・v2 列 null・RUNNING_V2 API で上書きできない）", async () => {
    const { block } = await makeMenuWithBlock();
    const legacy = await addMenuItem(block.id, menuItemInputSchema.parse({ displayName: "流し（旧）", sets: "3", distanceMeters: "100" }));
    expect(legacy).toMatchObject({
      prescriptionKind: "LEGACY",
      runningMethod: null,
      sessionTemplateId: null,
      ruleSetVersion: null,
      prescriptionJson: null,
      provenanceJson: null,
      rationale: null,
      sets: 3,
      distanceMeters: 100,
    });
    expect(await findRunningMenuItem(legacy.id)).toBeNull();
    const error = await updateRunningMenuItem(legacy.id, persistInputFor(planStride())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunningPersistenceError);
    expect(await prisma.menuItem.findUnique({ where: { id: legacy.id } })).toMatchObject({ prescriptionKind: "LEGACY", prescriptionJson: null });
  });

  it("actualRepLogJson の上限検査 primitive（64KB = 64 * 1024 bytes）", () => {
    expect(ACTUAL_REP_LOG_JSON_MAX_BYTES).toBe(65536);
    const exact = padJsonToBytes(JSON.stringify([{ note: "あ".repeat(1000) }]), ACTUAL_REP_LOG_JSON_MAX_BYTES);
    expect(actualRepLogJsonByteLimitIssue(exact)).toBeNull();
    expect(actualRepLogJsonByteLimitIssue(`${exact} `)).toMatch(/65537 bytes/);
  });
});

describe("T-RV-02: plan → 保存 → 読込で ruleSetVersion・contentHash・evidenceIds が provenance と列に一致", () => {
  beforeEach(resetDb);

  it("MenuItem 列 / Provenance.ruleSet / 処方の ruleSet が一致し、evidenceIds は provenance と計画結果で一致する", async () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "src/domain/running/rules/manifest.json"), "utf8")) as { version: string; contentHash: string }[];
    const { block } = await makeMenuWithBlock();
    for (const p of [planAcc(), planMvFly20(), planTi()]) {
      const saved = await createRunningMenuItem(block.id, persistInputFor(p));
      const read = await findRunningMenuItem(saved.id);
      if (read?.status !== "VALID") throw new Error("expected VALID");
      const { item, prescription, provenance } = read;

      expect(item.ruleSetVersion).toBe(prescription.ruleSet.version);
      expect(item.ruleSetVersion).toBe(provenance.ruleSet.version);
      expect(item.ruleSetContentHash).toBe(prescription.ruleSet.contentHash);
      expect(item.ruleSetContentHash).toBe(provenance.ruleSet.contentHash);
      expect(provenance.ruleSet).toEqual(p.ruleSet);
      // plan 時点の manifest（検証済み）の hash と一致
      expect(manifest.find((e) => e.version === item.ruleSetVersion)?.contentHash).toBe(item.ruleSetContentHash);

      const planned = collectPrescriptionEvidenceIds(p);
      expect(planned.length).toBeGreaterThan(0);
      expect([...provenance.evidenceIds].sort()).toEqual(planned);
      expect(collectPrescriptionEvidenceIds(prescription)).toEqual(planned);
      expect(provenance.confidence).toEqual(p.confidence);
      expect(provenance.generatedBy).toEqual(p.generatedBy);
    }
  });
});

describe("RunningMenuContext（MenuTemplate.runningContextJson）", () => {
  beforeEach(resetDb);

  const validContext = {
    schemaVersion: 1,
    subject: {
      kind: "GROUP",
      label: "中学男子短距離",
      members: [
        {
          ageBandOverride: "U15",
          maturity: { status: "UNKNOWN", confidence: "LOW", method: "NONE", assessedAt: null },
          trainingAge: { structuredSprintYears: 2 },
          primaryEvent: "100m",
        },
      ],
      allowAdvancedMethods: false,
    },
    plannedDate: "2026-09-20",
    plannedAt: "2026-09-20T16:00:00+09:00",
    availableMinutes: 90,
  };

  it("schema を通った入力文字列をそのまま保存し、読込で検証する", async () => {
    const { menu } = await makeMenuWithBlock();
    const raw = JSON.stringify(validContext, null, 2);
    await saveMenuRunningContext(menu.id, raw);
    expect((await prisma.menuTemplate.findUnique({ where: { id: menu.id } }))?.runningContextJson).toBe(raw);
    const read = await findMenuRunningContext(menu.id);
    expect(read).toMatchObject({ status: "VALID", raw });

    await saveMenuRunningContext(menu.id, null);
    expect(await findMenuRunningContext(menu.id)).toEqual({ status: "NONE" });
  });

  it("健康情報・個人情報（birthDate / sexForNorms / pain / soreness / fatigue / sleep / readiness 生値）を拒否する", async () => {
    const { menu } = await makeMenuWithBlock();
    const member = validContext.subject.members[0];
    const variants: object[] = [
      { ...validContext, subject: { ...validContext.subject, members: [{ ...member, birthDate: "2012-04-01" }] } },
      { ...validContext, subject: { ...validContext.subject, members: [{ ...member, sexForNorms: "MALE" }] } },
      { ...validContext, pain: { status: "PRESENT", regions: ["KNEE"], redFlags: [] } },
      { ...validContext, soreness: 3 },
      { ...validContext, fatigue: 3 },
      { ...validContext, sleepQuality: 2 },
      { ...validContext, readinessReport: { reporter: "ATHLETE" } },
    ];
    for (const v of variants) {
      const error = await saveMenuRunningContext(menu.id, JSON.stringify(v)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RunningPersistenceError);
      expect((error as RunningPersistenceError).issues.join()).toMatch(/HEALTH_DATA_PRESENT/);
    }
    expect((await prisma.menuTemplate.findUnique({ where: { id: menu.id } }))?.runningContextJson).toBeNull();
  });

  it("strict: 未知のキー・ATHLETE subject・身長履歴・plannedAt だけの指定を拒否する", async () => {
    const { menu } = await makeMenuWithBlock();
    const member = validContext.subject.members[0];
    const variants: object[] = [
      { ...validContext, phase: "PREPARATION" },
      { ...validContext, subject: { ...validContext.subject, kind: "ATHLETE" } },
      { ...validContext, subject: { ...validContext.subject, members: [{ ...member, maturity: { ...member.maturity, heightHistory: [{ date: "2026-01-01", heightCm: 150 }] } }] } },
      { ...validContext, plannedDate: null },
      { ...validContext, plannedAt: "2026-09-21T16:00:00+09:00" },
      { ...validContext, schemaVersion: 2 },
    ];
    for (const v of variants) {
      const error = await saveMenuRunningContext(menu.id, JSON.stringify(v)).catch((e: unknown) => e);
      expect(error, JSON.stringify(v).slice(0, 80)).toBeInstanceOf(RunningPersistenceError);
    }
  });
});
