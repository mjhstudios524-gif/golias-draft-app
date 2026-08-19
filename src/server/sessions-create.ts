"use server";

import { z } from "zod";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { snapshotV1, type SnapshotV1 } from "@/server/sessions";
import {
  CURRENT_SEASON,
  readLeagueRosterSpec,
  scoringConfigSchema,
  type CreateSessionResult,
} from "@/lib/leagues";
import { buildSnapshotPlayers, mapAdpContext } from "@/server/snapshot-players";
import { adpFormatForLeague, latestAdpSnapshot } from "@/server/adp/sync";
import { leagueFormat } from "@/engine/format";
import type { AdpContext, EnginePlayer } from "@/engine/types";

// createSession (PLAN.md §7): resolves league + ranking set into the FROZEN
// snapshotV1 stored on DraftSession.config — mid-draft edits to either can
// never shift a live board.

const createSessionInput = z.object({
  userId: z.string().min(1),
  leagueId: z.string().min(1),
  mode: z.enum(["MOCK", "MANUAL"]),
  rankingSetId: z.string().min(1),
  myTeamId: z.number().int().min(1),
  teamOrder: z.array(z.number().int().min(1)),
  teamNames: z.record(z.string(), z.string()),
});

export async function createSession(raw: unknown): Promise<CreateSessionResult> {
  const userId = await requireUser();
  const parsed = createSessionInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid draft settings" };
  }
  const input = parsed.data;
  if (input.userId !== userId) return { ok: false, error: "User mismatch" };

  const league = await db.league.findUnique({ where: { id: input.leagueId } });
  if (!league || league.userId !== userId) return { ok: false, error: "League not found" };
  const roster = readLeagueRosterSpec(league.rosterSpec);
  if (!roster) {
    return { ok: false, error: "League roster settings are unreadable — re-save the league first" };
  }

  const n = league.numTeams;
  const sortedOrder = [...input.teamOrder].sort((a, b) => a - b);
  if (sortedOrder.length !== n || !sortedOrder.every((v, i) => v === i + 1)) {
    return { ok: false, error: "Draft order must include every team exactly once" };
  }
  if (input.myTeamId > n) return { ok: false, error: "Pick a seat inside the league" };

  const set = await db.rankingSet.findUnique({
    where: { id: input.rankingSetId },
    include: { entries: { orderBy: { sourceRow: "asc" } } },
  });
  if (!set || set.status !== "READY" || (set.userId != null && set.userId !== userId)) {
    return { ok: false, error: "That ranking set is not available (it must be READY)" };
  }

  const matchedIds = set.entries.flatMap((e) => (e.playerId ? [e.playerId] : []));
  const [playerRows, byeRows] = await Promise.all([
    matchedIds.length
      ? db.player.findMany({
          where: { id: { in: matchedIds } },
          select: { id: true, fullName: true, pos: true, nflTeam: true },
        })
      : Promise.resolve([]),
    db.teamBye.findMany({ where: { seasonYear: CURRENT_SEASON } }),
  ]);

  // FULL_STATS prices stat lines under this league's scoring; the other tiers
  // never read it (POINTS ships pre-priced, RANK_ONLY is strict legacy mode).
  let scoring: z.infer<typeof scoringConfigSchema> = { name: "unset", weights: {} };
  if (set.dataTier === "FULL_STATS") {
    const sc = scoringConfigSchema.safeParse(league.scoring);
    if (!sc.success) {
      return { ok: false, error: "League scoring settings are unreadable — re-save the league first" };
    }
    scoring = sc.data;
  }

  const built = buildSnapshotPlayers({
    setId: set.id,
    tier: set.dataTier,
    entries: set.entries,
    matched: new Map(playerRows.map((p) => [p.id, p])),
    ctx: {
      numTeams: n,
      rosterSpec: roster.spec,
      flexEligibleBySlot: roster.flexEligibleBySlot,
      scoring,
    },
  });
  const { skipped } = built;
  let players: EnginePlayer[] = built.players;
  if (players.length === 0) {
    return { ok: false, error: "That ranking set has no draftable players for this league" };
  }

  // Live-ADP attachment (PLAN.md §8a): only when the set carries NO ADP of its
  // own — an uploaded ADP column always keeps precedence. adpContext then comes
  // from the snapshot's market (SF board → 'SF'), not the set's declared context.
  let adpContext: AdpContext = mapAdpContext(set.adpContext);
  let adpSource: string | undefined;
  let adpFetchedAt: string | undefined;
  if (!set.entries.some((e) => e.adp != null)) {
    const format = adpFormatForLeague(
      leagueFormat(roster.spec, roster.flexEligibleBySlot),
      league.scoring,
    );
    const live = await latestAdpSnapshot(format);
    if (live) {
      players = players.map((p) => {
        const adp = live.adpByPlayerId.get(String(p.id));
        return adp !== undefined ? { ...p, adp } : p;
      });
      adpContext = format === "SF" ? "SF" : "1QB";
      adpSource = `${live.source}:${format}`;
      adpFetchedAt = live.fetchedAt.toISOString();
    }
  }

  const teamNames = Object.fromEntries(
    Array.from({ length: n }, (_, i) => {
      const id = i + 1;
      const name = input.teamNames[String(id)]?.trim();
      return [String(id), name || `Team ${id}`];
    }),
  );

  const snapshot: SnapshotV1 = snapshotV1.parse({
    v: 1,
    numTeams: n,
    teamOrder: input.teamOrder,
    teamNames,
    rosterSpec: roster.spec,
    flexEligibleBySlot: roster.flexEligibleBySlot,
    myTeamId: input.myTeamId,
    byeWeeks: Object.fromEntries(byeRows.map((b) => [b.teamCode, b.week])),
    adpContext,
    adpSource,
    adpFetchedAt,
    // A board derived FROM market ADP cannot be judged against it — freeze the
    // flag so the room suppresses the rank-vs-ADP signals (PLAN.md §6).
    adpDerived: set.derivedFrom != null ? true : undefined,
    rngSeed: Math.floor(Math.random() * 2 ** 31),
    players,
  });

  const session = await db.draftSession.create({
    data: { userId, leagueId: league.id, mode: input.mode, config: snapshot },
  });
  return { ok: true, sessionId: session.id, skippedEntries: skipped };
}
