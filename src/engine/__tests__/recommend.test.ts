import { describe, it, expect } from "vitest";
import type { DraftConfig, DraftState, EnginePlayer, Pos } from "../types";
import { computeRecommendations, formatReason } from "../recommend";
import { buildPlayerPool } from "../pool";
import { applyPick } from "../draft";

let id = 0;
const mk = (pos: Pos, rank: number, over: Partial<EnginePlayer> = {}): EnginePlayer => ({
  id: `p${++id}`,
  name: `P${id}`,
  team: "SF",
  pos,
  rank,
  adp: null,
  ...over,
});

const mkConfig = (over: Partial<DraftConfig> = {}): DraftConfig => ({
  numTeams: 2,
  teamOrder: [1, 2],
  teamNames: { 1: "Me", 2: "Them" },
  rosterSpec: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 4 },
  flexEligibleBySlot: [["RB", "WR", "TE"]],
  myTeamId: 1,
  mockDraft: false,
  byeWeeks: { KC: 5, SF: 8, DET: 6 },
  adpContext: "1QB",
  ...over,
});

const mkState = (config: DraftConfig): DraftState => ({
  config,
  picks: [],
  recPos: ["QB", "RB", "WR", "TE", "DEF", "K"],
  queue: [],
});

describe("computeRecommendations — gates", () => {
  it("empty when not on the clock", () => {
    const config = mkConfig({ myTeamId: 2 }); // team 1 picks first
    const players = Array.from({ length: 20 }, (_, i) => mk("RB", i + 1));
    const pool = buildPlayerPool(players);
    expect(computeRecommendations(mkState(config), pool)).toEqual([]);
  });

  it("empty when every available position is toggled off", () => {
    const players = Array.from({ length: 10 }, (_, i) => mk("RB", i + 1));
    const pool = buildPlayerPool(players);
    const state = { ...mkState(mkConfig()), recPos: ["QB"] as Pos[] };
    expect(computeRecommendations(state, pool)).toEqual([]);
  });
});

describe("computeRecommendations — shortlist shape", () => {
  it("max 2 per position, stop at 5, positions with best scores first", () => {
    // 10 RBs ranked 1-10 (huge pool advantage) + a few others
    const players = [
      ...Array.from({ length: 10 }, (_, i) => mk("RB", i + 1)),
      mk("WR", 11), mk("WR", 12), mk("TE", 13), mk("QB", 14), mk("DEF", 15), mk("K", 16),
    ];
    const pool = buildPlayerPool(players);
    const recs = computeRecommendations(mkState(mkConfig()), pool);
    expect(recs.length).toBeLessThanOrEqual(5);
    const perPos = new Map<string, number>();
    recs.forEach((r) => perPos.set(r.player.pos, (perPos.get(r.player.pos) ?? 0) + 1));
    perPos.forEach((count) => expect(count).toBeLessThanOrEqual(2));
    // scores non-increasing within the returned order is NOT guaranteed across
    // positions (the per-pos cap skips), but the first entry is the top score
    const all = recs.map((r) => r.score);
    expect(Math.max(...all)).toBe(all[0]);
  });

  it("45-candidate scoring cap excludes deep-pool players entirely", () => {
    // 50 same-position players; the one ranked 46+ can never appear
    const players = Array.from({ length: 50 }, (_, i) => mk("WR", i + 1));
    const pool = buildPlayerPool(players);
    const recs = computeRecommendations(mkState(mkConfig()), pool);
    recs.forEach((r) => expect(r.player.rank).toBeLessThanOrEqual(45));
  });
});

describe("reason generation", () => {
  it("BEST_OVERALL fires for the top-ranked available player", () => {
    const players = [mk("RB", 1), mk("RB", 2), mk("WR", 3), mk("TE", 4), mk("QB", 5)];
    const pool = buildPlayerPool(players);
    const recs = computeRecommendations(mkState(mkConfig()), pool);
    const top = recs.find((r) => r.player.rank === 1)!;
    expect(top.reasons[0]).toEqual({ code: "BEST_OVERALL" });
    expect(top.reason.startsWith("Best available overall")).toBe(true);
  });

  it("keeps exactly the first 2 reasons joined with ' · '", () => {
    // top-ranked + last in tier + big drop candidate: >=3 reasons fire
    const players = [
      mk("RB", 1), mk("RB", 40), mk("RB", 41), // huge RB cliff after #1
      mk("WR", 2), mk("WR", 3), mk("TE", 4), mk("QB", 5), mk("DEF", 6), mk("K", 7),
    ];
    const pool = buildPlayerPool(players);
    const recs = computeRecommendations(mkState(mkConfig()), pool);
    const rb1 = recs.find((r) => r.player.rank === 1)!;
    expect(rb1.reasons.length).toBeGreaterThanOrEqual(2);
    expect(rb1.reason.split(" · ")).toHaveLength(2);
    expect(rb1.reason).toBe(rb1.reasons.slice(0, 2).map(formatReason).join(" · "));
  });

  it("STRONG_VALUE only when nothing else fires", () => {
    // dense uniform pool: no cliffs, no tier scarcity, no ADP, no byes
    const players = Array.from({ length: 30 }, (_, i) => mk((["RB", "WR"] as Pos[])[i % 2], i + 1, { team: "FA" }));
    const pool = buildPlayerPool(players);
    const recs = computeRecommendations(mkState(mkConfig()), pool);
    const withFallback = recs.filter((r) => r.reasons.some((x) => x.code === "STRONG_VALUE"));
    withFallback.forEach((r) => expect(r.reasons).toHaveLength(1));
  });

  it("bye clash penalizes at >=2 rostered starters on that bye and reads 'stacks your Week N bye'", () => {
    const config = mkConfig();
    const players = [
      mk("RB", 1, { team: "KC" }), mk("RB", 2, { team: "KC" }), // my first two picks
      mk("WR", 3, { team: "KC" }), // candidate — clashes (2 KC starters already)
      mk("WR", 4, { team: "SF" }), // control
      ...Array.from({ length: 8 }, (_, i) => mk("TE", 10 + i, { team: "DET" })),
    ];
    const pool = buildPlayerPool(players);
    let state = mkState(config);
    // 2-team snake: my picks are overalls 1 and 4; overall 5 is my clock again
    state = applyPick(state, players[0].id, pool); // me: KC RB
    state = applyPick(state, players[4].id, pool); // them (TE)
    state = applyPick(state, players[5].id, pool); // them (TE)
    state = applyPick(state, players[1].id, pool); // me: KC RB #2
    const recs = computeRecommendations(state, pool);
    const clash = recs.find((r) => r.player.id === players[2].id);
    const control = recs.find((r) => r.player.id === players[3].id);
    expect(clash?.byeClash).toBe(true);
    expect(clash?.scoreBreakdown.byePenalty).toBe(-4);
    expect(clash?.reasons.some((x) => x.code === "BYE_STACK" && x.bye === 5)).toBe(true);
    expect(formatReason({ code: "BYE_STACK", bye: 5 })).toBe("stacks your Week 5 bye");
    expect(control?.byeClash).toBe(false);
  });
});

describe("formatReason — verbatim legacy strings incl. number interpolation", () => {
  it("renders every reason code exactly", () => {
    expect(formatReason({ code: "GONE_SOON", adp: 35.7 })).toBe("ADP 35.7 - gone before your next pick");
    expect(formatReason({ code: "GONE_SOON", adp: 4 })).toBe("ADP 4 - gone before your next pick");
    expect(formatReason({ code: "BIG_DROP", pos: "RB" })).toBe("Big drop-off at RB after him");
    expect(formatReason({ code: "THINS_OUT", pos: "WR" })).toBe("WR thins out before your next pick");
    expect(formatReason({ code: "TIER_LAST_FEW", n: 2, pos: "TE" })).toBe("Only 2 left in this TE tier");
    expect(formatReason({ code: "TIER_FEW", n: 4, pos: "QB" })).toBe("4 left in this QB tier");
    expect(formatReason({ code: "WILL_WAIT", adp: 100.9 })).toBe("ADP 100.9 - should still be here next turn");
    expect(formatReason({ code: "FALLING", picksLater: 27 })).toBe("going ~27 picks later than his rank");
    expect(formatReason({ code: "STRONG_VALUE", pos: "K" })).toBe("Strong value at K");
  });
});
