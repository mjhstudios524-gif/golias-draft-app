import { describe, it, expect } from "vitest";
import type { DraftConfig, DraftState, EnginePlayer } from "../types";
import { applyPick, undoLast, undoLastUserTurn, resetPicks, toggleQueue, toggleRecPos } from "../draft";
import { runAutoPicks, undoInMockDraft } from "../autopick";
import { buildPlayerPool } from "../pool";
import { isOnClock, totalPicks } from "../snake";
import { mulberry32 } from "../rng";

let id = 0;
const mkPlayers = (n: number): EnginePlayer[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${++id}`,
    name: `P${id}`,
    team: "KC",
    pos: (["QB", "RB", "WR", "TE", "DEF", "K"] as const)[i % 6],
    rank: i + 1,
    adp: null,
  }));

const config: DraftConfig = {
  numTeams: 4,
  teamOrder: [2, 4, 1, 3],
  teamNames: { 1: "T1", 2: "T2", 3: "T3", 4: "T4" },
  rosterSpec: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 1 }, // 8 rounds, 32 picks
  flexEligibleBySlot: [["RB", "WR", "TE"]],
  myTeamId: 1, // picks 3rd in round 1
  mockDraft: true,
  byeWeeks: {},
  adpContext: "1QB",
};

const fresh = (): DraftState => ({
  config,
  picks: [],
  queue: ["p999"],
  recPos: ["QB", "RB", "WR", "TE", "DEF", "K"],
});

describe("applyPick", () => {
  it("appends with derived round/pickInRound/teamId and never mutates input", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    const s0 = fresh();
    const s1 = applyPick(s0, players[0].id, pool);
    expect(s0.picks).toHaveLength(0);
    expect(s1.picks).toEqual([{ overall: 1, round: 1, pickInRound: 1, teamId: 2, playerId: players[0].id }]);
  });

  it("rejects duplicates and unknown ids (behavior-change #1)", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    const s = applyPick(fresh(), players[0].id, pool);
    expect(applyPick(s, players[0].id, pool)).toBe(s); // duplicate → unchanged
    expect(applyPick(s, "nope", pool)).toBe(s); // unknown → unchanged
  });

  it("no-ops once the draft is complete", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    let s = fresh();
    for (let i = 0; i < totalPicks(config); i++) s = applyPick(s, players[i].id, pool);
    expect(s.picks).toHaveLength(32);
    expect(applyPick(s, players[35].id, pool)).toBe(s);
  });
});

describe("undo semantics", () => {
  it("undoLast pops exactly one", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    let s = applyPick(fresh(), players[0].id, pool);
    s = applyPick(s, players[1].id, pool);
    expect(undoLast(s).picks).toHaveLength(1);
    expect(undoLast(fresh()).picks).toHaveLength(0);
  });

  it("undoLastUserTurn pops bot picks back through the user's last pick", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    const rng = mulberry32(3);
    let s = runAutoPicks(fresh(), pool, rng); // bots pick 1..2 (my slot is 3rd)
    expect(isOnClock(s, 1)).toBe(true);
    const myPickOverall = s.picks.length + 1;
    s = applyPick(s, players[10].id, pool);
    s = runAutoPicks(s, pool, rng); // bots continue to my round-2 turn
    expect(s.picks.length).toBeGreaterThan(myPickOverall);

    const undone = undoLastUserTurn(s);
    expect(undone.picks).toHaveLength(myPickOverall - 1); // back on my clock
    expect(isOnClock(undone, 1)).toBe(true);
  });

  it("user never picked → pops everything (pinned legacy stall precondition)", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    const s = runAutoPicks(fresh(), pool, mulberry32(3)); // only bot picks exist
    expect(undoLastUserTurn(s).picks).toHaveLength(0);
  });

  it("undoInMockDraft re-runs autopicks instead of stalling (behavior-change #2)", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    const rng = mulberry32(3);
    const s = runAutoPicks(fresh(), pool, rng);
    const undone = undoInMockDraft(s, pool, rng);
    // legacy would land at overall 1 with a bot on the clock and ignore clicks;
    // the fix lands the user back on their clock
    expect(isOnClock(undone, 1)).toBe(true);
    expect(undone.picks.length).toBeGreaterThan(0);
  });
});

describe("reset + toggles", () => {
  it("resetPicks clears picks ONLY — queue and recPos survive (pinned)", () => {
    const players = mkPlayers(40);
    const pool = buildPlayerPool(players);
    let s = applyPick(fresh(), players[0].id, pool);
    s = toggleRecPos(s, "K");
    const reset = resetPicks(s);
    expect(reset.picks).toHaveLength(0);
    expect(reset.queue).toEqual(["p999"]);
    expect(reset.recPos).not.toContain("K");
  });

  it("toggleQueue appends/removes preserving insertion order", () => {
    let s = fresh();
    s = toggleQueue(s, "a");
    s = toggleQueue(s, "b");
    expect(s.queue).toEqual(["p999", "a", "b"]);
    s = toggleQueue(s, "a");
    expect(s.queue).toEqual(["p999", "b"]);
  });

  it("toggleRecPos round-trips", () => {
    let s = fresh();
    s = toggleRecPos(s, "DEF");
    expect(s.recPos).not.toContain("DEF");
    s = toggleRecPos(s, "DEF");
    expect(s.recPos).toContain("DEF");
  });
});
