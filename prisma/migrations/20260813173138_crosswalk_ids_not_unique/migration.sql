-- DropIndex
DROP INDEX "Player_espnId_key";

-- DropIndex
DROP INDEX "Player_yahooId_key";

-- CreateIndex
CREATE INDEX "Player_espnId_idx" ON "Player"("espnId");

-- CreateIndex
CREATE INDEX "Player_yahooId_idx" ON "Player"("yahooId");
