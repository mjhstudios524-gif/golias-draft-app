import "server-only";
import { z } from "zod";
import type { DraftSession, Pick as DbPick } from "@/generated/prisma/client";
import type { DraftConfig, EnginePlayer, Pos } from "@/engine/types";
import type { SessionPayload } from "@/stores/draftStore";

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

export function buildSessionPayload(
  session: DraftSession,
  picks: Pick<DbPick, "overall" | "teamSlot" | "playerId">[],
): SessionPayload {
  const snap = snapshotV1.parse(session.config);
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
  };
  return {
    sessionId: session.id,
    mode: session.mode,
    config,
    players: snap.players as EnginePlayer[],
    picks: picks.map((p) => ({ overall: p.overall, teamSlot: p.teamSlot, playerId: p.playerId })),
    queue: z.array(z.string()).catch([]).parse(session.queuedPlayerIds),
    recPos: z.array(posSchema).catch(["QB", "RB", "WR", "TE", "DEF", "K"]).parse(session.recPositions) as Pos[],
    rngSeed: snap.rngSeed,
  };
}
