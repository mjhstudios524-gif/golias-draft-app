import type { EnginePlayer, PlayerId, PlayerPool } from "./types";
import { computeTiers, type TierOptions } from "./tiers";

/** Build the immutable per-session pool: id lookup + tier map, computed once
 * (replaces legacy buildPlayersById ~1064 + its computeTiers side effect). */
export function buildPlayerPool(players: EnginePlayer[], tierOpts?: TierOptions): PlayerPool {
  const byId = new Map<PlayerId, EnginePlayer>();
  players.forEach((p) => byId.set(p.id, p));
  return { players, byId, tiers: computeTiers(players, tierOpts) };
}

/** Undrafted players sorted by overall ordinal. Legacy availableSortedByRank (~695). */
export function availableSorted(pool: PlayerPool, draftedIds: ReadonlySet<PlayerId>): EnginePlayer[] {
  return pool.players.filter((p) => !draftedIds.has(p.id)).sort((a, b) => a.rank - b.rank);
}

export function draftedIdSet(picks: { playerId: PlayerId }[]): Set<PlayerId> {
  return new Set(picks.map((p) => p.playerId));
}
