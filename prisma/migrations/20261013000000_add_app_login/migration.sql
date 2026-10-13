-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "loginId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "AppSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_loginId_key" ON "AppUser"("loginId");

-- CreateIndex
CREATE INDEX "AppSession_userId_idx" ON "AppSession"("userId");

