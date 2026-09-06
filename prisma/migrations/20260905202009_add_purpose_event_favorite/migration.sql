-- CreateTable
CREATE TABLE "ExercisePurpose" (
    "exerciseId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,

    PRIMARY KEY ("exerciseId", "purpose"),
    CONSTRAINT "ExercisePurpose_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExerciseEvent" (
    "exerciseId" TEXT NOT NULL,
    "event" TEXT NOT NULL,

    PRIMARY KEY ("exerciseId", "event"),
    CONSTRAINT "ExerciseEvent_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "Exercise" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Exercise" (
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
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Exercise" ("category", "coachingPoint", "commonMistake", "createdAt", "defaultDistanceMeters", "defaultDurationSeconds", "defaultReps", "defaultRestSeconds", "defaultSets", "description", "difficulty", "id", "metricType", "name", "nameKana", "ownerId", "source", "status", "updatedAt", "videoUrl") SELECT "category", "coachingPoint", "commonMistake", "createdAt", "defaultDistanceMeters", "defaultDurationSeconds", "defaultReps", "defaultRestSeconds", "defaultSets", "description", "difficulty", "id", "metricType", "name", "nameKana", "ownerId", "source", "status", "updatedAt", "videoUrl" FROM "Exercise";
DROP TABLE "Exercise";
ALTER TABLE "new_Exercise" RENAME TO "Exercise";
CREATE INDEX "Exercise_ownerId_category_idx" ON "Exercise"("ownerId", "category");
CREATE INDEX "Exercise_ownerId_status_idx" ON "Exercise"("ownerId", "status");
CREATE INDEX "Exercise_ownerId_isFavorite_idx" ON "Exercise"("ownerId", "isFavorite");
CREATE INDEX "Exercise_name_idx" ON "Exercise"("name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ExercisePurpose_purpose_idx" ON "ExercisePurpose"("purpose");

-- CreateIndex
CREATE INDEX "ExerciseEvent_event_idx" ON "ExerciseEvent"("event");
