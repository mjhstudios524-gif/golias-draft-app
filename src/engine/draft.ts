import type { DraftState, PlayerId, PlayerPool, Pos } from "./types";
import { pickForOverall, totalPicks } from "./snake";
import { draftedIdSet } from "./pool";

// Legacy source: draft-room.html ~625-659 (picks), ~887-905 (toggles).
// All reducers return NEW state objects; inputs are never mutated.

/**
 * Apply one pick. No-op past draft end (legacy). Rejects already-drafted
 * playerIds and ids missing from the pool — behavior-change register #1
 * (unreachable via the legacy UI; required once picks arrive over the network).
 */
export function applyPick(state: DraftState, playerId: PlayerId, pool: PlayerPool): DraftState {
  const overall = state.picks.length + 1;
  if (overall > totalPicks(state.config)) return state;
  if (!pool.byId.has(playerId)) return state;
  if (draftedIdSet(state.picks).has(playerId)) return state;
  const { round, pickInRound, teamId } = pickForOverall(state.config, overall);
  return { ...state, picks: [...state.picks, { overall, round, pickInRound, teamId, playerId }] };
}

/** Manual-mode undo: pop one pick. */
export function undoLast(state: DraftState): DraftState {
  if (state.picks.length === 0) return state;
  return { ...state, picks: state.picks.slice(0, -1) };
}

/**
 * Mock-mode undo, legacy semantics (~637): pop picks until (and including) the
 * user's most recent pick — undoing the whole "turn" including subsequent bot
 * picks, landing the user back on the clock. If the user never picked, this
 * pops EVERYTHING (the legacy stall case — see undoInMockDraft in autopick.ts
 * for the registered fix).
 */
export function undoLastUserTurn(state: DraftState): DraftState {
  if (state.picks.length === 0) return state;
  const myTeamId = state.config.myTeamId;
  let cut = -1;
  for (let i = state.picks.length - 1; i >= 0; i--) {
    if (state.picks[i].teamId === myTeamId) {
      cut = i;
      break;
    }
  }
  // cut === -1 → user never picked → pop everything (legacy)
  return { ...state, picks: cut === -1 ? [] : state.picks.slice(0, cut) };
}

/** Reset clears picks ONLY — queue and recPos survive (pinned legacy behavior). */
export function resetPicks(state: DraftState): DraftState {
  return { ...state, picks: [] };
}

export function toggleQueue(state: DraftState, playerId: PlayerId): DraftState {
  const i = state.queue.indexOf(playerId);
  const queue = i >= 0 ? state.queue.filter((_, j) => j !== i) : [...state.queue, playerId];
  return { ...state, queue };
}

export function toggleRecPos(state: DraftState, pos: Pos): DraftState {
  const i = state.recPos.indexOf(pos);
  const recPos = i >= 0 ? state.recPos.filter((_, j) => j !== i) : [...state.recPos, pos];
  return { ...state, recPos };
}
