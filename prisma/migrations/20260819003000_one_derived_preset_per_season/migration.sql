-- One derived preset board per (derivedFrom, seasonYear). NULL derivedFrom
-- (every user upload) is exempt: Postgres permits unlimited NULLs in a unique
-- index. Guards deriveAdpPresets' check-then-refresh against duplicate boards
-- from a retried or overlapping cron run.
CREATE UNIQUE INDEX "RankingSet_derivedFrom_seasonYear_key" ON "RankingSet"("derivedFrom", "seasonYear");
