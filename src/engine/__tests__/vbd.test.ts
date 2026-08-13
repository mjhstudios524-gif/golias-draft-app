// The PLAN.md §5 worked example is the acceptance fixture for the VBD engine.

import { describe, it, expect } from "vitest";
import type { FlexEligibility, Pos, RosterSpec } from "../types";
import { pointsFor, sleeperScoringToConfig, SCORING_PRESETS } from "../scoring";
import { computeStarterDemand, computeBaselines, BETA_1QB, type PointsByPos } from "../baseline";
import { computeValues, rankOnlyValues, type ValueEntry } from "../value";

// ---- §5 anchor pools (piecewise, exact at the anchors that matter) ----
const desc = (from: number, to: number, n: number) =>
  Array.from({ length: n }, (_, i) => from - ((from - to) * i) / (n - 1));

function anchorPools(superflex: boolean): PointsByPos {
  // QB1 380 … QB12 285 | QB13 272 … QB24 220 | tail
  const QB = [...desc(380, 285, 12), 272, 267, 262, 257, 252, 247, 242, 237, 232, 227, 224, 220, ...desc(210, 120, 10)];
  // RB1 305 … RB24 172 | RB25-30 exact | tail (long enough for blend idx 44)
  const RB = [...desc(305, 172, 24), 168, 164, 160, 156, 152, 149, ...desc(146, 40, 30)];
  // WR1 280 … WR36 160 | WR37-42 exact | tail (long enough for blend idx 56)
  const WR = [...desc(280, 160, 36), 158, 156, 154, 152, 150, 148, ...desc(146, 40, 30)];
  // TE1 210 … TE12 122 | TE13 118 | tail
  const TE = [...desc(210, 122, 12), 118, ...desc(114, 40, 10)];
  const K = desc(160, 100, 16);
  const DEF = desc(150, 90, 16);
  void superflex;
  return { QB, RB, WR, TE, K, DEF };
}

const SPEC_1QB: RosterSpec = { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DEF: 0, K: 0, BN: 6 };
const FLEX_STD: FlexEligibility = [["RB", "WR", "TE"]];
const FLEX_SF: FlexEligibility = [["QB", "RB", "WR", "TE"]];

describe("pointsFor — §5 worked-example vectors", () => {
  it("half-PPR WR: 95 rec / 1250 recYd / 8 recTD / 30 rushYd / 1 fumble → 221.5", () => {
    const pts = pointsFor(
      { rec: 95, rec_yd: 1250, rec_td: 8, rush_yd: 30, fum_lost: 1 },
      SCORING_PRESETS.halfPpr,
      "WR",
    );
    expect(pts).toBeCloseTo(221.5, 9);
  });

  it("QB: 4600 passYd / 38 passTD / 10 int / 550 rushYd / 4 rushTD / 4 fumbles → 387 (4pt) / 463 (6pt)", () => {
    const stat = { pass_yd: 4600, pass_td: 38, pass_int: 10, rush_yd: 550, rush_td: 4, fum_lost: 4 };
    expect(pointsFor(stat, SCORING_PRESETS.halfPpr, "QB")).toBeCloseTo(387, 9);
    expect(pointsFor(stat, SCORING_PRESETS.sixPtPassTd, "QB")).toBeCloseTo(463, 9);
  });

  it("TE premium +0.5/rec: an 85-rec TE gains exactly +42.5 over half-PPR", () => {
    const stat = { rec: 85, rec_yd: 800, rec_td: 6 };
    const base = pointsFor(stat, SCORING_PRESETS.halfPpr, "TE");
    const prem = pointsFor(stat, SCORING_PRESETS.tePremium, "TE");
    expect(prem - base).toBeCloseTo(42.5, 9);
    // the bonus is positional: a WR with the same line gains nothing
    expect(pointsFor(stat, SCORING_PRESETS.tePremium, "WR")).toBeCloseTo(
      pointsFor(stat, SCORING_PRESETS.halfPpr, "WR"),
      9,
    );
  });
});

describe("sleeperScoringToConfig", () => {
  it("rounds float noise, relocates bonus_rec_te, drops zero keys, keeps unknown keys", () => {
    const cfg = sleeperScoringToConfig({
      rec: 0.5,
      rec_yd: 0.10000000149011612,
      pass_td: 4,
      pass_int: -2,
      bonus_rec_te: 0.5,
      fum: 0,
      some_future_key: 1.25,
    });
    expect(cfg.weights.rec_yd).toBe(0.1);
    expect(cfg.weights.bonus_rec_te).toBeUndefined();
    expect(cfg.posWeights?.TE?.rec).toBe(0.5);
    expect(cfg.weights.fum).toBeUndefined();
    expect(cfg.weights.some_future_key).toBe(1.25);
  });
});

describe("computeStarterDemand — greedy flex simulation (§5)", () => {
  it("12-team 1QB/2RB/3WR/1TE/1FLEX(RB,WR,TE): flex splits RB+6/WR+6, TE gets none", () => {
    const spec: RosterSpec = { ...SPEC_1QB, RB: 2, WR: 3 };
    const demand = computeStarterDemand(anchorPools(false), 12, spec, FLEX_STD);
    expect(demand).toMatchObject({ QB: 12, RB: 30, WR: 42, TE: 12 });
  });

  it("superflex contrast: only change is QB-eligible FLEX → all 12 seats go QB", () => {
    const spec: RosterSpec = { ...SPEC_1QB, RB: 2, WR: 3 };
    const demand = computeStarterDemand(anchorPools(true), 12, spec, FLEX_SF);
    expect(demand).toMatchObject({ QB: 24, RB: 24, WR: 36, TE: 12 });
  });

  it("restrictive slots claim players first (WRRB before SUPER_FLEX)", () => {
    // Narrow slot [RB] must consume the RB tail before the wide slot sees it.
    const byPos: PointsByPos = {
      QB: [300, 100],
      RB: [200, 150],
      WR: [140],
      TE: [50],
      K: [],
      DEF: [],
    };
    const spec: RosterSpec = { QB: 1, RB: 1, WR: 0, TE: 0, FLEX: 2, DEF: 0, K: 0, BN: 0 };
    // config order lists the wide slot first; restrictive-first must reorder
    const demand = computeStarterDemand(byPos, 1, spec, [["QB", "RB", "WR", "TE"], ["RB"]]);
    // dedicated: QB1, RB1. [RB]-slot takes RB2 (150). Wide slot: best remaining
    // is WR 140 (QB2 is 100) → WR.
    expect(demand).toMatchObject({ QB: 1, RB: 2, WR: 1, TE: 0 });
  });

  it("exhausted pools are skipped", () => {
    const byPos: PointsByPos = { QB: [], RB: [100], WR: [90], TE: [], K: [], DEF: [] };
    const spec: RosterSpec = { QB: 0, RB: 1, WR: 1, TE: 0, FLEX: 2, DEF: 0, K: 0, BN: 0 };
    const demand = computeStarterDemand(byPos, 1, spec, [["RB", "WR"], ["RB", "WR"]]);
    // both pools exhausted by dedicated slots — flex seats find nothing
    expect(demand).toMatchObject({ RB: 1, WR: 1 });
  });
});

describe("computeBaselines — §5 blend table", () => {
  it("12-team 1QB blend λ=0.5 → indexes QB 16 / RB 44 / WR 56 / TE 16 (VOLS: 12/30/42/12)", () => {
    const spec: RosterSpec = { ...SPEC_1QB, RB: 2, WR: 3 };
    const byPos = anchorPools(false);
    const demand = computeStarterDemand(byPos, 12, spec, FLEX_STD);
    const vols = computeBaselines(byPos, demand, { lambda: 0, beta: BETA_1QB, numTeams: 12, benchSlots: 6 });
    expect(vols.baselineIndex).toMatchObject({ QB: 12, RB: 30, WR: 42, TE: 12 });
    const blend = computeBaselines(byPos, demand, { lambda: 0.5, beta: BETA_1QB, numTeams: 12, benchSlots: 6 });
    expect(blend.baselineIndex).toMatchObject({ QB: 16, RB: 44, WR: 56, TE: 16 });
  });

  it("clamps to pool length and reports it", () => {
    const byPos: PointsByPos = { QB: [300, 200], RB: [], WR: [], TE: [], K: [], DEF: [] };
    const res = computeBaselines(
      byPos,
      { QB: 10, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 },
      { lambda: 0, beta: BETA_1QB, numTeams: 10, benchSlots: 0 },
    );
    expect(res.baselineIndex.QB).toBe(2);
    expect(res.clamped).toContain("QB");
  });
});

describe("computeValues / rankOnlyValues", () => {
  const mkEntries = (): ValueEntry[] => {
    const byPos = anchorPools(true);
    const entries: ValueEntry[] = [];
    (Object.keys(byPos) as Pos[]).forEach((pos) => {
      byPos[pos].forEach((pts, i) => {
        entries.push({ id: `${pos}${i + 1}`, name: `${pos}${i + 1}`, team: "KC", pos, adp: null, projPoints: pts });
      });
    });
    return entries;
  };

  it("superflex: QB1 leapfrogs RB1 with zero format-specific code (VOLS)", () => {
    const spec: RosterSpec = { ...SPEC_1QB, RB: 2, WR: 3 };
    const valued = computeValues(mkEntries(), {
      numTeams: 12,
      rosterSpec: spec,
      flexEligibleBySlot: FLEX_SF,
      lambda: 0,
    });
    const qb1 = valued.find((p) => p.id === "QB1")!;
    const rb1 = valued.find((p) => p.id === "RB1")!;
    // §5: Allen 380−220=160 vs Bijan 305−172=133
    expect(qb1.value).toBeCloseTo(160, 6);
    expect(rb1.value).toBeCloseTo(133, 6);
    expect(qb1.rank).toBeLessThan(rb1.rank);
  });

  it("1QB: elite RB/WR outrank elite QB (VOLS)", () => {
    const spec: RosterSpec = { ...SPEC_1QB, RB: 2, WR: 3 };
    const valued = computeValues(mkEntries(), {
      numTeams: 12,
      rosterSpec: spec,
      flexEligibleBySlot: FLEX_STD,
      lambda: 0,
    });
    const qb1 = valued.find((p) => p.id === "QB1")!;
    const rb1 = valued.find((p) => p.id === "RB1")!;
    expect(rb1.rank).toBeLessThan(qb1.rank);
  });

  it("valueRank is a dense 1-based ordinal", () => {
    const valued = computeValues(mkEntries(), {
      numTeams: 12,
      rosterSpec: SPEC_1QB,
      flexEligibleBySlot: FLEX_STD,
    });
    valued.forEach((p, i) => expect(p.rank).toBe(i + 1));
  });

  it("rankOnlyValues: exact legacy degeneration (rank = sourceRank, value = −sourceRank)", () => {
    const out = rankOnlyValues([
      { id: "a", name: "A", team: "KC", pos: "RB", adp: 5, sourceRank: 2 },
      { id: "b", name: "B", team: "KC", pos: "WR", adp: null, sourceRank: 1 },
    ]);
    expect(out.map((p) => p.id)).toEqual(["b", "a"]);
    expect(out[0]).toMatchObject({ rank: 1, value: -1 });
    expect(out[1]).toMatchObject({ rank: 2, value: -2 });
  });
});
