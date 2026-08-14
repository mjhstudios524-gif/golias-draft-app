import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AdpFormat, AdpProvider, StoredAdpEntry } from "../types";

// "server-only" throws outside a React Server Components bundle — inert stub
vi.mock("server-only", () => ({}));

// vitest does not load .env; point at the live local dev DB before the db
// singleton (imported dynamically below) reads its env group
process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;

const { ffcAdpUrl, parseFfcResponse, ffcProvider } = await import("../ffc");
const { ADP_TEAMS, adpFormatForLeague, latestAdpSnapshot, syncAdpSnapshots } =
  await import("../sync");
const { snapshotV1 } = await import("@/server/sessions");
const { matchEntries } = await import("@/server/rankings/match");
const { db } = await import("@/server/db");

// Recorded real responses (2026-08-13, teams=12&year=2026) — the shapes the
// zod schema and DST/normalizer routing were verified against.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const FIXTURES: Record<AdpFormat, unknown> = {
  STANDARD: fixture("ffc-standard.json"),
  HALF_PPR: fixture("ffc-half-ppr.json"),
  PPR: fixture("ffc-ppr.json"),
  SF: fixture("ffc-2qb.json"),
};

// Distinct source id so test rows never collide with the real 'ffc' snapshots.
const TEST_SOURCE = "ffc-test";
const testStart = new Date();

function fixtureProvider(id = TEST_SOURCE): AdpProvider {
  return {
    id,
    async fetchSnapshot(format) {
      return parseFfcResponse(FIXTURES[format]);
    },
  };
}

afterAll(async () => {
  await db.adpSnapshot.deleteMany({ where: { source: { startsWith: TEST_SOURCE } } });
  await db.playerSyncRun.deleteMany({ where: { kind: "adp", ranAt: { gte: testStart } } });
  await db.$disconnect();
});

describe("ffcAdpUrl — format map (PLAN.md §8a)", () => {
  it("maps every snapshot format onto its FFC slug (2qb ⇒ the SF market)", () => {
    const base = "https://fantasyfootballcalculator.com/api/v1/adp";
    expect(ffcAdpUrl("STANDARD", 12)).toBe(`${base}/standard?teams=12&year=2026`);
    expect(ffcAdpUrl("HALF_PPR", 12)).toBe(`${base}/half-ppr?teams=12&year=2026`);
    expect(ffcAdpUrl("PPR", 12)).toBe(`${base}/ppr?teams=12&year=2026`);
    expect(ffcAdpUrl("SF", 12)).toBe(`${base}/2qb?teams=12&year=2026`);
    expect(ffcAdpUrl("PPR", 10, 2025)).toBe(`${base}/ppr?teams=10&year=2025`);
  });
});

describe("parseFfcResponse — recorded fixtures", () => {
  it("maps the PPR payload: fields, PK→K, DEF rows, canonical teams", () => {
    const snap = parseFfcResponse(FIXTURES.PPR);
    expect(snap.totalDrafts).toBe(6160);
    expect(snap.entries).toHaveLength(256);

    const bijan = snap.entries[0];
    expect(bijan).toMatchObject({
      rawName: "Bijan Robinson",
      pos: "RB",
      team: "ATL",
      adp: 1.7,
      stdev: 0.8,
      high: 1,
      low: 4,
      bye: 11,
      timesDrafted: 966,
    });

    const kicker = snap.entries.find((e) => e.rawName === "Brandon Aubrey");
    expect(kicker?.pos).toBe("K"); // FFC codes kickers 'PK'

    const dst = snap.entries.find((e) => e.rawName === "Denver Defense");
    expect(dst).toMatchObject({ pos: "DEF", team: "DEN" });
  });

  it("parses the 2qb payload — the QB-inflated SF market", () => {
    const snap = parseFfcResponse(FIXTURES.SF);
    expect(snap.totalDrafts).toBe(3577);
    expect(snap.entries[0]).toMatchObject({ rawName: "Josh Allen", pos: "QB", adp: 1.4 });
  });

  it("parses the remaining formats without loss", () => {
    expect(parseFfcResponse(FIXTURES.STANDARD).entries).toHaveLength(210);
    expect(parseFfcResponse(FIXTURES.HALF_PPR).entries).toHaveLength(219);
  });

  it("rejects a non-Success status instead of storing an empty board", () => {
    expect(() =>
      parseFfcResponse({ status: "Error", meta: { total_drafts: 0 }, players: [] }),
    ).toThrow(/unexpected status/);
  });
});

describe("entry resolution — shared identity pipeline", () => {
  it("routes a DST row through the GLOBAL alias branch and a suffixed name through the normalizer", async () => {
    const snap = parseFfcResponse(FIXTURES.PPR);
    const rows = ["Denver Defense", "Amon-Ra St. Brown", "Travis Etienne Jr."].map(
      (name) => snap.entries.find((e) => e.rawName === name)!,
    );
    expect(rows.every(Boolean)).toBe(true);

    const results = await matchEntries(
      rows.map((e) => ({ rawName: e.rawName, team: e.team, pos: e.pos })),
      { userId: "vitest-adp-user" },
    );

    // 'Denver Defense' → stage-0 GLOBAL alias → the DEN pseudo-player
    expect(results[0].matchMethod).toBe("ALIAS");
    const den = await db.player.findUnique({ where: { id: results[0].playerId! } });
    expect(den?.isTeamDefense).toBe(true);
    expect(den?.nflTeam).toBe("DEN");

    // 'Amon-Ra St. Brown' → normalizer strips punctuation → exact match
    expect(results[1].playerId).not.toBeNull();
    const asb = await db.player.findUnique({ where: { id: results[1].playerId! } });
    expect(asb?.fullName).toBe("Amon-Ra St. Brown");

    // 'Travis Etienne Jr.' → suffix stripped into the side channel
    expect(results[2].playerId).not.toBeNull();
    const etienne = await db.player.findUnique({ where: { id: results[2].playerId! } });
    expect(etienne?.fullName).toContain("Travis Etienne");
    expect(etienne?.pos).toBe("RB");
  });
});

describe("syncAdpSnapshots — upsert idempotence + storage contract", () => {
  it("run twice → exactly one row per format, refreshed in place", async () => {
    const provider = fixtureProvider();
    const first = await syncAdpSnapshots(provider);
    const second = await syncAdpSnapshots(provider);
    expect(first.formats.map((f) => f.format)).toEqual(["STANDARD", "HALF_PPR", "PPR", "SF"]);
    expect(second.total).toBe(210 + 219 + 256 + 223);

    const rows = await db.adpSnapshot.findMany({ where: { source: TEST_SOURCE } });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.teams === ADP_TEAMS)).toBe(true);

    // the most-drafted pool resolves nearly wholesale through the matcher
    // (100% at recording time; loose bound tolerates player-table drift)
    expect(second.matched / second.total).toBeGreaterThan(0.98);

    const ppr = rows.find((r) => r.format === "PPR")!;
    const entries = ppr.entries as unknown as StoredAdpEntry[];
    expect(entries).toHaveLength(256);
    expect(entries[0]).toMatchObject({ rawName: "Bijan Robinson", adp: 1.7 });
    expect(typeof entries[0].playerId).toBe("string");

    const run = await db.playerSyncRun.findFirst({
      where: { kind: "adp", ranAt: { gte: testStart } },
      orderBy: { ranAt: "desc" },
    });
    expect(run).toMatchObject({ ok: true, total: second.total, changed: second.matched });
  });

  it("resolves abbreviated-city DSTs via the team-code second pass", async () => {
    // 'LA Rams Defense' misses every seeded name alias (Sleeper city =
    // 'Los Angeles') — the DEF retry keyed on the team code must catch it.
    const row = await db.adpSnapshot.findUnique({
      where: { source_format_teams: { source: TEST_SOURCE, format: "PPR", teams: ADP_TEAMS } },
    });
    const entries = row!.entries as unknown as StoredAdpEntry[];
    const rams = entries.find((e) => e.rawName === "LA Rams Defense");
    expect(rams?.playerId).toBeTruthy();
    const player = await db.player.findUnique({ where: { id: rams!.playerId! } });
    expect(player).toMatchObject({ isTeamDefense: true, nflTeam: "LAR" });
  });

  it("latestAdpSnapshot reads back a playerId → adp map for attachment", async () => {
    const snap = await latestAdpSnapshot("PPR", TEST_SOURCE);
    expect(snap).not.toBeNull();
    expect(snap!.format).toBe("PPR");
    expect(snap!.adpByPlayerId.size).toBeGreaterThan(200);
    for (const adp of snap!.adpByPlayerId.values()) expect(Number.isFinite(adp)).toBe(true);
    expect(await latestAdpSnapshot("PPR", "no-such-source")).toBeNull();
  });

  it("keeps unmatched entries with playerId null (logged, never dropped)", async () => {
    const provider: AdpProvider = {
      id: `${TEST_SOURCE}-unmatched`,
      async fetchSnapshot(format) {
        const base = parseFfcResponse(FIXTURES[format]);
        return {
          ...base,
          entries: [
            base.entries[0],
            {
              rawName: "Zzyzx Quorblat",
              pos: "RB",
              team: null,
              adp: 42.5,
              stdev: null,
              high: null,
              low: null,
              bye: null,
              timesDrafted: 3,
            },
          ],
        };
      },
    };
    const res = await syncAdpSnapshots(provider);
    expect(res.total).toBe(8); // 2 entries × 4 formats
    expect(res.matched).toBe(4);

    const row = await db.adpSnapshot.findUnique({
      where: {
        source_format_teams: { source: provider.id, format: "PPR", teams: ADP_TEAMS },
      },
    });
    const entries = row!.entries as unknown as StoredAdpEntry[];
    expect(entries[1]).toMatchObject({ playerId: null, rawName: "Zzyzx Quorblat", adp: 42.5 });
  });
});

describe("adpFormatForLeague — league → snapshot format (PLAN.md §8a)", () => {
  const scoring = (rec?: number) => ({ name: "t", weights: rec === undefined ? {} : { rec } });

  it("a superflex league always attaches the SF market", () => {
    expect(adpFormatForLeague("MULTI_QB", scoring(1))).toBe("SF");
    expect(adpFormatForLeague("MULTI_QB", scoring(0))).toBe("SF");
  });

  it("1QB leagues pick the nearest rec-weight variant", () => {
    expect(adpFormatForLeague("1QB", scoring(1))).toBe("PPR");
    expect(adpFormatForLeague("1QB", scoring(0.5))).toBe("HALF_PPR");
    expect(adpFormatForLeague("1QB", scoring(0))).toBe("STANDARD");
    expect(adpFormatForLeague("1QB", scoring())).toBe("STANDARD");
    // nearest-variant boundaries
    expect(adpFormatForLeague("1QB", scoring(0.75))).toBe("PPR");
    expect(adpFormatForLeague("1QB", scoring(0.74))).toBe("HALF_PPR");
    expect(adpFormatForLeague("1QB", scoring(0.25))).toBe("HALF_PPR");
    expect(adpFormatForLeague("1QB", scoring(0.24))).toBe("STANDARD");
    // unreadable scoring degrades to STANDARD, never throws
    expect(adpFormatForLeague("1QB", null)).toBe("STANDARD");
  });
});

describe("snapshotV1 — attachment attribution fields", () => {
  it("keeps adpSource/adpFetchedAt (zod v4 objects strip unknown keys)", () => {
    const base = {
      v: 1,
      numTeams: 2,
      teamOrder: [1, 2],
      teamNames: { "1": "A", "2": "B" },
      rosterSpec: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 0, DEF: 0, K: 0, BN: 0 },
      flexEligibleBySlot: [],
      myTeamId: 1,
      byeWeeks: {},
      adpContext: "1QB",
      adpSource: "ffc:PPR",
      adpFetchedAt: "2026-08-13T00:00:00.000Z",
      rngSeed: 1,
      players: [],
    };
    const parsed = snapshotV1.parse(base);
    expect(parsed.adpSource).toBe("ffc:PPR");
    expect(parsed.adpFetchedAt).toBe("2026-08-13T00:00:00.000Z");
  });
});

// Live smoke — the one test allowed to hit the real API; skip with ADP_OFFLINE=1.
describe("live smoke (network)", () => {
  it.skipIf(process.env.ADP_OFFLINE === "1")(
    "FFC PPR endpoint still serves the verified shape",
    async () => {
      const snap = await ffcProvider.fetchSnapshot("PPR", 12);
      expect(snap.totalDrafts).toBeGreaterThan(0);
      expect(snap.entries.length).toBeGreaterThan(100);
      expect(snap.entries.some((e) => e.pos === "DEF")).toBe(true);
      for (const e of snap.entries.slice(0, 5)) {
        expect(e.rawName.length).toBeGreaterThan(0);
        expect(Number.isFinite(e.adp)).toBe(true);
      }
    },
    30_000,
  );
});
