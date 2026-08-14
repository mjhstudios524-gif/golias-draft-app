import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  sleeperDraftSchema,
  sleeperLeagueSchema,
  sleeperLeagueUserSchema,
  sleeperNflStateSchema,
  sleeperPickSchema,
  sleeperRosterSchema,
  sleeperTradedPickSchema,
  type SleeperDraft,
  type SleeperPick,
} from "@/server/providers/sleeper/client";
import {
  buildSleeperPickOwnerByOverall,
  normalizeRosterPositions,
  normalizeSleeperDraft,
  normalizeSleeperLeague,
  normalizeSleeperPicks,
  parseSleeperLeagueRef,
  seatsFromDraft,
} from "@/server/providers/sleeper/normalize";
import leagueFixture from "../fixtures/league.json";
import leagueUsersFixture from "../fixtures/league-users.json";
import leagueRostersFixture from "../fixtures/league-rosters.json";
import leagueDraftsFixture from "../fixtures/league-drafts.json";
import docsDraftFixture from "../fixtures/draft.json";
import docsDraftPicksFixture from "../fixtures/draft-picks.json";
import leagueDraftFixture from "../fixtures/league-draft.json";
import leagueDraftPicksFixture from "../fixtures/league-draft-picks.json";
import stateNflFixture from "../fixtures/state-nfl.json";

// Fixture goldens against REAL recorded Sleeper responses (docs example league
// 289646328504385536 / draft 257270643320426496, recorded 2026-08-13). The
// pickOwnerByOverall goldens cross-check the computed board against every
// actual pick's draft_slot — provider truth, not our own math re-derived.

const league = sleeperLeagueSchema.parse(leagueFixture);
const leagueUsers = z.array(sleeperLeagueUserSchema).parse(leagueUsersFixture);
const leagueRosters = z.array(sleeperRosterSchema).parse(leagueRostersFixture);
const docsDraft = sleeperDraftSchema.parse(docsDraftFixture);
const docsDraftPicks = z.array(sleeperPickSchema).parse(docsDraftPicksFixture);
const leagueDraft = sleeperDraftSchema.parse(leagueDraftFixture);
const leagueDraftPicks = z.array(sleeperPickSchema).parse(leagueDraftPicksFixture);

describe("client schemas accept recorded fixtures", () => {
  it("parses every recorded endpoint shape", () => {
    expect(league.league_id).toBe("289646328504385536");
    expect(z.array(sleeperDraftSchema).parse(leagueDraftsFixture)).toHaveLength(1);
    expect(z.array(sleeperTradedPickSchema).parse([])).toEqual([]);
    expect(sleeperNflStateSchema.parse(stateNflFixture).season).toMatch(/^\d{4}$/);
    expect(docsDraftPicks).toHaveLength(30);
    expect(leagueDraftPicks).toHaveLength(180);
  });
});

describe("parseSleeperLeagueRef", () => {
  it("parses league URLs, draft URLs, bare ids and usernames", () => {
    expect(parseSleeperLeagueRef("https://sleeper.com/leagues/289646328504385536/league")).toEqual({
      kind: "league",
      leagueId: "289646328504385536",
    });
    expect(parseSleeperLeagueRef("sleeper.com/leagues/123456789")).toEqual({
      kind: "league",
      leagueId: "123456789",
    });
    expect(parseSleeperLeagueRef("https://sleeper.com/draft/nfl/257270643320426496")).toEqual({
      kind: "draft",
      draftId: "257270643320426496",
    });
    expect(parseSleeperLeagueRef(" 289646328504385536 ")).toEqual({
      kind: "league",
      leagueId: "289646328504385536",
    });
    expect(parseSleeperLeagueRef("mattg_ff")).toEqual({ kind: "username", username: "mattg_ff" });
  });

  it("rejects garbage", () => {
    expect(parseSleeperLeagueRef("")).toBeNull();
    expect(parseSleeperLeagueRef("https://espn.com/leagues/1234567")).toBeNull();
    expect(parseSleeperLeagueRef("not a username!")).toBeNull();
  });
});

describe("normalizeRosterPositions", () => {
  it("maps the fixture league's positions with legacy label spellings", () => {
    const r = normalizeRosterPositions(league.roster_positions);
    expect(r.rosterSpec).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1, K: 0, BN: 6 });
    expect(r.slots.map((s) => s.label)).toEqual([
      "QB1", "RB1", "RB2", "WR1", "WR2", "TE1", "FLEX", "FLEX2", "DEF",
      "BN1", "BN2", "BN3", "BN4", "BN5", "BN6",
    ]);
    expect(r.flexEligibleBySlot).toEqual([
      ["RB", "WR", "TE"],
      ["RB", "WR", "TE"],
    ]);
    expect(r.ignoredSlots).toEqual([]);
  });

  it("maps exotic flex tokens and quarantines IDP slots", () => {
    const r = normalizeRosterPositions([
      "QB", "SUPER_FLEX", "WRRB_FLEX", "REC_FLEX", "IDP_FLEX", "DL", "LB", "DB", "K", "BN",
    ]);
    expect(r.rosterSpec).toEqual({ QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 3, DEF: 0, K: 1, BN: 1 });
    expect(r.flexEligibleBySlot).toEqual([
      ["QB", "RB", "WR", "TE"], // SUPER_FLEX
      ["RB", "WR"], // WRRB_FLEX
      ["WR", "TE"], // REC_FLEX
    ]);
    expect(r.ignoredSlots).toEqual(["IDP_FLEX", "DL", "LB", "DB"]);
    expect(r.slots.map((s) => s.label)).toEqual(["QB1", "FLEX", "FLEX2", "FLEX3", "K", "BN1"]);
  });
});

describe("normalizeSleeperLeague", () => {
  const settings = normalizeSleeperLeague({
    league,
    users: leagueUsers,
    rosters: leagueRosters,
  });

  it("passes scoring through with zero-drop and 4dp rounding", () => {
    expect(settings.scoring.weights.rec).toBe(1);
    expect(settings.scoring.weights.pass_td).toBe(6);
    expect(settings.scoring.weights.pass_yd).toBe(0.04); // was 0.03999999910593033 (IEEE noise)
    expect(settings.scoring.weights.rush_yd).toBe(0.1);
    expect(settings.scoring.weights.fum_lost).toBe(-2);
    expect(settings.scoring.weights).not.toHaveProperty("bonus_rec_yd_100"); // zero → dropped
    expect(settings.scoring.name).toBe("Sleeper Friends League (Sleeper)");
  });

  it("relocates bonus_rec_te into posWeights.TE.rec", () => {
    const s = normalizeSleeperLeague({
      league: { ...league, scoring_settings: { rec: 0.5, bonus_rec_te: 0.5, pass_yd: 0 } },
      users: leagueUsers,
      rosters: leagueRosters,
    });
    expect(s.scoring.weights).toEqual({ rec: 0.5 });
    expect(s.scoring.posWeights).toEqual({ TE: { rec: 0.5 } });
  });

  it("derives teams, superflex flag and seats from the bundle", () => {
    expect(settings.numTeams).toBe(12);
    expect(settings.isSuperflex).toBe(false);
    expect(settings.ignoredSlots).toEqual([]);
    expect(settings.teamSeats).toHaveLength(12);
    // roster 1 is owned by 189140835533586432 — the seat carries that user's name
    const owner = leagueUsers.find((u) => u.user_id === "189140835533586432");
    expect(settings.teamSeats[0]).toMatchObject({
      seat: 1,
      rosterId: 1,
      providerUserId: "189140835533586432",
    });
    expect(settings.teamSeats[0].name.length).toBeGreaterThan(0);
    expect(
      owner?.metadata?.team_name ? [owner.metadata.team_name] : [owner?.display_name],
    ).toContain(settings.teamSeats[0].name);
  });

  it("flags superflex when a SUPER_FLEX slot exists", () => {
    const s = normalizeSleeperLeague({
      league: { ...league, roster_positions: ["QB", "SUPER_FLEX", "RB", "BN"] },
      users: leagueUsers,
      rosters: leagueRosters,
    });
    expect(s.isSuperflex).toBe(true);
  });
});

describe("buildSleeperPickOwnerByOverall", () => {
  it("matches every real pick's draft_slot in the 12-team snake draft", () => {
    const owners = buildSleeperPickOwnerByOverall({
      type: "snake",
      teams: leagueDraft.settings.teams,
      rounds: leagueDraft.settings.rounds,
      reversalRound: leagueDraft.settings.reversal_round ?? 0,
      slotToRosterId: leagueDraft.slot_to_roster_id ?? null,
      tradedPicks: [],
    });
    expect(owners).toHaveLength(12 * 15);
    for (const pick of leagueDraftPicks) {
      expect(owners[pick.pick_no - 1]).toBe(pick.draft_slot);
    }
  });

  it("matches every real pick in the 6-team docs draft (shuffled draft_order)", () => {
    // draft_order maps users→slots in shuffled order; the board itself is
    // slot-ordered, which is exactly what the golden asserts.
    expect(new Set(Object.values(docsDraft.draft_order ?? {})).size).toBe(6);
    const owners = buildSleeperPickOwnerByOverall({
      type: "snake",
      teams: docsDraft.settings.teams,
      rounds: docsDraft.settings.rounds,
      reversalRound: docsDraft.settings.reversal_round ?? 0,
      slotToRosterId: docsDraft.slot_to_roster_id ?? null,
      tradedPicks: [],
    });
    for (const pick of docsDraftPicks) {
      expect(owners[pick.pick_no - 1]).toBe(pick.draft_slot);
    }
  });

  it("builds linear boards with no reversal ever", () => {
    const owners = buildSleeperPickOwnerByOverall({
      type: "linear",
      teams: 4,
      rounds: 3,
      reversalRound: 3, // must be ignored for linear
      slotToRosterId: null,
      tradedPicks: [],
    });
    expect(owners).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it("implements 3rd-round reversal (direction flips from the reversal round on)", () => {
    const owners = buildSleeperPickOwnerByOverall({
      type: "snake",
      teams: 4,
      rounds: 5,
      reversalRound: 3,
      slotToRosterId: null,
      tradedPicks: [],
    });
    expect(owners).toEqual([
      1, 2, 3, 4, // R1 forward
      4, 3, 2, 1, // R2 reverse
      4, 3, 2, 1, // R3 reverse AGAIN (the reversal)
      1, 2, 3, 4, // R4 forward — snake continues from the flipped direction
      4, 3, 2, 1, // R5
    ]);
  });

  it("treats reversal_round 0 and 1 as plain snake (defensive)", () => {
    const plain = [1, 2, 3, 3, 2, 1, 1, 2, 3];
    for (const reversalRound of [0, 1]) {
      expect(
        buildSleeperPickOwnerByOverall({
          type: "snake",
          teams: 3,
          rounds: 3,
          reversalRound,
          slotToRosterId: null,
          tradedPicks: [],
        }),
      ).toEqual(plain);
    }
  });

  it("reassigns traded picks by (round, original slot) → new owner's seat", () => {
    // Real non-identity mapping from the fixture: slot 1 → roster 10, slot 9 → roster 5.
    const slotToRosterId = leagueDraft.slot_to_roster_id!;
    expect(slotToRosterId["1"]).toBe(10);
    expect(slotToRosterId["9"]).toBe(5);
    const owners = buildSleeperPickOwnerByOverall({
      type: "snake",
      teams: 12,
      rounds: 15,
      reversalRound: 0,
      slotToRosterId,
      tradedPicks: [{ round: 2, roster_id: 10, owner_id: 5 }],
    });
    // Round 2 runs 12..1, so slot 1's round-2 pick is overall 24 — now seat 9's.
    expect(owners[23]).toBe(9);
    // Everything else in round 2 untouched.
    expect(owners.slice(12, 23)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    // Seat 1's round-1 pick unaffected.
    expect(owners[0]).toBe(1);
  });

  it("applies traded picks against the reversed layout in a 3RR round", () => {
    const owners = buildSleeperPickOwnerByOverall({
      type: "snake",
      teams: 4,
      rounds: 4,
      reversalRound: 3,
      slotToRosterId: { "1": 101, "2": 102, "3": 103, "4": 104 },
      tradedPicks: [{ round: 3, roster_id: 104, owner_id: 101 }],
    });
    // R3 with 3RR runs 4,3,2,1 — slot 4's pick is overall 9, reassigned to seat 1.
    expect(owners.slice(8, 12)).toEqual([1, 3, 2, 1]);
  });

  it("leaves unmappable traded picks on the base owner (defensive)", () => {
    const owners = buildSleeperPickOwnerByOverall({
      type: "snake",
      teams: 4,
      rounds: 2,
      reversalRound: 0,
      slotToRosterId: { "1": 101, "2": 102, "3": 103, "4": 104 },
      tradedPicks: [
        { round: 1, roster_id: 999, owner_id: 101 }, // unknown original roster
        { round: 9, roster_id: 104, owner_id: 101 }, // round out of range
      ],
    });
    expect(owners).toEqual([1, 2, 3, 4, 4, 3, 2, 1]);
  });
});

describe("normalizeSleeperDraft", () => {
  it("normalizes the docs draft end-to-end", () => {
    const state = normalizeSleeperDraft(docsDraft, []);
    expect(state).toMatchObject({
      draftId: "257270643320426496",
      leagueId: "257270637750382592",
      status: "complete",
      type: "snake",
      numTeams: 6,
      rounds: 15,
      pickTimerSec: 120,
      reversalRound: 0,
    });
    expect(state.pickOwnerByOverall).toHaveLength(90);
    expect(state.seatByUserId["200837482281963520"]).toBe(1);
    expect(state.rosterIdBySeat).toEqual({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 });
  });

  it("emits an empty board for auction drafts (capability-gated at import)", () => {
    const auction: SleeperDraft = { ...docsDraft, type: "auction" };
    const state = normalizeSleeperDraft(auction, []);
    expect(state.type).toBe("auction");
    expect(state.pickOwnerByOverall).toEqual([]);
  });
});

describe("normalizeSleeperPicks", () => {
  it("normalizes real picks with metadata fallback and canonical team codes", () => {
    const picks = normalizeSleeperPicks(docsDraftPicks);
    expect(picks[0]).toEqual({
      overall: 1,
      seat: 1,
      round: 1,
      providerPlayerId: "2391",
      pickedByUserId: "200837482281963520",
      autopick: false,
      metadata: { name: "David Johnson", pos: "RB", team: "ARI" },
    });
    // overall/seat/round always mirror pick_no/draft_slot/round
    docsDraftPicks.forEach((raw, i) => {
      expect(picks[i].overall).toBe(raw.pick_no);
      expect(picks[i].seat).toBe(raw.draft_slot);
      expect(picks[i].round).toBe(raw.round);
    });
  });

  it('treats picked_by "" as autopick and tolerates missing metadata', () => {
    const raw: SleeperPick = { ...docsDraftPicks[0], picked_by: "", metadata: null };
    const [pick] = normalizeSleeperPicks([raw]);
    expect(pick.autopick).toBe(true);
    expect(pick.pickedByUserId).toBeNull();
    expect(pick.metadata).toBeNull();
  });
});

describe("seatsFromDraft", () => {
  it("orders seats by draft slot and names them from league users", () => {
    const seats = seatsFromDraft(leagueDraft, leagueUsers, leagueRosters);
    expect(seats).toHaveLength(12);
    expect(seats.map((s) => s.seat)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // Golden by construction: every seat's user must match draft_order exactly.
    const order = leagueDraft.draft_order!;
    for (const seat of seats) {
      expect(order[seat.providerUserId!]).toBe(seat.seat);
      expect(seat.rosterId).toBe(leagueDraft.slot_to_roster_id![String(seat.seat)]);
      expect(seat.name.length).toBeGreaterThan(0);
    }
  });

  it("falls back to slot_to_roster_id → roster owner when draft_order is absent", () => {
    const noOrder: SleeperDraft = { ...leagueDraft, draft_order: null };
    const seats = seatsFromDraft(noOrder, leagueUsers, leagueRosters);
    const rosterOwner = new Map(leagueRosters.map((r) => [r.roster_id, r.owner_id ?? null]));
    for (const seat of seats) {
      expect(seat.providerUserId).toBe(rosterOwner.get(seat.rosterId!) ?? null);
    }
  });
});
