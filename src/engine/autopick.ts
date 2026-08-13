import type { DraftState, EnginePlayer, PlayerPool, Rng } from "./types";
import { pickForOverall, totalPicks, isOnClock } from "./snake";
import { draftedIdSet } from "./pool";
import { computeTeamNeeds } from "./roster";
import { applyPick, undoLastUserTurn } from "./draft";

// Legacy source: draft-room.html ~969-1017. RNG call ORDER is part of the
// contract — seeded streams must align with the legacy engine exactly:
// one draw for the sleeper roll, then EITHER one draw for the sleeper index
// OR one draw for the top-N cumulative walk.

/**
 * pool is sorted best-rank-first. 8% "sleeper reach" uniformly over indices
 * [min(8,len-1), min(28,len-1)] (only when pool > 8); otherwise weighted top-4
 * (0.55/0.24/0.13/0.08), implicitly renormalized for shorter pools via the
 * r <= acc cumulative walk (idx defaults to 0).
 */
export function weightedPick(pool: EnginePlayer[], rng: Rng): EnginePlayer | null {
  if (pool.length === 0) return null;
  const roll = rng();
  if (roll < 0.08 && pool.length > 8) {
    const lo = Math.min(8, pool.length - 1);
    const hi = Math.min(28, pool.length - 1);
    const idx = lo + Math.floor(rng() * (hi - lo + 1));
    return pool[idx];
  }
  const topN = Math.min(4, pool.length);
  const weights = [0.55, 0.24, 0.13, 0.08].slice(0, topN);
  const total = weights.reduce((a, b) => a + b, 0);
  const r = rng() * total;
  let acc = 0,
    idx = 0;
  for (let i = 0; i < topN; i++) {
    acc += weights[i];
    if (r <= acc) {
      idx = i;
      break;
    }
  }
  return pool[idx];
}

/** Needs-filtered (fallback to all when the filter empties it), rank-sorted, weighted pick. */
export function autoPickForTeam(
  state: DraftState,
  pool: PlayerPool,
  teamId: number,
  rng: Rng,
): EnginePlayer | null {
  const drafted = draftedIdSet(state.picks);
  const available = pool.players.filter((p) => !drafted.has(p.id));
  const { neededPositions } = computeTeamNeeds(state, pool, teamId);
  let candidates: EnginePlayer[];
  if (neededPositions.size > 0) {
    candidates = available.filter((p) => neededPositions.has(p.pos));
    if (candidates.length === 0) candidates = available.slice();
  } else {
    candidates = available.slice();
  }
  candidates.sort((a, b) => a.rank - b.rank);
  return weightedPick(candidates, rng);
}

/**
 * Draft silently for every non-user team until the user's turn, draft end, or
 * pool exhaustion (silent halt — pinned legacy behavior; guard 5000).
 */
export function runAutoPicks(state: DraftState, pool: PlayerPool, rng: Rng): DraftState {
  let cur = state;
  let guard = 0;
  while (guard++ < 5000) {
    const overall = cur.picks.length + 1;
    if (overall > totalPicks(cur.config)) break;
    const { teamId } = pickForOverall(cur.config, overall);
    if (teamId === cur.config.myTeamId) break;
    const pick = autoPickForTeam(cur, pool, teamId, rng);
    if (!pick) break;
    cur = applyPick(cur, pick.id, pool);
  }
  return cur;
}

/**
 * Mock-mode undo with the registered stall fix (behavior-change #2): legacy
 * pop-through-user's-last-pick, then — if that leaves a bot on the clock
 * (only possible when the user had no picks yet) — re-run autopicks so the
 * draft lands on the user's turn instead of stalling.
 */
export function undoInMockDraft(state: DraftState, pool: PlayerPool, rng: Rng): DraftState {
  let cur = undoLastUserTurn(state);
  if (!isOnClock(cur, cur.config.myTeamId) && cur.picks.length + 1 <= totalPicks(cur.config)) {
    cur = runAutoPicks(cur, pool, rng);
  }
  return cur;
}
