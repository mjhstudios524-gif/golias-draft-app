import { describe, expect } from "vitest";
import { test, fc } from "@fast-check/vitest";
import type { DraftConfig, DraftState, EnginePlayer, Pos } from "../types";
import { pickForOverall, totalPicks, totalRounds } from "../snake";
import { computeTiers } from "../tiers";
import { survivalProb } from "../adp";
import { assignRosterSlots } from "../roster";
import { buildPlayerPool } from "../pool";
import { runAutoPicks } from "../autopick";
import { applyPick } from "../draft";
import { mulberry32 } from "../rng";

const POS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

const arbConfig = fc
  .record({
    numTeams: fc.integer({ min: 4, max: 20 }),
    seed: fc.integer({ min: 1, max: 1 << 30 }),
    spec: fc.record({
      QB: fc.integer({ min: 0, max: 2 }),
      RB: fc.integer({ min: 0, max: 3 }),
      WR: fc.integer({ min: 0, max: 3 }),
      TE: fc.integer({ min: 0, max: 2 }),
      FLEX: fc.integer({ min: 0, max: 2 }),
      DEF: fc.integer({ min: 0, max: 1 }),
      K: fc.integer({ min: 0, max: 1 }),
      BN: fc.integer({ min: 0, max: 6 }),
    }),
  })
  .filter(({ spec }) => totalRounds(spec) >= 1)
  .map(({ numTeams, seed, spec }): DraftConfig => {
    const rng = mulberry32(seed);
    const teamOrder = Array.from({ length: numTeams }, (_, i) => i + 1);
    for (let i = teamOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [teamOrder[i], teamOrder[j]] = [teamOrder[j], teamOrder[i]];
    }
    return {
      numTeams,
      teamOrder,
      teamNames: {},
      rosterSpec: spec,
      flexEligibleBySlot: spec.FLEX > 0 ? Array.from({ length: spec.FLEX }, () => ["RB", "WR", "TE"] as Pos[]) : [],
      myTeamId: teamOrder[0],
      mockDraft: true,
      byeWeeks: {},
      adpContext: "1QB",
    };
  });

describe("snake order properties", () => {
  test.prop([arbConfig])("every overall maps to exactly one team; each team gets exactly `rounds` picks", (config) => {
    const rounds = totalRounds(config.rosterSpec);
    const counts = new Map<number, number>();
    for (let o = 1; o <= totalPicks(config); o++) {
      const { teamId } = pickForOverall(config, o);
      expect(config.teamOrder).toContain(teamId);
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
    config.teamOrder.forEach((t) => expect(counts.get(t) ?? 0).toBe(rounds));
  });

  test.prop([arbConfig])("snake reflection at every round boundary", (config) => {
    const rounds = totalRounds(config.rosterSpec);
    const n = config.numTeams;
    for (let r = 1; r < rounds; r++) {
      expect(pickForOverall(config, r * n).teamId).toBe(pickForOverall(config, r * n + 1).teamId);
    }
  });
});

describe("tiering properties", () => {
  const arbPlayers = fc
    .array(
      fc.record({
        pos: fc.constantFrom(...POS),
        rank: fc.integer({ min: 1, max: 400 }),
      }),
      { minLength: 1, maxLength: 120 },
    )
    .map((rows) => {
      const seen = new Set<number>();
      return rows
        .filter((r) => (seen.has(r.rank) ? false : (seen.add(r.rank), true)))
        .map((r, i): EnginePlayer => ({ id: i + 1, name: `P${i}`, team: "KC", pos: r.pos, rank: r.rank, adp: null }));
    })
    .filter((players) => players.length > 0);

  test.prop([arbPlayers])("tiers start at 1, are contiguous down each positional list, and respect caps", (players) => {
    const tiers = computeTiers(players);
    const caps: Record<string, number> = { QB: 6, RB: 8, WR: 8, TE: 6, DEF: 6, K: 6 };
    POS.forEach((pos) => {
      const list = players.filter((p) => p.pos === pos).sort((a, b) => a.rank - b.rank);
      if (list.length === 0) return;
      expect(tiers.get(list[0].id)).toBe(1);
      const sizes = new Map<number, number>();
      let prev = 1;
      list.forEach((p) => {
        const t = tiers.get(p.id)!;
        expect(t === prev || t === prev + 1).toBe(true);
        prev = t;
        sizes.set(t, (sizes.get(t) ?? 0) + 1);
      });
      sizes.forEach((size) => expect(size).toBeLessThanOrEqual(caps[pos]));
    });
  });
});

describe("survival properties", () => {
  test.prop([fc.double({ min: 1, max: 300, noNaN: true }), fc.integer({ min: 1, max: 300 })])(
    "in (0,1) whenever non-null",
    (adp, at) => {
      const p: EnginePlayer = { id: 1, name: "X", team: "KC", pos: "RB", rank: 1, adp };
      const v = survivalProb(p, at, "1QB", "1QB")!;
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    },
  );
});

describe("full mock drafts", () => {
  test.prop([arbConfig, fc.integer({ min: 1, max: 1 << 30 })], { numRuns: 25 })(
    "terminate with exactly totalPicks unique players and fully assignable rosters",
    (config, seed) => {
      const total = totalPicks(config);
      fc.pre(total >= 1 && total <= 300);
      // pool comfortably larger than the draft, spread across positions
      const players: EnginePlayer[] = Array.from({ length: total + 60 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
        team: "KC",
        pos: POS[i % POS.length],
        rank: i + 1,
        adp: null,
      }));
      const pool = buildPlayerPool(players);
      const rng = mulberry32(seed);
      let state: DraftState = { config, picks: [], queue: [], recPos: [...POS] };
      let guard = 0;
      while (state.picks.length < total && guard++ < total + 10) {
        state = runAutoPicks(state, pool, rng);
        if (state.picks.length >= total) break;
        // user's turn: draft best available
        const drafted = new Set(state.picks.map((p) => p.playerId));
        const best = players.find((p) => !drafted.has(p.id))!;
        state = applyPick(state, best.id, pool);
      }
      expect(state.picks.length).toBe(total);
      expect(new Set(state.picks.map((p) => p.playerId)).size).toBe(total);
      // roster invariant: slots + overflow account for every pick, no double-occupancy
      config.teamOrder.forEach((teamId) => {
        const teamPickCount = state.picks.filter((p) => p.teamId === teamId).length;
        const { slots, overflow } = assignRosterSlots(state, pool, teamId);
        const filled = slots.filter((s) => s.player);
        expect(filled.length + overflow.length).toBe(teamPickCount);
        const ids = [...filled.map((s) => s.player!.id), ...overflow.map((o) => o.player.id)];
        expect(new Set(ids).size).toBe(ids.length);
        // eligibility respected
        filled.forEach((s) => {
          if (s.type === "FLEX") expect(s.eligible).toContain(s.player!.pos);
          else if (s.type !== "BN") expect(s.type).toBe(s.player!.pos);
        });
      });
    },
  );
});
