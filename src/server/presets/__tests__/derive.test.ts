import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdpFormat } from "@/server/adp/types";

// "server-only" throws outside a React Server Components bundle — inert stub
vi.mock("server-only", () => ({}));

// vitest does not load .env; point at the live local dev DB before the db
// singleton (imported dynamically below) reads its env group
process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;

const { deriveAdpPresets, DERIVED_MATCH_METHOD, TARGET_BOARD_SIZE } = await import("../derive");
const { db } = await import("@/server/db");
const { currentSeason } = await import("@/lib/season");

// Runs against the real seeded FFC snapshots and the real Player table: these
// derived presets ARE the shipped free boards (PLAN.md §6), so the test asserts
// the production artifact rather than a fixture of it. Nothing is torn down —
// re-deriving is idempotent by design and that is half of what's under test.

const SEASON = currentSeason(new Date()).seasonYear;
const EXPECTED: Record<AdpFormat, { name: string; formatTag: string; adpContext: string }> = {
  PPR: { name: "Consensus PPR", formatTag: "1QB", adpContext: "ONE_QB" },
  HALF_PPR: { name: "Consensus Half-PPR", formatTag: "1QB", adpContext: "ONE_QB" },
  STANDARD: { name: "Consensus Standard", formatTag: "1QB", adpContext: "ONE_QB" },
  SF: { name: "Consensus Superflex", formatTag: "SF", adpContext: "SUPERFLEX" },
};

type Awaitedd<T> = T extends Promise<infer U> ? U : T;
let first: Awaitedd<ReturnType<typeof deriveAdpPresets>>;

interface BoardEntry {
  playerId: string | null;
  rank: number | null;
  adp: number | null;
  matchMethod: string;
  pos: string | null;
  sourceRow: number;
}

async function loadBoard(setId: string): Promise<BoardEntry[]> {
  return db.rankingEntry.findMany({
    where: { rankingSetId: setId },
    orderBy: { rank: "asc" },
    select: { playerId: true, rank: true, adp: true, matchMethod: true, pos: true, sourceRow: true },
  });
}

beforeAll(async () => {
  first = await deriveAdpPresets();
}, 120_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("deriveAdpPresets — one shipped preset per ADP snapshot (PLAN.md §6/§8a)", () => {
  it("derives all four boards from the seeded snapshots", () => {
    expect(first.ok).toBe(true);
    expect(first.seasonYear).toBe(SEASON);
    expect(first.boards.map((b) => b.format).sort()).toEqual([
      "HALF_PPR",
      "PPR",
      "SF",
      "STANDARD",
    ]);
  });

  it("stamps each board as a READY, rank-only, userId-null preset with derivedFrom", async () => {
    for (const board of first.boards) {
      const set = await db.rankingSet.findUniqueOrThrow({ where: { id: board.setId } });
      const expected = EXPECTED[board.format];
      expect(set.name).toBe(expected.name);
      expect(set.userId).toBeNull(); // userId null ⇒ shipped preset
      expect(set.kind).toBe("PRESET");
      expect(set.status).toBe("READY");
      expect(set.dataTier).toBe("RANK_ONLY");
      expect(set.formatTag).toBe(expected.formatTag);
      expect(set.adpContext).toBe(expected.adpContext);
      expect(set.seasonYear).toBe(SEASON);
      // derivedFrom is what tells the room to suppress the value/reach
      // colouring and the "falling past his rank" reason — a board built FROM
      // market ADP cannot also be judged AGAINST it.
      expect(set.derivedFrom).toBe(`ffc:${board.format}`);
      expect(board.derivedFrom).toBe(`ffc:${board.format}`);
    }
  });

  it("orders the ADP-covered head strictly by ADP ascending", async () => {
    for (const board of first.boards) {
      const entries = await loadBoard(board.setId);
      const head = entries.slice(0, board.fromAdp);
      expect(head).toHaveLength(board.fromAdp);
      for (const e of head) expect(e.adp).not.toBeNull();
      for (let i = 1; i < head.length; i++) {
        expect(head[i].adp!).toBeGreaterThanOrEqual(head[i - 1].adp!);
      }
    }
  });

  it("emits a dense 1..N rank sequence with sourceRow in lockstep", async () => {
    for (const board of first.boards) {
      const entries = await loadBoard(board.setId);
      expect(entries).toHaveLength(board.total);
      entries.forEach((e, i) => {
        expect(e.rank).toBe(i + 1);
        expect(e.sourceRow).toBe(i + 1);
      });
    }
  });

  it("links every row to a unique player under the DERIVED method", async () => {
    for (const board of first.boards) {
      const entries = await loadBoard(board.setId);
      const ids = entries.map((e) => e.playerId);
      expect(ids.every((id) => id !== null)).toBe(true);
      // the [rankingSetId, playerId] unique constraint, asserted at the source
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of entries) expect(e.matchMethod).toBe(DERIVED_MATCH_METHOD);
    }
  });

  it("backfills the tail with unseen active players carrying null ADP", async () => {
    for (const board of first.boards) {
      const entries = await loadBoard(board.setId);
      const head = entries.slice(0, board.fromAdp);
      const tail = entries.slice(board.fromAdp);

      expect(board.tail).toBe(tail.length);
      expect(board.total).toBe(board.fromAdp + board.tail);
      // ~400 keeps a 20-team deep league from running dry
      expect(board.total).toBe(TARGET_BOARD_SIZE);
      expect(board.fromAdp).toBeGreaterThan(200);
      expect(tail.length).toBeGreaterThan(0);

      // tail rows continue the rank sequence past the ADP-covered head
      expect(tail[0].rank).toBe(board.fromAdp + 1);
      // no ADP: FFC has not priced them. The engine reads null ADP correctly.
      for (const e of tail) expect(e.adp).toBeNull();

      // only players the ADP head did not already cover
      const headIds = new Set(head.map((e) => e.playerId));
      for (const e of tail) expect(headIds.has(e.playerId)).toBe(false);

      // only active, fantasy-relevant players
      const players = await db.player.findMany({
        where: { id: { in: tail.map((e) => e.playerId!) } },
        select: { active: true, pos: true },
      });
      expect(players).toHaveLength(tail.length);
      for (const p of players) {
        expect(p.active).toBe(true);
        expect(["QB", "RB", "WR", "TE", "K", "DEF"]).toContain(p.pos);
      }
    }
  });

  it("guarantees all 32 team defenses so a deep league can fill its DEF slots", async () => {
    const allDsts = await db.player.count({ where: { active: true, pos: "DEF" } });
    for (const board of first.boards) {
      const entries = await loadBoard(board.setId);
      const onBoard = entries.filter((e) => e.pos === "DEF").length;
      // Sleeper publishes no search_rank for D/ST, so popularity ordering alone
      // would ship only the snapshot's 15-26 defenses.
      expect(onBoard).toBe(allDsts);
    }
  });
});

describe("deriveAdpPresets — refresh in place, not a new version every night", () => {
  it("is idempotent: same rows, same set ids, no version explosion", async () => {
    const before = new Map<string, BoardEntry[]>();
    for (const b of first.boards) before.set(b.format, await loadBoard(b.setId));

    const second = await deriveAdpPresets();

    for (const b of second.boards) {
      const prior = first.boards.find((x) => x.format === b.format)!;
      expect(b.setId).toBe(prior.setId); // same row refreshed, not a new one
      expect(b.created).toBe(false);
      expect(b.total).toBe(prior.total);
      expect(b.fromAdp).toBe(prior.fromAdp);
      expect(b.tail).toBe(prior.tail);

      const set = await db.rankingSet.findUniqueOrThrow({ where: { id: b.setId } });
      expect(set.version).toBe(1);

      // entries are replaced wholesale, so assert the content is stable too
      const after = await loadBoard(b.setId);
      expect(after.map((e) => [e.rank, e.playerId, e.adp])).toEqual(
        before.get(b.format)!.map((e) => [e.rank, e.playerId, e.adp]),
      );
    }

    // exactly one preset row per format across all versions
    for (const b of second.boards) {
      const count = await db.rankingSet.count({
        where: { userId: null, kind: "PRESET", derivedFrom: b.derivedFrom, seasonYear: SEASON },
      });
      expect(count).toBe(1);
    }
  }, 120_000);
});

describe("deriveAdpPresets — the SF board is a genuinely different market", () => {
  it("tags SF as the superflex market", async () => {
    const sf = first.boards.find((b) => b.format === "SF")!;
    const set = await db.rankingSet.findUniqueOrThrow({ where: { id: sf.setId } });
    expect(set.formatTag).toBe("SF");
    expect(set.adpContext).toBe("SUPERFLEX");
  });

  it("ranks QBs materially higher than the PPR board does", async () => {
    const sf = first.boards.find((b) => b.format === "SF")!;
    const ppr = first.boards.find((b) => b.format === "PPR")!;
    const sfTop5 = (await loadBoard(sf.setId)).slice(0, 5);
    const pprTop5 = (await loadBoard(ppr.setId)).slice(0, 5);

    // Pinned against the real 2026 snapshots: SF's top 5 opens with Josh Allen
    // (ADP 1.4) and carries a second QB by pick 5; PPR's first QB is ~29th.
    expect(sfTop5.filter((e) => e.pos === "QB").length).toBeGreaterThanOrEqual(1);
    expect(pprTop5.filter((e) => e.pos === "QB").length).toBe(0);

    const firstQb = async (setId: string) =>
      (await loadBoard(setId)).find((e) => e.pos === "QB")!.rank!;
    const sfFirstQb = await firstQb(sf.setId);
    const pprFirstQb = await firstQb(ppr.setId);
    expect(sfFirstQb).toBeLessThan(pprFirstQb);
    expect(pprFirstQb - sfFirstQb).toBeGreaterThan(10);
  });
});

describe("deriveAdpPresets — concurrent runs cannot duplicate a board", () => {
  // Regression: the lookup is check-then-create, so two overlapping runs (a
  // retried cron, or a manual trigger landing on the schedule) both saw "no
  // board yet" and each created one — leaving users two identical "Consensus
  // PPR" presets and making the refresh lookup pick between twins at random.
  // @@unique([derivedFrom, seasonYear]) makes it impossible; the loser of the
  // race adopts the winner's row instead of failing.
  it("runs three derives at once and still ships exactly one board per format", async () => {
    const results = await Promise.all([
      deriveAdpPresets(),
      deriveAdpPresets(),
      deriveAdpPresets(),
    ]);
    for (const r of results) expect(r.ok).toBe(true);

    const presets = await db.rankingSet.findMany({
      where: { userId: null, kind: "PRESET", derivedFrom: { not: null }, seasonYear: SEASON },
      select: { id: true, derivedFrom: true, version: true },
    });
    const perFormat = new Map<string, number>();
    for (const p of presets) {
      perFormat.set(p.derivedFrom!, (perFormat.get(p.derivedFrom!) ?? 0) + 1);
      expect(p.version).toBe(1); // refreshed in place, never versioned upward
    }
    expect([...perFormat.values()].every((n) => n === 1)).toBe(true);
    expect(perFormat.size).toBe(first.boards.length);

    // all three calls agree on the surviving row id for every format
    for (const format of perFormat.keys()) {
      const ids = new Set(
        results.map((r) => r.boards.find((b) => `ffc:${b.format}` === format)!.setId),
      );
      expect(ids.size).toBe(1);
    }
  });
});
