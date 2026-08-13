import type {
  AdpContext,
  EnginePlayer,
  FlexEligibility,
  Pos,
  RosterSpec,
  ScoringConfig,
  StatLine,
} from "@/engine/types";
import { computeValues, rankOnlyValues, type RankOnlyEntry, type ValueEntry } from "@/engine/value";
import { pointsFor } from "@/engine/scoring";
import { canonicalTeamCode } from "@/engine/teams";

// Pure snapshot-pool builder for createSession (PLAN.md §6/§7): RankingEntry
// rows → the frozen ValuedPlayer[] per data tier. Separated from the
// "use server" action so vitest pins the tier rules without a database.

export type SnapshotTier = "RANK_ONLY" | "POINTS" | "FULL_STATS";

/** Structural subset of a RankingEntry row (Prisma rows satisfy it as-is). */
export interface SnapshotSourceEntry {
  playerId: string | null;
  rawName: string;
  team: string | null;
  pos: Pos | null;
  rank: number | null;
  adp: number | null;
  projPoints: number | null;
  stats: unknown; // RankingEntry.stats Json — validated here
  matchMethod: string;
  sourceRow: number;
}

/** Structural subset of a Player row for matched entries. */
export interface MatchedPlayer {
  fullName: string;
  pos: Pos;
  nflTeam: string | null;
}

export interface SnapshotLeagueCtx {
  numTeams: number;
  rosterSpec: RosterSpec;
  flexEligibleBySlot: FlexEligibility;
  /** FULL_STATS only: prices each stat line under THIS league's scoring. */
  scoring: ScoringConfig;
}

export interface SnapshotPlayersResult {
  players: EnginePlayer[];
  /** Entries dropped for lacking the tier's required datum (PLAN.md §6). */
  skipped: number;
}

/** RankingSet.adpContext (Prisma enum) → engine AdpContext. */
export function mapAdpContext(dbValue: string): AdpContext {
  if (dbValue === "ONE_QB") return "1QB";
  if (dbValue === "SUPERFLEX") return "SF";
  return "UNKNOWN";
}

function toStatLine(raw: unknown): StatLine | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: StatLine = {};
  let any = false;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

interface IdentifiedBase {
  id: string;
  name: string;
  team: string;
  pos: Pos;
}

export function buildSnapshotPlayers(args: {
  setId: string;
  tier: SnapshotTier;
  entries: SnapshotSourceEntry[];
  matched: ReadonlyMap<string, MatchedPlayer>;
  ctx: SnapshotLeagueCtx;
}): SnapshotPlayersResult {
  const { setId, tier, entries, matched, ctx } = args;
  let skipped = 0;

  const identified: { base: IdentifiedBase; entry: SnapshotSourceEntry }[] = [];
  for (const entry of entries) {
    if (entry.playerId != null) {
      const p = matched.get(entry.playerId);
      if (!p) {
        skipped++; // matched row whose Player vanished — surface, never guess
        continue;
      }
      identified.push({
        base: { id: entry.playerId, name: p.fullName, team: p.nflTeam ?? "FA", pos: p.pos },
        entry,
      });
    } else if (entry.matchMethod === "UNLINKED") {
      // Unlinked entries stay first-class on the board (PLAN.md §6), but the
      // engine cannot slot a player without a position.
      if (entry.pos == null) {
        skipped++;
        continue;
      }
      identified.push({
        base: {
          id: `custom:${setId}:${entry.sourceRow}`,
          name: entry.rawName,
          team: canonicalTeamCode(entry.team) ?? "FA",
          pos: entry.pos,
        },
        entry,
      });
    }
    // any other unresolved/excluded row never reaches a draft board
  }

  if (tier === "RANK_ONLY") {
    const list: RankOnlyEntry[] = [];
    for (const { base, entry } of identified) {
      if (entry.rank == null || entry.rank < 1) {
        skipped++;
        continue;
      }
      list.push({ ...base, adp: entry.adp ?? null, sourceRank: entry.rank });
    }
    return { players: rankOnlyValues(list), skipped };
  }

  const list: ValueEntry[] = [];
  for (const { base, entry } of identified) {
    const projPoints =
      tier === "POINTS"
        ? entry.projPoints
        : (() => {
            const stats = toStatLine(entry.stats);
            return stats ? pointsFor(stats, ctx.scoring, base.pos) : null;
          })();
    if (projPoints == null || !Number.isFinite(projPoints)) {
      skipped++;
      continue;
    }
    list.push({ ...base, adp: entry.adp ?? null, projPoints });
  }
  return {
    players: computeValues(list, {
      numTeams: ctx.numTeams,
      rosterSpec: ctx.rosterSpec,
      flexEligibleBySlot: ctx.flexEligibleBySlot,
    }),
    skipped,
  };
}
