import { describe, it, expect } from "vitest";
import type { DraftConfig, DraftState, EnginePlayer } from "../types";
import { rosterExportRows, csvSerialize } from "../export";
import { buildPlayerPool } from "../pool";

const config: DraftConfig = {
  numTeams: 2,
  teamOrder: [1, 2],
  teamNames: { 1: 'Team "A", East', 2: "Team B" }, // exercises quoting
  rosterSpec: { QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 1 },
  flexEligibleBySlot: [],
  myTeamId: 1,
  mockDraft: false,
  byeWeeks: { KC: 5 },
  adpContext: "1QB",
};

const qb: EnginePlayer = { id: "q1", name: "Pat M, Jr.", team: "KC", pos: "QB", rank: 1, adp: 3.5 };
const qb2: EnginePlayer = { id: "q2", name: "Josh A", team: "FA", pos: "QB", rank: 2, adp: null };
const rb: EnginePlayer = { id: "r1", name: "RB Guy", team: "KC", pos: "RB", rank: 3, adp: null };

describe("rosterExportRows", () => {
  it("header, filled + EMPTY slot rows, bench, null-adp → '', unknown bye → ''", () => {
    const pool = buildPlayerPool([qb, qb2, rb]);
    const state: DraftState = {
      config,
      picks: [
        { overall: 1, round: 1, pickInRound: 1, teamId: 1, playerId: "q1" },
        { overall: 2, round: 1, pickInRound: 2, teamId: 2, playerId: "q2" },
        { overall: 3, round: 2, pickInRound: 1, teamId: 2, playerId: "r1" }, // → bench
      ],
      queue: [],
      recPos: ["QB", "RB", "WR", "TE", "DEF", "K"],
    };
    const rows = rosterExportRows(state, pool);
    expect(rows[0]).toEqual([
      "Team", "Slot", "Player", "NFL Team", "Position", "Bye", "Consensus Rank", "ADP", "Overall Pick",
    ]);
    // team 1: QB filled, BN empty
    expect(rows[1]).toEqual(['Team "A", East', "QB1", "Pat M, Jr.", "KC", "QB", 5, 1, 3.5, 1]);
    expect(rows[2]).toEqual(['Team "A", East', "BN1", "", "", "", "", "", "", ""]);
    // team 2: FA team has no bye → '', null adp → ''
    expect(rows[3]).toEqual(["Team B", "QB1", "Josh A", "FA", "QB", "", 2, "", 2]);
    expect(rows[4]).toEqual(["Team B", "BN1", "RB Guy", "KC", "RB", 5, 3, "", 3]);
  });
});

describe("csvSerialize — legacy quoting rule", () => {
  it("quotes iff /[\",\\n]/ and doubles embedded quotes", () => {
    const csv = csvSerialize([
      ["plain", "with,comma", 'with"quote', "with\nnewline", 42, ""],
    ]);
    expect(csv).toBe('plain,"with,comma","with""quote","with\nnewline",42,');
  });
});
