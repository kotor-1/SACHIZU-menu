-- CreateTable
CREATE TABLE "Exercise" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'default-coach',
    "name" TEXT NOT NULL,
    "nameKana" TEXT,
    "description" TEXT,
    "coachingPoint" TEXT,
    "commonMistake" TEXT,
    "category" TEXT NOT NULL,
    "metricType" TEXT NOT NULL DEFAULT 'REPS',
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "defaultSets" INTEGER,
    "defaultReps" INTEGER,
    "defaultDistanceMeters" REAL,
    "defaultDurationSeconds" INTEGER,
    "defaultRestSeconds" INTEGER,
    "videoUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'REVIEWED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExerciseTarget" (
    "exerciseId" TEXT NOT NULL,
    "target" TEXT NOT NULL,

    PRIMARY KEY ("exerciseId", "target"),
    CONSTRAINT "ExerciseTarget_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'GENERAL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExerciseTag" (
    "exerciseId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("exerciseId", "tagId"),
    CONSTRAINT "ExerciseTag_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExerciseTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'default-coach',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "purpose" TEXT,
    "phase" TEXT,
    "estimatedMinutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MenuTag" (
    "menuTemplateId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("menuTemplateId", "tagId"),
    CONSTRAINT "MenuTag_menuTemplateId_fkey" FOREIGN KEY ("menuTemplateId") REFERENCES "MenuTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MenuTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "menuTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "MenuBlock_menuTemplateId_fkey" FOREIGN KEY ("menuTemplateId") REFERENCES "MenuTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "menuBlockId" TEXT NOT NULL,
    "exerciseId" TEXT,
    "displayName" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "sets" INTEGER,
    "reps" INTEGER,
    "distanceMeters" REAL,
    "durationSeconds" INTEGER,
    "restSeconds" INTEGER,
    "intensityPercent" INTEGER,
    "loadKg" REAL,
    "note" TEXT,
    CONSTRAINT "MenuItem_menuBlockId_fkey" FOREIGN KEY ("menuBlockId") REFERENCES "MenuBlock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MenuItem_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'default-coach',
    "title" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "sourceMenuTemplateId" TEXT,
    "sourceMenuNameSnapshot" TEXT,
    "groupName" TEXT,
    "location" TEXT,
    "weather" TEXT,
    "condition" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "coachNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingSession_sourceMenuTemplateId_fkey" FOREIGN KEY ("sourceMenuTemplateId") REFERENCES "MenuTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SessionItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trainingSessionId" TEXT NOT NULL,
    "exerciseId" TEXT,
    "exerciseNameSnapshot" TEXT NOT NULL,
    "blockNameSnapshot" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "plannedSets" INTEGER,
    "plannedReps" INTEGER,
    "plannedDistanceMeters" REAL,
    "plannedDurationSeconds" INTEGER,
    "plannedRestSeconds" INTEGER,
    "plannedIntensityPercent" INTEGER,
    "plannedLoadKg" REAL,
    "plannedNote" TEXT,
    "actualSets" INTEGER,
    "actualReps" INTEGER,
    "actualDistanceMeters" REAL,
    "actualDurationSeconds" INTEGER,
    "actualLoadKg" REAL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "actualNote" TEXT,
    CONSTRAINT "SessionItem_trainingSessionId_fkey" FOREIGN KEY ("trainingSessionId") REFERENCES "TrainingSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionItem_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'default-coach',
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'video/mp4',
    "sizeBytes" INTEGER,
    "durationSeconds" INTEGER,
    "thumbnailKey" TEXT,
    "exerciseId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VideoAsset_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoAssetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "model" TEXT,
    "rawOutput" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnalysisJob_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExerciseDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'default-coach',
    "analysisJobId" TEXT,
    "videoAssetId" TEXT,
    "payload" TEXT NOT NULL,
    "confidence" REAL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "appliedExerciseId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExerciseDraft_appliedExerciseId_fkey" FOREIGN KEY ("appliedExerciseId") REFERENCES "Exercise" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExerciseDraft_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "AnalysisJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ExerciseDraft_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Exercise_ownerId_category_idx" ON "Exercise"("ownerId", "category");

-- CreateIndex
CREATE INDEX "Exercise_ownerId_status_idx" ON "Exercise"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Exercise_name_idx" ON "Exercise"("name");

-- CreateIndex
CREATE INDEX "ExerciseTarget_target_idx" ON "ExerciseTarget"("target");

-- CreateIndex
CREATE INDEX "Tag_kind_idx" ON "Tag"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_kind_name_key" ON "Tag"("kind", "name");

-- CreateIndex
CREATE INDEX "ExerciseTag_tagId_idx" ON "ExerciseTag"("tagId");

-- CreateIndex
CREATE INDEX "MenuTemplate_ownerId_status_idx" ON "MenuTemplate"("ownerId", "status");

-- CreateIndex
CREATE INDEX "MenuTemplate_name_idx" ON "MenuTemplate"("name");

-- CreateIndex
CREATE INDEX "MenuTag_tagId_idx" ON "MenuTag"("tagId");

-- CreateIndex
CREATE INDEX "MenuBlock_menuTemplateId_sortOrder_idx" ON "MenuBlock"("menuTemplateId", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuItem_menuBlockId_sortOrder_idx" ON "MenuItem"("menuBlockId", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuItem_exerciseId_idx" ON "MenuItem"("exerciseId");

-- CreateIndex
CREATE INDEX "TrainingSession_ownerId_date_idx" ON "TrainingSession"("ownerId", "date");

-- CreateIndex
CREATE INDEX "TrainingSession_ownerId_status_idx" ON "TrainingSession"("ownerId", "status");

-- CreateIndex
CREATE INDEX "SessionItem_trainingSessionId_sortOrder_idx" ON "SessionItem"("trainingSessionId", "sortOrder");

-- CreateIndex
CREATE INDEX "SessionItem_exerciseId_idx" ON "SessionItem"("exerciseId");

-- CreateIndex
CREATE INDEX "VideoAsset_ownerId_createdAt_idx" ON "VideoAsset"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisJob_videoAssetId_idx" ON "AnalysisJob"("videoAssetId");

-- CreateIndex
CREATE INDEX "AnalysisJob_status_idx" ON "AnalysisJob"("status");

-- CreateIndex
CREATE INDEX "ExerciseDraft_ownerId_status_idx" ON "ExerciseDraft"("ownerId", "status");
