import { describe, expect, it } from "vitest";
import { currentSeason } from "@/lib/season";

const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0) =>
  new Date(Date.UTC(y, m, d, h, min, s));

describe("currentSeason — league-year window (PLAN.md §14 #3)", () => {
  it("Mar 1 opens the new league year", () => {
    const s = currentSeason(utc(2026, 2, 1));
    expect(s.product).toBe("season-2026");
    expect(s.seasonYear).toBe(2026);
    expect(s.expiresAt.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("Feb 28 23:59:59 still belongs to the outgoing league year", () => {
    const s = currentSeason(utc(2026, 1, 28, 23, 59, 59));
    expect(s.product).toBe("season-2025");
    expect(s.expiresAt.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("leap day (Feb 29) belongs to the outgoing league year", () => {
    const s = currentSeason(utc(2028, 1, 29, 12));
    expect(s.product).toBe("season-2027");
    expect(s.expiresAt.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("Mar 1 following a leap day rolls over correctly", () => {
    const s = currentSeason(utc(2028, 2, 1));
    expect(s.product).toBe("season-2028");
    expect(s.expiresAt.toISOString()).toBe("2029-03-01T00:00:00.000Z");
  });

  it("December mid-season stays on the current league year", () => {
    const s = currentSeason(utc(2026, 11, 15));
    expect(s.product).toBe("season-2026");
    expect(s.expiresAt.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("January playoffs still map to the prior calendar year's product", () => {
    const s = currentSeason(utc(2027, 0, 10));
    expect(s.product).toBe("season-2026");
    expect(s.seasonYear).toBe(2026);
    expect(s.expiresAt.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("a purchase instant equal to its own expiry boundary buys the NEW season", () => {
    // The Mar 1 00:00:00 UTC instant is not ambiguous: it opens season Y,
    // and season Y-1 entitlements expire exactly then (expiresAt <= now).
    const boundary = utc(2027, 2, 1);
    expect(currentSeason(boundary).product).toBe("season-2027");
    expect(currentSeason(new Date(boundary.getTime() - 1)).product).toBe("season-2026");
  });
});
