-- AlterTable
ALTER TABLE "MenuTemplate" ADD COLUMN "runningContextJson" TEXT;

-- CreateTable
CREATE TABLE "Competition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL DEFAULT 'default-coach',
    "name" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "endDate" DATETIME,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MenuItem" (
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
    "prescriptionKind" TEXT NOT NULL DEFAULT 'LEGACY',
    "runningMethod" TEXT,
    "sessionTemplateId" TEXT,
    "recoveryStructure" TEXT,
    "buildUpDistanceMeters" REAL,
    "flyZoneDistanceMeters" REAL,
    "setRestSeconds" INTEGER,
    "intraRepRestSeconds" INTEGER,
    "intensityReferenceKind" TEXT,
    "prescriptionConfidence" TEXT,
    "ruleSetVersion" TEXT,
    "ruleSetContentHash" TEXT,
    "prescriptionJson" TEXT,
    "provenanceJson" TEXT,
    "rationale" TEXT,
    CONSTRAINT "MenuItem_menuBlockId_fkey" FOREIGN KEY ("menuBlockId") REFERENCES "MenuBlock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MenuItem_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MenuItem" ("displayName", "distanceMeters", "durationSeconds", "exerciseId", "id", "intensityPercent", "loadKg", "menuBlockId", "note", "reps", "restSeconds", "sets", "sortOrder") SELECT "displayName", "distanceMeters", "durationSeconds", "exerciseId", "id", "intensityPercent", "loadKg", "menuBlockId", "note", "reps", "restSeconds", "sets", "sortOrder" FROM "MenuItem";
DROP TABLE "MenuItem";
ALTER TABLE "new_MenuItem" RENAME TO "MenuItem";
CREATE INDEX "MenuItem_menuBlockId_sortOrder_idx" ON "MenuItem"("menuBlockId", "sortOrder");
CREATE INDEX "MenuItem_exerciseId_idx" ON "MenuItem"("exerciseId");
CREATE INDEX "MenuItem_prescriptionKind_runningMethod_idx" ON "MenuItem"("prescriptionKind", "runningMethod");
CREATE TABLE "new_SessionItem" (
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
    "prescriptionKind" TEXT NOT NULL DEFAULT 'LEGACY',
    "runningMethod" TEXT,
    "sessionTemplateId" TEXT,
    "recoveryStructure" TEXT,
    "plannedBuildUpDistanceMeters" REAL,
    "plannedFlyZoneDistanceMeters" REAL,
    "plannedSetRestSeconds" INTEGER,
    "plannedIntraRepRestSeconds" INTEGER,
    "plannedIntensityReferenceKind" TEXT,
    "plannedPrescriptionConfidence" TEXT,
    "ruleSetVersion" TEXT,
    "ruleSetContentHash" TEXT,
    "plannedPrescriptionJson" TEXT,
    "plannedProvenanceJson" TEXT,
    "plannedRationale" TEXT,
    "loadCategory" TEXT,
    "actualRepLogJson" TEXT,
    "actualHighSpeedExposureJson" TEXT,
    "stopReason" TEXT,
    "safetyOutcome" TEXT,
    "readinessActionsJson" TEXT,
    CONSTRAINT "SessionItem_trainingSessionId_fkey" FOREIGN KEY ("trainingSessionId") REFERENCES "TrainingSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SessionItem_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SessionItem" ("actualDistanceMeters", "actualDurationSeconds", "actualLoadKg", "actualNote", "actualReps", "actualSets", "blockNameSnapshot", "done", "exerciseId", "exerciseNameSnapshot", "id", "plannedDistanceMeters", "plannedDurationSeconds", "plannedIntensityPercent", "plannedLoadKg", "plannedNote", "plannedReps", "plannedRestSeconds", "plannedSets", "sortOrder", "trainingSessionId") SELECT "actualDistanceMeters", "actualDurationSeconds", "actualLoadKg", "actualNote", "actualReps", "actualSets", "blockNameSnapshot", "done", "exerciseId", "exerciseNameSnapshot", "id", "plannedDistanceMeters", "plannedDurationSeconds", "plannedIntensityPercent", "plannedLoadKg", "plannedNote", "plannedReps", "plannedRestSeconds", "plannedSets", "sortOrder", "trainingSessionId" FROM "SessionItem";
DROP TABLE "SessionItem";
ALTER TABLE "new_SessionItem" RENAME TO "SessionItem";
CREATE INDEX "SessionItem_trainingSessionId_sortOrder_idx" ON "SessionItem"("trainingSessionId", "sortOrder");
CREATE INDEX "SessionItem_exerciseId_idx" ON "SessionItem"("exerciseId");
CREATE INDEX "SessionItem_trainingSessionId_loadCategory_idx" ON "SessionItem"("trainingSessionId", "loadCategory");
CREATE TABLE "new_TrainingSession" (
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
    "sessionKind" TEXT NOT NULL DEFAULT 'TRAINING',
    "competitionId" TEXT,
    "planningSnapshotJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TrainingSession_sourceMenuTemplateId_fkey" FOREIGN KEY ("sourceMenuTemplateId") REFERENCES "MenuTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TrainingSession_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_TrainingSession" ("coachNote", "condition", "createdAt", "date", "groupName", "id", "location", "ownerId", "sourceMenuNameSnapshot", "sourceMenuTemplateId", "status", "title", "updatedAt", "weather") SELECT "coachNote", "condition", "createdAt", "date", "groupName", "id", "location", "ownerId", "sourceMenuNameSnapshot", "sourceMenuTemplateId", "status", "title", "updatedAt", "weather" FROM "TrainingSession";
DROP TABLE "TrainingSession";
ALTER TABLE "new_TrainingSession" RENAME TO "TrainingSession";
CREATE INDEX "TrainingSession_ownerId_date_idx" ON "TrainingSession"("ownerId", "date");
CREATE INDEX "TrainingSession_ownerId_status_idx" ON "TrainingSession"("ownerId", "status");
CREATE INDEX "TrainingSession_ownerId_sessionKind_date_idx" ON "TrainingSession"("ownerId", "sessionKind", "date");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Competition_ownerId_date_idx" ON "Competition"("ownerId", "date");
