import { describe, it, expect, afterAll, vi } from "vitest";
import type { MatchInput, MatchPlayer } from "../types";

// "server-only" throws outside a React Server Components bundle — inert stub
vi.mock("server-only", () => ({}));

// vitest does not load .env; point at the live local dev DB before the db
// singleton (imported dynamically below) reads its env group
process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;

const { jaroWinkler, exactMatch, fuzzyMatch, prepareInput, matchEntry, matchEntries } =
  await import("../match");
const { db } = await import("@/server/db");

const ctx = { userId: "vitest-matcher-user" }; // no user-scoped aliases exist for it

afterAll(async () => {
  await db.$disconnect();
});

describe("jaroWinkler — standard unit vectors", () => {
  it("matches the classic reference values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("jellyfish", "smellyfish")).toBeCloseTo(0.8963, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 4);
  });

  it("handles identity, empties, and disjoint strings", () => {
    expect(jaroWinkler("jamarrchase", "jamarrchase")).toBe(1);
    expect(jaroWinkler("", "")).toBe(1);
    expect(jaroWinkler("abc", "")).toBe(0);
    expect(jaroWinkler("", "abc")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("is symmetric", () => {
    for (const [a, b] of [
      ["martha", "marhta"],
      ["dixon", "dicksonx"],
      ["jamarchase", "jamarrchase"],
    ] as const) {
      expect(jaroWinkler(a, b)).toBeCloseTo(jaroWinkler(b, a), 12);
    }
  });
});

// Synthetic pools for the suffix side-channel — the seeded DB happens to hold
// no collision pair where one row carries a suffix, so the positive path is
// exercised at the pure-stage level.
function mp(o: Partial<MatchPlayer> & { id: string; nameKey: string }): MatchPlayer {
  return {
    fullName: o.id,
    suffix: null,
    pos: "RB",
    team: null,
    active: true,
    isTeamDefense: false,
    ...o,
  };
}

describe("exactMatch — suffix side-channel (stage 4)", () => {
  const senior = mp({ id: "p_sr", nameKey: "frankgore" });
  const junior = mp({ id: "p_jr", nameKey: "frankgore", suffix: "jr" });
  const input = (suffix: string | null) => ({ nameKey: "frankgore", suffix, team: null, pos: "RB" as const });

  it("a suffixed input uniquely picks the matching-suffix row of a collision pair", () => {
    expect(exactMatch(input("jr"), [senior, junior])).toEqual({
      playerId: "p_jr",
      matchMethod: "EXACT_NAME",
      confidence: 0.85,
    });
  });

  it("a suffix-less input uniquely picks the suffix-less row", () => {
    expect(exactMatch(input(null), [senior, junior])).toEqual({
      playerId: "p_sr",
      matchMethod: "EXACT_NAME",
      confidence: 0.85,
    });
  });

  it("falls through (never guesses) when the side channel cannot break the tie", () => {
    const twin = mp({ id: "p_sr2", nameKey: "frankgore" });
    expect(exactMatch(input(null), [senior, twin])).toBeNull(); // two suffix-less
    const jrTwin = mp({ id: "p_jr2", nameKey: "frankgore", suffix: "jr" });
    expect(exactMatch(input("jr"), [junior, jrTwin])).toBeNull(); // two jr rows
  });
});

describe("fuzzyMatch — acceptance rules (stage 5)", () => {
  const input = { nameKey: "jamarchase", suffix: null, team: null, pos: "WR" as const };

  it("accepts a unique above-threshold candidate with a clear gap", () => {
    const pool = [
      mp({ id: "a", nameKey: "jamarrchase", pos: "WR" }),
      mp({ id: "b", nameKey: "garrettwilson", pos: "WR" }),
    ];
    const res = fuzzyMatch(input, pool);
    expect(res.matchMethod).toBe("FUZZY");
    expect(res.playerId).toBe("a");
    expect(res.confidence).toBeCloseTo(jaroWinkler("jamarchase", "jamarrchase"), 12);
  });

  it("rejects a near-tie: two candidates above threshold", () => {
    const pool = [
      mp({ id: "a", nameKey: "jamarrchase", pos: "WR" }),
      mp({ id: "b", nameKey: "jamarrchase", pos: "WR" }),
    ];
    const res = fuzzyMatch(input, pool);
    expect(res.playerId).toBeNull();
    expect(res.matchMethod).toBe("UNMATCHED");
    expect(res.candidates).toHaveLength(2);
    // deterministic ordering: equal scores tie-break by playerId asc
    expect(res.candidates!.map((c) => c.playerId)).toEqual(["a", "b"]);
  });

  it("rejects when best minus runner-up is under the 0.03 gap", () => {
    // both very close to the input but distinct: gap below 0.03
    const pool = [
      mp({ id: "a", nameKey: "jamarrchase", pos: "WR" }),
      mp({ id: "b", nameKey: "jamarchasee", pos: "WR" }),
    ];
    const s1 = jaroWinkler(input.nameKey, "jamarrchase");
    const s2 = jaroWinkler(input.nameKey, "jamarchasee");
    expect(Math.abs(s1 - s2)).toBeLessThan(0.03); // fixture sanity
    const res = fuzzyMatch(input, pool);
    expect(res.matchMethod).toBe("UNMATCHED");
    expect(res.candidates!.length).toBeGreaterThanOrEqual(2);
  });

  it("returns empty candidates on an empty pool", () => {
    expect(fuzzyMatch(input, [])).toEqual({
      playerId: null,
      matchMethod: "UNMATCHED",
      confidence: null,
      candidates: [],
    });
  });
});

describe("stage attribution against the seeded DB", () => {
  const wr = (nameKey: string) =>
    db.player.findFirstOrThrow({ where: { nameKey, pos: "WR" }, orderBy: { id: "asc" } });

  it("punctuation: Ja'Marr Chase (straight + curly apostrophe) → EXACT_FULL", async () => {
    const chase = await wr("jamarrchase");
    for (const rawName of ["Ja'Marr Chase", "Ja’Marr Chase"]) {
      const res = await matchEntry({ rawName, team: "CIN", pos: "WR" }, ctx);
      expect(res).toMatchObject({ playerId: chase.id, matchMethod: "EXACT_FULL", confidence: 1 });
    }
  });

  it("punctuation: Amon-Ra St. Brown → EXACT_FULL; bare name → EXACT_NAME (stage 4)", async () => {
    const asb = await wr("amonrastbrown");
    expect(await matchEntry({ rawName: "Amon-Ra St. Brown", team: "DET", pos: "WR" }, ctx)).toMatchObject({
      playerId: asb.id,
      matchMethod: "EXACT_FULL",
    });
    expect(await matchEntry({ rawName: "Amon-Ra St. Brown", team: null, pos: null }, ctx)).toMatchObject({
      playerId: asb.id,
      matchMethod: "EXACT_NAME",
    });
  });

  it("Michael Pittman Jr. resolves to the suffix-less seeded Michael Pittman", async () => {
    const pittman = await wr("michaelpittman");
    const res = await matchEntry({ rawName: "Michael Pittman Jr.", team: null, pos: "WR" }, ctx);
    expect(res.playerId).toBe(pittman.id);
    expect(res.matchMethod).toBe("EXACT_POS");
  });

  it("DST forms all resolve to the same defense via the GLOBAL alias rows (stage 0)", async () => {
    const den = await db.player.findFirstOrThrow({ where: { isTeamDefense: true, nflTeam: "DEN" } });
    const inputs: MatchInput[] = [
      { rawName: "Broncos", team: null, pos: null },
      { rawName: "Denver D/ST", team: "DEN", pos: "DEF" },
      { rawName: "DEN DST", team: null, pos: "DEF" },
    ];
    for (const res of await matchEntries(inputs, ctx)) {
      expect(res).toMatchObject({ playerId: den.id, matchMethod: "ALIAS", confidence: 1 });
    }
  });

  it("no fuzzy for DSTs: an unknown DEF input is UNMATCHED with no candidates", async () => {
    const res = await matchEntry({ rawName: "Denver Broncoz", team: null, pos: "DEF" }, ctx);
    expect(res).toEqual({ playerId: null, matchMethod: "UNMATCHED", confidence: null });
  });

  it("team-mismatch-but-pos-match falls to EXACT_POS (offseason moves, stale files)", async () => {
    const chase = await wr("jamarrchase");
    const res = await matchEntry({ rawName: "Ja'Marr Chase", team: "LAR", pos: "WR" }, ctx);
    expect(res).toMatchObject({ playerId: chase.id, matchMethod: "EXACT_POS" });
  });

  it("team disambiguates a name collision at stage 3 (EXACT_TEAM)", async () => {
    // two seeded Frank Gore RBs: one BUF, one free agent
    const gores = await db.player.findMany({ where: { nameKey: "frankgore" }, orderBy: { id: "asc" } });
    expect(gores).toHaveLength(2);
    const buf = gores.find((p) => p.nflTeam === "BUF")!;
    const res = await matchEntry({ rawName: "Frank Gore", team: "BUF", pos: null }, ctx);
    expect(res).toMatchObject({ playerId: buf.id, matchMethod: "EXACT_TEAM" });
  });

  it("ambiguous two-candidate collision falls through every stage to a fuzzy near-tie → UNMATCHED", async () => {
    // two active seeded WRs share nameKey 'chasecota' with no suffix to break
    // the tie; both then fuzzy-score 1.0 — not unique above threshold
    const res = await matchEntry({ rawName: "Chase Cota", team: null, pos: "WR" }, ctx);
    expect(res.playerId).toBeNull();
    expect(res.matchMethod).toBe("UNMATCHED");
    expect(res.candidates![0].score).toBe(1);
    expect(res.candidates![1].score).toBe(1);
    // equal scores order by playerId asc — deterministic for the UI
    expect(res.candidates![0].playerId < res.candidates![1].playerId).toBe(true);
  });

  it("unmatched queue path: nonsense name yields top-5 candidates, scores descending", async () => {
    const res = await matchEntry({ rawName: "Zzyzx Quixote", team: null, pos: "WR" }, ctx);
    expect(res.playerId).toBeNull();
    expect(res.matchMethod).toBe("UNMATCHED");
    expect(res.candidates).toHaveLength(5);
    for (let i = 1; i < res.candidates!.length; i++) {
      expect(res.candidates![i - 1].score).toBeGreaterThanOrEqual(res.candidates![i].score);
    }
    for (const c of res.candidates!) expect(c.pos).toBe("WR");
  });

  it("fuzzy end-to-end agrees with the pure stage over the real WR pool", async () => {
    const res = await matchEntry({ rawName: "Jamar Chase", team: null, pos: "WR" }, ctx);
    const pool = (
      await db.player.findMany({
        where: { active: true, isTeamDefense: false, pos: "WR" },
        orderBy: { id: "asc" },
      })
    ).map((p) =>
      mp({ id: p.id, nameKey: p.nameKey, fullName: p.fullName, suffix: p.suffix, pos: "WR", team: p.nflTeam }),
    );
    const pure = fuzzyMatch(prepareInput({ rawName: "Jamar Chase", team: null, pos: "WR" }), pool);
    expect(res).toEqual(pure);
  });

  it("exact pipeline determinism: the same batch twice → identical output", async () => {
    const inputs: MatchInput[] = [
      { rawName: "Ja'Marr Chase", team: "CIN", pos: "WR" },
      { rawName: "Amon-Ra St. Brown", team: null, pos: null },
      { rawName: "Michael Pittman Jr.", team: null, pos: "WR" },
      { rawName: "Broncos", team: null, pos: null },
      { rawName: "Chase Cota", team: null, pos: "WR" },
      { rawName: "Frank Gore", team: "BUF", pos: null },
      { rawName: "Jamar Chase", team: null, pos: "WR" },
      { rawName: "Zzyzx Quixote", team: null, pos: "WR" },
      { rawName: "Denver Broncoz", team: null, pos: "DEF" },
      { rawName: "", team: null, pos: null },
    ];
    const first = await matchEntries(inputs, ctx);
    const second = await matchEntries(inputs, ctx);
    expect(second).toEqual(first);
    expect(first).toHaveLength(inputs.length);
    // blank name short-circuits to the unmatched queue
    expect(first[9]).toEqual({ playerId: null, matchMethod: "UNMATCHED", confidence: null });
  });
});
