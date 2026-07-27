-- CreateTable
CREATE TABLE "LeagueConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "statsHost" TEXT NOT NULL,
    "statsLeagueId" TEXT NOT NULL,
    "statsReferer" TEXT NOT NULL,
    "seasonFormat" TEXT NOT NULL,
    "currentSeason" TEXT NOT NULL,
    "espnPathSegment" TEXT NOT NULL,
    "sofaTournamentId" INTEGER,
    "betanoPathSegment" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LeagueBreak" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leagueId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "suppressLayoffFlag" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "LeagueBreak_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "LeagueConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leagueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "city" TEXT,
    "conference" TEXT,
    "logoUrl" TEXT,
    "paceRating" REAL,
    "offRating" REAL,
    "defRating" REAL,
    "ratingsAsOf" DATETIME,
    CONSTRAINT "Team_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "LeagueConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "teamId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalised" TEXT NOT NULL,
    "source" TEXT,
    CONSTRAINT "TeamAlias_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leagueId" TEXT NOT NULL,
    "teamId" TEXT,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "suffix" TEXT,
    "normalised" TEXT NOT NULL,
    "position" TEXT,
    "jerseyNumber" TEXT,
    "headshotUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Player_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "LeagueConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlayerAlias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalised" TEXT NOT NULL,
    "source" TEXT,
    CONSTRAINT "PlayerAlias_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "playerId" TEXT,
    "teamId" TEXT,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "rawName" TEXT NOT NULL,
    "matchConfidence" REAL NOT NULL DEFAULT 1.0,
    "matchMethod" TEXT NOT NULL,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceIdentity_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Fixture" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leagueId" TEXT NOT NULL,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "venue" TEXT,
    "season" TEXT NOT NULL,
    "reconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "reconciliationScore" REAL,
    "timeDeltaMinutes" INTEGER,
    "isBackToBackHome" BOOLEAN NOT NULL DEFAULT false,
    "isBackToBackAway" BOOLEAN NOT NULL DEFAULT false,
    "spread" REAL,
    "total" REAL,
    CONSTRAINT "Fixture_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "LeagueConfig" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Fixture_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Fixture_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "Team" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FixtureSourceLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fixtureId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "rawPayload" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FixtureSourceLink_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlayerGameLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "fixtureId" TEXT,
    "gameDate" DATETIME NOT NULL,
    "opponentAbbr" TEXT NOT NULL,
    "isHome" BOOLEAN NOT NULL,
    "won" BOOLEAN,
    "minutes" REAL NOT NULL,
    "points" INTEGER NOT NULL,
    "assists" INTEGER NOT NULL,
    "rebounds" INTEGER NOT NULL,
    "offRebounds" INTEGER,
    "defRebounds" INTEGER,
    "threesMade" INTEGER NOT NULL,
    "threesAtt" INTEGER,
    "fgm" INTEGER,
    "fga" INTEGER,
    "ftm" INTEGER,
    "fta" INTEGER,
    "steals" INTEGER,
    "blocks" INTEGER,
    "turnovers" INTEGER,
    "plusMinus" INTEGER,
    "didNotPlay" BOOLEAN NOT NULL DEFAULT false,
    "dnpReason" TEXT,
    "startedGame" BOOLEAN,
    "source" TEXT NOT NULL,
    "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerGameLog_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlayerGameLog_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InjuryStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "playerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "detail" TEXT,
    "source" TEXT NOT NULL,
    "reportedAt" DATETIME NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "InjuryStatus_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PropLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fixtureId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "line" REAL NOT NULL,
    "overOdds" REAL,
    "underOdds" REAL,
    "isMainLine" BOOLEAN NOT NULL DEFAULT false,
    "bookmaker" TEXT NOT NULL DEFAULT 'BETANO_NG',
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawMarketName" TEXT,
    CONSTRAINT "PropLine_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PropLine_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "leagueId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "windowStart" DATETIME NOT NULL,
    "windowEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "scoringVersion" TEXT NOT NULL,
    "fixturesConsidered" INTEGER NOT NULL DEFAULT 0,
    "playersConsidered" INTEGER NOT NULL DEFAULT 0,
    "playersExcluded" INTEGER NOT NULL DEFAULT 0,
    "recommendationsEmitted" INTEGER NOT NULL DEFAULT 0,
    "sourceErrors" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "durationMs" INTEGER
);

-- CreateTable
CREATE TABLE "PlayerExclusion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "playerId" TEXT,
    "rawName" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlayerExclusion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlayerExclusion_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlayerExclusion_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'OVER',
    "recommendedLine" REAL NOT NULL,
    "betanoMinLine" REAL NOT NULL,
    "betanoMaxLine" REAL NOT NULL,
    "offeredOdds" REAL,
    "selectionMode" TEXT NOT NULL,
    "meanWeighted" REAL NOT NULL,
    "meanSimple" REAL NOT NULL,
    "stdDev" REAL NOT NULL,
    "hitsL5" INTEGER NOT NULL,
    "gamesL5" INTEGER NOT NULL,
    "pushesL5" INTEGER NOT NULL DEFAULT 0,
    "hitsL10" INTEGER NOT NULL,
    "gamesL10" INTEGER NOT NULL,
    "hitRateL5" REAL NOT NULL,
    "hitRateL10" REAL NOT NULL,
    "seasonMean" REAL,
    "confidence" REAL NOT NULL,
    "tier" TEXT NOT NULL,
    "scoringVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "voidReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Recommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Recommendation_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "Fixture" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Recommendation_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecommendationFactor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recommendationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "weight" REAL,
    "contribution" REAL,
    "note" TEXT,
    CONSTRAINT "RecommendationFactor_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SettlementResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recommendationId" TEXT NOT NULL,
    "actualValue" REAL NOT NULL,
    "outcome" TEXT NOT NULL,
    "minutesPlayed" REAL,
    "settledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SettlementResult_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "paramsHash" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "shapeHash" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ScrapeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "tier" TEXT,
    "success" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "itemCount" INTEGER,
    "errorMessage" TEXT,
    "shapeChanged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EntityReviewItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "rawName" TEXT NOT NULL,
    "rawTeam" TEXT,
    "fixtureId" TEXT,
    "candidates" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedToId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ScoringConfigVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "JobExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobName" TEXT NOT NULL,
    "fixtureId" TEXT,
    "leagueId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "error" TEXT
);

-- CreateIndex
CREATE INDEX "LeagueBreak_leagueId_startsAt_idx" ON "LeagueBreak"("leagueId", "startsAt");

-- CreateIndex
CREATE INDEX "Team_leagueId_name_idx" ON "Team"("leagueId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_leagueId_abbreviation_key" ON "Team"("leagueId", "abbreviation");

-- CreateIndex
CREATE INDEX "TeamAlias_normalised_idx" ON "TeamAlias"("normalised");

-- CreateIndex
CREATE UNIQUE INDEX "TeamAlias_normalised_source_key" ON "TeamAlias"("normalised", "source");

-- CreateIndex
CREATE INDEX "Player_leagueId_normalised_idx" ON "Player"("leagueId", "normalised");

-- CreateIndex
CREATE INDEX "Player_teamId_idx" ON "Player"("teamId");

-- CreateIndex
CREATE INDEX "PlayerAlias_normalised_idx" ON "PlayerAlias"("normalised");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerAlias_normalised_source_key" ON "PlayerAlias"("normalised", "source");

-- CreateIndex
CREATE INDEX "SourceIdentity_playerId_idx" ON "SourceIdentity"("playerId");

-- CreateIndex
CREATE INDEX "SourceIdentity_source_rawName_idx" ON "SourceIdentity"("source", "rawName");

-- CreateIndex
CREATE UNIQUE INDEX "SourceIdentity_source_externalId_entityType_key" ON "SourceIdentity"("source", "externalId", "entityType");

-- CreateIndex
CREATE INDEX "Fixture_leagueId_startsAt_idx" ON "Fixture"("leagueId", "startsAt");

-- CreateIndex
CREATE INDEX "Fixture_startsAt_status_idx" ON "Fixture"("startsAt", "status");

-- CreateIndex
CREATE INDEX "FixtureSourceLink_fixtureId_idx" ON "FixtureSourceLink"("fixtureId");

-- CreateIndex
CREATE UNIQUE INDEX "FixtureSourceLink_source_externalId_key" ON "FixtureSourceLink"("source", "externalId");

-- CreateIndex
CREATE INDEX "PlayerGameLog_playerId_gameDate_idx" ON "PlayerGameLog"("playerId", "gameDate" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "PlayerGameLog_playerId_gameDate_source_key" ON "PlayerGameLog"("playerId", "gameDate", "source");

-- CreateIndex
CREATE INDEX "InjuryStatus_playerId_isCurrent_idx" ON "InjuryStatus"("playerId", "isCurrent");

-- CreateIndex
CREATE INDEX "InjuryStatus_capturedAt_idx" ON "InjuryStatus"("capturedAt");

-- CreateIndex
CREATE INDEX "PropLine_fixtureId_playerId_market_idx" ON "PropLine"("fixtureId", "playerId", "market");

-- CreateIndex
CREATE INDEX "PropLine_capturedAt_idx" ON "PropLine"("capturedAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_leagueId_startedAt_idx" ON "AnalysisRun"("leagueId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "PlayerExclusion_runId_reason_idx" ON "PlayerExclusion"("runId", "reason");

-- CreateIndex
CREATE INDEX "Recommendation_runId_confidence_idx" ON "Recommendation"("runId", "confidence" DESC);

-- CreateIndex
CREATE INDEX "Recommendation_fixtureId_market_idx" ON "Recommendation"("fixtureId", "market");

-- CreateIndex
CREATE INDEX "Recommendation_status_createdAt_idx" ON "Recommendation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationFactor_recommendationId_idx" ON "RecommendationFactor"("recommendationId");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementResult_recommendationId_key" ON "SettlementResult"("recommendationId");

-- CreateIndex
CREATE INDEX "SourceCache_expiresAt_idx" ON "SourceCache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceCache_source_endpoint_paramsHash_key" ON "SourceCache"("source", "endpoint", "paramsHash");

-- CreateIndex
CREATE INDEX "ScrapeLog_source_createdAt_idx" ON "ScrapeLog"("source", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "EntityReviewItem_status_createdAt_idx" ON "EntityReviewItem"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScoringConfigVersion_version_key" ON "ScoringConfigVersion"("version");

-- CreateIndex
CREATE INDEX "JobExecution_jobName_fixtureId_idx" ON "JobExecution"("jobName", "fixtureId");

-- CreateIndex
CREATE INDEX "JobExecution_startedAt_idx" ON "JobExecution"("startedAt");
