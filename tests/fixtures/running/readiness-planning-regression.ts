import { createHash } from "node:crypto";
import { planRunningPrescription } from "@/domain/running/planning";
import { resolveReadinessAction } from "@/domain/running/readiness";
import { isoDateTimeSchema } from "@/domain/running/types/primitives";
import { readinessReport, readinessContext } from "./readiness-execution";
import { makeRequest, COACH } from "../../repository/running/fixtures";

/** Full PlanResult golden, including findings/rationale/doses/substitutes/override behavior. */
export function readinessPlanningRegressionDigest() {
  const reports = [null, readinessReport(), readinessReport({ soreness: 4 }), readinessReport({ fatigue: 4 }),
    readinessReport({ performanceStatus: "DOWN" }), readinessReport({ pain: { status: "PRESENT", regions: [], redFlags: [] } }),
    readinessReport({ pain: { status: "PRESENT", regions: [], redFlags: [] }, performanceStatus: "DOWN" }),
    readinessReport({ pain: { status: "NOT_ASKED", regions: [], redFlags: [] } }),
    readinessReport({ pain: { status: "PRESENT", regions: [], redFlags: ["SWELLING"] } }),
    readinessReport({ pain: { status: "PRESENT", regions: [], redFlags: ["SUDDEN_SHARP_PAIN"] } }),
  ];
  const selections = [["STRIDE", "ST_RELAXED"], ["TEMPO_EXTENSIVE", "TE_200"], ["TEMPO_INTENSIVE", "TI_VITTORI_SE"],
    ["ACCELERATION", "ACC_BLOCK_20"], ["MAX_VELOCITY", "MV_FLY20"], ["SPRINT_ENDURANCE_SHORT", "SES_100"]] as const;
  const results = [];
  for (const [method, templateId] of selections) for (const report of reports) for (const override of [false, true]) {
    const request = makeRequest(method, templateId);
    request.planningDate = readinessContext().planningDate;
    request.readiness = report === null ? null : resolveReadinessAction(report, readinessContext({ method, ageBand: "U15" }));
    request.overrides = override ? [{ target: { kind: "READINESS", action: "CANCEL_HIGH_INTENSITY" },
      reason: "コーチ判断で本日の例外として実施する", confirmedTwice: false, actor: COACH,
      at: isoDateTimeSchema.parse("2026-09-20T09:00:00+09:00") }] : [];
    results.push(planRunningPrescription(request));
  }
  return { count: results.length, sha256: createHash("sha256").update(JSON.stringify(results)).digest("hex") };
}
