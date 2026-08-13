import { describe, expect, it } from "vitest";
import {
  buildSnapshotPlayers,
  mapAdpContext,
  type MatchedPlayer,
  type SnapshotSourceEntry,
} from "@/server/snapshot-players";
import type { ScoringConfig } from "@/engine/types";

const entry = (over: Partial<SnapshotSourceEntry>): SnapshotSourceEntry => ({
  playerId: null,
  rawName: "Someone",
  team: null,
  pos: null,
  rank: null,
  adp: null,
  projPoints: null,
  stats: null,
  matchMethod: "UNLINKED",
  sourceRow: 0,
  ...over,
});

const scoring: ScoringConfig = {
  name: "test",
  weights: { rec: 1, rec_yd: 0.1 },
  posWeights: { TE: { rec: 0.5 } },
};

const ctx = {
  numTeams: 2,
  rosterSpec: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1, DEF: 0, K: 0, BN: 1 },
  flexEligibleBySlot: [["RB", "WR", "TE"]] as ("QB" | "RB" | "WR" | "TE")[][],
  scoring,
};

describe("mapAdpContext", () => {
  it("maps the Prisma enum onto the engine vocabulary", () => {
    expect(mapAdpContext("ONE_QB")).toBe("1QB");
    expect(mapAdpContext("SUPERFLEX")).toBe("SF");
    expect(mapAdpContext("UNKNOWN")).toBe("UNKNOWN");
    expect(mapAdpContext("anything-else")).toBe("UNKNOWN");
  });
});

describe("buildSnapshotPlayers — RANK_ONLY (strict legacy mode, PLAN.md §14 #5)", () => {
  const matched = new Map<string, MatchedPlayer>([
    ["p1", { fullName: "Alpha Back", pos: "RB", nflTeam: "DEN" }],
  ]);

  it("uses sourceRank as rank and -sourceRank as value", () => {
    const { players, skipped } = buildSnapshotPlayers({
      setId: "set1",
      tier: "RANK_ONLY",
      entries: [
        entry({ playerId: "p1", rank: 2, adp: 5.5 }),
        entry({ rawName: "Custom Guy", pos: "WR", team: "ARZ", rank: 1, sourceRow: 7 }),
      ],
      matched,
      ctx,
    });
    expect(skipped).toBe(0);
    expect(players.map((p) => p.id)).toEqual(["custom:set1:7", "p1"]);
    expect(players[0]).toMatchObject({
      name: "Custom Guy",
      team: "ARI", // canonicalized from ARZ
      pos: "WR",
      rank: 1,
      value: -1,
      adp: null,
    });
    expect(players[1]).toMatchObject({ name: "Alpha Back", team: "DEN", rank: 2, value: -2, adp: 5.5 });
  });

  it("skips entries lacking rank, position (unlinked), or a Player row — with a count", () => {
    const { players, skipped } = buildSnapshotPlayers({
      setId: "set1",
      tier: "RANK_ONLY",
      entries: [
        entry({ playerId: "p1", rank: null }), // matched but no rank
        entry({ rawName: "No Pos", rank: 3 }), // unlinked without a position
        entry({ playerId: "ghost", rank: 4 }), // playerId with no Player row
        entry({ rawName: "OK", pos: "TE", rank: 5, sourceRow: 9 }),
      ],
      matched,
      ctx,
    });
    expect(skipped).toBe(3);
    expect(players.map((p) => p.id)).toEqual(["custom:set1:9"]);
  });

  it("drops excluded/unresolved rows silently (they never reach a board)", () => {
    const { players, skipped } = buildSnapshotPlayers({
      setId: "set1",
      tier: "RANK_ONLY",
      entries: [entry({ rawName: "Excluded", pos: "RB", rank: 1, matchMethod: "EXCLUDED" })],
      matched,
      ctx,
    });
    expect(players).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("falls back to FA when an unlinked entry has no team", () => {
    const { players } = buildSnapshotPlayers({
      setId: "s",
      tier: "RANK_ONLY",
      entries: [entry({ rawName: "Rookie", pos: "RB", rank: 1, sourceRow: 1 })],
      matched,
      ctx,
    });
    expect(players[0].team).toBe("FA");
  });
});

describe("buildSnapshotPlayers — POINTS", () => {
  it("orders by VBD value from the given points and keeps projPoints", () => {
    const { players, skipped } = buildSnapshotPlayers({
      setId: "s",
      tier: "POINTS",
      entries: [
        entry({ rawName: "RB Low", pos: "RB", projPoints: 100, sourceRow: 1 }),
        entry({ rawName: "RB High", pos: "RB", projPoints: 200, sourceRow: 2 }),
        entry({ rawName: "No Points", pos: "RB", rank: 1, sourceRow: 3 }), // lacks the tier datum
      ],
      matched: new Map(),
      ctx,
    });
    expect(skipped).toBe(1);
    expect(players.map((p) => p.name)).toEqual(["RB High", "RB Low"]);
    expect(players.map((p) => p.rank)).toEqual([1, 2]);
    expect(players[0].projPoints).toBe(200);
    // same-position values keep the raw points gap (per-pos baseline subtraction)
    expect(players[0].value! - players[1].value!).toBe(100);
  });
});

describe("buildSnapshotPlayers — FULL_STATS", () => {
  it("prices stat lines through pointsFor under the league scoring (incl. TE premium)", () => {
    const { players, skipped } = buildSnapshotPlayers({
      setId: "s",
      tier: "FULL_STATS",
      entries: [
        entry({ rawName: "WR Guy", pos: "WR", stats: { rec: 10, rec_yd: 100 }, sourceRow: 1 }),
        entry({ rawName: "TE Guy", pos: "TE", stats: { rec: 10 }, sourceRow: 2 }),
        entry({ rawName: "Bad Stats", pos: "WR", stats: { rec: "ten" }, sourceRow: 3 }),
        entry({ rawName: "No Stats", pos: "WR", projPoints: 50, sourceRow: 4 }),
      ],
      matched: new Map(),
      ctx,
    });
    expect(skipped).toBe(2);
    const byName = Object.fromEntries(players.map((p) => [p.name, p]));
    expect(byName["WR Guy"].projPoints).toBe(20); // 10·1 + 100·0.1
    expect(byName["TE Guy"].projPoints).toBe(15); // 10·(1 + 0.5 TE premium)
  });
});
