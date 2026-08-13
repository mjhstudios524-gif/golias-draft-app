import { describe, expect, it } from "vitest";
import { leagueInputSchema, readLeagueRosterSpec, scoringConfigSchema } from "@/lib/leagues";

const validInput = {
  name: "My League",
  numTeams: 10,
  rosterSpec: { QB: 2, RB: 2, WR: 3, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 },
  flexEligibleBySlot: [["RB", "WR", "TE"]],
  scoring: { name: "Half PPR", weights: { rec: 0.5, pass_td: 4 } },
};

describe("leagueInputSchema", () => {
  it("accepts a valid league", () => {
    const parsed = leagueInputSchema.parse(validInput);
    expect(parsed.numTeams).toBe(10);
    expect(parsed.rankingSetId).toBeUndefined();
  });

  it("enforces numTeams 4-20", () => {
    expect(leagueInputSchema.safeParse({ ...validInput, numTeams: 3 }).success).toBe(false);
    expect(leagueInputSchema.safeParse({ ...validInput, numTeams: 21 }).success).toBe(false);
    expect(leagueInputSchema.safeParse({ ...validInput, numTeams: 4 }).success).toBe(true);
    expect(leagueInputSchema.safeParse({ ...validInput, numTeams: 20 }).success).toBe(true);
  });

  it("requires one eligibility list per FLEX slot", () => {
    expect(
      leagueInputSchema.safeParse({
        ...validInput,
        rosterSpec: { ...validInput.rosterSpec, FLEX: 2 },
      }).success,
    ).toBe(false);
    expect(
      leagueInputSchema.safeParse({
        ...validInput,
        rosterSpec: { ...validInput.rosterSpec, FLEX: 2 },
        flexEligibleBySlot: [["RB", "WR", "TE"], ["QB", "RB", "WR", "TE"]],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty eligibility list and non-flex positions", () => {
    expect(
      leagueInputSchema.safeParse({ ...validInput, flexEligibleBySlot: [[]] }).success,
    ).toBe(false);
    expect(
      leagueInputSchema.safeParse({ ...validInput, flexEligibleBySlot: [["DEF"]] }).success,
    ).toBe(false);
  });

  it("rejects an all-zero roster", () => {
    expect(
      leagueInputSchema.safeParse({
        ...validInput,
        rosterSpec: { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 0 },
        flexEligibleBySlot: [],
      }).success,
    ).toBe(false);
  });

  it("strips unknown keys (updateLeague passes {id, ...input})", () => {
    const parsed = leagueInputSchema.parse({ ...validInput, id: "league_1" });
    expect("id" in parsed).toBe(false);
  });
});

describe("scoringConfigSchema", () => {
  it("round-trips weights and posWeights", () => {
    const cfg = {
      name: "TE Premium",
      weights: { rec: 0.5, pass_td: 6 },
      posWeights: { TE: { rec: 0.5 } },
    };
    expect(scoringConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it("allows posWeights to be partial across positions", () => {
    expect(scoringConfigSchema.safeParse({ name: "x", weights: {}, posWeights: {} }).success).toBe(
      true,
    );
  });
});

describe("readLeagueRosterSpec", () => {
  const spec = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1, K: 1, BN: 6 };

  it("round-trips a stored rosterSpec Json", () => {
    const stored = { ...spec, flexEligibleBySlot: [["RB", "WR"], ["QB", "RB", "WR", "TE"]] };
    expect(readLeagueRosterSpec(stored)).toEqual({
      spec,
      flexEligibleBySlot: [["RB", "WR"], ["QB", "RB", "WR", "TE"]],
    });
  });

  it("pads missing eligibility lists with the RB/WR/TE default (legacy dev rows)", () => {
    const out = readLeagueRosterSpec(spec);
    expect(out?.flexEligibleBySlot).toEqual([
      ["RB", "WR", "TE"],
      ["RB", "WR", "TE"],
    ]);
  });

  it("truncates surplus eligibility lists to the FLEX count", () => {
    const stored = {
      ...spec,
      FLEX: 1,
      flexEligibleBySlot: [["RB"], ["WR"]],
    };
    expect(readLeagueRosterSpec(stored)?.flexEligibleBySlot).toEqual([["RB"]]);
  });

  it("returns null on garbage", () => {
    expect(readLeagueRosterSpec(null)).toBeNull();
    expect(readLeagueRosterSpec({ QB: "one" })).toBeNull();
    expect(readLeagueRosterSpec({})).toBeNull();
  });
});
