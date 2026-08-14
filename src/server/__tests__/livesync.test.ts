import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Env must exist BEFORE @/server/db (adapter built at import) is pulled in —
// vi.hoisted runs ahead of the hoisted static imports (same pattern as
// billing.test.ts). No network: the engine gets an injected fake provider.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
  process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
});
vi.mock("server-only", () => ({}));

import { db } from "@/server/db";
import { computeTtlSec, syncLiveDraft, type LiveSessionRef } from "@/server/livesync";
import {
  ProviderError,
  type DraftProvider,
  type NormalizedPick,
  type ResolvedPlayer,
} from "@/server/providers/types";

// Unique run prefix: the suite shares the dev database with the dev server and
// possibly concurrent suites — every row it creates is namespaced + cleaned up.
const T = `lv${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const userId = `${T}_user`;
let leagueId: string;

// 4 teams × 3 rounds, plain snake: 1234 4321 1234 (mirrors what
// normalizeSleeperDraft precomputes for a real board).
const N = 4;
const OWNERS = [1, 2, 3, 4, 4, 3, 2, 1, 1, 2, 3, 4];

let seq = 0;

/** SLEEPER_SYNC DraftSession with a sessions-create-shaped config snapshot. */
async function mkSession(opts: { teamOrder?: number[] } = {}): Promise<LiveSessionRef> {
  const draftId = `${T}d${++seq}`;
  const session = await db.draftSession.create({
    data: {
      userId,
      leagueId,
      mode: "SLEEPER_SYNC",
      providerDraftId: draftId,
      config: {
        v: 1,
        numTeams: N,
        teamOrder: opts.teamOrder ?? [1, 2, 3, 4],
        teamNames: { "1": "Team 1", "2": "Team 2", "3": "Team 3", "4": "Team 4" },
        rosterSpec: { QB: 1, RB: 1, WR: 1, TE: 0, FLEX: 0, DEF: 0, K: 0, BN: 0 },
        flexEligibleBySlot: [],
        myTeamId: 1,
        byeWeeks: {},
        adpContext: "1QB",
        rngSeed: 1,
        players: [{ id: "p1", name: "Player One", team: "KC", pos: "QB", rank: 1, adp: null }],
        sleeper: {
          providerDraftId: draftId,
          providerLeagueId: `${T}lg`,
          type: "snake",
          reversalRound: 0,
          pickTimerSec: 90,
          pickOwnerByOverall: OWNERS,
          rosterIdBySeat: null,
          seatByUserId: {},
        },
      },
    },
  });
  return { id: session.id, mode: session.mode, status: session.status, config: session.config };
}

function pick(overall: number, providerPlayerId: string, meta?: NormalizedPick["metadata"]): NormalizedPick {
  return {
    overall,
    seat: OWNERS[overall - 1],
    round: Math.ceil(overall / N),
    providerPlayerId,
    pickedByUserId: null,
    autopick: false,
    metadata: meta ?? null,
  };
}

interface FakeState {
  picks: NormalizedPick[];
  etag: string;
  draftStatus: string;
  startTime: number | null;
  pickTimerSec: number | null;
  resolvable: Map<string, ResolvedPlayer>;
  throwOnPicks: ProviderError | null;
  picksDelayMs: number;
  getPicksCalls: number;
  getDraftCalls: number;
}

/** Programmable in-memory DraftProvider (the engine's injectable test seam). */
function makeFakeProvider(): { provider: DraftProvider; fake: FakeState } {
  const fake: FakeState = {
    picks: [],
    etag: "v1",
    draftStatus: "drafting",
    startTime: null,
    pickTimerSec: 90,
    resolvable: new Map(),
    throwOnPicks: null,
    picksDelayMs: 0,
    getPicksCalls: 0,
    getDraftCalls: 0,
  };
  const provider: DraftProvider = {
    id: "fake",
    authSpec: "none",
    parseLeagueRef: () => null,
    listLeaguesForUser: async () => [],
    getLeague: async () => ({}),
    normalizeLeagueConfig: () => {
      throw new Error("unused in livesync");
    },
    listDrafts: async () => [],
    async getDraft(_ctx, draftId) {
      fake.getDraftCalls++;
      return {
        draftId,
        leagueId: null,
        status: fake.draftStatus,
        type: "snake",
        numTeams: N,
        rounds: 3,
        pickTimerSec: fake.pickTimerSec,
        reversalRound: 0,
        startTime: fake.startTime,
        seatByUserId: {},
        rosterIdBySeat: null,
        pickOwnerByOverall: OWNERS,
      };
    },
    async getPicks(_ctx, _draftId, opts = {}) {
      fake.getPicksCalls++;
      if (fake.picksDelayMs > 0) await new Promise((r) => setTimeout(r, fake.picksDelayMs));
      if (fake.throwOnPicks) throw fake.throwOnPicks;
      if (opts.etag != null && opts.etag === fake.etag) {
        return { notModified: true, picks: null, etag: fake.etag };
      }
      return { notModified: false, picks: fake.picks.map((p) => ({ ...p })), etag: fake.etag };
    },
    async resolvePlayers(ids) {
      const m = new Map<string, ResolvedPlayer>();
      for (const id of ids) {
        const r = fake.resolvable.get(id);
        if (r) m.set(id, r);
      }
      return m;
    },
  };
  return { provider, fake };
}

/** Force the cache row stale/claimed/backing-off without touching the engine. */
async function patchSync(
  sessionId: string,
  data: Partial<{ syncedAt: Date; claimedUntil: Date | null; nextAllowedAt: Date | null; ttlSec: number }>,
) {
  await db.draftSync.update({ where: { sessionId }, data });
}

async function dbPicks(sessionId: string) {
  return db.pick.findMany({
    where: { sessionId },
    orderBy: { overall: "asc" },
    select: { id: true, overall: true, teamSlot: true, playerId: true, source: true },
  });
}

beforeAll(async () => {
  await db.user.create({ data: { id: userId, email: `${T}@test.local`, name: "Livesync Test" } });
  const league = await db.league.create({
    data: {
      userId,
      name: `${T} League`,
      seasonYear: 2026,
      numTeams: N,
      scoring: {},
      rosterSpec: {},
    },
  });
  leagueId = league.id;
});

afterAll(async () => {
  await db.draftSession.deleteMany({ where: { userId } }); // cascades picks + sync
  await db.league.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("syncLiveDraft — mode + freshness gates", () => {
  it("rejects non-SLEEPER_SYNC sessions", async () => {
    const { provider } = makeFakeProvider();
    const mock = await db.draftSession.create({
      data: { userId, leagueId, mode: "MOCK", config: { v: 1 } },
    });
    await expect(
      syncLiveDraft(
        { id: mock.id, mode: mock.mode, status: mock.status, config: mock.config },
        { provider },
      ),
    ).rejects.toThrow(/SLEEPER_SYNC/);
  });

  it("fresh cache → serves DB picks without touching the provider", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    await db.draftSync.create({
      data: { sessionId: session.id, providerStatus: "drafting", syncedAt: new Date(), ttlSec: 60 },
    });
    await db.pick.createMany({
      data: [
        { sessionId: session.id, overall: 1, teamSlot: 1, playerId: "pl_a", source: "PROVIDER" },
        { sessionId: session.id, overall: 2, teamSlot: 2, playerId: "pl_b", source: "PROVIDER" },
      ],
    });
    const res = await syncLiveDraft(session, { provider });
    expect(fake.getPicksCalls).toBe(0);
    expect(res.picks.map((p) => p.playerId)).toEqual(["pl_a", "pl_b"]);
    expect(res.status).toBe("drafting");
    expect(res.corrected).toBe(false);
    expect(res.onClockSeat).toBe(OWNERS[2]); // 2 picks in → overall 3 → seat 3
  });
});

describe("syncLiveDraft — ingest", () => {
  it("creates the DraftSync row on first call and ingests provider picks (seat→teamOrder map, sentinel ids)", async () => {
    const { provider, fake } = makeFakeProvider();
    // Non-identity teamOrder pins the seat n → teamOrder[n-1] mapping (real
    // provider sessions write identity, where it is a no-op).
    const session = await mkSession({ teamOrder: [2, 1, 3, 4] });
    fake.resolvable.set("s1", { id: "pl_canon_1", fullName: "Canon One", pos: "QB", nflTeam: "KC" });
    fake.picks = [
      pick(1, "s1"),
      pick(2, "s404", { name: "Mystery Man", pos: "RB", team: "FA" }),
    ];

    const res = await syncLiveDraft(session, { provider });

    const rows = await dbPicks(session.id);
    expect(rows).toMatchObject([
      { overall: 1, teamSlot: 2, playerId: "pl_canon_1", source: "PROVIDER" }, // seat 1 → teamOrder[0] = 2
      { overall: 2, teamSlot: 1, playerId: "sleeper:s404", source: "PROVIDER" }, // unresolved → sentinel
    ]);
    expect(res.corrected).toBe(false);
    expect(res.staleSeconds).toBe(0);
    expect(res.unresolved["sleeper:s404"]).toEqual({ name: "Mystery Man", pos: "RB", team: "FA" });
    expect(fake.getPicksCalls).toBe(1);
    expect(fake.getDraftCalls).toBe(1); // picks changed → status refetch

    const sync = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });
    expect(sync.providerStatus).toBe("drafting");
    expect(sync.ttlSec).toBe(4); // in_progress cadence
    expect(sync.etagPicks).toBe("v1");
    expect(sync.claimedUntil).toBeNull(); // lease released on success
  });

  it("appends only new picks on a later sync (no rewrite of existing rows)", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA"), pick(2, "sB")];
    await syncLiveDraft(session, { provider });
    const firstIds = (await dbPicks(session.id)).map((r) => r.id);

    fake.picks = [pick(1, "sA"), pick(2, "sB"), pick(3, "sC")];
    fake.etag = "v2";
    await patchSync(session.id, { syncedAt: new Date(0) });
    const res = await syncLiveDraft(session, { provider });

    const rows = await dbPicks(session.id);
    expect(rows.map((r) => r.playerId)).toEqual(["sleeper:sA", "sleeper:sB", "sleeper:sC"]);
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(firstIds); // untouched rows keep identity
    expect(res.corrected).toBe(false);
  });

  it("304 path: touches syncedAt only — no ingest, no draft refetch inside the 30s window", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA")];
    await syncLiveDraft(session, { provider }); // stores etag v1 + draftFetchedAt
    const before = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });

    await patchSync(session.id, { syncedAt: new Date(0) });
    const res = await syncLiveDraft(session, { provider }); // etag matches → 304

    expect(fake.getPicksCalls).toBe(2);
    expect(fake.getDraftCalls).toBe(1); // no pick change + recent draft fetch → skipped
    expect(res.corrected).toBe(false);
    expect(res.picks).toHaveLength(1);
    const after = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });
    expect(after.syncedAt.getTime()).toBeGreaterThan(0);
    expect(after.etagPicks).toBe(before.etagPicks);
  });
});

describe("syncLiveDraft — single-flight lease", () => {
  it("a held lease makes the caller serve the DB copy without a provider hit", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA")];
    await db.draftSync.create({
      data: {
        sessionId: session.id,
        providerStatus: "drafting",
        syncedAt: new Date(0), // stale — only the lease is blocking
        ttlSec: 4,
        claimedUntil: new Date(Date.now() + 10_000),
      },
    });
    const res = await syncLiveDraft(session, { provider });
    expect(fake.getPicksCalls).toBe(0);
    expect(res.picks).toHaveLength(0); // DB copy — the (simulated) winner hasn't ingested yet
    expect(res.staleSeconds).toBeGreaterThan(1_000_000); // epoch-0 syncedAt
  });

  it("two concurrent stale polls produce exactly one provider fetch", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA")];
    fake.picksDelayMs = 75; // hold the lease long enough for the loser to collide
    await db.draftSync.create({
      data: { sessionId: session.id, providerStatus: "drafting", syncedAt: new Date(0), ttlSec: 4 },
    });

    const [a, b] = await Promise.all([
      syncLiveDraft(session, { provider }),
      syncLiveDraft(session, { provider }),
    ]);

    expect(fake.getPicksCalls).toBe(1);
    expect((await dbPicks(session.id)).map((r) => r.playerId)).toEqual(["sleeper:sA"]);
    // The winner returns the ingested pick; the loser returns whatever the DB
    // held at its moment (0 or 1 picks) — never a second upstream call.
    const lengths = [a.picks.length, b.picks.length].sort();
    expect(lengths[1]).toBe(1);
  });
});

describe("syncLiveDraft — commissioner-undo reconciliation", () => {
  it("truncates + reinserts from the first divergent overall and flags corrected", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA"), pick(2, "sB"), pick(3, "sC")];
    await syncLiveDraft(session, { provider });
    const keepId = (await dbPicks(session.id))[0].id;

    // Commissioner undid pick 2 and a different player went there; draft moved on.
    fake.picks = [pick(1, "sA"), pick(2, "sX"), pick(3, "sC"), pick(4, "sD")];
    fake.etag = "v2";
    await patchSync(session.id, { syncedAt: new Date(0) });
    const res = await syncLiveDraft(session, { provider });

    expect(res.corrected).toBe(true);
    expect(res.lastCorrectedAt).not.toBeNull();
    const rows = await dbPicks(session.id);
    expect(rows.map((r) => r.playerId)).toEqual([
      "sleeper:sA",
      "sleeper:sX",
      "sleeper:sC",
      "sleeper:sD",
    ]);
    expect(rows[0].id).toBe(keepId); // rows before the divergence survive untouched
    expect(rows.every((r) => r.source === "PROVIDER")).toBe(true);

    // The watermark persists for later polls (route's same-length-rewrite check).
    await patchSync(session.id, { syncedAt: new Date() });
    const later = await syncLiveDraft(session, { provider });
    expect(later.corrected).toBe(false);
    expect(later.lastCorrectedAt).toBe(res.lastCorrectedAt);
  });

  it("handles a pure undo (provider list shrinks) as truncation", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA"), pick(2, "sB")];
    await syncLiveDraft(session, { provider });

    fake.picks = [pick(1, "sA")];
    fake.etag = "v2";
    await patchSync(session.id, { syncedAt: new Date(0) });
    const res = await syncLiveDraft(session, { provider });

    expect(res.corrected).toBe(true);
    expect((await dbPicks(session.id)).map((r) => r.playerId)).toEqual(["sleeper:sA"]);
  });
});

describe("syncLiveDraft — provider failure backoff", () => {
  it("RateLimited → serve stale + exponential nextAllowedAt (8s → 16s), success clears it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA")];
    await syncLiveDraft(session, { provider }); // healthy baseline sync

    fake.throwOnPicks = new ProviderError("RateLimited", "429 from sleeper", 429);
    await patchSync(session.id, { syncedAt: new Date(0) });
    const stale = await syncLiveDraft(session, { provider });
    expect(stale.picks).toHaveLength(1); // served from DB
    let sync = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });
    const wait1 = (sync.nextAllowedAt!.getTime() - Date.now()) / 1000;
    expect(wait1).toBeGreaterThan(6);
    expect(wait1).toBeLessThanOrEqual(8.5);
    expect(sync.claimedUntil).toBeNull();

    // While backing off, the provider is not even attempted.
    const calls = fake.getPicksCalls;
    await syncLiveDraft(session, { provider });
    expect(fake.getPicksCalls).toBe(calls);

    // Next allowed attempt fails again → the step doubles.
    await patchSync(session.id, { nextAllowedAt: new Date(Date.now() - 1000) });
    await syncLiveDraft(session, { provider });
    sync = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });
    const wait2 = (sync.nextAllowedAt!.getTime() - Date.now()) / 1000;
    expect(wait2).toBeGreaterThan(14);
    expect(wait2).toBeLessThanOrEqual(16.5);

    // Recovery clears the backoff so the next failure restarts at 8s.
    fake.throwOnPicks = null;
    fake.etag = "v2";
    await patchSync(session.id, { nextAllowedAt: new Date(Date.now() - 1000) });
    await syncLiveDraft(session, { provider });
    sync = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });
    expect(sync.nextAllowedAt).toBeNull();
    warn.mockRestore();
  });

  it("non-provider errors propagate (no swallow)", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA")];
    provider.resolvePlayers = async () => {
      throw new TypeError("boom");
    };
    await expect(syncLiveDraft(session, { provider })).rejects.toThrow("boom");
  });
});

describe("syncLiveDraft — completion", () => {
  it("provider complete → final reconcile + DraftSession COMPLETE, then the gate stops syncing", async () => {
    const { provider, fake } = makeFakeProvider();
    const session = await mkSession();
    fake.picks = [pick(1, "sA"), pick(2, "sB")];
    fake.draftStatus = "complete";

    const res = await syncLiveDraft(session, { provider });
    expect(res.status).toBe("complete");
    expect(res.sessionStatus).toBe("COMPLETE");
    expect(res.onClockSeat).toBeNull();
    expect(res.picks).toHaveLength(2);
    const row = await db.draftSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("COMPLETE");

    // Later polls short-circuit on the COMPLETE session before any freshness math.
    const calls = fake.getPicksCalls;
    await patchSync(session.id, { syncedAt: new Date(0) });
    const again = await syncLiveDraft(
      { ...session, status: row.status },
      { provider },
    );
    expect(fake.getPicksCalls).toBe(calls);
    expect(again.sessionStatus).toBe("COMPLETE");
  });
});

describe("computeTtlSec — adaptive cadence table (PLAN.md §8)", () => {
  const now = new Date("2026-08-14T18:00:00Z");
  const base = { startTime: null, pickTimerSec: null, lastPickAt: null, now };

  it("pre_draft: 60s far out, 10s inside 5 minutes of start", () => {
    expect(computeTtlSec({ ...base, status: "pre_draft" })).toBe(60);
    expect(
      computeTtlSec({ ...base, status: "pre_draft", startTime: now.getTime() + 60 * 60_000 }),
    ).toBe(60);
    expect(
      computeTtlSec({ ...base, status: "pre_draft", startTime: now.getTime() + 4 * 60_000 }),
    ).toBe(10);
  });

  it("drafting: 4s live, 15s past 3×pick_timer of silence, 60s past 10×", () => {
    const timer = { pickTimerSec: 90 };
    expect(computeTtlSec({ ...base, status: "drafting" })).toBe(4);
    expect(
      computeTtlSec({
        ...base,
        ...timer,
        status: "drafting",
        lastPickAt: new Date(now.getTime() - 60_000), // quiet 60s < 270s
      }),
    ).toBe(4);
    expect(
      computeTtlSec({
        ...base,
        ...timer,
        status: "drafting",
        lastPickAt: new Date(now.getTime() - 5 * 90_000), // 450s > 3×90
      }),
    ).toBe(15);
    expect(
      computeTtlSec({
        ...base,
        ...timer,
        status: "drafting",
        lastPickAt: new Date(now.getTime() - 11 * 90_000), // 990s > 10×90
      }),
    ).toBe(60);
  });

  it("paused 45s, complete parks at 3600s, unknown vocabulary polls cautiously", () => {
    expect(computeTtlSec({ ...base, status: "paused" })).toBe(45);
    expect(computeTtlSec({ ...base, status: "complete" })).toBe(3600);
    expect(computeTtlSec({ ...base, status: "definitely_new_status" })).toBe(15);
  });
});
