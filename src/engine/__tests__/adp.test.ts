import { describe, it, expect, test } from "vitest";
import type { EnginePlayer } from "../types";
import { effectiveAdp, survivalProb, adpSignal } from "../adp";

const p = (over: Partial<EnginePlayer>): EnginePlayer => ({
  id: 1,
  name: "Test Player",
  team: "KC",
  pos: "RB",
  rank: 10,
  adp: 10,
  ...over,
});

describe("effectiveAdp — generalized FTN rule", () => {
  it("passes ADP through in a 1QB league regardless of source context", () => {
    expect(effectiveAdp(p({ pos: "QB", adp: 36 }), "1QB", "1QB")).toBe(36);
    expect(effectiveAdp(p({ pos: "QB", adp: 36 }), "SF", "1QB")).toBe(36);
    expect(effectiveAdp(p({ pos: "QB", adp: 36 }), "UNKNOWN", "1QB")).toBe(36);
  });
  it("nulls QB ADP in a multi-QB league when the source is 1QB-market", () => {
    expect(effectiveAdp(p({ pos: "QB", adp: 36 }), "1QB", "MULTI_QB")).toBeNull();
  });
  it("UNKNOWN source defaults to the 1QB behavior (legacy default)", () => {
    expect(effectiveAdp(p({ pos: "QB", adp: 36 }), "UNKNOWN", "MULTI_QB")).toBeNull();
  });
  it("SF-market ADP survives in a multi-QB league", () => {
    expect(effectiveAdp(p({ pos: "QB", adp: 3 }), "SF", "MULTI_QB")).toBe(3);
  });
  it("non-QB positions are never nulled", () => {
    expect(effectiveAdp(p({ pos: "RB", adp: 36 }), "1QB", "MULTI_QB")).toBe(36);
  });
  it("null contract: missing player or missing adp", () => {
    expect(effectiveAdp(null, "1QB", "1QB")).toBeNull();
    expect(effectiveAdp(p({ adp: null }), "1QB", "1QB")).toBeNull();
  });
});

describe("survivalProb — logistic golden numbers (1e-6)", () => {
  // sigma = max(6, 0.18·adp), P = 1/(1+exp(-1.7·(adp-at)/sigma))
  test.each([
    [30, 30, 0.5],
    [30, 36, 0.1544653],
    [30, 24, 0.8455347],
    [10, 13, 0.299433], // sigma floor 6 active
    [100, 136, 0.0322955], // sigma 18
    [200, 180, 0.7199965], // sigma 36
  ])("adp %d at pick %d → %f", (adp, at, expected) => {
    const v = survivalProb(p({ adp }), at, "1QB", "1QB");
    expect(v).not.toBeNull();
    expect(Math.abs(v! - expected)).toBeLessThan(1e-6);
  });

  it("sigma floor boundary: identical shape at adp 33 (floor) vs scaled at 34", () => {
    // adp 33: sigma = max(6, 5.94) = 6; adp 34: sigma = 6.12
    const at33 = survivalProb(p({ adp: 33 }), 39, "1QB", "1QB")!;
    expect(Math.abs(at33 - 1 / (1 + Math.exp((1.7 * 6) / 6)))).toBeLessThan(1e-12);
    const at34 = survivalProb(p({ adp: 34 }), 40, "1QB", "1QB")!;
    expect(Math.abs(at34 - 1 / (1 + Math.exp((1.7 * 6) / 6.12)))).toBeLessThan(1e-12);
  });

  it("null when adp null, atOverall null, or format-nulled QB", () => {
    expect(survivalProb(p({ adp: null }), 10, "1QB", "1QB")).toBeNull();
    expect(survivalProb(p({}), null, "1QB", "1QB")).toBeNull();
    expect(survivalProb(p({ pos: "QB" }), 10, "1QB", "MULTI_QB")).toBeNull();
  });

  it("strictly decreasing in atOverall", () => {
    let prev = 1;
    for (let at = 1; at <= 100; at += 3) {
      const v = survivalProb(p({ adp: 50 }), at, "1QB", "1QB")!;
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });
});

describe("adpSignal — ADP cell classifier", () => {
  test.each([
    [{ rank: 10, adp: 30 }, "value"], // d = +20 → value (inclusive)
    [{ rank: 10, adp: 29.9 }, "neutral"],
    [{ rank: 30, adp: 10 }, "reach"], // d = -20 → reach (inclusive)
    [{ rank: 30, adp: 10.1 }, "neutral"],
    [{ rank: 10, adp: null }, "na"],
  ])("%o → %s", (over, expected) => {
    expect(adpSignal(p(over as Partial<EnginePlayer>), "1QB", "1QB")).toBe(expected);
  });
  it("format-nulled QB reads superflex-qb (rendered '{adp}*')", () => {
    expect(adpSignal(p({ pos: "QB", adp: 36 }), "1QB", "MULTI_QB")).toBe("superflex-qb");
  });
});
