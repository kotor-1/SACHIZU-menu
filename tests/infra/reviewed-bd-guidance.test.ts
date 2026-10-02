import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrichExerciseVideo } from "@/application/menu-composition/video-enrichment";
import { generateComposedMenu } from "@/application/menu-composition/generate";
import { exerciseVideoGuidanceSchema, type ExerciseVideoGuidance } from "@/domain/exercise/video-guidance";
import { exerciseDoseState, exercisePlanValues, type ComposerCatalogExercise, type ExercisePlanItem } from "@/domain/menu-composition/contracts";
import { suggestPrescription } from "@/domain/prescription/calculate";
import { DEFAULT_OWNER_ID } from "@/domain/shared/constants";
import { prisma } from "@/infra/db/prisma";
import { FileVideoGuidanceStore } from "@/infra/exercise/video-guidance-store";
import { listComposerCatalog } from "@/infra/menu-composition/catalog-repository";
import { composeMenuWithOpenAI } from "@/infra/menu-composition/openai-composer";
import { verifyMenuCompositionToken } from "@/infra/menu-composition/preview-token";
import { listExercisesForMenuPlanner, type ExerciseWithRelations } from "@/infra/repositories/exercise-repository";
import { catalogFixture, COMPOSITION_TEST_KEY, interpretedFixture } from "../fixtures/menu-composition";

// These are data-contract regressions, not live-model quality claims. No original
// DB or video provider is opened; the real catalog reader receives injected rows.
vi.mock("@/infra/db/prisma", () => ({ prisma: { videoAsset: { findMany: vi.fn() } } }));
vi.mock("@/infra/repositories/exercise-repository", () => ({ listExercisesForMenuPlanner: vi.fn() }));

type Decision = { exerciseId: string; sourceVideoId: string; approvedGuidance: unknown };
const decisions = JSON.parse(readFileSync(new URL("../../docs/coach-decisions/2026-10-02-bd-video-guidance.json", import.meta.url), "utf8")) as {
  B: Decision & { metricType: string; defaultDistanceMeters: { before: number; after: null } };
  D: Decision;
};
const approved = {
  B: exerciseVideoGuidanceSchema.parse(decisions.B.approvedGuidance),
  D: exerciseVideoGuidanceSchema.parse(decisions.D.approvedGuidance),
};
const names = {
  B: "片足ケンケン引きつけドリル",
  D: "両足アンクルホップ（ポゴジャンプ・接地反発ドリル）",
};

function reviewedCatalog(key: "B" | "D"): ComposerCatalogExercise {
  return catalogFixture({
    id: decisions[key].exerciseId, name: names[key], category: key === "B" ? "DRILL" : "JUMP",
    metricType: "REPS", difficulty: 3, energySystem: null,
    description: key === "B" ? "片足でホップして膝を引きつける。" : "両足で段差へ上がり、降りる。",
    coachingPoint: null, commonMistake: null,
    defaultSets: key === "B" ? 3 : null, defaultReps: null,
    defaultDistanceMeters: key === "B" ? decisions.B.defaultDistanceMeters.after : null,
    defaultDurationSeconds: null, defaultRestSeconds: key === "B" ? 60 : null,
    purposes: [], events: [], targets: ["TECHNIQUE", "COORDINATION", "POWER"], tags: [],
    videoGuidance: approved[key],
  });
}

function repositoryRow(catalog: ComposerCatalogExercise): ExerciseWithRelations {
  return {
    ...catalog, difficulty: catalog.difficulty ?? 3, nameKana: null, source: "AI_DRAFT", isFavorite: false,
    createdAt: new Date("2026-10-02T00:00:00.000Z"), updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    targets: catalog.targets.map((target) => ({ exerciseId: catalog.id, target })),
    purposes: catalog.purposes.map((purpose) => ({ exerciseId: catalog.id, purpose })),
    events: catalog.events.map((event) => ({ exerciseId: catalog.id, event })), tags: [],
  };
}

function mockedPlan(key: "B" | "D"): ExercisePlanItem {
  return {
    type: "CATALOG_EXERCISE", exerciseId: decisions[key].exerciseId, displayName: names[key],
    plannedSets: null, plannedReps: key === "B" ? 10 : null,
    plannedDurationSeconds: null, plannedDistanceMeters: null, plannedRestSeconds: null,
    executionInstruction: key === "B"
      ? "1回のホップ（離地して膝を引きつけ、同じ足で接地）を1回と数える。片側10回を終えてから反対側10回。"
      : "段差に上がって降りる1往復を1回と数える。回数の量は未設定。",
    plannedNote: key === "B" ? "片側ごとの回数。左右交互にはしない。" : "片道の跳躍ごとには数えない。",
    reason: "希望した種目をコーチ確認済みの数え方で行うため",
  };
}

let directory: string;
let store: FileVideoGuidanceStore;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("LIVE_NETWORK_FORBIDDEN"); }));
  directory = await mkdtemp(join(tmpdir(), "sachizu-reviewed-bd-test-"));
  store = new FileVideoGuidanceStore(directory);
  for (const key of ["B", "D"] as const) await store.write(DEFAULT_OWNER_ID, decisions[key].exerciseId, approved[key]);
  vi.mocked(listExercisesForMenuPlanner).mockResolvedValue([repositoryRow(reviewedCatalog("B")), repositoryRow(reviewedCatalog("D"))]);
  vi.mocked(prisma.videoAsset.findMany).mockResolvedValue(["B", "D"].map((key) => ({
    id: decisions[key as "B" | "D"].sourceVideoId, exerciseId: decisions[key as "B" | "D"].exerciseId,
  })) as Awaited<ReturnType<typeof prisma.videoAsset.findMany>>);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});

describe("Coach-defined B/D video guidance and corrected B catalog dose", () => {
  it("retains distinct reviewed definitions: B per side, D one round trip", () => {
    expect(decisions.B.metricType).toBe("REPS");
    expect(decisions.B.defaultDistanceMeters).toEqual({ before: 20, after: null });
    expect(approved.B).toMatchObject({ videoAnalysisStatus: "COACH_REVIEWED", countingUnit: "PER_SIDE", sourceVideoId: decisions.B.sourceVideoId });
    expect(approved.B.coachReviewedAt).not.toBeNull();
    expect(approved.B.typicalStructure).toContain("10");
    expect(approved.B.bilateralCounting).toContain("SEQUENTIAL_SIDES");
    expect(approved.D).toMatchObject({ videoAnalysisStatus: "COACH_REVIEWED", countingUnit: "ROUND_TRIP", sourceVideoId: decisions.D.sourceVideoId });
    expect(approved.D.coachReviewedAt).not.toBeNull();
  });

  it("does not turn corrected B defaults into the historical 20m execution value", async () => {
    const b = (await listComposerCatalog(DEFAULT_OWNER_ID, store)).find((row) => row.id === decisions.B.exerciseId)!;
    expect(b).toMatchObject({ metricType: "REPS", defaultDistanceMeters: null, defaultReps: null });
    expect(suggestPrescription(b).prescription.distanceMeters).toBeNull();
    // Coach quantity lives in reusable guidance; it is not installed as a new
    // generic prescription rule or automatically copied into Exercise defaults.
    expect(b.defaultReps).toBeNull();
    expect(b.videoGuidance).toEqual(approved.B);
  });

  it.each([
    ["B1", "B", "片足ケンケンを入れたい"],
    ["B2", "B", "片足ケンケン引きつけドリルを左右10回ずつ、片側を終えてから反対側で行いたい"],
    ["D1", "D", "アンクルホップを入れたい"],
  ] as const)("%s passes reviewed context through mocked composer, validator and plan materialization", async (_label, key, requestText) => {
    const output = { blocks: [{ name: "希望した動き", items: [mockedPlan(key)] }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
    }), { headers: { "content-type": "application/json" } }));
    const interpret = vi.fn(async () => interpretedFixture(false, requestText));
    const result = await generateComposedMenu({ requestText, context: {} }, {
      ownerId: DEFAULT_OWNER_ID, signingKey: COMPOSITION_TEST_KEY,
      catalog: () => listComposerCatalog(DEFAULT_OWNER_ID, store), interpret,
      compose: (input) => composeMenuWithOpenAI(input, { apiKey: "offline-fake-key", fetchImpl }),
    });
    expect(result.ok).toBe(true);
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const request = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    const input = JSON.parse(request.input);
    expect(input.requestText).toBe(requestText);
    expect(request.tools).toBeUndefined();
    expect(input.catalog.find((row: ComposerCatalogExercise) => row.id === decisions[key].exerciseId).videoGuidance).toEqual(approved[key]);
    expect(input.catalog.find((row: ComposerCatalogExercise) => row.id === decisions.B.exerciseId).defaultDistanceMeters).toBeNull();
    if (!result.ok) throw new Error(result.code);
    expect(result.preview.runningPrescription).toBeNull();
    const item = result.preview.composition.blocks[0].items[0];
    if (item.type === "RUNNING_POLICY") throw new Error("Unexpected Running item");
    expect(item.executionInstruction).toBe(mockedPlan(key).executionInstruction);
    expect(exercisePlanValues(item)).toMatchObject({ reps: key === "B" ? 10 : null, distanceMeters: null, durationSeconds: null });
    if (key === "D") expect(exerciseDoseState(item)).toBe("UNCONFIGURED");
    expect(verifyMenuCompositionToken(result.preview.previewToken, COMPOSITION_TEST_KEY)?.proposal).toEqual(result.preview.composition);
  });

  it.each(["B", "D"] as const)("reuses reviewed %s guidance without another video analysis at the same version", async (key) => {
    const analyze = vi.fn();
    const input = { ownerId: DEFAULT_OWNER_ID, exerciseId: decisions[key].exerciseId, sourceVideoId: decisions[key].sourceVideoId, analysisVersion: approved[key].analysisVersion };
    const result = await enrichExerciseVideo(input, {
      store, analyzer: { analyze }, findLocalVideo: async () => ({
        id: input.sourceVideoId, ownerId: input.ownerId, exerciseId: input.exerciseId, localPath: "/offline/owned-local-video.mp4",
      }),
    });
    expect(result).toEqual({ guidance: approved[key], reused: true });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("does not lend D's approval to a different Exercise sharing its media", async () => {
    const other = catalogFixture({ id: "same-media-other-exercise", name: "未確認の別種目" });
    vi.mocked(listExercisesForMenuPlanner).mockResolvedValue([repositoryRow(reviewedCatalog("D")), repositoryRow(other)]);
    vi.mocked(prisma.videoAsset.findMany).mockResolvedValue([
      { id: decisions.D.sourceVideoId, exerciseId: decisions.D.exerciseId },
      { id: "same-media-other-asset", exerciseId: other.id },
    ] as Awaited<ReturnType<typeof prisma.videoAsset.findMany>>);
    expect(other.videoUrl).toBe(reviewedCatalog("D").videoUrl);
    expect(await store.read(DEFAULT_OWNER_ID, other.id)).toBeNull();
    const catalog = await listComposerCatalog(DEFAULT_OWNER_ID, store);
    expect(catalog.find((row) => row.id === decisions.D.exerciseId)?.videoGuidance).toEqual(approved.D);
    expect(catalog.find((row) => row.id === other.id)?.videoGuidance).toBeNull();
    // Even an incorrectly copied cache entry cannot bypass source-to-Exercise binding.
    const misbound = await listComposerCatalog(DEFAULT_OWNER_ID, { read: async () => approved.D, write: async () => undefined });
    expect(misbound.find((row) => row.id === other.id)?.videoGuidance).toBeNull();
  });

  it("preserves E's partial AI analysis without promoting it during B/D reuse", async () => {
    const e = catalogFixture({ id: "exercise-e-partial", name: "音声確認待ちの種目" });
    const partial: ExerciseVideoGuidance = {
      sourceVideoId: "video-e", analysisVersion: "partial-local-audio-v1",
      analyzedAt: "2026-10-02T00:00:00.000Z", videoAnalysisStatus: "AI_ANALYZED", coachReviewedAt: null,
      executionSummary: "映像では対角の手足を上げる動作を確認。", movementPattern: "対角の手足を上げる",
      countingUnit: "CUSTOM", bilateralCounting: "UNRESOLVED", typicalStructure: "PARTIAL: 1 rep・左右の扱いは未確定。",
      equipment: [], setup: null, keyCues: [], commonErrors: [],
      doseObservations: ["SPOKEN_GUIDANCE: ローカル文字起こしの観察を保持。推奨回数へは変換しない。"],
    };
    await store.write(DEFAULT_OWNER_ID, e.id, partial);
    vi.mocked(listExercisesForMenuPlanner).mockResolvedValue([repositoryRow(reviewedCatalog("B")), repositoryRow(reviewedCatalog("D")), repositoryRow(e)]);
    vi.mocked(prisma.videoAsset.findMany).mockResolvedValue([
      ...["B", "D"].map((key) => ({ id: decisions[key as "B" | "D"].sourceVideoId, exerciseId: decisions[key as "B" | "D"].exerciseId })),
      { id: partial.sourceVideoId, exerciseId: e.id },
    ] as Awaited<ReturnType<typeof prisma.videoAsset.findMany>>);
    const catalog = await listComposerCatalog(DEFAULT_OWNER_ID, store);
    expect(catalog.find((row) => row.id === e.id)?.videoGuidance).toEqual(partial);
    expect(await store.read(DEFAULT_OWNER_ID, e.id)).toEqual(partial);
    expect(exerciseVideoGuidanceSchema.safeParse({ ...partial, videoAnalysisStatus: "PARTIAL" }).success).toBe(false);
  });
});
