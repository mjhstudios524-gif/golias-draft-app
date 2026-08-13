import { describe, it, expect } from "vitest";
import type { EnginePlayer, Pos } from "../types";
import { computeTiers, tierRemaining } from "../tiers";

let nextId = 0;
const players = (pos: Pos, ranks: number[]): EnginePlayer[] =>
  ranks.map((rank) => ({ id: ++nextId, name: `P${nextId}`, team: "KC", pos, rank, adp: null }));

const tiersOf = (list: EnginePlayer[]) => {
  const map = computeTiers(list);
  return list
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .map((p) => map.get(p.id));
};

describe("computeTiers — gap vs local-median with per-position caps", () => {
  it("uniform gap-1 run of 9 splits at the cap: RB (cap 8) → 8+1", () => {
    expect(tiersOf(players("RB", [1, 2, 3, 4, 5, 6, 7, 8, 9]))).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2]);
  });

  it("QB cap 6 → 6+3", () => {
    expect(tiersOf(players("QB", [1, 2, 3, 4, 5, 6, 7, 8, 9]))).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2]);
  });

  it("uniform gap-2 run does NOT break (thr = max(2, 2·2) = 4 > gap)", () => {
    expect(tiersOf(players("RB", [1, 3, 5, 7, 9, 11]))).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("a gap-2 inside a gap-1 run breaks (med 1 → thr 2, g >= thr inclusive)", () => {
    expect(tiersOf(players("RB", [1, 2, 3, 5, 6, 7]))).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("large gap mid-list breaks even inside a sparse run", () => {
    // gaps [3,3,20,3,3]: at the 20 the local sorted window [3,3,3,3,20] has
    // upper-median 3 → thr 6 → 20 breaks
    expect(tiersOf(players("WR", [1, 4, 7, 27, 30, 33]))).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it("singleton and two-player positions (a lone gap can never split: thr = 2×gap > gap)", () => {
    expect(tiersOf(players("TE", [5]))).toEqual([1]);
    expect(tiersOf(players("TE", [5, 6]))).toEqual([1, 1]);
    // pinned legacy behavior: with one gap the window median IS the gap,
    // so even a 25-rank cliff between two players stays one tier
    expect(tiersOf(players("TE", [5, 30]))).toEqual([1, 1]);
  });

  it("positions tier independently and non-contiguous overall ranks are fine", () => {
    const mixed = [...players("RB", [1, 5, 9]), ...players("WR", [2, 3, 4])];
    const map = computeTiers(mixed);
    // RB gaps of 4 with med 4 → thr 8 → single tier; WR gap-1 → single tier
    mixed.forEach((p) => expect(map.get(p.id)).toBe(1));
  });

  it("tier numbers start at 1 and increment by exactly 1", () => {
    const list = players("RB", [1, 2, 3, 4, 20, 21, 22, 50, 51]);
    const ts = tiersOf(list) as number[];
    expect(ts[0]).toBe(1);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(0);
      expect(ts[i]! - ts[i - 1]!).toBeLessThanOrEqual(1);
    }
  });

  it("custom metric generalization: same tiers when metric is a scaled rank", () => {
    const list = players("RB", [1, 2, 3, 5, 6, 7]);
    const byRank = computeTiers(list);
    // valueRank semantics: metric = rank (identical), gapFloor default —
    // scaled metric with proportional floor produces identical grouping
    const scaled = computeTiers(list, { metric: (p) => p.rank * 10, gapFloor: 20 });
    list.forEach((p) => expect(scaled.get(p.id)).toBe(byRank.get(p.id)));
  });
});

describe("tierRemaining", () => {
  it("counts same-pos same-tier players among available only", () => {
    const list = players("RB", [1, 2, 3, 5, 6, 7]);
    const map = computeTiers(list);
    const available = list.filter((p) => p.rank !== 2); // one tier-1 RB drafted
    expect(tierRemaining(list[0], available, map)).toBe(2); // ranks 1,3 left in tier 1
  });
});
