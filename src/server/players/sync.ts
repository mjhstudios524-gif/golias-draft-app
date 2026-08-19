import "server-only";
import { z } from "zod";
import { db } from "@/server/db";
import { normalizeName, dstAliasKeys } from "@/lib/players/normalize";
import { canonicalTeamCode } from "@/engine/teams";

// Players-dump sync (PLAN.md §8): Sleeper mandates ≤1 call/day; the dump is
// ~14MB / ~12k entries. We keep the ~4.3k fantasy-relevant rows and ingest the
// 32 D/ST pseudo-players (player_id = team code). ETag short-circuit: 304 → no-op.

const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

const sleeperPlayer = z
  .object({
    player_id: z.string(),
    first_name: z.string().nullish(),
    last_name: z.string().nullish(),
    full_name: z.string().nullish(),
    position: z.string().nullish(),
    fantasy_positions: z.array(z.string()).nullish(),
    team: z.string().nullish(),
    active: z.boolean().nullish(),
    injury_status: z.string().nullish(),
    search_rank: z.number().nullish(),
    espn_id: z.union([z.string(), z.number()]).nullish(),
    yahoo_id: z.union([z.string(), z.number()]).nullish(),
    gsis_id: z.string().nullish(),
    sportradar_id: z.string().nullish(),
  })
  .loose();

// Sleeper's search_rank is a coarse popularity ordinal used only to extend
// derived preset boards past the ~250-player ADP pool. It is sparse and the
// dump parks unranked players at 9999999 — kept verbatim (they simply sort
// last) but clamped to int4 so an out-of-range value can never fail the write.
const MAX_INT4 = 2_147_483_647;

function toSearchRank(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return Math.min(Math.max(Math.trunc(raw), 0), MAX_INT4);
}

export interface PlayerSyncResult {
  ok: boolean;
  notModified: boolean;
  total: number;
  kept: number;
  upserted: number;
}

export async function syncPlayersFromSleeper(): Promise<PlayerSyncResult> {
  const lastRun = await db.playerSyncRun.findFirst({
    where: { kind: "players", ok: true },
    orderBy: { ranAt: "desc" },
  });

  const res = await fetch("https://api.sleeper.app/v1/players/nfl", {
    headers: lastRun?.etag ? { "If-None-Match": lastRun.etag } : {},
    // the dump is 14MB — never let Next cache it
    cache: "no-store",
  });

  if (res.status === 304) {
    await db.playerSyncRun.create({
      data: { kind: "players", etag: lastRun?.etag, changed: 0, total: 0, ok: true },
    });
    return { ok: true, notModified: true, total: 0, kept: 0, upserted: 0 };
  }
  if (!res.ok) {
    await db.playerSyncRun.create({ data: { kind: "players", changed: 0, total: 0, ok: false } });
    throw new Error(`sleeper players fetch failed: ${res.status}`);
  }
  const etag = res.headers.get("etag");
  const dump = (await res.json()) as Record<string, unknown>;
  const entries = Object.values(dump);

  type Row = {
    sleeperId: string;
    fullName: string;
    nameKey: string;
    suffix: string | null;
    pos: "QB" | "RB" | "WR" | "TE" | "K" | "DEF";
    nflTeam: string | null;
    active: boolean;
    injuryStatus: string | null;
    isTeamDefense: boolean;
    searchRank: number | null;
    espnId: string | null;
    yahooId: string | null;
    gsisId: string | null;
    sportradarId: string | null;
  };
  const rows: Row[] = [];
  const dstAliases: { aliasKey: string; playerSleeperId: string }[] = [];

  for (const raw of entries) {
    const parsed = sleeperPlayer.safeParse(raw);
    if (!parsed.success) continue;
    const p = parsed.data;
    const fantasyPos = (p.fantasy_positions ?? []).filter((x) => FANTASY_POS.has(x));
    const primary = FANTASY_POS.has(p.position ?? "") ? p.position! : fantasyPos[0];
    if (!primary) continue;

    const isDst = primary === "DEF" && p.player_id === p.team;
    const fullName = p.full_name ?? [p.first_name, p.last_name].filter(Boolean).join(" ");
    if (!fullName) continue;
    // keep active players + all DSTs; inactive skipped at seed (deactivation of
    // referenced rows is handled by never deleting — see plan §8)
    if (!isDst && p.active !== true) continue;

    const { nameKey, suffix } = normalizeName(fullName);
    rows.push({
      sleeperId: p.player_id,
      fullName,
      nameKey,
      suffix,
      pos: primary as Row["pos"],
      nflTeam: canonicalTeamCode(p.team ?? null),
      active: true,
      injuryStatus: p.injury_status ?? null,
      isTeamDefense: isDst,
      searchRank: toSearchRank(p.search_rank),
      espnId: p.espn_id != null ? String(p.espn_id) : null,
      yahooId: p.yahoo_id != null ? String(p.yahoo_id) : null,
      gsisId: p.gsis_id ?? null,
      sportradarId: p.sportradar_id ?? null,
    });

    if (isDst && p.first_name && p.last_name) {
      for (const aliasKey of dstAliasKeys(p.first_name, p.last_name, p.player_id)) {
        dstAliases.push({ aliasKey, playerSleeperId: p.player_id });
      }
    }
  }

  // Upsert in chunks keyed on sleeperId.
  let upserted = 0;
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.$transaction(
      chunk.map((r) =>
        db.player.upsert({
          where: { sleeperId: r.sleeperId },
          update: { ...r },
          create: { ...r },
        }),
      ),
    );
    upserted += chunk.length;
  }

  // GLOBAL alias rows for every DST naming variant → stage-0 matches.
  const dstPlayers = await db.player.findMany({
    where: { isTeamDefense: true },
    select: { id: true, sleeperId: true },
  });
  const idBySleeper = new Map(dstPlayers.map((p) => [p.sleeperId, p.id]));
  for (const a of dstAliases) {
    const playerId = idBySleeper.get(a.playerSleeperId);
    if (!playerId) continue;
    await db.playerAlias.upsert({
      where: { aliasKey_scope: { aliasKey: a.aliasKey, scope: "GLOBAL" } },
      update: { playerId },
      create: { aliasKey: a.aliasKey, playerId, scope: "GLOBAL", createdBy: "system:player-sync" },
    });
  }

  await db.playerSyncRun.create({
    data: { kind: "players", etag, changed: upserted, total: entries.length, ok: true },
  });

  return { ok: true, notModified: false, total: entries.length, kept: rows.length, upserted };
}
