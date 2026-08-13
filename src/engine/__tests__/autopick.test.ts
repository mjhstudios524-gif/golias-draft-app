import { describe, it, expect } from "vitest";
import type { EnginePlayer, Rng } from "../types";
import { weightedPick } from "../autopick";
import { mulberry32 } from "../rng";

let poolInstance = 0;
const pool = (n: number): EnginePlayer[] => {
  poolInstance++;
  return Array.from({ length: n }, (_, i) => ({
    id: `${poolInstance}-${i}`,
    name: `P${i + 1}`,
    team: "KC",
    pos: "RB" as const,
    rank: i + 1,
    adp: null,
  }));
};

/** Rng stub yielding a fixed sequence (throws if over-consumed). */
const seq = (...vals: number[]): Rng => {
  let i = 0;
  return () => {
    if (i >= vals.length) throw new Error("rng over-consumed");
    return vals[i++];
  };
};

describe("weightedPick — branch boundaries (stubbed RNG)", () => {
  it("empty pool → null (no rng draws)", () => {
    expect(weightedPick([], seq())).toBeNull();
  });

  it("sleeper gate needs roll < 0.08 AND pool > 8", () => {
    const p9 = pool(9);
    // roll exactly 0.08 → NOT sleeper (strict <) → topN draw follows
    expect(weightedPick(p9, seq(0.08, 0))).toBe(p9[0]);
    // pool of exactly 8 → never sleeper even with tiny roll
    const p8 = pool(8);
    expect(weightedPick(p8, seq(0.01, 0))).toBe(p8[0]);
  });

  it("pool of exactly 9: sleeper band collapses to index 8", () => {
    const p9 = pool(9);
    expect(weightedPick(p9, seq(0.05, 0.0))).toBe(p9[8]);
    expect(weightedPick(p9, seq(0.05, 0.999))).toBe(p9[8]);
  });

  it("pool ≥ 30: band is indices 8..28 inclusive", () => {
    const p40 = pool(40);
    expect(weightedPick(p40, seq(0.05, 0.0))).toBe(p40[8]);
    expect(weightedPick(p40, seq(0.05, 0.9999))).toBe(p40[28]);
  });

  it("top-N cumulative walk: r <= acc inclusive boundaries", () => {
    const p20 = pool(20);
    // full weights sum 1.0: r = 0.55 exactly → idx 0 (r <= acc)
    expect(weightedPick(p20, seq(0.5, 0.55))).toBe(p20[0]);
    expect(weightedPick(p20, seq(0.5, 0.5500001))).toBe(p20[1]);
    expect(weightedPick(p20, seq(0.5, 0.79))).toBe(p20[1]);
    expect(weightedPick(p20, seq(0.5, 0.92))).toBe(p20[2]);
    expect(weightedPick(p20, seq(0.5, 0.99))).toBe(p20[3]);
  });

  it("short pools renormalize implicitly: pool of 2 uses weights .55/.24", () => {
    const p2 = pool(2);
    // r = rng * 0.79; rng .999 → r=.789 ≤ .79 → idx 1
    expect(weightedPick(p2, seq(0.5, 0.999))).toBe(p2[1]);
    // rng .69 → r=.545 ≤ .55 → idx 0
    expect(weightedPick(p2, seq(0.5, 0.69))).toBe(p2[0]);
  });

  it("pool of 1 always returns it", () => {
    const p1 = pool(1);
    expect(weightedPick(p1, seq(0.5, 0.9999))).toBe(p1[0]);
  });
});

describe("weightedPick — seeded distribution (200k draws, pool 40)", () => {
  it("matches net probabilities {.506,.2208,.1196,.0736} ±1% and sleeper band .08 ±0.5%", () => {
    const p40 = pool(40);
    const rng = mulberry32(7);
    const N = 200_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      const picked = weightedPick(p40, rng)!;
      counts.set(String(picked.id), (counts.get(String(picked.id)) ?? 0) + 1);
    }
    const freq = (idx: number) => (counts.get(String(p40[idx].id)) ?? 0) / N;
    expect(Math.abs(freq(0) - 0.506)).toBeLessThan(0.01);
    expect(Math.abs(freq(1) - 0.2208)).toBeLessThan(0.01);
    expect(Math.abs(freq(2) - 0.1196)).toBeLessThan(0.01);
    expect(Math.abs(freq(3) - 0.0736)).toBeLessThan(0.01);
    let sleeperTotal = 0;
    for (let i = 8; i <= 28; i++) sleeperTotal += freq(i);
    expect(Math.abs(sleeperTotal - 0.08)).toBeLessThan(0.005);
    // indices 4..7 are unreachable (not top-4, below sleeper band)
    for (let i = 4; i <= 7; i++) expect(freq(i)).toBe(0);
    for (let i = 29; i < 40; i++) expect(freq(i)).toBe(0);
  });
});
