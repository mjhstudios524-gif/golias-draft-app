import type { FlexEligibility, Pos, RosterSpec, SlotDef } from "@/engine/types";
import { leagueFormat } from "@/engine/format";
import { sleeperScoringToConfig } from "@/engine/scoring";
import { canonicalTeamCode } from "@/engine/teams";
import type {
  NormalizedLeagueSettings,
  NormalizedPick,
  ParsedLeagueRef,
  ProviderDraftState,
  ProviderDraftType,
  TeamSeat,
} from "@/server/providers/types";
import type {
  SleeperDraft,
  SleeperLeague,
  SleeperLeagueUser,
  SleeperPick,
  SleeperRoster,
  SleeperTradedPick,
} from "@/server/providers/sleeper/client";

// PURE Sleeper → engine normalization (PLAN.md §8). No I/O anywhere in this
// module — everything is fixture-tested goldens.

// ---------------- League ref parsing ----------------

const LEAGUE_URL_RE = /sleeper\.(?:com|app)\/leagues\/(\d+)/i;
const DRAFT_URL_RE = /sleeper\.(?:com|app)\/draft\/nfl\/(\d+)/i;
// Sleeper usernames: letters/digits/underscores (display names differ).
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

export function parseSleeperLeagueRef(input: string): ParsedLeagueRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const leagueUrl = LEAGUE_URL_RE.exec(trimmed);
  if (leagueUrl) return { kind: "league", leagueId: leagueUrl[1] };
  const draftUrl = DRAFT_URL_RE.exec(trimmed);
  if (draftUrl) return { kind: "draft", draftId: draftUrl[1] };
  if (trimmed.includes("/")) return null; // some other URL — don't guess
  // Bare numeric ids are league ids (Sleeper ids are 15+ digit snowflakes;
  // an all-digit username is indistinguishable, so ids win).
  if (/^\d{6,}$/.test(trimmed)) return { kind: "league", leagueId: trimmed };
  if (USERNAME_RE.test(trimmed)) return { kind: "username", username: trimmed };
  return null;
}

// ---------------- Roster positions → SlotDef[] ----------------

const DEDICATED: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

/** Verified Sleeper flex vocabulary (PLAN.md §8) → eligibility lists. */
const FLEX_ELIGIBLE: Record<string, Pos[]> = {
  FLEX: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
};

export interface NormalizedRoster {
  slots: SlotDef[];
  rosterSpec: RosterSpec;
  flexEligibleBySlot: FlexEligibility;
  /** Original provider tokens we can't draft (IDP etc.), in provider order. */
  ignoredSlots: string[];
}

/**
 * roster_positions → ordered SlotDef[] + engine shapes. Labels use the exact
 * legacy spellings (QB1.., FLEX/FLEX2.., DEF/DEF2.., BN1.. — see
 * buildSlotTemplate) so imported slots render like native ones.
 */
export function normalizeRosterPositions(rosterPositions: string[]): NormalizedRoster {
  const slots: SlotDef[] = [];
  const ignoredSlots: string[] = [];
  const flexEligibleBySlot: FlexEligibility = [];
  const spec: RosterSpec = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 0 };

  for (const token of rosterPositions) {
    if (DEDICATED.has(token)) {
      const pos = token as Pos;
      spec[pos] += 1;
      const n = spec[pos];
      // Legacy spelling: QB/RB/WR/TE always numbered; DEF/K first unnumbered.
      const label = pos === "DEF" || pos === "K" ? pos + (n > 1 ? n : "") : pos + n;
      slots.push({ type: pos, label });
    } else if (token in FLEX_ELIGIBLE) {
      spec.FLEX += 1;
      const n = spec.FLEX;
      flexEligibleBySlot.push([...FLEX_ELIGIBLE[token]]);
      slots.push({ type: "FLEX", label: "FLEX" + (n > 1 ? n : ""), eligible: [...FLEX_ELIGIBLE[token]] });
    } else if (token === "BN") {
      spec.BN += 1;
      slots.push({ type: "BN", label: "BN" + spec.BN });
    } else {
      // IDP (DL/LB/DB/IDP_FLEX) and anything novel — surfaced with the §8
      // disclosure banner, never silently dropped.
      ignoredSlots.push(token);
    }
  }

  return { slots, rosterSpec: spec, flexEligibleBySlot, ignoredSlots };
}

// ---------------- League bundle → NormalizedLeagueSettings ----------------

export interface SleeperLeagueBundle {
  league: SleeperLeague;
  users: SleeperLeagueUser[];
  rosters: SleeperRoster[];
}

function seatName(user: SleeperLeagueUser | undefined, fallback: string): string {
  const teamName = user?.metadata?.team_name?.trim();
  if (teamName) return teamName;
  const display = user?.display_name?.trim();
  return display || fallback;
}

/**
 * PURE league normalization (DraftProvider.normalizeLeagueConfig). teamSeats
 * here are provisional (seat = roster_id order); a real draft's slot order
 * refines them via seatsFromDraft.
 */
export function normalizeSleeperLeague(bundle: SleeperLeagueBundle): NormalizedLeagueSettings {
  const { league, users, rosters } = bundle;
  const roster = normalizeRosterPositions(league.roster_positions);
  const scoringSettings: Record<string, number> = {};
  for (const [k, v] of Object.entries(league.scoring_settings)) {
    if (typeof v === "number") scoringSettings[k] = v;
  }
  const scoring = sleeperScoringToConfig(scoringSettings, `${league.name} (Sleeper)`);

  const usersById = new Map(users.map((u) => [u.user_id, u]));
  const teamSeats: TeamSeat[] = [...rosters]
    .sort((a, b) => a.roster_id - b.roster_id)
    .map((r) => ({
      seat: r.roster_id,
      name: seatName(r.owner_id ? usersById.get(r.owner_id) : undefined, `Team ${r.roster_id}`),
      providerUserId: r.owner_id ?? null,
      rosterId: r.roster_id,
    }));

  return {
    numTeams: league.total_rosters,
    rosterSlots: roster.slots,
    ignoredSlots: roster.ignoredSlots,
    isSuperflex: leagueFormat(roster.rosterSpec, roster.flexEligibleBySlot) === "MULTI_QB",
    scoring,
    teamSeats,
    rosterSpec: roster.rosterSpec,
    flexEligibleBySlot: roster.flexEligibleBySlot,
  };
}

/** Board seats in draft-slot order, named via draft_order/slot_to_roster_id. */
export function seatsFromDraft(
  draft: SleeperDraft,
  users: SleeperLeagueUser[],
  rosters: SleeperRoster[],
): TeamSeat[] {
  const usersById = new Map(users.map((u) => [u.user_id, u]));
  const rostersById = new Map(rosters.map((r) => [r.roster_id, r]));
  const userBySeat = new Map<number, string>();
  for (const [userId, seat] of Object.entries(draft.draft_order ?? {})) {
    userBySeat.set(seat, userId);
  }
  const seats: TeamSeat[] = [];
  for (let seat = 1; seat <= draft.settings.teams; seat++) {
    const rosterId = draft.slot_to_roster_id?.[String(seat)] ?? null;
    let userId = userBySeat.get(seat) ?? null;
    if (!userId && rosterId != null) userId = rostersById.get(rosterId)?.owner_id ?? null;
    seats.push({
      seat,
      name: seatName(userId ? usersById.get(userId) : undefined, `Team ${seat}`),
      providerUserId: userId,
      rosterId,
    });
  }
  return seats;
}

// ---------------- pickOwnerByOverall ----------------

export interface SleeperBoardArgs {
  type: "snake" | "linear";
  teams: number;
  rounds: number;
  /** Sleeper settings.reversal_round; 0/absent = plain snake (decision #6).
   * 3RR rule (support.sleeper.com verified): from the reversal round on, the
   * direction is flipped relative to plain snake — R1 1→N, R2 N→1, R3 N→1
   * again, R4 1→N, … Values < 2 are treated as no reversal (defensive). */
  reversalRound: number;
  /** Seat → roster_id (Sleeper slot_to_roster_id keys are strings). */
  slotToRosterId: Record<string, number> | null;
  tradedPicks: Pick<SleeperTradedPick, "round" | "roster_id" | "owner_id">[];
}

/** Overall → seat honoring snake/linear, reversal_round and traded picks —
 * the §8 convergence point. Index overall-1; length teams*rounds. */
export function buildSleeperPickOwnerByOverall(args: SleeperBoardArgs): number[] {
  const { type, teams, rounds, reversalRound, slotToRosterId, tradedPicks } = args;
  const owners: number[] = [];
  for (let round = 1; round <= rounds; round++) {
    let forward = true;
    if (type === "snake") {
      forward = round % 2 === 1;
      if (reversalRound >= 2 && round >= reversalRound) forward = !forward;
    }
    for (let i = 0; i < teams; i++) owners.push(forward ? i + 1 : teams - i);
  }

  if (tradedPicks.length > 0 && slotToRosterId) {
    const seatByRosterId = new Map<number, number>();
    for (const [slot, rosterId] of Object.entries(slotToRosterId)) {
      seatByRosterId.set(rosterId, Number(slot));
    }
    for (const trade of tradedPicks) {
      if (trade.round < 1 || trade.round > rounds) continue;
      const originalSeat = seatByRosterId.get(trade.roster_id);
      const newSeat = seatByRosterId.get(trade.owner_id);
      // Unmappable rosters (defensive): leave the base owner rather than guess.
      if (originalSeat == null || newSeat == null) continue;
      const start = (trade.round - 1) * teams;
      for (let i = start; i < start + teams; i++) {
        // Each seat appears exactly once per round, so this match is unique.
        // Trades chain correctly because we match the BASE layout: Sleeper's
        // traded_picks rows always name the pick by its original roster.
        if (owners[i] === originalSeat) {
          owners[i] = newSeat;
          break;
        }
      }
    }
  }
  return owners;
}

// ---------------- Draft + picks ----------------

export function normalizeDraftType(type: string): ProviderDraftType {
  if (type === "snake" || type === "linear" || type === "auction") return type;
  return "snake"; // defensive: unknown future types draft like snake, visibly logged upstream
}

export function normalizeSleeperDraft(
  draft: SleeperDraft,
  tradedPicks: SleeperTradedPick[],
): ProviderDraftState {
  const type = normalizeDraftType(draft.type);
  const teams = draft.settings.teams;
  const rounds = draft.settings.rounds;
  const reversalRound = draft.settings.reversal_round ?? 0;
  const pickOwnerByOverall =
    type === "auction"
      ? [] // capability-gated out at import (PLAN.md §8); never draftable here
      : buildSleeperPickOwnerByOverall({
          type,
          teams,
          rounds,
          reversalRound,
          slotToRosterId: draft.slot_to_roster_id ?? null,
          tradedPicks,
        });

  const rosterIdBySeat: Record<number, number> | null = draft.slot_to_roster_id
    ? Object.fromEntries(
        Object.entries(draft.slot_to_roster_id).map(([slot, rosterId]) => [Number(slot), rosterId]),
      )
    : null;

  return {
    draftId: draft.draft_id,
    leagueId: draft.league_id ?? null,
    status: draft.status,
    type,
    numTeams: teams,
    rounds,
    pickTimerSec: draft.settings.pick_timer ?? null,
    reversalRound,
    startTime: draft.start_time ?? null,
    seatByUserId: draft.draft_order ?? {},
    rosterIdBySeat,
    pickOwnerByOverall,
  };
}

export function normalizeSleeperPicks(picks: SleeperPick[]): NormalizedPick[] {
  return picks.map((p) => {
    const first = p.metadata?.first_name?.trim() ?? "";
    const last = p.metadata?.last_name?.trim() ?? "";
    const name = `${first} ${last}`.trim();
    return {
      overall: p.pick_no,
      seat: p.draft_slot,
      round: p.round,
      providerPlayerId: p.player_id,
      pickedByUserId: p.picked_by === "" ? null : p.picked_by,
      autopick: p.picked_by === "",
      metadata: name
        ? {
            name,
            pos: p.metadata?.position ?? null,
            team: canonicalTeamCode(p.metadata?.team) ?? null,
          }
        : null,
    };
  });
}
