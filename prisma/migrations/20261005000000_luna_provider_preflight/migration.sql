ALTER TABLE "VideoAnalysisAttempt" ADD COLUMN "rawRef" TEXT;
ALTER TABLE "VideoAnalysisAttempt" ADD COLUMN "responseMetadataJson" TEXT;
ALTER TABLE "VideoAnalysisAttempt" ADD COLUMN "providerUsageJson" TEXT;
ALTER TABLE "VideoAnalysisAttempt" ADD COLUMN "candidateJson" TEXT;
CREATE TABLE "VideoLunaPreflight" (
 "id" TEXT NOT NULL PRIMARY KEY, "ownerId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
 "payloadHash" TEXT NOT NULL, "frameManifestHash" TEXT NOT NULL,
 "manifestHash" TEXT NOT NULL, "manifestJson" TEXT NOT NULL,
 "requestedAt" DATETIME NOT NULL, "expiresAt" DATETIME NOT NULL,
 "countOutcome" TEXT NOT NULL DEFAULT 'PENDING', "countDispatchKey" TEXT NOT NULL,
 "countSentAt" DATETIME, "countRequestId" TEXT, "countRawRef" TEXT, "countRawHash" TEXT,
 "countReceiptJson" TEXT, "countError" TEXT, "responseApprovalJson" TEXT, "responseBatchId" TEXT
);
CREATE UNIQUE INDEX "VideoLunaPreflight_ownerId_payloadHash_key" ON "VideoLunaPreflight"("ownerId","payloadHash");
CREATE UNIQUE INDEX "VideoLunaPreflight_countDispatchKey_key" ON "VideoLunaPreflight"("countDispatchKey");
CREATE UNIQUE INDEX "VideoLunaPreflight_responseBatchId_key" ON "VideoLunaPreflight"("responseBatchId");
-- Real raw is captured BEFORE usage is known. Permit exactly the first usage attachment;
-- preserve the Phase3 synthetic raw/usage immutability boundary.
DROP TRIGGER "video_raw_immutable";
CREATE TRIGGER "video_raw_immutable" BEFORE UPDATE ON "VideoAnalysisAttempt"
WHEN OLD.rawHash IS NOT NULL AND (
 NEW.rawHash IS NOT OLD.rawHash OR NEW.rawJson IS NOT OLD.rawJson
 OR (OLD.rawRef IS NOT NULL AND NEW.rawRef IS NOT OLD.rawRef)
 OR (OLD.rawJson IS NOT NULL AND NEW.usageJson IS NOT OLD.usageJson)
 OR (OLD.usageJson IS NOT NULL AND NEW.usageJson IS NOT OLD.usageJson))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RAW'); END;
CREATE TRIGGER "video_luna_receipt_immutable" BEFORE UPDATE ON "VideoAnalysisAttempt"
WHEN (OLD.responseMetadataJson IS NOT NULL AND NEW.responseMetadataJson IS NOT OLD.responseMetadataJson)
 OR (OLD.rawRef IS NOT NULL AND OLD.providerRequestId IS NOT NULL AND NEW.providerRequestId IS NOT OLD.providerRequestId)
 OR (OLD.providerUsageJson IS NOT NULL AND NEW.providerUsageJson IS NOT OLD.providerUsageJson)
 OR (OLD.candidateJson IS NOT NULL AND NEW.candidateJson IS NOT OLD.candidateJson)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LUNA_RECEIPT'); END;
CREATE TRIGGER "video_luna_preflight_immutable" BEFORE UPDATE ON "VideoLunaPreflight"
WHEN NEW.id IS NOT OLD.id OR NEW.ownerId IS NOT OLD.ownerId OR NEW.actorId IS NOT OLD.actorId
 OR NEW.payloadHash IS NOT OLD.payloadHash OR NEW.frameManifestHash IS NOT OLD.frameManifestHash
 OR NEW.manifestHash IS NOT OLD.manifestHash OR NEW.manifestJson IS NOT OLD.manifestJson
 OR NEW.requestedAt IS NOT OLD.requestedAt OR NEW.expiresAt IS NOT OLD.expiresAt
 OR NEW.countDispatchKey IS NOT OLD.countDispatchKey
 OR (OLD.countRawHash IS NOT NULL AND NEW.countRawHash IS NOT OLD.countRawHash)
 OR (OLD.countRawRef IS NOT NULL AND NEW.countRawRef IS NOT OLD.countRawRef)
 OR (OLD.countRequestId IS NOT NULL AND NEW.countRequestId IS NOT OLD.countRequestId)
 OR (OLD.countReceiptJson IS NOT NULL AND NEW.countReceiptJson IS NOT OLD.countReceiptJson)
 OR (OLD.responseApprovalJson IS NOT NULL AND NEW.responseApprovalJson IS NOT OLD.responseApprovalJson)
 OR (OLD.responseBatchId IS NOT NULL AND NEW.responseBatchId IS NOT OLD.responseBatchId)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LUNA_PREFLIGHT'); END;
CREATE TRIGGER "video_luna_count_transition" BEFORE UPDATE ON "VideoLunaPreflight"
WHEN NEW.countOutcome IS NOT OLD.countOutcome AND NOT (
 (OLD.countOutcome='PENDING' AND NEW.countOutcome='SENT')
 OR (OLD.countOutcome='SENT' AND NEW.countOutcome IN ('CONFIRMED_NOT_SENT','REQUEST_OUTCOME_UNKNOWN','SUCCEEDED','FAILED_CONFIRMED'))
 OR (OLD.countOutcome='REQUEST_OUTCOME_UNKNOWN' AND NEW.countOutcome IN ('SUCCEEDED','FAILED_CONFIRMED'))
 OR (OLD.countOutcome='CONFIRMED_NOT_SENT' AND NEW.countOutcome='PENDING'))
BEGIN SELECT RAISE(ABORT,'INVALID_LUNA_COUNT_TRANSITION'); END;
CREATE TRIGGER "video_luna_preflight_no_delete" BEFORE DELETE ON "VideoLunaPreflight"
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LUNA_PREFLIGHT_HISTORY'); END;
