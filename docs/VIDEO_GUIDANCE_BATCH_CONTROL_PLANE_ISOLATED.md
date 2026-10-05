# Video Guidance batch control plane — isolated Phase 3

This is an offline control plane, not a production analyzer or production cutover.
It has no route, scheduler, real provider, media reader or Guidance write capability.
Use an isolated checkout/copy and SQLite database. The original test harness replaces
`<cwd>/prisma/test.db`; never run it against the workspace's preserved database.

## Authority and data

`VideoBatchControlPlane` resolves the existing real-session `GuidanceIdentityPort`.
Creation requires the separate owner-scoped `ANALYZE_VIDEO_GUIDANCE` grant, also
checked in the creation transaction. Legacy Review capability does not imply Analyze.
The migration extends only the existing grant constraint; it grants nobody access.
Operator pause/resume/cancel/selected retry and stored-raw reconciliation reauthenticate.
No default user is created. Test credentials/users exist only in isolated fixtures.

Five new tables: `VideoGuidanceBatch`, `VideoGuidanceBatchItem`,
`VideoAnalysisWork`, `VideoAnalysisAttempt`, `VideoObservationResult`.
The repository's worker operations write only these tables. They never invoke a
Guidance repository or update a revision/head/audit. `resultRevisionId` stays null;
a database trigger prevents setting it. Candidate interpretation/creation is deferred.
Thus a COMPLETE fake result does not change B/D approval or promote E to COACH_REVIEWED.

Observations contain only timestamped CONTACT/FLIGHT/MOVEMENT events, synthetic
evidence identifiers and unresolved media conditions. The strict schema rejects
coach interpretation, repetition definitions, doses and approval fields.

## Identities and invariants

- Batch unique boundary: `(ownerId, creationKey)`. Changed manifest/config/budget
  with that key is `OPERATION_KEY_CONFLICT`. Canonical target ordering is stable.
- Content key hashes owner, media fingerprint, segment, extraction recipe, input
  manifest, provider, model/version, schema, prompt and config version. Exercise
  identity is deliberately excluded. Cross-owner cache sharing is forbidden.
- Item work key additionally hashes Exercise, exact source binding and full config.
  `(batchId, workKey)` is unique. Same media does not share review or approval.
- Global flight: `(ownerId, contentKey)` on `VideoAnalysisWork`, across batches
  and processes. A completed observation is immutable and has the same unique key.
- Attempt: unique dispatch key and `(workId, attemptNo)`. Replaying a SENT attempt
  cannot dispatch again. Retry history is never deleted.
- Source validation rechecks owner/Exercise/VideoAsset and bound key/URL before
  dispatch/result mapping. These tests use manifest fingerprints; they do not read
  real media bytes. A future real provider requires a separate freshness adapter.

## States

Batch: PENDING -> RUNNING -> SUCCEEDED/FAILED only when all items settle.
One FAILED item leaves other items runnable. Manual stop -> PAUSED; in-flight
raw/usage/results still persist. Resume restores scheduling, not failed-item retry.
CANCELLED means explicit abandonment of pending items; cancel refuses running work
or unaccounted attempts and never erases usage/history. Terminal success is not resumed.

Item: PENDING -> RUNNING -> SUCCEEDED/FAILED. Cache reuse is SKIPPED with
`OBSERVATION_REUSED`, result identity and quality. PARTIAL is SUCCEEDED/PARTIAL.
Selected confirmed retry -> PENDING with a retry-not-before timestamp.

Work: READY / LEASED / UNKNOWN / COMPLETE / FAILED. UNKNOWN blocks every batch.
Attempt: RESERVED -> SENT -> RECEIVED or FAILED_CONFIRMED or REQUEST_OUTCOME_UNKNOWN.
SENT is the conservative durable send boundary, including a crash just before the
actual provider invocation. Lease expiration does not prove a request failed.

## Lease, budgets and failures

Lease is frozen in the batch config (100–300,000 ms). Rehearsal uses 30,000 ms;
clock-driven fault tests use 1,000 ms. Heartbeats extend only the current live fence.
Every claim increments a global work fence. A late response may update its own
raw/usage record, but cannot activate a result. It is quarantined for reconciliation.

Before sending: claim -> source/fence/pause recheck -> transaction committing
Attempt + worst-case reservations -> durable SENT transition -> fake dispatch.
SQLite takes a write lock before reading counters, then checks requests, total tokens
and fictional integer cost units together. Batch used + reserved cannot exceed caps.
Unknown attempts retain their entire reservation. Cache reuse spends no budget.
Confirmed usage releases the reservation exactly once. Cached input tokens are a
subset of input, reasoning tokens a subset of output, so total = input + output.

Fake fixed maximum usage: 1 request, input 20 (cached 5), output 10 (reasoning 2),
cost 7 **fictional test units**. Config reservation must cover at least that bound.
Tests normally reserve 1 request / 100 tokens / 20 fictional cost units.
No actual model price or spend is calculated.

`maxRetries` is explicit (0–5); tests/rehearsal use 2 retries after the initial send.
Only selected FAILED_CONFIRMED/retryable work may retry. Per-item and global-work
retry counters are checked. Backoff is 1s, 2s, 4s… capped at 30s, tested using an
injected clock. No automatic all-failed retry or transport retry exists.

The fake supports SUCCESS, PARTIAL, SCHEMA_INVALID, HTTP_429, HTTP_500,
TIMEOUT_BEFORE_SEND, FAILURE_CONFIRMED_AFTER_SEND, UNKNOWN_AFTER_SEND,
DELAYED_SUCCESS. Availability alone is never a capability. Constructor and dispatch
require explicit isolated-test mode and NODE_ENV=test; production mode or a missing
provider throws the existing AnalyzerNotConfiguredError.

## Raw and recovery

Synthetic raw (maximum 64 KB) is durably stored inside the **isolated SQLite**
Attempt with hash, timestamps, request identity and usage before parsing. This is a
private synthetic-evidence adapter, not a production private-storage implementation.
It never writes public/uploads. Raw and Observation are immutable after persistence.

- Before claim: remains PENDING.
- After claim / before reservation: expired lease can be reclaimed.
- RESERVED without SENT: old worker is fenced; expiry proves protocol-level unsent,
  releases reservation and records CONFIRMED_NOT_SENT before another send.
- SENT without durable raw: UNKNOWN, full reservation retained, no automatic resend.
- Raw saved / result transaction failed: reclaim and parse stored raw, provider calls 0.
- Result committed / ack lost: item/cache identity reuses result, provider calls 0.

For UNKNOWN with a late durable raw, authorized `reconcileStoredRaw` requires the
exact stored hash and a reason. It records actor/time/evidence, adopts only that raw,
and enables parse-only recovery. It cannot authorize a new send. Without verifiable
stored raw, UNKNOWN remains blocked; there is no force retry, assumed-zero-cost or
lease-based unlock. A future real provider needs its own request-outcome evidence
and reconciliation policy before canary readiness can be claimed.

## SQLite and verification

No global PRAGMA/WAL changes. Tests use migrated isolated SQLite with rollback
journal. Independent Prisma clients and separate OS processes exercise single-flight
and the last-budget race. Busy errors get at most three retries of a DB-only
transaction (5/10/15 ms delays); exhausted contention is PERSISTENCE_ERROR, not an
analysis failure. No provider call occurs inside a database transaction.

Run from an isolated copy with copied node_modules (Prisma generation must not
rewrite the original generated client). Apply migrations only to temporary DBs.
Use the offline preload for the entire suite and child processes:

```sh
NODE_OPTIONS='--require=/absolute/isolated-copy/tests/fixtures/video-batch-network-guard.cjs' CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 node node_modules/vitest/vitest.mjs run
```

Use an absolute preload path because migration children change their working directory.
The guard blocks external transport (also loopback TCP); Unix sockets remain for
local tooling. Fake calls and Better Auth handler requests are in-process. Crash
tests actually SIGKILL a dedicated child at durable boundaries, not the test runner.
The child fixture accepts explicit isolated DB/ledger paths; never point it at live data.

Migration rollback/restore rehearsals are evidence artifacts, not a production
rollback command. Rollback drops only the five batch tables and Analyze grants,
restores the prior grant constraint and removes only the Phase 3 migration ledger
entry; it preserves Guidance, sessions and existing grants. Back up first. Full
restoration checks all table hashes, integrity_check and foreign_key_check.

Phase 4 readiness means read-only dry-run preparation may begin. Real manifest,
pricing, cost estimates, real provider capability, canary selection, video analysis,
production cutover and the 158-video run are not implemented or authorized here.
