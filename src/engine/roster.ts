import type {
  DraftState,
  EnginePlayer,
  FilledSlot,
  FlexEligibility,
  PlayerPool,
  Pos,
  RosterAssignment,
  RosterSpec,
  SlotDef,
  TeamNeeds,
} from "./types";
import { FLEX_ELIGIBLE_DEFAULT } from "./format";
import { byeWeekFor } from "./bye";

// Legacy source: draft-room.html ~1020-1060 (slots), ~662-673 (needs),
// ~722-731 (bye counts), ~943-966 (bye summary).

/** Exact legacy slot order and label spellings: QB1..QBn, RB1.., WR1.., TE1..,
 * FLEX (first unnumbered) FLEX2.., DEF DEF2.., K K2.., BN1.. */
export function buildSlotTemplate(spec: RosterSpec, flexEligibleBySlot: FlexEligibility): SlotDef[] {
  const slots: SlotDef[] = [];
  for (let i = 0; i < spec.QB; i++) slots.push({ type: "QB", label: "QB" + (i + 1) });
  for (let i = 0; i < spec.RB; i++) slots.push({ type: "RB", label: "RB" + (i + 1) });
  for (let i = 0; i < spec.WR; i++) slots.push({ type: "WR", label: "WR" + (i + 1) });
  for (let i = 0; i < spec.TE; i++) slots.push({ type: "TE", label: "TE" + (i + 1) });
  for (let i = 0; i < spec.FLEX; i++) {
    const eligible = (flexEligibleBySlot && flexEligibleBySlot[i]) || FLEX_ELIGIBLE_DEFAULT;
    slots.push({ type: "FLEX", label: "FLEX" + (i + 1 > 1 ? i + 1 : ""), eligible });
  }
  for (let i = 0; i < spec.DEF; i++) slots.push({ type: "DEF", label: "DEF" + (i + 1 > 1 ? i + 1 : "") });
  for (let i = 0; i < spec.K; i++) slots.push({ type: "K", label: "K" + (i + 1 > 1 ? i + 1 : "") });
  for (let i = 0; i < spec.BN; i++) slots.push({ type: "BN", label: "BN" + (i + 1) });
  return slots;
}

/**
 * Greedy assignment IN PICK ORDER: first open dedicated slot → first open FLEX
 * whose eligibility includes the position → first open bench → overflow.
 * The greedy order-dependence (a later pick can strand an earlier FLEX) is
 * pinned legacy behavior, not a bug.
 */
export function assignRosterSlots(state: DraftState, pool: PlayerPool, teamId: number): RosterAssignment {
  const spec = state.config.rosterSpec;
  const flexEligibleBySlot = state.config.flexEligibleBySlot || [];
  const slots: FilledSlot[] = buildSlotTemplate(spec, flexEligibleBySlot).map((s) => ({ ...s, player: null }));
  const teamPicks = state.picks.filter((p) => p.teamId === teamId).sort((a, b) => a.overall - b.overall);
  const overflow: { player: EnginePlayer; overall: number }[] = [];
  teamPicks.forEach((pk) => {
    const player = pool.byId.get(pk.playerId);
    if (!player) return;
    let slot = slots.find((s) => s.type === player.pos && !s.player);
    if (!slot) {
      slot = slots.find((s) => s.type === "FLEX" && !s.player && s.eligible && s.eligible.includes(player.pos));
    }
    if (!slot) {
      slot = slots.find((s) => s.type === "BN" && !s.player);
    }
    if (slot) {
      slot.player = player;
      slot.pickOverall = pk.overall;
    } else {
      overflow.push({ player, overall: pk.overall });
    }
  });
  return { slots, overflow };
}

/** Open non-bench slots → needed positions (FLEX expands to its eligibility).
 * Legacy bnOpen output intentionally dropped (behavior-change register #3). */
export function computeTeamNeeds(state: DraftState, pool: PlayerPool, teamId: number): TeamNeeds {
  const { slots } = assignRosterSlots(state, pool, teamId);
  const neededPositions = new Set<Pos>();
  slots
    .filter((s) => !s.player)
    .forEach((s) => {
      if (s.type === "BN") return;
      if (s.type === "FLEX") {
        (s.eligible || FLEX_ELIGIBLE_DEFAULT).forEach((p) => neededPositions.add(p));
      } else neededPositions.add(s.type);
    });
  return { neededPositions };
}

/** Bye-week counts over FILLED NON-BENCH slots only (FLEX counts as a starter). */
export function starterByeCounts(state: DraftState, pool: PlayerPool, teamId: number): Record<number, number> {
  const { slots } = assignRosterSlots(state, pool, teamId);
  const counts: Record<number, number> = {};
  slots.forEach((s) => {
    if (!s.player || s.type === "BN") return;
    const b = byeWeekFor(s.player.team, state.config.byeWeeks);
    if (b) counts[b] = (counts[b] || 0) + 1;
  });
  return counts;
}

export interface ByeSummaryWeek {
  week: number;
  starters: { label: string; player: EnginePlayer }[];
  /** ≥3 starters out — the roster-view "stacked bye" flag. (The recommender's
   * bye-clash penalty fires earlier, at ≥2 already rostered — pinned asymmetry.) */
  stacked: boolean;
}

export function byeSummary(state: DraftState, pool: PlayerPool, teamId: number): ByeSummaryWeek[] {
  const { slots } = assignRosterSlots(state, pool, teamId);
  const byWeek = new Map<number, { label: string; player: EnginePlayer }[]>();
  slots.forEach((s) => {
    if (!s.player || s.type === "BN") return;
    const b = byeWeekFor(s.player.team, state.config.byeWeeks);
    if (!b) return;
    const list = byWeek.get(b);
    const entry = { label: s.label, player: s.player };
    if (list) list.push(entry);
    else byWeek.set(b, [entry]);
  });
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, starters]) => ({ week, starters, stacked: starters.length >= 3 }));
}
