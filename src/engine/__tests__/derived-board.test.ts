import { describe, it, expect } from "vitest";
import type { DraftConfig, DraftState, EnginePlayer, Pos } from "../types";
import { computeRecommendations, formatReason } from "../recommend";
import { buildPlayerPool } from "../pool";

// PLAN.md §6: a board DERIVED from market ADP cannot also be judged against it
// — rank and ADP are then the same underlying number and diverge only as tail
// noise. config.adpDerived suppresses the one rank-vs-ADP reason (FALLING) and
// nothing else; every ADP-vs-PICK-NUMBER signal (survival, outlook, scarcity)
// must stay bit-identical.

let id = 0;
const mk = (pos: Pos, rank: number, over: Partial<EnginePlayer> = {}): EnginePlayer => ({
  id: `p${++id}`,
  name: `P${id}`,
  team: "FA", // no byes — keeps BYE_STACK out of the comparison
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
  byeWeeks: {},
  adpContext: "1QB",
  ...over,
});

const mkState = (config: DraftConfig): DraftState => ({
  config,
  picks: [],
  recPos: ["QB", "RB", "WR", "TE", "DEF", "K"],
  queue: [],
});

/** Lone TE ranked 5 whose ADP (40) is 35 picks later — FALLING territory. */
function fallingPool() {
  const players = [
    ...Array.from({ length: 4 }, (_, i) => mk("RB", i + 1)),
    mk("TE", 5, { adp: 40 }),
    ...Array.from({ length: 8 }, (_, i) => mk("WR", i + 6)),
    ...Array.from({ length: 6 }, (_, i) => mk("QB", i + 14)),
  ];
  return { players, pool: buildPlayerPool(players), teId: players[4].id };
}

describe("adpDerived — FALLING suppression (PLAN.md §6)", () => {
  it("default (flag absent) still fires 'going ~N picks later than his rank'", () => {
    const { pool, teId } = fallingPool();
    const recs = computeRecommendations(mkState(mkConfig()), pool);
    const te = recs.find((r) => r.player.id === teId)!;
    expect(te).toBeDefined();
    expect(te.reasons).toContainEqual({ code: "FALLING", picksLater: 35 });
  });

  it("adpDerived: false is the legacy path verbatim", () => {
    const { pool, teId } = fallingPool();
    const legacy = computeRecommendations(mkState(mkConfig()), pool);
    const explicitFalse = computeRecommendations(mkState(mkConfig({ adpDerived: false })), pool);
    expect(explicitFalse).toEqual(legacy);
    expect(explicitFalse.find((r) => r.player.id === teId)!.reasons).toContainEqual({
      code: "FALLING",
      picksLater: 35,
    });
  });

  it("adpDerived: true drops FALLING and changes nothing else", () => {
    const { pool } = fallingPool();
    const legacy = computeRecommendations(mkState(mkConfig()), pool);
    const derived = computeRecommendations(mkState(mkConfig({ adpDerived: true })), pool);

    expect(derived.some((r) => r.reasons.some((x) => x.code === "FALLING"))).toBe(false);
    expect(legacy.some((r) => r.reasons.some((x) => x.code === "FALLING"))).toBe(true);

    // Same shortlist, same order, same scores — suppression is display-only.
    expect(derived.map((r) => r.player.id)).toEqual(legacy.map((r) => r.player.id));
    derived.forEach((d, i) => {
      const l = legacy[i];
      expect(d.score).toBe(l.score);
      expect(d.scoreBreakdown).toEqual(l.scoreBreakdown);
      expect(d.drop).toBe(l.drop);
      expect(d.tierLeft).toBe(l.tierLeft);
      expect(d.surv).toBe(l.surv);
      expect(d.adp).toBe(l.adp); // effectiveAdp is untouched: survival still uses it
      // reasons differ by exactly the removed FALLING entries
      expect(d.reasons).toEqual(l.reasons.filter((x) => x.code !== "FALLING"));
      expect(d.reason).toBe(d.reasons.slice(0, 2).map(formatReason).join(" · "));
    });
  });

  it("suppression reaches the rendered reason string when FALLING was in the top 2", () => {
    // 15-team seat 1 picks again at overall 30, so the ADP-30 leader survives
    // at exactly even odds: no GONE_SOON/WILL_WAIT, no drop (he is his own
    // successor), no tier scarcity — FALLING is the only reason after
    // BEST_OVERALL, i.e. inside the two the room actually prints.
    // exactly one TE tier (per-position cap 6) so no tier bonus reorders them
    const players = [mk("TE", 1, { adp: 30 }), ...Array.from({ length: 5 }, (_, i) => mk("TE", i + 2))];
    const pool = buildPlayerPool(players);
    const config = mkConfig({
      numTeams: 15,
      teamOrder: Array.from({ length: 15 }, (_, i) => i + 1),
      teamNames: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [i + 1, `T${i + 1}`])),
    });
    const legacy = computeRecommendations(mkState(config), pool);
    const derived = computeRecommendations(mkState({ ...config, adpDerived: true }), pool);

    expect(legacy[0].reason).toBe("Best available overall · going ~29 picks later than his rank");
    expect(derived[0].reason).toBe("Best available overall");
  });
});
