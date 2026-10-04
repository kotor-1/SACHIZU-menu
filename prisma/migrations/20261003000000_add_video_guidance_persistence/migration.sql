-- Additive only: no existing Exercise, video, Menu or Session data are rewritten.
CREATE TABLE "ExerciseVideoGuidanceRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "sourceBindingJson" TEXT NOT NULL CHECK (json_valid("sourceBindingJson")),
    "sourceBindingHash" TEXT NOT NULL CHECK (length("sourceBindingHash") = 64),
    "payloadJson" TEXT NOT NULL CHECK (json_valid("payloadJson")),
    "payloadHash" TEXT NOT NULL CHECK (length("payloadHash") = 64),
    "authorityStatus" TEXT NOT NULL CHECK ("authorityStatus" IN ('AI_ANALYZED', 'COACH_REVIEWED')),
    "revisionOrigin" TEXT NOT NULL CHECK ("revisionOrigin" IN ('AI_ANALYSIS', 'COACH_REVIEW', 'LEGACY_IMPORT')),
    "parentRevisionId" TEXT,
    "baseAiRevisionId" TEXT,
    "fieldAssessmentJson" TEXT NOT NULL CHECK (json_valid("fieldAssessmentJson") AND json_type("fieldAssessmentJson") = 'array'),
    "aiMetadataJson" TEXT CHECK ("aiMetadataJson" IS NULL OR json_valid("aiMetadataJson")),
    "provenanceJson" TEXT NOT NULL CHECK (json_valid("provenanceJson")),
    "analyzedAt" DATETIME NOT NULL,
    "reviewedAt" DATETIME,
    "reviewerActorId" TEXT,
    "reviewReason" TEXT,
    "operationKey" TEXT NOT NULL CHECK (length(trim("operationKey")) > 0),
    "operationHash" TEXT NOT NULL CHECK (length("operationHash") = 64),
    "importSourceHash" TEXT CHECK ("importSourceHash" IS NULL OR length("importSourceHash") = 64),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (("authorityStatus" = 'COACH_REVIEWED' AND "reviewedAt" IS NOT NULL)
        OR ("authorityStatus" = 'AI_ANALYZED' AND "reviewedAt" IS NULL)),
    CHECK ("revisionOrigin" <> 'AI_ANALYSIS' OR "authorityStatus" = 'AI_ANALYZED'),
    CHECK ("revisionOrigin" <> 'COACH_REVIEW' OR
        ("authorityStatus" = 'COACH_REVIEWED' AND "reviewerActorId" IS NOT NULL
         AND length(trim("reviewerActorId")) > 0 AND "reviewReason" IS NOT NULL AND length(trim("reviewReason")) > 0)),
    CHECK (json_extract("payloadJson", '$.videoAnalysisStatus') IS "authorityStatus"),
    CHECK (json_extract("payloadJson", '$.sourceVideoId') IS "sourceVideoId"),
    CHECK (json_extract("sourceBindingJson", '$.sourceVideoId') IS "sourceVideoId"),
    CONSTRAINT "ExerciseVideoGuidanceRevision_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ExerciseVideoGuidanceRevision_sourceVideoId_fkey" FOREIGN KEY ("sourceVideoId") REFERENCES "VideoAsset" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ExerciseVideoGuidanceRevision_parentRevisionId_fkey" FOREIGN KEY ("parentRevisionId") REFERENCES "ExerciseVideoGuidanceRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ExerciseVideoGuidanceRevision_baseAiRevisionId_fkey" FOREIGN KEY ("baseAiRevisionId") REFERENCES "ExerciseVideoGuidanceRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "ExerciseVideoGuidanceHead" (
    "ownerId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "approvedRevisionId" TEXT,
    "activeAiRevisionId" TEXT,
    "latestCandidateRevisionId" TEXT,
    "rowVersion" INTEGER NOT NULL DEFAULT 0 CHECK ("rowVersion" >= 0),
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("ownerId", "exerciseId"),
    CONSTRAINT "ExerciseVideoGuidanceHead_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ExerciseVideoGuidanceHead_approvedRevisionId_fkey" FOREIGN KEY ("approvedRevisionId") REFERENCES "ExerciseVideoGuidanceRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ExerciseVideoGuidanceHead_activeAiRevisionId_fkey" FOREIGN KEY ("activeAiRevisionId") REFERENCES "ExerciseVideoGuidanceRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "ExerciseVideoGuidanceHead_latestCandidateRevisionId_fkey" FOREIGN KEY ("latestCandidateRevisionId") REFERENCES "ExerciseVideoGuidanceRevision" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE "VideoGuidanceAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorKind" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL CHECK (json_valid("beforeJson")),
    "afterJson" TEXT NOT NULL CHECK (json_valid("afterJson")),
    "expectedRowVersion" INTEGER NOT NULL CHECK ("expectedRowVersion" >= 0),
    "resultingRowVersion" INTEGER NOT NULL CHECK ("resultingRowVersion" >= 0),
    "operationKey" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoGuidanceAuditEvent_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "ExerciseVideoGuidanceRevision_ownerId_exerciseId_operationKey_key" ON "ExerciseVideoGuidanceRevision"("ownerId", "exerciseId", "operationKey");
CREATE INDEX "ExerciseVideoGuidanceRevision_ownerId_exerciseId_createdAt_idx" ON "ExerciseVideoGuidanceRevision"("ownerId", "exerciseId", "createdAt");
CREATE INDEX "ExerciseVideoGuidanceRevision_sourceVideoId_idx" ON "ExerciseVideoGuidanceRevision"("sourceVideoId");
CREATE UNIQUE INDEX "VideoGuidanceAuditEvent_ownerId_exerciseId_operationKey_operation_key" ON "VideoGuidanceAuditEvent"("ownerId", "exerciseId", "operationKey", "operation");
CREATE INDEX "VideoGuidanceAuditEvent_ownerId_exerciseId_timestamp_idx" ON "VideoGuidanceAuditEvent"("ownerId", "exerciseId", "timestamp");

-- History is append-only even when a caller bypasses the repository.
CREATE TRIGGER "video_guidance_revision_no_update" BEFORE UPDATE ON "ExerciseVideoGuidanceRevision"
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_REVISION'); END;
CREATE TRIGGER "video_guidance_revision_no_delete" BEFORE DELETE ON "ExerciseVideoGuidanceRevision"
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_REVISION'); END;
CREATE TRIGGER "video_guidance_audit_no_update" BEFORE UPDATE ON "VideoGuidanceAuditEvent"
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_AUDIT'); END;
CREATE TRIGGER "video_guidance_audit_no_delete" BEFORE DELETE ON "VideoGuidanceAuditEvent"
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_AUDIT'); END;

-- SQLite REPLACE can delete a conflicting row without firing DELETE triggers
-- when recursive_triggers is disabled. Reject the collision before replacement.
-- Repository idempotency replays an existing same-key operation, not its INSERT.
CREATE TRIGGER "video_guidance_revision_no_replace" BEFORE INSERT ON "ExerciseVideoGuidanceRevision"
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r
        WHERE r."id" = NEW."id" OR
          (r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."operationKey" = NEW."operationKey")
    ) THEN RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_REVISION') END;
END;
CREATE TRIGGER "video_guidance_audit_no_replace" BEFORE INSERT ON "VideoGuidanceAuditEvent"
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM "VideoGuidanceAuditEvent" a
        WHERE a."id" = NEW."id" OR
          (a."ownerId" = NEW."ownerId" AND a."exerciseId" = NEW."exerciseId"
           AND a."operationKey" = NEW."operationKey" AND a."operation" = NEW."operation")
    ) THEN RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_AUDIT') END;
END;

CREATE TRIGGER "video_guidance_revision_boundary" BEFORE INSERT ON "ExerciseVideoGuidanceRevision"
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM "Exercise" e JOIN "VideoAsset" v ON v."exerciseId" = e."id"
        WHERE e."id" = NEW."exerciseId" AND e."ownerId" = NEW."ownerId"
          AND v."id" = NEW."sourceVideoId" AND v."ownerId" = NEW."ownerId"
          AND v."storageKey" IS json_extract(NEW."sourceBindingJson", '$.storageKey')
          AND v."sourceUrl" IS json_extract(NEW."sourceBindingJson", '$.sourceUrl')
    ) THEN RAISE(ABORT, 'CROSS_BOUNDARY_VIDEO_GUIDANCE_SOURCE') END;
    SELECT CASE WHEN NEW."parentRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."parentRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId"
    ) THEN RAISE(ABORT, 'CROSS_BOUNDARY_VIDEO_GUIDANCE_PARENT') END;
    SELECT CASE WHEN NEW."baseAiRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."baseAiRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId"
          AND r."sourceVideoId" = NEW."sourceVideoId" AND r."sourceBindingHash" = NEW."sourceBindingHash"
          AND r."authorityStatus" = 'AI_ANALYZED'
    ) THEN RAISE(ABORT, 'CROSS_BOUNDARY_VIDEO_GUIDANCE_BASE_AI') END;
END;

CREATE TRIGGER "video_guidance_head_insert_boundary" BEFORE INSERT ON "ExerciseVideoGuidanceHead"
BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "Exercise" e WHERE e."id" = NEW."exerciseId" AND e."ownerId" = NEW."ownerId")
        THEN RAISE(ABORT, 'CROSS_BOUNDARY_VIDEO_GUIDANCE_HEAD') END;
    SELECT CASE WHEN NEW."approvedRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."approvedRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."authorityStatus" = 'COACH_REVIEWED'
    ) THEN RAISE(ABORT, 'INVALID_APPROVED_VIDEO_GUIDANCE_HEAD') END;
    SELECT CASE WHEN NEW."activeAiRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."activeAiRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."authorityStatus" = 'AI_ANALYZED'
    ) THEN RAISE(ABORT, 'INVALID_AI_VIDEO_GUIDANCE_HEAD') END;
    SELECT CASE WHEN NEW."latestCandidateRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."latestCandidateRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."authorityStatus" = 'AI_ANALYZED'
    ) THEN RAISE(ABORT, 'INVALID_CANDIDATE_VIDEO_GUIDANCE_HEAD') END;
END;

CREATE TRIGGER "video_guidance_head_update_boundary" BEFORE UPDATE ON "ExerciseVideoGuidanceHead"
BEGIN
    SELECT CASE WHEN NEW."ownerId" <> OLD."ownerId" OR NEW."exerciseId" <> OLD."exerciseId"
        THEN RAISE(ABORT, 'IMMUTABLE_VIDEO_GUIDANCE_HEAD_IDENTITY') END;
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "Exercise" e WHERE e."id" = NEW."exerciseId" AND e."ownerId" = NEW."ownerId")
        THEN RAISE(ABORT, 'CROSS_BOUNDARY_VIDEO_GUIDANCE_HEAD') END;
    SELECT CASE WHEN NEW."rowVersion" <> OLD."rowVersion" + 1
        THEN RAISE(ABORT, 'STALE_VIDEO_GUIDANCE_HEAD_VERSION') END;
    SELECT CASE WHEN NEW."approvedRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."approvedRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."authorityStatus" = 'COACH_REVIEWED'
    ) THEN RAISE(ABORT, 'INVALID_APPROVED_VIDEO_GUIDANCE_HEAD') END;
    SELECT CASE WHEN NEW."activeAiRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."activeAiRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."authorityStatus" = 'AI_ANALYZED'
    ) THEN RAISE(ABORT, 'INVALID_AI_VIDEO_GUIDANCE_HEAD') END;
    SELECT CASE WHEN NEW."latestCandidateRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "ExerciseVideoGuidanceRevision" r WHERE r."id" = NEW."latestCandidateRevisionId"
          AND r."ownerId" = NEW."ownerId" AND r."exerciseId" = NEW."exerciseId" AND r."authorityStatus" = 'AI_ANALYZED'
    ) THEN RAISE(ABORT, 'INVALID_CANDIDATE_VIDEO_GUIDANCE_HEAD') END;
END;

CREATE TRIGGER "video_guidance_audit_boundary" BEFORE INSERT ON "VideoGuidanceAuditEvent"
BEGIN
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "Exercise" e WHERE e."id" = NEW."exerciseId" AND e."ownerId" = NEW."ownerId")
        THEN RAISE(ABORT, 'CROSS_BOUNDARY_VIDEO_GUIDANCE_AUDIT') END;
END;
