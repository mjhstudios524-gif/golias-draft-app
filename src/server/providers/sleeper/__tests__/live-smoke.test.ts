import { beforeAll, describe, expect, it, vi } from "vitest";

// LIVE smoke against api.sleeper.app (PLAN.md §8 verification): the full
// provider pipeline — league bundle → normalize → drafts → board → picks
// (with a real ETag 304 round-trip) → resolvePlayers against local Postgres.
// Gated behind SLEEPER_LIVE=1 so the default suite never touches the network:
//   SLEEPER_LIVE=1 pnpm vitest run src/server/providers/sleeper/__tests__/live-smoke.test.ts

const LIVE = process.env.SLEEPER_LIVE === "1";
const LEAGUE_ID = "289646328504385536"; // docs example league (2018, real shapes)
const DRAFT_ID = "289646328508579840"; // that league's own 12-team snake draft

vi.mock("server-only", () => ({}));

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
  process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
});

describe.runIf(LIVE)("sleeper provider live smoke", () => {
  it("imports the docs example league end-to-end", async () => {
    const { sleeperProvider } = await import("@/server/providers/sleeper");
    const { getProvider } = await import("@/server/providers/registry");
    expect(getProvider("sleeper").id).toBe("sleeper");

    const ref = sleeperProvider.parseLeagueRef(`https://sleeper.com/leagues/${LEAGUE_ID}/league`);
    expect(ref).toEqual({ kind: "league", leagueId: LEAGUE_ID });

    const bundle = await sleeperProvider.getLeague({}, LEAGUE_ID);
    const settings = sleeperProvider.normalizeLeagueConfig(bundle);
    expect(settings.numTeams).toBe(12);
    expect(settings.rosterSpec).toEqual({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1, K: 0, BN: 6 });
    expect(settings.isSuperflex).toBe(false);
    expect(settings.scoring.weights.rec).toBe(1);
    expect(settings.teamSeats).toHaveLength(12);

    const drafts = await sleeperProvider.listDrafts({}, LEAGUE_ID);
    expect(drafts.map((d) => d.draftId)).toContain(DRAFT_ID);

    const draft = await sleeperProvider.getDraft({}, DRAFT_ID);
    expect(draft.type).toBe("snake");
    expect(draft.pickOwnerByOverall).toHaveLength(12 * 15);

    const first = await sleeperProvider.getPicks({}, DRAFT_ID);
    expect(first.notModified).toBe(false);
    expect(first.picks).toHaveLength(180);
    for (const pick of first.picks!) {
      expect(draft.pickOwnerByOverall[pick.overall - 1]).toBe(pick.seat);
    }

    // ETag round-trip: replaying the returned etag must 304 (PLAN.md §8).
    if (first.etag) {
      const again = await sleeperProvider.getPicks({}, DRAFT_ID, { etag: first.etag });
      expect(again.notModified).toBe(true);
      expect(again.picks).toBeNull();
    }

    const ids = [...new Set(first.picks!.map((p) => p.providerPlayerId))];
    const resolved = await sleeperProvider.resolvePlayers(ids);
    // 2018 picks against the 2026 fantasy-relevant pool: partial resolution is
    // expected; the pipeline (Player.sleeperId batch lookup) must work.
    console.info(`[live-smoke] resolved ${resolved.size}/${ids.length} 2018 draft picks against local players`);
    for (const [sleeperId, player] of resolved) {
      expect(ids).toContain(sleeperId);
      expect(player.id.length).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe.runIf(LIVE)("sleeper import action live smoke", () => {
  it("previews and imports the docs league through the real actions (dev-user auth)", async () => {
    // requireUser falls back to the fixed dev user when Clerk is unconfigured.
    const { lookupSleeper, importSleeperLeague } = await import("@/server/providers/import-action");
    const { db } = await import("@/server/db");

    const looked = await lookupSleeper({ ref: `https://sleeper.com/leagues/${LEAGUE_ID}/league` });
    expect(looked.ok).toBe(true);
    if (!looked.ok || looked.kind !== "preview") throw new Error("expected preview");
    const p = looked.preview;
    expect(p).toMatchObject({ numTeams: 12, isSuperflex: false, ppr: 1, passTd: 6 });
    expect(p.rosterSlots.map((s) => s.label)).toContain("FLEX2");
    expect(p.ignoredSlots).toEqual([]);
    // every draft in the docs league is complete → nothing syncable
    expect(p.drafts.every((d) => !d.syncable)).toBe(true);

    const imported = await importSleeperLeague({ leagueId: LEAGUE_ID });
    expect(imported.ok).toBe(true);
    if (!imported.ok) throw new Error("import failed");
    expect(imported.sessionId).toBeNull();
    try {
      const row = await db.league.findUnique({ where: { id: imported.leagueId } });
      expect(row).toMatchObject({
        provider: "sleeper",
        providerLeagueId: LEAGUE_ID,
        numTeams: 12,
        name: "Sleeper Friends League",
      });
      // Re-import is idempotent: refreshes the same row, never duplicates.
      const again = await importSleeperLeague({ leagueId: LEAGUE_ID });
      expect(again).toMatchObject({ ok: true, leagueId: imported.leagueId });
    } finally {
      await db.league.delete({ where: { id: imported.leagueId } }).catch(() => {});
    }
  }, 60_000);
});

describe.runIf(!LIVE)("sleeper provider live smoke (skipped)", () => {
  it("is gated behind SLEEPER_LIVE=1", () => {
    expect(LIVE).toBe(false);
  });
});
