# Luna preflight refresh

An expired Luna input-token preflight is retained as immutable history. To refresh it, call the existing plan path with a new, stable `runId` and `previousPreflightId` set to the expired `SUCCEEDED` preflight. The predecessor must match owner, payload, frame manifest, and manifest, and must be the latest leaf. A first plan may omit both fields; callers omitting `runId` use the legacy key `legacy:<payloadHash>`.

Each `(ownerId, runId)` is idempotent for the same payload/frame/manifest/predecessor scope. Replays return the original row and do not extend its expiry. A different scope under the same run ID is rejected. Refresh creates a new preflight and token-count receipt; it never copies the old receipt. `PENDING`, `SENT`, `REQUEST_OUTCOME_UNKNOWN`, and `CONFIRMED_NOT_SENT` count outcomes hold a single-flight lock for `(ownerId, payloadHash)`. A unique predecessor link prevents competing refresh branches.

The migration backfills legacy rows with `runId = 'legacy:' || payloadHash` and preserves their other values. It must be applied only to the intended isolated database after explicit approval; it has not been applied to the original database. Existing persisted Luna work keys are not rewritten. New Luna work keys omit the preflight ID, while fake-provider work keys remain unchanged; old Luna work rows therefore retain their pre-refresh identity and are not automatically remapped.

The original refresh blocker was the one-row-per-owner/payload unique key, combined with setup that assumed that key identified the sole preflight. Refresh support replaces that uniqueness with owner/run identity and adds an owner/payload history index plus the active-flight constraint.

Temporary offline runner: `/private/tmp/sachizu-preflight-refresh-fix/workspace/refresh-canary.ts`, invoked by `/private/tmp/sachizu-preflight-refresh-fix/refresh-run.py`. This phase authorizes no API request. Any future token-count or model-response request requires separate explicit approval; do not run the temporary live path on the strength of this document.
