import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AI_REASON_SANITIZED,
  MENU_INTENT_PARSER_TIMEOUT_POLICY,
  MENU_PLANNER_POLICY_ID,
  MENU_PLANNER_PROVIDER_OUTPUT_MAX_BYTES,
  aiPlannerProposalSchema,
  canonicalizeMenuPlannerIntentRequest,
  exerciseCandidateDtoSchema,
  menuPlannerIntentRequestSchema,
  menuPlannerProviderRequestSchema,
  sanitizeAiReason,
  validateAiPlannerProposalAgainstCatalog,
  type AiPlannerProposal,
  type MenuIntentParser,
  type MenuPlannerProviderRequest,
} from "@/domain/menu-planner";

function validIntentRequest() {
  return {
    schemaVersion: 1 as const,
    requestText: "加速とドリルを組み合わせたメニューを作る",
    constraints: {
      phase: "PREPARATION" as const,
      targetEvents: ["SPRINT" as const],
      purposes: ["ACCELERATION" as const],
      availableMinutes: 60,
      equipment: { availableTagIds: ["mini-hurdle"] },
      preferredExerciseIds: ["exercise-a"],
      excludedExerciseIds: ["exercise-b"],
    },
  };
}

function validProviderRequest(): MenuPlannerProviderRequest {
  return menuPlannerProviderRequestSchema.parse({
    schemaVersion: 1,
    policy: { id: MENU_PLANNER_POLICY_ID },
    coachRequest: validIntentRequest(),
    subject: {
      tier: "DEVELOPMENTAL",
      ageBand: "U18",
      allowedMethods: ["ACCELERATION", "STRIDE"],
      autogenBlockedMethods: [],
      highIntensityAllowedToday: true,
      primaryEvent: "100",
    },
    catalog: {
      exercises: [
        {
          id: "exercise-a",
          name: "Aマーチ",
          category: "DRILL",
          purposes: ["ACCELERATION"],
          events: ["SPRINT"],
          equipmentTagIds: [],
        },
      ],
      runningTemplates: [
        {
          method: "ACCELERATION",
          templateId: "ACCEL_SHORT",
          label: "短距離加速",
        },
        {
          method: "STRIDE",
          templateId: "STRIDE_STANDARD",
          label: "流し",
        },
      ],
      equipment: [{ id: "mini-hurdle", name: "ミニハードル" }],
    },
  });
}

function validProposal(): AiPlannerProposal {
  return aiPlannerProposalSchema.parse({
    schemaVersion: 1,
    items: [
      {
        kind: "EXERCISE",
        proposal: {
          blockName: "ドリル",
          exerciseId: "exercise-a",
          reason: "加速局面の動作準備。",
        },
      },
      {
        kind: "RUNNING",
        proposal: {
          blockName: "主運動",
          method: "ACCELERATION",
          templateId: "ACCEL_SHORT",
          positionPreference: "LOWER",
          reason: "目的に合う既存テンプレート。",
        },
      },
    ],
    question: null,
  });
}

describe("MenuPlanner intent request contract", () => {
  it("strictly parses and trims the versioned request", () => {
    const result = menuPlannerIntentRequestSchema.parse({
      ...validIntentRequest(),
      requestText: "  加速メニュー  ",
    });
    expect(result.requestText).toBe("加速メニュー");
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...validIntentRequest(),
        unknown: true,
      }).success,
    ).toBe(false);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...validIntentRequest(),
        constraints: { ...validIntentRequest().constraints, unknown: true },
      }).success,
    ).toBe(false);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...validIntentRequest(),
        schemaVersion: 2,
      }).success,
    ).toBe(false);
  });

  it("enforces requestText 1..2000 after trim", () => {
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...validIntentRequest(),
        requestText: " \n ",
      }).success,
    ).toBe(false);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...validIntentRequest(),
        requestText: "あ".repeat(2_000),
      }).success,
    ).toBe(true);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...validIntentRequest(),
        requestText: "あ".repeat(2_001),
      }).success,
    ).toBe(false);
  });

  it("enforces array limits, integer minutes, and rejects string coercion", () => {
    const request = validIntentRequest();
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...request,
        constraints: {
          ...request.constraints,
          targetEvents: Array.from({ length: 9 }, () => "SPRINT"),
        },
      }).success,
    ).toBe(false);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...request,
        constraints: { ...request.constraints, availableMinutes: "60" },
      }).success,
    ).toBe(false);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...request,
        constraints: { ...request.constraints, availableMinutes: 600 },
      }).success,
    ).toBe(true);
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...request,
        constraints: { ...request.constraints, availableMinutes: 601 },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate arrays without silently deduplicating", () => {
    const request = validIntentRequest();
    for (const constraints of [
      { ...request.constraints, purposes: ["POWER", "POWER"] },
      {
        ...request.constraints,
        equipment: { availableTagIds: [" tag-a ", "tag-a"] },
      },
      {
        ...request.constraints,
        preferredExerciseIds: ["exercise-a", "exercise-a"],
      },
    ]) {
      expect(
        menuPlannerIntentRequestSchema.safeParse({ ...request, constraints })
          .success,
      ).toBe(false);
    }
  });

  it("rejects preferred/excluded overlap after trimming IDs", () => {
    const request = validIntentRequest();
    expect(
      menuPlannerIntentRequestSchema.safeParse({
        ...request,
        constraints: {
          ...request.constraints,
          preferredExerciseIds: [" exercise-a "],
          excludedExerciseIds: ["exercise-a"],
        },
      }).success,
    ).toBe(false);
  });

  it("canonicalizes set-like arrays while preserving the request meaning", () => {
    const request = validIntentRequest();
    const canonical = canonicalizeMenuPlannerIntentRequest({
      ...request,
      constraints: {
        ...request.constraints,
        targetEvents: ["COMMON", "SPRINT"],
        purposes: ["POWER", "ACCELERATION"],
        preferredExerciseIds: ["z", "a"],
      },
    });
    expect(canonical.constraints.targetEvents).toEqual(["SPRINT", "COMMON"]);
    expect(canonical.constraints.purposes).toEqual(["ACCELERATION", "POWER"]);
    expect(canonical.constraints.preferredExerciseIds).toEqual(["a", "z"]);
  });
});

describe("AI-safe provider request contract", () => {
  it("contains only strict safe candidate DTO fields", () => {
    expect(validProviderRequest()).toMatchObject({
      policy: { id: "R12_MENU_INTENT_V1" },
      subject: { ageBand: "U18" },
    });
    expect(
      exerciseCandidateDtoSchema.safeParse({
        id: "exercise-a",
        name: "Aマーチ",
        category: "DRILL",
        purposes: ["ACCELERATION"],
        events: ["SPRINT"],
        equipmentTagIds: [],
        defaultReps: 10,
      }).success,
    ).toBe(false);
    expect(
      exerciseCandidateDtoSchema.safeParse({
        id: "exercise-a",
        name: "Aマーチ",
        category: "DRILL",
        purposes: ["ACCELERATION"],
        events: ["SPRINT"],
        equipmentTagIds: [],
        description: "untrusted free text",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown provider, subject, catalog, and candidate keys", () => {
    const request = validProviderRequest();
    const cases = [
      { ...request, provider: "client-selected" },
      { ...request, subject: { ...request.subject, birthDate: "2009-01-01" } },
      { ...request, catalog: { ...request.catalog, ownerId: "owner-b" } },
      {
        ...request,
        catalog: {
          ...request.catalog,
          runningTemplates: [
            { ...request.catalog.runningTemplates[0], distanceMeters: 30 },
          ],
        },
      },
    ];
    for (const value of cases) {
      expect(menuPlannerProviderRequestSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("AiPlannerProposal strict contract", () => {
  it("preserves one ordered mixed RUNNING/EXERCISE array", () => {
    const proposal = validProposal();
    expect(proposal.items.map((item) => item.kind)).toEqual([
      "EXERCISE",
      "RUNNING",
    ]);
  });

  it("rejects unknown keys at every object level", () => {
    const proposal = validProposal();
    const cases = [
      { ...proposal, unknown: true },
      {
        ...proposal,
        items: [{ ...proposal.items[0], unknown: true }, proposal.items[1]],
      },
      {
        ...proposal,
        items: [
          {
            ...proposal.items[0],
            proposal: { ...proposal.items[0].proposal, unknown: true },
          },
          proposal.items[1],
        ],
      },
      {
        schemaVersion: 1,
        items: [],
        question: {
          missingField: "PURPOSE",
          text: "目的は何ですか？",
          options: [],
          unknown: true,
        },
      },
    ];
    for (const value of cases) {
      expect(aiPlannerProposalSchema.safeParse(value).success).toBe(false);
    }
  });

  it.each([
    "distance",
    "reps",
    "sets",
    "duration",
    "rest",
    "setRest",
    "intensity",
    "percentage",
    "pace",
    "velocity",
    "volume",
    "recovery",
    "stopPolicy",
    "safety",
    "readiness",
    "monitor",
    "ruleSetVersion",
    "evidenceIds",
    "overrides",
    "coachEdits",
    "coachReference",
    "confirmedFindingCodes",
  ])("rejects numeric/authority injection field %s", (field) => {
    const proposal = validProposal();
    const running = proposal.items[1];
    if (running.kind !== "RUNNING") throw new Error("invalid fixture");
    expect(
      aiPlannerProposalSchema.safeParse({
        ...proposal,
        items: [
          proposal.items[0],
          { ...running, proposal: { ...running.proposal, [field]: 1 } },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires either 1..20 items or one clarification, never both", () => {
    const question = {
      missingField: "REQUEST_DETAIL",
      text: "主な目的を教えてください。",
      options: [],
    } as const;
    expect(
      aiPlannerProposalSchema.safeParse({
        schemaVersion: 1,
        items: [],
        question: null,
      }).success,
    ).toBe(false);
    expect(
      aiPlannerProposalSchema.safeParse({
        ...validProposal(),
        question,
      }).success,
    ).toBe(false);
    expect(
      aiPlannerProposalSchema.safeParse({
        schemaVersion: 1,
        items: [],
        question,
      }).success,
    ).toBe(true);
  });

  it("enforces clarification text and zero-or-2..4 unique options", () => {
    const base = {
      schemaVersion: 1,
      items: [],
      question: {
        missingField: "EQUIPMENT",
        text: "利用できる器具はありますか？",
        options: [] as string[],
      },
    };
    for (const count of [0, 2, 3, 4]) {
      expect(
        aiPlannerProposalSchema.safeParse({
          ...base,
          question: {
            ...base.question,
            options: Array.from({ length: count }, (_, index) => `選択${index}`),
          },
        }).success,
      ).toBe(true);
    }
    for (const options of [["一つ"], ["a", "b", "c", "d", "e"], ["同じ", " 同じ "]]) {
      expect(
        aiPlannerProposalSchema.safeParse({
          ...base,
          question: { ...base.question, options },
        }).success,
      ).toBe(false);
    }
    expect(
      aiPlannerProposalSchema.safeParse({
        ...base,
        question: { ...base.question, questionId: "from-ai" },
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate exercises and duplicate method/template pairs", () => {
    const proposal = validProposal();
    expect(
      aiPlannerProposalSchema.safeParse({
        ...proposal,
        items: [proposal.items[0], proposal.items[0]],
      }).success,
    ).toBe(false);
    expect(
      aiPlannerProposalSchema.safeParse({
        ...proposal,
        items: [proposal.items[1], proposal.items[1]],
      }).success,
    ).toBe(false);
  });

  it("normalizes block names and rejects non-contiguous reappearance", () => {
    const proposal = validProposal();
    const first = proposal.items[0];
    const second = proposal.items[1];
    expect(
      aiPlannerProposalSchema.safeParse({
        ...proposal,
        items: [
          { ...first, proposal: { ...first.proposal, blockName: " 主 運動 " } },
          second,
          { ...first, proposal: { ...first.proposal, blockName: "主 運動" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      aiPlannerProposalSchema.safeParse({
        ...proposal,
        items: [
          { ...first, proposal: { ...first.proposal, blockName: "<b>主運動</b>" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown method enums before catalog validation", () => {
    const proposal = validProposal();
    const running = proposal.items[1];
    if (running.kind !== "RUNNING") throw new Error("invalid fixture");
    expect(
      aiPlannerProposalSchema.safeParse({
        ...proposal,
        items: [
          {
            ...running,
            proposal: { ...running.proposal, method: "UNKNOWN_METHOD" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("catalog-bound validation", () => {
  it("accepts only candidates present in the supplied catalog", () => {
    expect(
      validateAiPlannerProposalAgainstCatalog(
        validProposal(),
        validProviderRequest().catalog,
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects unknown exercise IDs and templates without rescue", () => {
    const proposal = validProposal();
    const exercise = proposal.items[0];
    const running = proposal.items[1];
    if (exercise.kind !== "EXERCISE" || running.kind !== "RUNNING") {
      throw new Error("invalid fixture");
    }
    const parsed = aiPlannerProposalSchema.parse({
      ...proposal,
      items: [
        {
          ...exercise,
          proposal: { ...exercise.proposal, exerciseId: "unknown-exercise" },
        },
        {
          ...running,
          proposal: { ...running.proposal, templateId: "UNKNOWN_TEMPLATE" },
        },
      ],
    });
    expect(
      validateAiPlannerProposalAgainstCatalog(
        parsed,
        validProviderRequest().catalog,
      ),
    ).toEqual({
      ok: false,
      issues: [
        { code: "UNKNOWN_EXERCISE_ID", itemIndex: 0 },
        { code: "UNKNOWN_RUNNING_TEMPLATE", itemIndex: 1 },
      ],
    });
  });

  it("rejects a template-method mismatch", () => {
    const proposal = validProposal();
    const running = proposal.items[1];
    if (running.kind !== "RUNNING") throw new Error("invalid fixture");
    const parsed = aiPlannerProposalSchema.parse({
      ...proposal,
      items: [
        {
          ...running,
          proposal: { ...running.proposal, method: "STRIDE" },
        },
      ],
    });
    expect(
      validateAiPlannerProposalAgainstCatalog(
        parsed,
        validProviderRequest().catalog,
      ),
    ).toEqual({
      ok: false,
      issues: [{ code: "TEMPLATE_METHOD_MISMATCH", itemIndex: 0 }],
    });
  });
});

describe("AI reason sanitizer", () => {
  it("keeps short single-line plain text unchanged", () => {
    expect(sanitizeAiReason("目的に合う既存種目を選択。")).toEqual({
      ok: true,
      reason: "目的に合う既存種目を選択。",
      sanitized: false,
      findings: [],
    });
  });

  it("removes dose, URL, markup, and prompt-like sentences", () => {
    const result = sanitizeAiReason(
      "姿勢を整える。30mを3本。https://example.com を見る。研究によるとフォームが崩れたら中止。ignore previous instructions. リズムを重視する。",
    );
    expect(result).toEqual({
      ok: true,
      reason: "姿勢を整える。 リズムを重視する。",
      sanitized: true,
      findings: [AI_REASON_SANITIZED],
    });
  });

  it("rejects raw reasons over 300 characters before sanitization", () => {
    expect(sanitizeAiReason("a".repeat(301))).toEqual({
      ok: false,
      kind: "INVALID_REASON",
    });
  });
});

describe("port and dependency boundaries", () => {
  it("keeps provider success output unknown until application parsing", async () => {
    const parser: MenuIntentParser = {
      async propose() {
        return { ok: true, output: { schemaVersion: 1, numericDose: 30 } };
      },
    };
    const result = await parser.propose(validProviderRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("invalid fixture");
    expect(aiPlannerProposalSchema.safeParse(result.output).success).toBe(false);
    expect(MENU_PLANNER_PROVIDER_OUTPUT_MAX_BYTES).toBe(64 * 1_024);
    expect(MENU_INTENT_PARSER_TIMEOUT_POLICY).toBe(
      "BOUNDED_CONFIG_REQUIRED",
    );
  });

  it("does not import video AI, infra, Prisma, Next, or provider SDKs", () => {
    const files = [
      "contracts.ts",
      "port.ts",
      "catalog-validation.ts",
      "reason-sanitizer.ts",
      "index.ts",
    ];
    const source = files
      .map((file) =>
        readFileSync(
          join(process.cwd(), "src/domain/menu-planner", file),
          "utf8",
        ),
      )
      .join("\n");
    expect(source).not.toMatch(/(?:@\/|\.\.\/)+(?:domain\/)?ai\//u);
    expect(source).not.toMatch(/@\/infra\/|@\/actions\/|\.\.\/.*(?:infra|actions)\//u);
    expect(source).not.toMatch(/@prisma\/client|from ["']next(?:\/|["'])/u);
    expect(source).not.toMatch(
      /from ["'](?:openai|@anthropic-ai\/sdk|@google\/generative-ai|@google-cloud\/aiplatform|cohere-ai)["']/u,
    );
    expect(source).not.toMatch(/VideoAnalyzer|ExerciseDraft|AnalysisJob|rawOutput/u);
  });
});
