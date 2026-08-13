// Edge-branch coverage for pinned behaviors that the main suites don't reach.

import { describe, it, expect } from "vitest";
import type { DraftConfig, DraftState, EnginePlayer, Pos } from "../types";
import { runAutoPicks } from "../autopick";
import { undoLastUserTurn } from "../draft";
import { scarcitySummary } from "../scarcity";
import { computeBaselines, computeStarterDemand, type PointsByPos } from "../baseline";
import { pointsFor } from "../scoring";
import { buildPlayerPool } from "../pool";
import { totalPicks } from "../snake";
import { mulberry32 } from "../rng";

const POS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

const mkConfig = (over: Partial<DraftConfig> = {}): DraftConfig => ({
  numTeams: 4,
  teamOrder: [1, 2, 3, 4],
  teamNames: {},
  rosterSpec: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 2 }, // 9 rounds
  flexEligibleBySlot: [["RB", "WR", "TE"]],
  myTeamId: 1,
  mockDraft: true,
  byeWeeks: {},
  adpContext: "1QB",
  ...over,
});

const mkPlayers = (n: number): EnginePlayer[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `P${i}`,
    team: "KC",
    pos: POS[i % POS.length],
    rank: i + 1,
    adp: null,
  }));

const mkState = (config: DraftConfig): DraftState => ({
  config,
  picks: [],
  queue: [],
  recPos: [...POS],
});

describe("pool exhaustion — pinned silent halt", () => {
  it("runAutoPicks halts silently when the pool runs dry mid-draft", () => {
    const config = mkConfig({ myTeamId: 99 }); // user never picks — bots draft everything
    const players = mkPlayers(10); // far fewer than 36 total picks
    const pool = buildPlayerPool(players);
    const state = runAutoPicks(mkState(config), pool, mulberry32(1));
    expect(state.picks.length).toBe(10); // consumed the pool, then stopped
    expect(state.picks.length).toBeLessThan(totalPicks(config));
  });
});

describe("undoLastUserTurn — empty state", () => {
  it("no-ops on zero picks", () => {
    const s = mkState(mkConfig());
    expect(undoLastUserTurn(s)).toBe(s);
  });
});

describe("scarcitySummary — edges", () => {
  it("empty once the draft is complete", () => {
    const config = mkConfig({
      rosterSpec: { QB: 1, RB: 0, WR: 0, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 0 },
      flexEligibleBySlot: [],
    }); // 4 total picks
    const players = mkPlayers(12);
    const pool = buildPlayerPool(players);
    let state = mkState(config);
    // fill the whole draft
    const qbs = players.filter((p) => p.pos === "QB");
    state = {
      ...state,
      picks: [0, 1, 2, 3].map((i) => ({
        overall: i + 1,
        round: 1,
        pickInRound: i + 1,
        teamId: i + 1,
        playerId: (qbs[i] ?? players[i]).id,
      })),
    };
    expect(scarcitySummary(state, pool)).toEqual([]);
  });

  it("warn severity at tierLeft 3-4, skips positions with no available players", () => {
    // 3 RBs in one tier → warn; no QB/WR/TE at all → skipped rows
    const players: EnginePlayer[] = [1, 2, 3].map((r) => ({
      id: `rb${r}`,
      name: `RB${r}`,
      team: "KC",
      pos: "RB",
      rank: r,
      adp: null,
    }));
    const pool = buildPlayerPool(players);
    const state = mkState(mkConfig());
    const items = scarcitySummary(state, pool);
    expect(items).toEqual([{ pos: "RB", tier: 1, tierLeft: 3, severity: "warn" }]);
  });
});

describe("baseline — degenerate inputs", () => {
  const emptyByPos: PointsByPos = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] };

  it("all-zero beta → benchTarget 0 everywhere (no NaN from Σβ)", () => {
    const byPos: PointsByPos = { ...emptyByPos, QB: [300, 200, 100] };
    const res = computeBaselines(
      byPos,
      { QB: 2, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 },
      { lambda: 1, beta: { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 }, numTeams: 2, benchSlots: 5 },
    );
    expect(res.baselineIndex.QB).toBe(2);
    expect(res.baselinePoints.QB).toBe(200);
  });

  it("empty positional pool → baselineIndex 0, points 0, no clamp entry", () => {
    const res = computeBaselines(
      emptyByPos,
      { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 },
      { lambda: 0, beta: { QB: 1, RB: 1, WR: 1, TE: 1, K: 0, DEF: 0 }, numTeams: 2, benchSlots: 0 },
    );
    expect(res.baselineIndex.WR).toBe(0);
    expect(res.baselinePoints.WR).toBe(0);
    expect(res.clamped).toEqual([]);
  });

  it("flex demand with zero flex slots is dedicated-only", () => {
    const byPos: PointsByPos = { ...emptyByPos, RB: [100, 90] };
    const demand = computeStarterDemand(byPos, 2, { QB: 0, RB: 1, WR: 0, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 0 }, []);
    expect(demand.RB).toBe(2);
  });
});

describe("pointsFor — sparse stat lines", () => {
  it("skips undefined stat values and unknown weight keys score 0", () => {
    expect(pointsFor({ rec: undefined, mystery_stat: 10 }, { name: "x", weights: { rec: 1 } }, "WR")).toBe(0);
  });
});
