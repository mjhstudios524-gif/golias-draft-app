import { describe, it, expect } from "vitest";
import type { RosterSpec } from "../types";
import { leagueFormat, flexEligibleUnion } from "../format";
import { canonicalTeamCode, TEAM_ALIASES } from "../teams";
import { byeWeekFor } from "../bye";

const spec = (qb: number): RosterSpec => ({ QB: qb, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 });

describe("leagueFormat", () => {
  it("QB >= 2 → MULTI_QB", () => {
    expect(leagueFormat(spec(2), [["RB", "WR", "TE"]])).toBe("MULTI_QB");
  });
  it("any QB-eligible flex slot → MULTI_QB", () => {
    expect(leagueFormat(spec(1), [["RB", "WR"], ["QB", "RB", "WR", "TE"]])).toBe("MULTI_QB");
  });
  it("neither → 1QB; empty flex list safe", () => {
    expect(leagueFormat(spec(1), [["RB", "WR", "TE"]])).toBe("1QB");
    expect(leagueFormat(spec(1), [])).toBe("1QB");
  });
});

describe("flexEligibleUnion", () => {
  it("unions across slots in QB,RB,WR,TE order", () => {
    expect(flexEligibleUnion([["TE", "WR"], ["QB", "RB"]])).toEqual(["QB", "RB", "WR", "TE"]);
  });
  it("empty → RB/WR/TE default", () => {
    expect(flexEligibleUnion([])).toEqual(["RB", "WR", "TE"]);
  });
});

describe("canonicalTeamCode", () => {
  it("maps every alias and passes canonical codes through", () => {
    expect(canonicalTeamCode("ARZ")).toBe("ARI");
    expect(canonicalTeamCode("BLT")).toBe("BAL");
    expect(canonicalTeamCode("HST")).toBe("HOU");
    expect(canonicalTeamCode("LA")).toBe("LAR");
    expect(canonicalTeamCode("OAK")).toBe("LV");
    expect(canonicalTeamCode("KC")).toBe("KC");
    expect(canonicalTeamCode(" kc ")).toBe("KC");
  });
  it("free-agent markers and null → null", () => {
    expect(canonicalTeamCode("FA")).toBeNull();
    expect(canonicalTeamCode("INA")).toBeNull();
    expect(canonicalTeamCode("")).toBeNull();
    expect(canonicalTeamCode(null)).toBeNull();
  });
  it("alias values are themselves canonical (no chains)", () => {
    Object.values(TEAM_ALIASES).forEach((v) => expect(TEAM_ALIASES[v]).toBeUndefined());
  });
});

describe("byeWeekFor", () => {
  it("injected map lookup; unknown → null", () => {
    expect(byeWeekFor("KC", { KC: 5 })).toBe(5);
    expect(byeWeekFor("FA", { KC: 5 })).toBeNull();
  });
});
