import "server-only";
import { z } from "zod";
import type { DraftSession, Pick as DbPick } from "@/generated/prisma/client";
import type { DraftConfig, EnginePlayer, Pos } from "@/engine/types";
import type { SessionPayload } from "@/stores/draftStore";
import { db } from "@/server/db";

const posSchema = z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** The frozen per-session config snapshot stored in DraftSession.config
 * (PLAN.md §7): everything the engine needs, resolved at creation time. */
export const snapshotV1 = z.object({
  v: z.literal(1),
  numTeams: z.number().int().min(2).max(20),
  teamOrder: z.array(z.number().int()),
  teamNames: z.record(z.string(), z.string()),
  rosterSpec: z.object({
    QB: z.number().int().min(0),
    RB: z.number().int().min(0),
    WR: z.number().int().min(0),
    TE: z.number().int().min(0),
    FLEX: z.number().int().min(0),
    DEF: z.number().int().min(0),
    K: z.number().int().min(0),
    BN: z.number().int().min(0),
  }),
  flexEligibleBySlot: z.array(z.array(posSchema)),
  myTeamId: z.number().int(),
  byeWeeks: z.record(z.string(), z.number().int()),
  adpContext: z.enum(["1QB", "SF", "UNKNOWN"]),
  adpSource: z.string().optional(), // 'ffc:FORMAT' when live ADP was attached (PLAN.md §8a)
  adpFetchedAt: z.string().optional(),
  // Set when the chosen ranking set was itself derived from market ADP
  // (RankingSet.derivedFrom): the room then suppresses the rank-vs-ADP signals
  // (PLAN.md §6). Absent on every pre-existing snapshot ⇒ legacy behavior.
  adpDerived: z.boolean().optional(),
  rngSeed: z.number().int(),
  players: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      team: z.string(),
      pos: posSchema,
      rank: z.number().int().min(1),
      adp: z.number().nullable(),
      projPoints: z.number().optional(),
      value: z.number().optional(),
    }),
  ),
});

export type SnapshotV1 = z.infer<typeof snapshotV1>;

export async function buildSessionPayload(
  session: DraftSession,
  picks: Pick<DbPick, "overall" | "teamSlot" | "playerId">[],
): Promise<SessionPayload> {
  const snap = snapshotV1.parse(session.config);

  // Ghost rows for picks the snapshot pool can't name — SLEEPER_SYNC boards
  // regularly contain players outside the user's ranking set. Canonical ids
  // resolve from the Player table; 'sleeper:<id>' sentinels from the sync
  // engine's stored render metadata. Ghosts are already-drafted, so
  // availability-derived math never sees them (mirrors the store-side
  // injection in applyProviderPicks).
  const known = new Set(snap.players.map((p) => p.id));
  const unknown = picks.filter((p) => !known.has(p.playerId));
  const ghosts: SnapshotV1["players"] = [];
  if (unknown.length > 0) {
    const canonicalIds = unknown.filter((p) => !p.playerId.startsWith("sleeper:")).map((p) => p.playerId);
    const dbPlayers = canonicalIds.length
      ? await db.player.findMany({
          where: { id: { in: canonicalIds } },
          select: { id: true, fullName: true, nflTeam: true, pos: true },
        })
      : [];
    const byId = new Map(dbPlayers.map((p) => [p.id, p]));
    let sentinelMeta: Record<string, { name: string; pos: string | null; team: string | null }> = {};
    if (unknown.some((p) => p.playerId.startsWith("sleeper:"))) {
      const sync = await db.draftSync.findUnique({
        where: { sessionId: session.id },
        select: { etagDraft: true },
      });
      try {
        sentinelMeta = JSON.parse(sync?.etagDraft ?? "{}").unresolved ?? {};
      } catch {
        // scratch state unreadable — sentinels fall back to placeholder names
      }
    }
    const VALID_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
    for (const p of unknown) {
      const hit = byId.get(p.playerId);
      const meta = sentinelMeta[p.playerId];
      const pos = hit?.pos ?? (meta?.pos && VALID_POS.has(meta.pos) ? meta.pos : "WR");
      ghosts.push({
        id: p.playerId,
        name: hit?.fullName ?? meta?.name ?? "Sleeper player",
        team: hit?.nflTeam ?? meta?.team ?? "FA",
        pos: pos as SnapshotV1["players"][number]["pos"],
        rank: 9000 + p.overall,
        adp: null,
      });
    }
  }
  const config: DraftConfig = {
    numTeams: snap.numTeams,
    teamOrder: snap.teamOrder,
    teamNames: Object.fromEntries(
      Object.entries(snap.teamNames).map(([k, v]) => [Number(k), v]),
    ) as Record<number, string>,
    rosterSpec: snap.rosterSpec,
    flexEligibleBySlot: snap.flexEligibleBySlot,
    myTeamId: snap.myTeamId,
    mockDraft: session.mode === "MOCK",
    byeWeeks: snap.byeWeeks,
    adpContext: snap.adpContext,
    ...(snap.adpDerived === true && { adpDerived: true as const }),
  };
  return {
    sessionId: session.id,
    mode: session.mode,
    config,
    players: [...snap.players, ...ghosts] as EnginePlayer[],
    picks: picks.map((p) => ({ overall: p.overall, teamSlot: p.teamSlot, playerId: p.playerId })),
    queue: z.array(z.string()).catch([]).parse(session.queuedPlayerIds),
    recPos: z.array(posSchema).catch(["QB", "RB", "WR", "TE", "DEF", "K"]).parse(session.recPositions) as Pos[],
    rngSeed: snap.rngSeed,
  };
}
