-- Preserve historical preflights while allowing a new, explicitly linked run after expiry.
ALTER TABLE "VideoLunaPreflight" ADD COLUMN "runId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "VideoLunaPreflight" ADD COLUMN "previousPreflightId" TEXT;
UPDATE "VideoLunaPreflight" SET "runId"='legacy:' || "payloadHash" WHERE "runId"='';

DROP INDEX "VideoLunaPreflight_ownerId_payloadHash_key";
CREATE UNIQUE INDEX "VideoLunaPreflight_ownerId_runId_key" ON "VideoLunaPreflight"("ownerId","runId");
CREATE INDEX "VideoLunaPreflight_ownerId_payloadHash_idx" ON "VideoLunaPreflight"("ownerId","payloadHash");
-- At most one active count flight for a given payload, regardless of run ID.
CREATE UNIQUE INDEX "VideoLunaPreflight_active_payload_key"
 ON "VideoLunaPreflight"("ownerId","payloadHash")
 WHERE "countOutcome" IN ('PENDING','SENT','REQUEST_OUTCOME_UNKNOWN','CONFIRMED_NOT_SENT');
-- A prior preflight can have at most one successor, preventing refresh branches.
CREATE UNIQUE INDEX "VideoLunaPreflight_previousPreflightId_key"
 ON "VideoLunaPreflight"("previousPreflightId");
