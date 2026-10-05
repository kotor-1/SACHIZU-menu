-- CreateTable
CREATE TABLE "VideoGuidanceBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "creationKey" TEXT NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "endedAt" DATETIME,
    "heartbeat" DATETIME,
    "stopReason" TEXT,
    "requestBudget" INTEGER NOT NULL,
    "tokenBudget" INTEGER NOT NULL,
    "costBudget" INTEGER NOT NULL,
    "reservedRequests" INTEGER NOT NULL DEFAULT 0,
    "reservedTokens" INTEGER NOT NULL DEFAULT 0,
    "reservedCost" INTEGER NOT NULL DEFAULT 0,
    "usedRequests" INTEGER NOT NULL DEFAULT 0,
    "usedTokens" INTEGER NOT NULL DEFAULT 0,
    "usedCost" INTEGER NOT NULL DEFAULT 0,
    "rowVersion" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "VideoGuidanceBatchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "sourceBindingJson" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "workKey" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resultQuality" TEXT,
    "observationId" TEXT,
    "resultRevisionId" TEXT,
    "skipReason" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "retryAt" DATETIME,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY ("batchId") REFERENCES "VideoGuidanceBatch"("id") ON DELETE RESTRICT,
    FOREIGN KEY ("workId") REFERENCES "VideoAnalysisWork"("id") ON DELETE RESTRICT,
    FOREIGN KEY ("observationId") REFERENCES "VideoObservationResult"("id") ON DELETE RESTRICT
);

-- CreateTable
CREATE TABLE "VideoAnalysisWork" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "activeItemId" TEXT,
    "observationId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "retryAt" DATETIME,
    "errorCode" TEXT
);

-- CreateTable
CREATE TABLE "VideoAnalysisAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "dispatchKey" TEXT NOT NULL,
    "fencingToken" INTEGER NOT NULL,
    "reservedAt" DATETIME NOT NULL,
    "dispatchStartedAt" DATETIME,
    "providerRequestId" TEXT,
    "responseReceivedAt" DATETIME,
    "rawJson" TEXT,
    "rawHash" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'RESERVED',
    "latencyMs" INTEGER,
    "errorCode" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "usageJson" TEXT,
    "reconciliationState" TEXT NOT NULL DEFAULT 'NONE',
    "reconciledBy" TEXT,
    "reconciledAt" DATETIME,
    "reconciliationEvidenceJson" TEXT,
    "reservationRequests" INTEGER NOT NULL,
    "reservationTokens" INTEGER NOT NULL,
    "reservationCost" INTEGER NOT NULL,
    "accounted" BOOLEAN NOT NULL DEFAULT false,
    FOREIGN KEY ("batchId") REFERENCES "VideoGuidanceBatch"("id") ON DELETE RESTRICT,
    FOREIGN KEY ("itemId") REFERENCES "VideoGuidanceBatchItem"("id") ON DELETE RESTRICT,
    FOREIGN KEY ("workId") REFERENCES "VideoAnalysisWork"("id") ON DELETE RESTRICT
);

-- CreateTable
CREATE TABLE "VideoObservationResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "contentKey" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "rawHash" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    FOREIGN KEY ("attemptId") REFERENCES "VideoAnalysisAttempt"("id") ON DELETE RESTRICT
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoGuidanceBatch_ownerId_creationKey_key" ON "VideoGuidanceBatch"("ownerId", "creationKey");

-- CreateIndex
CREATE INDEX "VideoGuidanceBatchItem_workId_idx" ON "VideoGuidanceBatchItem"("workId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoGuidanceBatchItem_batchId_workKey_key" ON "VideoGuidanceBatchItem"("batchId", "workKey");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAnalysisWork_ownerId_contentKey_key" ON "VideoAnalysisWork"("ownerId", "contentKey");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAnalysisAttempt_dispatchKey_key" ON "VideoAnalysisAttempt"("dispatchKey");

-- CreateIndex
CREATE INDEX "VideoAnalysisAttempt_itemId_idx" ON "VideoAnalysisAttempt"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoAnalysisAttempt_workId_attemptNo_key" ON "VideoAnalysisAttempt"("workId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "VideoObservationResult_attemptId_key" ON "VideoObservationResult"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoObservationResult_ownerId_contentKey_key" ON "VideoObservationResult"("ownerId", "contentKey");


-- Extend just the existing permission constraint; preserve all existing grants.
CREATE TABLE "GuidanceOwnerAccess_phase3" (
 "userId" TEXT NOT NULL, "ownerId" TEXT NOT NULL CHECK(length(trim("ownerId"))>0),
 "permission" TEXT NOT NULL CHECK("permission" IN ('VIEW_VIDEO_GUIDANCE','REVIEW_VIDEO_GUIDANCE','PUBLISH_VIDEO_GUIDANCE','ANALYZE_VIDEO_GUIDANCE')),
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY("userId","ownerId","permission"), FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "GuidanceOwnerAccess_phase3" SELECT * FROM "GuidanceOwnerAccess";
DROP TABLE "GuidanceOwnerAccess";
ALTER TABLE "GuidanceOwnerAccess_phase3" RENAME TO "GuidanceOwnerAccess";

CREATE TRIGGER video_batch_budget_update BEFORE UPDATE ON "VideoGuidanceBatch"
WHEN NEW.reservedRequests < 0 OR NEW.reservedTokens < 0 OR NEW.reservedCost < 0
 OR NEW.usedRequests < 0 OR NEW.usedTokens < 0 OR NEW.usedCost < 0
 OR NEW.usedRequests+NEW.reservedRequests > NEW.requestBudget
 OR NEW.usedTokens+NEW.reservedTokens > NEW.tokenBudget
 OR NEW.usedCost+NEW.reservedCost > NEW.costBudget
BEGIN SELECT RAISE(ABORT,'BUDGET_EXCEEDED'); END;
CREATE TRIGGER video_batch_identity BEFORE UPDATE ON "VideoGuidanceBatch"
WHEN NEW.ownerId IS NOT OLD.ownerId OR NEW.actorId IS NOT OLD.actorId OR NEW.creationKey IS NOT OLD.creationKey
 OR NEW.manifestHash IS NOT OLD.manifestHash OR NEW.configJson IS NOT OLD.configJson
 OR NEW.requestBudget IS NOT OLD.requestBudget OR NEW.tokenBudget IS NOT OLD.tokenBudget OR NEW.costBudget IS NOT OLD.costBudget
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BATCH_MANIFEST'); END;
CREATE TRIGGER video_item_boundary BEFORE INSERT ON "VideoGuidanceBatchItem"
WHEN NOT EXISTS(SELECT 1 FROM "VideoGuidanceBatch" b, "VideoAnalysisWork" w, "Exercise" e
 WHERE b.id=NEW.batchId AND w.id=NEW.workId AND e.id=NEW.exerciseId AND b.ownerId=NEW.ownerId
 AND w.ownerId=NEW.ownerId AND w.contentKey=NEW.contentKey AND e.ownerId=NEW.ownerId)
BEGIN SELECT RAISE(ABORT,'CROSS_BOUNDARY_BATCH_ITEM'); END;
CREATE TRIGGER video_item_identity BEFORE UPDATE ON "VideoGuidanceBatchItem"
WHEN NEW.ownerId IS NOT OLD.ownerId OR NEW.batchId IS NOT OLD.batchId OR NEW.exerciseId IS NOT OLD.exerciseId
 OR NEW.workId IS NOT OLD.workId OR NEW.workKey IS NOT OLD.workKey OR NEW.contentKey IS NOT OLD.contentKey
 OR NEW.sourceBindingJson IS NOT OLD.sourceBindingJson OR NEW.configHash IS NOT OLD.configHash OR NEW.resultRevisionId IS NOT NULL
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_BATCH_ITEM'); END;
CREATE TRIGGER video_attempt_boundary BEFORE INSERT ON "VideoAnalysisAttempt"
WHEN NOT EXISTS(SELECT 1 FROM "VideoGuidanceBatchItem" i, "VideoAnalysisWork" w
 WHERE i.id=NEW.itemId AND i.workId=NEW.workId AND i.batchId=NEW.batchId AND i.ownerId=NEW.ownerId
 AND w.id=NEW.workId AND w.fencingToken=NEW.fencingToken AND w.activeItemId=NEW.itemId)
BEGIN SELECT RAISE(ABORT,'CROSS_BOUNDARY_ATTEMPT'); END;
CREATE TRIGGER video_raw_immutable BEFORE UPDATE ON "VideoAnalysisAttempt"
WHEN OLD.rawHash IS NOT NULL AND (NEW.rawHash IS NOT OLD.rawHash OR NEW.rawJson IS NOT OLD.rawJson OR NEW.usageJson IS NOT OLD.usageJson)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RAW'); END;
CREATE TRIGGER video_observation_boundary BEFORE INSERT ON "VideoObservationResult"
WHEN NOT EXISTS(SELECT 1 FROM "VideoAnalysisAttempt" a, "VideoAnalysisWork" w
 WHERE a.id=NEW.attemptId AND a.workId=w.id AND a.ownerId=NEW.ownerId AND w.contentKey=NEW.contentKey
 AND a.rawHash=NEW.rawHash AND a.outcome='RECEIVED' AND a.reconciliationState IN ('NONE','RESOLVED_RAW'))
BEGIN SELECT RAISE(ABORT,'CROSS_BOUNDARY_OBSERVATION'); END;
CREATE TRIGGER video_observation_immutable_update BEFORE UPDATE ON "VideoObservationResult"
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION'); END;
CREATE TRIGGER video_observation_immutable_delete BEFORE DELETE ON "VideoObservationResult"
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION'); END;

CREATE TRIGGER "VideoGuidanceBatch_INSERT_state" BEFORE INSERT ON "VideoGuidanceBatch" WHEN NEW."status" NOT IN ('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoGuidanceBatch_UPDATE_state" BEFORE UPDATE ON "VideoGuidanceBatch" WHEN NEW."status" NOT IN ('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','CANCELLED') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoGuidanceBatchItem_INSERT_state" BEFORE INSERT ON "VideoGuidanceBatchItem" WHEN NEW."status" NOT IN ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoGuidanceBatchItem_UPDATE_state" BEFORE UPDATE ON "VideoGuidanceBatchItem" WHEN NEW."status" NOT IN ('PENDING','RUNNING','SUCCEEDED','FAILED','SKIPPED') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoAnalysisWork_INSERT_state" BEFORE INSERT ON "VideoAnalysisWork" WHEN NEW."status" NOT IN ('READY','LEASED','UNKNOWN','COMPLETE','FAILED') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoAnalysisWork_UPDATE_state" BEFORE UPDATE ON "VideoAnalysisWork" WHEN NEW."status" NOT IN ('READY','LEASED','UNKNOWN','COMPLETE','FAILED') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoAnalysisAttempt_INSERT_state" BEFORE INSERT ON "VideoAnalysisAttempt" WHEN NEW."outcome" NOT IN ('RESERVED','SENT','RECEIVED','FAILED_CONFIRMED','REQUEST_OUTCOME_UNKNOWN') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER "VideoAnalysisAttempt_UPDATE_state" BEFORE UPDATE ON "VideoAnalysisAttempt" WHEN NEW."outcome" NOT IN ('RESERVED','SENT','RECEIVED','FAILED_CONFIRMED','REQUEST_OUTCOME_UNKNOWN') BEGIN SELECT RAISE(ABORT,'INVALID_BATCH_STATE'); END;

CREATE TRIGGER video_item_observation_boundary BEFORE UPDATE ON "VideoGuidanceBatchItem"
WHEN NEW.observationId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM VideoObservationResult o WHERE o.id=NEW.observationId AND o.ownerId=NEW.ownerId AND o.contentKey=NEW.contentKey)
BEGIN SELECT RAISE(ABORT,'CROSS_BOUNDARY_ITEM_RESULT'); END;
CREATE TRIGGER video_work_identity BEFORE UPDATE ON "VideoAnalysisWork"
WHEN NEW.ownerId IS NOT OLD.ownerId OR NEW.contentKey IS NOT OLD.contentKey
 OR (OLD.status='COMPLETE' AND (NEW.status IS NOT OLD.status OR NEW.observationId IS NOT OLD.observationId))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_WORK_IDENTITY'); END;
CREATE TRIGGER video_attempt_identity BEFORE UPDATE ON "VideoAnalysisAttempt"
WHEN NEW.workId IS NOT OLD.workId OR NEW.itemId IS NOT OLD.itemId OR NEW.batchId IS NOT OLD.batchId
 OR NEW.ownerId IS NOT OLD.ownerId OR NEW.attemptNo IS NOT OLD.attemptNo OR NEW.dispatchKey IS NOT OLD.dispatchKey
 OR NEW.fencingToken IS NOT OLD.fencingToken OR NEW.reservedAt IS NOT OLD.reservedAt
 OR NEW.reservationRequests IS NOT OLD.reservationRequests OR NEW.reservationTokens IS NOT OLD.reservationTokens OR NEW.reservationCost IS NOT OLD.reservationCost
 OR (OLD.accounted=1 AND NEW.accounted<>1)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT_IDENTITY'); END;
