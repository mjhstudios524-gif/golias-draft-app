import { describe, it, expect } from "vitest";
import type { DraftConfig, DraftState, EnginePlayer, PlayerId, Pos, RosterSpec } from "../types";
import { buildSlotTemplate, assignRosterSlots, computeTeamNeeds, starterByeCounts, byeSummary } from "../roster";
import { buildPlayerPool } from "../pool";
import { pickForOverall } from "../snake";

const BYES = { KC: 5, DET: 6, BUF: 7, SF: 8 };

let id = 0;
const mkPlayer = (pos: Pos, team = "KC"): EnginePlayer => ({
  id: `p${++id}`,
  name: `P${id}`,
  team,
  pos,
  rank: id,
  adp: null,
});

function mkConfig(spec: RosterSpec, flex: Pos[][] = [["RB", "WR", "TE"]]): DraftConfig {
  return {
    numTeams: 2,
    teamOrder: [1, 2],
    teamNames: { 1: "A", 2: "B" },
    rosterSpec: spec,
    flexEligibleBySlot: flex,
    myTeamId: 1,
    mockDraft: false,
    byeWeeks: BYES,
    adpContext: "1QB",
  };
}

/** State where team 1 drafted `mine` in order (team 2 absorbs alternating picks). */
function stateWithMyPicks(config: DraftConfig, mine: EnginePlayer[], filler: EnginePlayer[]) {
  const picks = [];
  let overall = 1;
  let mi = 0,
    fi = 0;
  while (mi < mine.length && overall < 200) {
    const { round, pickInRound, teamId } = pickForOverall(config, overall);
    const player = teamId === 1 ? mine[mi++] : filler[fi++];
    if (!player) break;
    picks.push({ overall, round, pickInRound, teamId, playerId: player.id });
    overall++;
  }
  const state: DraftState = { config, picks, queue: [], recPos: ["QB", "RB", "WR", "TE", "DEF", "K"] };
  return state;
}

describe("buildSlotTemplate — exact legacy labels and order", () => {
  it("QB1..; FLEX unnumbered-first; DEF/K unnumbered-first; BN always numbered", () => {
    const slots = buildSlotTemplate(
      { QB: 2, RB: 2, WR: 3, TE: 1, FLEX: 2, DEF: 2, K: 1, BN: 3 },
      [
        ["RB", "WR"],
        ["QB", "RB", "WR", "TE"],
      ],
    );
    expect(slots.map((s) => s.label)).toEqual([
      "QB1", "QB2", "RB1", "RB2", "WR1", "WR2", "WR3", "TE1",
      "FLEX", "FLEX2", "DEF", "DEF2", "K", "BN1", "BN2", "BN3",
    ]);
    expect(slots[8].eligible).toEqual(["RB", "WR"]);
    expect(slots[9].eligible).toEqual(["QB", "RB", "WR", "TE"]);
  });

  it("missing per-slot eligibility falls back to RB/WR/TE", () => {
    const slots = buildSlotTemplate({ QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 2, DEF: 0, K: 0, BN: 0 }, [["RB"]]);
    expect(slots[1].eligible).toEqual(["RB", "WR", "TE"]);
  });
});

describe("assignRosterSlots — greedy in pick order", () => {
  it("dedicated → eligible FLEX → bench → overflow", () => {
    const config = mkConfig({ QB: 0, RB: 1, WR: 0, TE: 0, FLEX: 1, DEF: 0, K: 0, BN: 1 });
    const rb1 = mkPlayer("RB"), rb2 = mkPlayer("RB"), rb3 = mkPlayer("RB"), rb4 = mkPlayer("RB");
    const filler = Array.from({ length: 8 }, () => mkPlayer("WR"));
    const pool = buildPlayerPool([rb1, rb2, rb3, rb4, ...filler]);
    const state = stateWithMyPicks(config, [rb1, rb2, rb3, rb4], filler);
    const { slots, overflow } = assignRosterSlots(state, pool, 1);
    expect(slots.find((s) => s.label === "RB1")!.player).toBe(rb1);
    expect(slots.find((s) => s.label === "FLEX")!.player).toBe(rb2);
    expect(slots.find((s) => s.label === "BN1")!.player).toBe(rb3);
    expect(overflow).toEqual([{ player: rb4, overall: expect.any(Number) }]);
  });

  it("pinned order-dependence: FLEX1[RB,WR] + FLEX2[RB], RB then WR strands the WR", () => {
    const config = mkConfig(
      { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 2, DEF: 0, K: 0, BN: 0 },
      [["RB", "WR"], ["RB"]],
    );
    const rb = mkPlayer("RB"), wr = mkPlayer("WR");
    const filler = Array.from({ length: 4 }, () => mkPlayer("TE"));
    const pool = buildPlayerPool([rb, wr, ...filler]);
    const state = stateWithMyPicks(config, [rb, wr], filler);
    const { slots, overflow } = assignRosterSlots(state, pool, 1);
    // greedy puts the RB in FLEX1; the WR fits nowhere — pinned, not a bug
    expect(slots.find((s) => s.label === "FLEX")!.player).toBe(rb);
    expect(slots.find((s) => s.label === "FLEX2")!.player).toBeNull();
    expect(overflow.map((o) => o.player)).toEqual([wr]);
  });

  it("DEF/K never land in FLEX", () => {
    const config = mkConfig({ QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 1, DEF: 0, K: 0, BN: 0 });
    const def = mkPlayer("DEF");
    const filler = [mkPlayer("WR"), mkPlayer("WR")];
    const pool = buildPlayerPool([def, ...filler]);
    const state = stateWithMyPicks(config, [def], filler);
    const { slots, overflow } = assignRosterSlots(state, pool, 1);
    expect(slots.find((s) => s.label === "FLEX")!.player).toBeNull();
    expect(overflow.map((o) => o.player)).toEqual([def]);
  });
});

describe("computeTeamNeeds", () => {
  it("FLEX expands to its eligibility; bench-only-open → empty set", () => {
    const config = mkConfig({ QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 1, DEF: 0, K: 0, BN: 2 }, [["QB", "RB", "WR", "TE"]]);
    const qb = mkPlayer("QB");
    const filler = Array.from({ length: 6 }, () => mkPlayer("WR"));
    const pool0 = buildPlayerPool([qb, ...filler]);
    const empty: DraftState = { config, picks: [], queue: [], recPos: ["QB", "RB", "WR", "TE", "DEF", "K"] };
    expect([...computeTeamNeeds(empty, pool0, 1).neededPositions].sort()).toEqual(["QB", "RB", "TE", "WR"].sort());

    // fill QB + FLEX(QB-eligible takes second QB); only bench remains
    const qb2 = mkPlayer("QB");
    const pool = buildPlayerPool([qb, qb2, ...filler]);
    const state = stateWithMyPicks(config, [qb, qb2], filler);
    expect(computeTeamNeeds(state, pool, 1).neededPositions.size).toBe(0);
  });
});

describe("bye counting — starters only, clash vs summary asymmetry", () => {
  it("starterByeCounts ignores bench and unknown-bye teams; byeSummary flags at >=3", () => {
    const config = mkConfig({ QB: 0, RB: 2, WR: 2, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 2 });
    const kc1 = mkPlayer("RB", "KC"), kc2 = mkPlayer("RB", "KC"), kc3 = mkPlayer("WR", "KC");
    const fa = mkPlayer("WR", "FA"); // no bye entry → skipped
    const kcBench = mkPlayer("WR", "KC"); // lands on bench (WR slots full)
    const filler = Array.from({ length: 10 }, () => mkPlayer("TE", "SF"));
    const pool = buildPlayerPool([kc1, kc2, kc3, fa, kcBench, ...filler]);
    const state = stateWithMyPicks(config, [kc1, kc2, kc3, fa, kcBench], filler);

    const counts = starterByeCounts(state, pool, 1);
    expect(counts).toEqual({ 5: 3 }); // three KC starters; FA skipped; bench KC excluded

    const summary = byeSummary(state, pool, 1);
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ week: 5, stacked: true });
    expect(summary[0].starters.map((s) => s.player.id as PlayerId)).toEqual([kc1.id, kc2.id, kc3.id]);
  });
});
