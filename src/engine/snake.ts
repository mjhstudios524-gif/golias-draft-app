import type { DraftConfig, DraftState, Pick, RosterSpec } from "./types";

// Legacy source: draft-room.html ~604-692.

export function totalRounds(spec: RosterSpec): number {
  return spec.QB + spec.RB + spec.WR + spec.TE + spec.FLEX + spec.DEF + spec.K + spec.BN;
}

export function totalPicks(config: DraftConfig): number {
  return totalRounds(config.rosterSpec) * config.numTeams;
}

/** Pure snake: odd rounds walk teamOrder forward, even rounds reverse.
 * No bounds guard, matching legacy — callers cap `overall` themselves. */
export function pickForOverall(
  config: DraftConfig,
  overall: number,
): { round: number; pickInRound: number; teamId: number } {
  const n = config.numTeams;
  const round = Math.ceil(overall / n);
  const pickInRound = overall - (round - 1) * n;
  const order = config.teamOrder;
  const teamId = round % 2 === 1 ? order[pickInRound - 1] : order[n - pickInRound];
  return { round, pickInRound, teamId };
}

/** Overall → owning teamId for every pick, 0-indexed (index overall-1).
 * The provider path builds the same array honoring 3RR/traded picks (PLAN.md §8),
 * making everything downstream source-agnostic. */
export function buildPickOwnerByOverall(config: DraftConfig): number[] {
  const total = totalPicks(config);
  const owners = new Array<number>(total);
  for (let o = 1; o <= total; o++) owners[o - 1] = pickForOverall(config, o).teamId;
  return owners;
}

export function currentOverall(picks: Pick[]): number {
  return picks.length + 1;
}

export function isOnClock(state: DraftState, teamId: number): boolean {
  const overall = currentOverall(state.picks);
  if (overall > totalPicks(state.config)) return false;
  return pickForOverall(state.config, overall).teamId === teamId;
}

/** Next overall at which `teamId` picks; null when draft complete or the team
 * never picks again. Starts at cur+1 when the team is already on the clock. */
export function nextPickFor(state: DraftState, teamId: number): number | null {
  const cur = currentOverall(state.picks);
  const total = totalPicks(state.config);
  if (cur > total) return null;
  const start = isOnClock(state, teamId) ? cur + 1 : cur;
  for (let o = start; o <= total; o++) {
    if (pickForOverall(state.config, o).teamId === teamId) return o;
  }
  return null;
}

/** How many players other teams will take before `teamId` is on the clock again. */
export function picksUntilTurn(state: DraftState, teamId: number): number | null {
  const cur = currentOverall(state.picks);
  const nxt = nextPickFor(state, teamId);
  if (nxt == null) return null;
  return isOnClock(state, teamId) ? nxt - cur - 1 : nxt - cur;
}
