-- CreateEnum
CREATE TYPE "DraftMode" AS ENUM ('MOCK', 'MANUAL', 'SLEEPER_SYNC');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('IN_PROGRESS', 'COMPLETE', 'ABANDONED');

-- CreateEnum
CREATE TYPE "PickSource" AS ENUM ('USER', 'AUTOPICK', 'PROVIDER');

-- CreateEnum
CREATE TYPE "Pos" AS ENUM ('QB', 'RB', 'WR', 'TE', 'K', 'DEF');

-- CreateEnum
CREATE TYPE "SetKind" AS ENUM ('PRESET', 'UPLOAD');

-- CreateEnum
CREATE TYPE "SetStatus" AS ENUM ('DRAFT', 'READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DataTier" AS ENUM ('RANK_ONLY', 'POINTS', 'FULL_STATS');

-- CreateEnum
CREATE TYPE "AdpContext" AS ENUM ('ONE_QB', 'SUPERFLEX', 'UNKNOWN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "sleeperUserId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "stripeCheckoutSessionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "amountTotal" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "sleeperId" TEXT,
    "fullName" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "suffix" TEXT,
    "pos" "Pos" NOT NULL,
    "nflTeam" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "injuryStatus" TEXT,
    "isTeamDefense" BOOLEAN NOT NULL DEFAULT false,
    "espnId" TEXT,
    "yahooId" TEXT,
    "gsisId" TEXT,
    "sportradarId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerAlias" (
    "id" TEXT NOT NULL,
    "aliasKey" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "PlayerAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamBye" (
    "seasonYear" INTEGER NOT NULL,
    "teamCode" TEXT NOT NULL,
    "week" INTEGER NOT NULL,

    CONSTRAINT "TeamBye_pkey" PRIMARY KEY ("seasonYear","teamCode")
);

-- CreateTable
CREATE TABLE "League" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerLeagueId" TEXT,
    "numTeams" INTEGER NOT NULL,
    "scoring" JSONB NOT NULL,
    "rosterSpec" JSONB NOT NULL,
    "rankingSetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "League_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankingSet" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "kind" "SetKind" NOT NULL,
    "status" "SetStatus" NOT NULL DEFAULT 'DRAFT',
    "dataTier" "DataTier" NOT NULL,
    "formatTag" TEXT NOT NULL,
    "adpContext" "AdpContext" NOT NULL DEFAULT 'UNKNOWN',
    "headerFingerprint" TEXT,
    "columnMap" JSONB,
    "rawCsv" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankingSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankingEntry" (
    "id" TEXT NOT NULL,
    "rankingSetId" TEXT NOT NULL,
    "playerId" TEXT,
    "rawName" TEXT NOT NULL,
    "team" TEXT,
    "pos" "Pos",
    "rank" INTEGER,
    "adp" DOUBLE PRECISION,
    "projPoints" DOUBLE PRECISION,
    "stats" JSONB,
    "matchMethod" TEXT NOT NULL,
    "matchConfidence" DOUBLE PRECISION,
    "sourceRow" INTEGER NOT NULL,

    CONSTRAINT "RankingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "headerFingerprint" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MappingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "mode" "DraftMode" NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "config" JSONB NOT NULL,
    "queuedPlayerIds" JSONB NOT NULL DEFAULT '[]',
    "recPositions" JSONB NOT NULL DEFAULT '["QB","RB","WR","TE","DEF","K"]',
    "providerDraftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pick" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "overall" INTEGER NOT NULL,
    "teamSlot" INTEGER NOT NULL,
    "playerId" TEXT NOT NULL,
    "source" "PickSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftSync" (
    "sessionId" TEXT NOT NULL,
    "providerStatus" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "ttlSec" INTEGER NOT NULL,
    "etagPicks" TEXT,
    "etagDraft" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "nextAllowedAt" TIMESTAMP(3),

    CONSTRAINT "DraftSync_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "AdpSnapshot" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "teams" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "totalDrafts" INTEGER NOT NULL,
    "entries" JSONB NOT NULL,

    CONSTRAINT "AdpSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSyncRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'players',
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "etag" TEXT,
    "changed" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,

    CONSTRAINT "PlayerSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_stripeCheckoutSessionId_key" ON "Entitlement"("stripeCheckoutSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_stripePaymentIntentId_key" ON "Entitlement"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Entitlement_userId_idx" ON "Entitlement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_userId_product_key" ON "Entitlement"("userId", "product");

-- CreateIndex
CREATE UNIQUE INDEX "Player_sleeperId_key" ON "Player"("sleeperId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_espnId_key" ON "Player"("espnId");

-- CreateIndex
CREATE UNIQUE INDEX "Player_yahooId_key" ON "Player"("yahooId");

-- CreateIndex
CREATE INDEX "Player_nameKey_pos_idx" ON "Player"("nameKey", "pos");

-- CreateIndex
CREATE INDEX "Player_pos_nflTeam_idx" ON "Player"("pos", "nflTeam");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerAlias_aliasKey_scope_key" ON "PlayerAlias"("aliasKey", "scope");

-- CreateIndex
CREATE INDEX "League_userId_idx" ON "League"("userId");

-- CreateIndex
CREATE INDEX "RankingSet_userId_seasonYear_idx" ON "RankingSet"("userId", "seasonYear");

-- CreateIndex
CREATE UNIQUE INDEX "RankingSet_groupId_version_key" ON "RankingSet"("groupId", "version");

-- CreateIndex
CREATE INDEX "RankingEntry_rankingSetId_idx" ON "RankingEntry"("rankingSetId");

-- CreateIndex
CREATE UNIQUE INDEX "RankingEntry_rankingSetId_playerId_key" ON "RankingEntry"("rankingSetId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "MappingProfile_userId_headerFingerprint_key" ON "MappingProfile"("userId", "headerFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "DraftSession_providerDraftId_key" ON "DraftSession"("providerDraftId");

-- CreateIndex
CREATE INDEX "DraftSession_userId_status_idx" ON "DraftSession"("userId", "status");

-- CreateIndex
CREATE INDEX "Pick_sessionId_idx" ON "Pick"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Pick_sessionId_overall_key" ON "Pick"("sessionId", "overall");

-- CreateIndex
CREATE UNIQUE INDEX "AdpSnapshot_source_format_teams_key" ON "AdpSnapshot"("source", "format", "teams");

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "League" ADD CONSTRAINT "League_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankingSet" ADD CONSTRAINT "RankingSet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RankingEntry" ADD CONSTRAINT "RankingEntry_rankingSetId_fkey" FOREIGN KEY ("rankingSetId") REFERENCES "RankingSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftSession" ADD CONSTRAINT "DraftSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftSession" ADD CONSTRAINT "DraftSession_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "League"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pick" ADD CONSTRAINT "Pick_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DraftSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftSync" ADD CONSTRAINT "DraftSync_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DraftSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
