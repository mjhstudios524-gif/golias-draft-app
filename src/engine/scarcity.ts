import type { DraftState, PlayerPool, Pos, ScarcityItem } from "./types";
import { totalPicks } from "./snake";
import { availableSorted, draftedIdSet } from "./pool";
import { computeTeamNeeds } from "./roster";

/** Pure extraction of the legacy scarcity bar (~844-869): for QB/RB/WR/TE —
 * skipping positions not needed when needs are non-empty — how many players
 * remain in the best available player's tier. crit ≤2, warn ≤4. */
export function scarcitySummary(state: DraftState, pool: PlayerPool): ScarcityItem[] {
  if (state.picks.length + 1 > totalPicks(state.config)) return [];
  const available = availableSorted(pool, draftedIdSet(state.picks));
  const { neededPositions } = computeTeamNeeds(state, pool, state.config.myTeamId);
  const items: ScarcityItem[] = [];
  (["QB", "RB", "WR", "TE"] as Pos[]).forEach((pos) => {
    if (neededPositions.size > 0 && !neededPositions.has(pos)) return;
    const best = available.find((p) => p.pos === pos);
    if (!best) return;
    const tier = pool.tiers.get(best.id)!;
    const tierLeft = available.filter((p) => p.pos === pos && pool.tiers.get(p.id) === tier).length;
    const severity = tierLeft <= 2 ? "crit" : tierLeft <= 4 ? "warn" : "";
    items.push({ pos, tier, tierLeft, severity });
  });
  return items;
}
