# Freeform AI Menu Composer — Phase 1

Running Interpreter `running-intent-v2`, Policy `rp-2026.09.0` (`b522cdccba0fa65c5639eb823ccd313439700fb65ce00f8192edca51699b535f`) and Engine remain frozen. This phase is implemented and verified offline: no live OpenAI requests and no video analysis.

## Authority and flow

Japanese request → existing frozen Running interpretation/verification → Running Engine when requested → one Menu Composer stage → deterministic composition validator → editable blocks → signed save → existing Session snapshot.

The Composer receives the verified Running prescription as read-only context. It may place exactly one `{ type: "RUNNING_POLICY" }` reference when Running is available. This variant has **no numeric or instruction fields**. Running distance, total reps, sets, rests and targets come from Engine or the existing approved Coach Edit validator. Running is recomputed and compared at save; client echoes never become execution values. Interpreter unavailability, unresolved Running input or safety review stops composition. There is no default prescription fallback.

For non-Running items AI may propose sets, reps, seconds, meters, rest and instructions. These are editable proposals, not changes to Exercise knowledge. Catalog IDs must be owned, REVIEWED and non-Running under the existing classifier. Freeform items have no Exercise ID, preserve a quoted user instruction and create only MenuItem rows. Their category must be non-Running. Clauses bound as explicit Running distances cannot be reused as freeform doses. Structural validation does not independently prove the meaning of every arbitrary non-Running instruction; human preview confirmation and the forthcoming limited model smoke remain necessary.

The strict structured-output contract follows the [OpenAI Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). Each non-Running item has nullable `plannedSets`, `plannedReps`, `plannedDurationSeconds`, `plannedDistanceMeters`, `plannedRestSeconds`; at most one primary unit (reps/time/distance) is set. Bounds follow existing MenuItem inputs. No quantity is mandatory. Missing primary quantity is `UNCONFIGURED`, displayed as 「量未設定」 in preview, saved Menu and Session.

## Catalog context

Owned REVIEWED catalog data supplies id/name/category, description, coachingPoint/commonMistake, metricType, all five defaults, difficulty, purposes/events/targets/tags and any cached video guidance. The existing classifier excludes Running exercises from AI dose proposal.

Metadata search uses Japanese word segmentation and existing metadata labels, retains explicitly selected IDs and limits context to 24 candidates / 32,000 characters. This is retrieval, not a new training policy. Descriptions are bounded at 800 characters; coaching and mistakes at 400. Defaults are reference data. The Composer must choose current MenuItem dose, not automatically copy defaults or observed video counts. Unsupported requests may stay freeform rather than being replaced by approximate catalog names. Athlete persistence and age eligibility metadata are not introduced.

## Editing and persistence

`/menus/new` presents one ordered block preview with Running, catalog and freeform cards. Blocks/items can be reordered; items can move between blocks, be removed and receive notes. Catalog/freeform dose and instructions are editable. Freeform names are editable; AI-derived original quotations are retained. Manual catalog/freeform items and blocks can be added. A fully manual signed draft makes zero AI calls.

Running numbers are absent from generic item inputs; the existing Coach Edit UI/server validator remains the only adjustment path. New composed menus suppress the old Method/Template picker and generic Running recommendation. Existing legacy menus remain readable.

Saving verifies owner-bound expiring HMAC proof, current catalog ownership/review status, units and Engine result inside the existing transaction path. User-confirmed plan fields use existing MenuItem columns. Instructions, original freeform request and notes fit the existing 1,000-character note column; reason uses rationale and proposal origin uses provenanceJson. No Exercise is created or updated.

`runningContextJson` uses a discriminated `MENU_COMPOSITION` envelope carrying only the confirmed-plan digest for idempotence; it is not a legacy Running profile/context. New composed-menu UI does not send it through legacy Method evaluation. Identical retries return the existing Menu; a different final plan for the same token is stale.

Session creation copies MenuItem final plan fields, instructions and order using the existing immutable snapshot. It does not regenerate AI plans or reload Exercise defaults. Full description/video knowledge snapshots remain a separate phase.

Running time displays known inter-rep and between-set rest, plus an explicit coach target if present. Three reps with 900-second rep rest contain two rests: at least 1,800 seconds. No running speed is invented. Non-Running time estimates use existing plan-based estimates; items without quantity have unknown duration.

## One-time video guidance

`ExerciseVideoGuidance` stores executionSummary, movementPattern, countingUnit, bilateralCounting, typicalStructure, equipment, setup, keyCues, commonErrors and doseObservations, with sourceVideoId, analysisVersion, analyzedAt and separate analysis/review status. Absence means NOT_ANALYZED; analyzer output becomes AI_ANALYZED; explicit human review becomes COACH_REVIEWED. These statuses are independent of Exercise.REVIEWED. No existing 158 Exercise counting units or guidance have been backfilled.

The enrichment service operates on one owned Exercise/local VideoAsset through an injected analyzer port. The local resolver reads existing VideoAsset storage references; it performs no download. Same asset/version reuses guidance. A version/asset change requires explicit new enrichment. Counts visible in a video are observations, not prescriptions. There is **no live analyzer provider or batch command** in this phase.

The default private file store is `.data/exercise-video-guidance/`, excluded from Git and public uploads. Owner/exercise keys are hashed, writes are atomic and every analysis/review revision is retained. Menu generation only reads the cache. Deployment must persist this private directory (or provide a shared store implementation); an ephemeral filesystem would lose reusable guidance. This avoids a Prisma migration while keeping a storage port for a later shared backend. The current catalog/context contract accepts guidance when available; no video bytes enter generation.

## Cost and validation rules

Normal production design: one primary Interpreter call (selective review only under frozen rules) + one Composer call; no video call. Production model/effort/timeout/output/retry remain gpt-6-luna / low / 20,000 ms per stage / 3,000 tokens / one transport retry. Exercise-only generation still uses the frozen Interpreter stage; manual creation, editing, saving and Session creation use zero AI calls.

Development uses deterministic tests, recorded replay and injected mock adapters. Full tests/build run in an isolated workspace with a fresh isolated DB and a network blocker; original dev.db/test.db hashes are compared before/after. Never run real corpus/model comparison as part of validation. Any later live smoke requires a predeclared request budget, explicit authorization, at most 10 ordinary inputs and no repeated input batch. No unbounded scripts or Sol API evaluation. This phase authorizes **zero** live requests.

Next proposed phase: limited freeform Luna smoke, separately authorized, covering Running-only, Running + catalog, Exercise-only, freeform-only and mixed composition. For five inputs, the normal expectation is ten stage requests, with a separately approved hard cap accounting for existing selective reviews and transport retry. No smoke has been executed here. Video enrichment should start with at most five Exercises in a separately authorized batch followed by coach review.

## Offline recovery after the limited Luna smoke

The subsequent five-input live smoke completed with 3/5 semantic passes and eight requests. This recovery phase makes **zero live requests and zero video-analysis calls**. Its scope is the Exercise-only request contract, session time scope, whitespace-only grounding and preview reference hierarchy. Policy, Engine, Coach Edit, transport/configuration and Session persistence are unchanged.

`EXERCISE_ONLY` with an affirmed boolean `RUNNING_REQUEST=false` is consistent. A true value contradicts that request kind; `RUNNING` with false also contradicts it. Boolean negation is not rewritten into a second `NEGATED` polarity.

`AVAILABLE_TIME` is a session budget, never a dose simply because it uses seconds/minutes/hours. Its source must include a session/aggregate time subject, an availability restriction or a session completion/time-box predicate adjacent to the numeric evidence. The verifier uses a small conservative grammatical check, not an Exercise/phrase dictionary or a quantity recommendation. Unrecognized or item-local evidence is rejected as `SESSION_TIME_BASIS_REQUIRED`; it is not silently converted or discarded. Primary instructions leave Exercise reps/duration/distance/rest/sets to Composer and retain those wishes as unsupported raw quotations. This bounded check is not a complete natural-language time-scope parser; broader legitimate wording may need later offline review.

The recorded CASE4 output therefore remains rejected for its wrong `AVAILABLE_TIME`, even after quote grounding is fixed. An explicitly labeled corrected-contract mock omits that claim, retains the 20-second wish and passes the original raw request through the normal Composer stage. The resulting Freeform has `plannedDurationSeconds=20`, with distance/reps null. This is an offline contract result, not a claim that Luna has been re-evaluated.

Source grounding removes only whitespace for matching and maps a **unique** match back to the exact original substring and UTF-16 offsets. It neither folds Unicode nor repairs words, punctuation or order. Multiple normalized matches are rejected even when one is an exact quote. Numeric witnesses still undergo their existing checks, so whitespace removal cannot join separate numerals into fabricated numeric evidence. The same resolver grounds Composer Freeform source quotations before signing; human edits retain the existing save rules.

Preview puts 「今回の実施内容」 and its dose/instruction first. Catalog description/coaching is under collapsed 「種目の基本説明（参考）」; catalog knowledge is not changed.

After all offline checks pass, the next separately authorized Luna recovery smoke is **at most three inputs**, each once: Exercise-only with no Running, a Freeform duration of 20 seconds, and a genuine whole-session time budget. Expected normal requests: six; global hard cap: seven including selective review and production transport retry. Sol/Astra application API calls and video analysis remain zero. Menu-use and video-analysis readiness remain NO until that recovery is evaluated.
