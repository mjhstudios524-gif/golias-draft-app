import { describe, it, expect, test } from "vitest";
import type { DraftConfig, DraftState, RosterSpec } from "../types";
import {
  totalRounds,
  totalPicks,
  pickForOverall,
  buildPickOwnerByOverall,
  currentOverall,
  isOnClock,
  nextPickFor,
  picksUntilTurn,
} from "../snake";
import { mulberry32 } from "../rng";

const SPEC: RosterSpec = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 }; // 15 rounds

function shuffled(n: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

const cfg = (numTeams: number, seed = 99): DraftConfig => ({
  numTeams,
  teamOrder: shuffled(numTeams, seed),
  teamNames: {},
  rosterSpec: SPEC,
  flexEligibleBySlot: [["RB", "WR", "TE"]],
  myTeamId: 1,
  mockDraft: false,
  byeWeeks: {},
  adpContext: "1QB",
});

describe("totalRounds / totalPicks", () => {
  it("sums ALL eight spec fields including bench", () => {
    expect(totalRounds(SPEC)).toBe(15);
    expect(totalPicks(cfg(10))).toBe(150);
  });
});

describe("pickForOverall — snake order over shuffled team orders", () => {
  test.each([4, 8, 10, 12, 14, 20])("n=%d: round edges, reflection, final pick", (n) => {
    const config = cfg(n);
    const order = config.teamOrder;
    // round 1 walks the order forward
    expect(pickForOverall(config, 1)).toEqual({ round: 1, pickInRound: 1, teamId: order[0] });
    expect(pickForOverall(config, n)).toEqual({ round: 1, pickInRound: n, teamId: order[n - 1] });
    // snake reflection: picks n and n+1 belong to the same team
    expect(pickForOverall(config, n + 1)).toEqual({ round: 2, pickInRound: 1, teamId: order[n - 1] });
    // and picks 2n / 2n+1 likewise
    expect(pickForOverall(config, 2 * n).teamId).toBe(order[0]);
    expect(pickForOverall(config, 2 * n + 1).teamId).toBe(order[0]);
    // mid-round spot check, round 3 (odd → forward)
    const mid = Math.ceil(n / 2);
    expect(pickForOverall(config, 2 * n + mid)).toEqual({ round: 3, pickInRound: mid, teamId: order[mid - 1] });
    // final pick: 15 rounds — 15 is odd → forward → last team in order
    const total = totalPicks(config);
    expect(pickForOverall(config, total)).toEqual({ round: 15, pickInRound: n, teamId: order[n - 1] });
  });

  it("every team receives exactly `rounds` picks", () => {
    const config = cfg(12);
    const counts = new Map<number, number>();
    for (let o = 1; o <= totalPicks(config); o++) {
      const t = pickForOverall(config, o).teamId;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    config.teamOrder.forEach((t) => expect(counts.get(t)).toBe(15));
  });

  it("buildPickOwnerByOverall matches pickForOverall everywhere", () => {
    const config = cfg(10);
    const owners = buildPickOwnerByOverall(config);
    expect(owners.length).toBe(totalPicks(config));
    for (let o = 1; o <= owners.length; o++) expect(owners[o - 1]).toBe(pickForOverall(config, o).teamId);
  });
});

describe("clock helpers", () => {
  const mkState = (config: DraftConfig, numPicks: number): DraftState => ({
    config,
    picks: Array.from({ length: numPicks }, (_, i) => {
      const { round, pickInRound, teamId } = pickForOverall(config, i + 1);
      return { overall: i + 1, round, pickInRound, teamId, playerId: i + 1 };
    }),
    queue: [],
    recPos: ["QB", "RB", "WR", "TE", "DEF", "K"],
  });

  it("currentOverall = picks.length + 1", () => {
    const config = cfg(10);
    expect(currentOverall(mkState(config, 0).picks)).toBe(1);
    expect(currentOverall(mkState(config, 37).picks)).toBe(38);
  });

  it("on the clock: nextPickFor starts scanning at cur+1", () => {
    const config = cfg(10);
    const first = config.teamOrder[0];
    const state = mkState(config, 0); // overall 1, first team on the clock
    expect(isOnClock(state, first)).toBe(true);
    // next pick for the round-1 first team is the LAST pick of round 2
    expect(nextPickFor(state, first)).toBe(2 * config.numTeams);
    expect(picksUntilTurn(state, first)).toBe(2 * config.numTeams - 2);
  });

  it("not on the clock: picksUntilTurn = next − cur", () => {
    const config = cfg(10);
    const second = config.teamOrder[1];
    const state = mkState(config, 0);
    expect(isOnClock(state, second)).toBe(false);
    expect(nextPickFor(state, second)).toBe(2);
    expect(picksUntilTurn(state, second)).toBe(1);
  });

  it("draft complete → everything nulls/false", () => {
    const config = cfg(4);
    const state = mkState(config, totalPicks(config));
    expect(isOnClock(state, config.teamOrder[0])).toBe(false);
    expect(nextPickFor(state, config.teamOrder[0])).toBeNull();
    expect(picksUntilTurn(state, config.teamOrder[0])).toBeNull();
  });

  it("team on its final pick: nextPickFor returns null while on the clock", () => {
    const config = cfg(4);
    const total = totalPicks(config);
    const lastTeam = pickForOverall(config, total).teamId;
    const state = mkState(config, total - 1); // final pick on the clock
    expect(isOnClock(state, lastTeam)).toBe(true);
    expect(nextPickFor(state, lastTeam)).toBeNull();
    expect(picksUntilTurn(state, lastTeam)).toBeNull();
  });
});
