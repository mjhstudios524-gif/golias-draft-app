import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Env must exist BEFORE @/server/db (adapter built at import) is pulled in —
// vi.hoisted runs ahead of the hoisted static imports (same pattern as
// livesync.test.ts).
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
  process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
});
vi.mock("server-only", () => ({}));

// The admin allowlist is env-cached per process (lib/env caches each group on
// first read), so the allowlist itself is the seam — everything else in
// lib/env stays real, including dbEnv for the Prisma adapter.
const envState = vi.hoisted(() => ({ admins: [] as string[] }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, adminUserIds: () => envState.admins };
});

import { db } from "@/server/db";
import { publishAsPreset, unpublishPreset } from "@/server/presets/publish";
import { createSession } from "@/server/sessions-create";
import { buildSessionPayload, snapshotV1 } from "@/server/sessions";
import type { Pos } from "@/generated/prisma/enums";

// requireUser's dev fallback (no Clerk keys in vitest) resolves to this id.
const USER = "dev_local_user";
const OTHER_USER = "someone-else";
// Unique run prefix: this suite shares the dev database with the dev server —
// every row it creates is namespaced and cleaned up.
const T = `pp${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

interface SeedPlayer {
  id: string;
  fullName: string;
  pos: Pos;
  nflTeam: string | null;
}
let seedPlayers: SeedPlayer[] = [];

async function mkSet(
  opts: {
    name?: string;
    userId?: string | null;
    status?: "DRAFT" | "READY" | "ARCHIVED";
    kind?: "UPLOAD" | "PRESET";
    derivedFrom?: string | null;
    unmatchedRow?: boolean;
    entryCount?: number;
  } = {},
): Promise<string> {
  const count = opts.entryCount ?? 8;
  const set = await db.rankingSet.create({
    data: {
      groupId: `${T}-${Math.random().toString(36).slice(2)}`,
      version: 1,
      userId: opts.userId === undefined ? USER : opts.userId,
      name: opts.name ?? `${T} Board`,
      seasonYear: 2026,
      kind: opts.kind ?? "UPLOAD",
      status: opts.status ?? "READY",
      dataTier: "RANK_ONLY",
      formatTag: "1QB",
      adpContext: "ONE_QB",
      rawCsv: "name,rank\n",
      derivedFrom: opts.derivedFrom ?? null,
    },
  });
  await db.rankingEntry.createMany({
    data: seedPlayers.slice(0, count).map((p, i) => ({
      rankingSetId: set.id,
      playerId: p.id,
      rawName: p.fullName,
      team: p.nflTeam,
      pos: p.pos,
      rank: i + 1,
      adp: i + 1.5,
      matchMethod: "EXACT_FULL",
      matchConfidence: 1,
      sourceRow: i + 1,
    })),
  });
  if (opts.unmatchedRow) {
    await db.rankingEntry.create({
      data: {
        rankingSetId: set.id,
        playerId: null,
        rawName: `${T} Mystery Rookie`,
        team: "FA",
        pos: "WR",
        rank: count + 1,
        matchMethod: "UNMATCHED",
        sourceRow: count + 1,
      },
    });
  }
  return set.id;
}

let leagueId: string;

beforeAll(async () => {
  await db.user.upsert({ where: { id: USER }, update: {}, create: { id: USER } });
  await db.user.upsert({ where: { id: OTHER_USER }, update: {}, create: { id: OTHER_USER } });
  seedPlayers = await db.player.findMany({
    where: { active: true, pos: { in: ["QB", "RB", "WR", "TE"] } },
    select: { id: true, fullName: true, pos: true, nflTeam: true },
    orderBy: { id: "asc" },
    take: 8,
  });
  const league = await db.league.create({
    data: {
      userId: USER,
      name: `${T} League`,
      seasonYear: 2026,
      numTeams: 4,
      scoring: {},
      rosterSpec: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 0, DEF: 0, K: 0, BN: 2 },
    },
  });
  leagueId = league.id;
});

afterAll(async () => {
  await db.draftSession.deleteMany({ where: { leagueId } });
  await db.league.deleteMany({ where: { id: leagueId } });
  await db.rankingSet.deleteMany({ where: { name: { startsWith: T } } }); // entries cascade
  await db.$disconnect();
});

describe("publishAsPreset — admin gate", () => {
  it("rejects a non-admin and creates nothing", async () => {
    envState.admins = [];
    const setId = await mkSet();
    const res = await publishAsPreset(setId);
    expect(res).toEqual({ ok: false, error: "Publishing presets is restricted to the site owner" });
    expect(await db.rankingSet.count({ where: { userId: null, name: { startsWith: T } } })).toBe(0);
  });

  it("rejects a non-admin unpublish", async () => {
    envState.admins = [];
    const presetId = await mkSet({ userId: null, kind: "PRESET" });
    const res = await unpublishPreset(presetId);
    expect(res.ok).toBe(false);
    expect(await db.rankingSet.findUniqueOrThrow({ where: { id: presetId } })).toMatchObject({
      status: "READY",
    });
  });
});

describe("publishAsPreset — eligibility", () => {
  it("refuses a set that still has UNMATCHED entries", async () => {
    envState.admins = [USER];
    const setId = await mkSet({ name: `${T} Unmatched`, unmatchedRow: true });
    const res = await publishAsPreset(setId);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/unmatched/i);
    expect(await db.rankingSet.count({ where: { userId: null, name: `${T} Unmatched` } })).toBe(0);
  });

  it("refuses a DRAFT set", async () => {
    envState.admins = [USER];
    const setId = await mkSet({ name: `${T} Draft`, status: "DRAFT" });
    const res = await publishAsPreset(setId);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/READY/);
  });

  it("refuses another user's upload and a set that is already a preset", async () => {
    envState.admins = [USER];
    const theirs = await mkSet({ name: `${T} Theirs`, userId: OTHER_USER });
    expect(await publishAsPreset(theirs)).toEqual({ ok: false, error: "Ranking set not found" });
    const preset = await mkSet({ name: `${T} Already`, userId: null, kind: "PRESET" });
    expect(await publishAsPreset(preset)).toEqual({
      ok: false,
      error: "That set is already a shipped preset",
    });
  });
});

describe("publishAsPreset — the copy", () => {
  it("creates a shipped preset copy and leaves the original untouched", async () => {
    envState.admins = [USER];
    const name = `${T} Copy`;
    // test-scoped, never a real 'ffc:*' value: @@unique([derivedFrom,
    // seasonYear]) reserves those for the nightly-derived boards
    const setId = await mkSet({ name, derivedFrom: `test:${T}:copy` });
    const before = await db.rankingSet.findUniqueOrThrow({
      where: { id: setId },
      include: { entries: { orderBy: { sourceRow: "asc" } } },
    });

    const res = await publishAsPreset(setId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toBe(before.entries.length);
    expect(res.presetId).not.toBe(setId);

    const preset = await db.rankingSet.findUniqueOrThrow({
      where: { id: res.presetId },
      include: { entries: { orderBy: { sourceRow: "asc" } } },
    });
    expect(preset).toMatchObject({
      userId: null,
      kind: "PRESET",
      status: "READY",
      version: 1,
      name,
      seasonYear: before.seasonYear,
      dataTier: before.dataTier,
      formatTag: before.formatTag,
      adpContext: before.adpContext,
      // a published copy is human-authored and frozen, NOT a cron-owned derived
      // board — so it drops the marker and keeps its rank-vs-ADP signals live
      derivedFrom: null,
      rawCsv: null, // presets are not re-mappable; the owner keeps the source file
    });
    expect(preset.groupId).not.toBe(before.groupId); // preset lineage is its own
    expect(preset.entries.map((e) => [e.playerId, e.rank, e.adp, e.matchMethod])).toEqual(
      before.entries.map((e) => [e.playerId, e.rank, e.adp, e.matchMethod]),
    );

    // copy, not move
    const after = await db.rankingSet.findUniqueOrThrow({
      where: { id: setId },
      include: { entries: true },
    });
    expect(after).toMatchObject({ userId: USER, kind: "UPLOAD", status: "READY" });
    expect(after.entries).toHaveLength(before.entries.length);
  });

  it("republishing versions the preset group and archives the version it supersedes", async () => {
    envState.admins = [USER];
    const name = `${T} Refresh`;
    const first = await publishAsPreset(await mkSet({ name }));
    const second = await publishAsPreset(await mkSet({ name }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.version).toBe(2);
    const rows = await db.rankingSet.findMany({ where: { userId: null, name } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    expect(rows.find((r) => r.id === first.presetId)!.status).toBe("ARCHIVED");
    expect(rows.find((r) => r.id === second.presetId)!.status).toBe("READY");
  });
});

describe("unpublishPreset", () => {
  it("archives a shipped preset, and refuses non-presets and repeats", async () => {
    envState.admins = [USER];
    const presetId = await mkSet({ name: `${T} Retire`, userId: null, kind: "PRESET" });
    const res = await unpublishPreset(presetId);
    expect(res.ok).toBe(true);
    expect(await db.rankingSet.findUniqueOrThrow({ where: { id: presetId } })).toMatchObject({
      status: "ARCHIVED",
    });
    // entries survive — archiving is a visibility change, not a delete
    expect(await db.rankingEntry.count({ where: { rankingSetId: presetId } })).toBeGreaterThan(0);

    expect(await unpublishPreset(presetId)).toEqual({
      ok: false,
      error: "That preset is already unpublished",
    });
    const upload = await mkSet({ name: `${T} NotPreset` });
    expect(await unpublishPreset(upload)).toEqual({
      ok: false,
      error: "That set is not a shipped preset",
    });
  });
});

describe("adpDerived plumbing (PLAN.md §6)", () => {
  const sessionInput = (rankingSetId: string) => ({
    userId: USER,
    leagueId,
    mode: "MOCK" as const,
    rankingSetId,
    myTeamId: 1,
    teamOrder: [1, 2, 3, 4],
    teamNames: { "1": "A", "2": "B", "3": "C", "4": "D" },
  });

  it("a derivedFrom set freezes adpDerived:true into the snapshot and the room config", async () => {
    const setId = await mkSet({ name: `${T} Derived`, derivedFrom: `test:${T}:derived` });
    const res = await createSession(sessionInput(setId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const session = await db.draftSession.findUniqueOrThrow({ where: { id: res.sessionId } });
    expect(snapshotV1.parse(session.config).adpDerived).toBe(true);
    const payload = await buildSessionPayload(session, []);
    expect(payload.config.adpDerived).toBe(true);
  });

  it("an ordinary upload leaves it unset — the legacy path is untouched", async () => {
    const setId = await mkSet({ name: `${T} Plain` });
    const res = await createSession(sessionInput(setId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const session = await db.draftSession.findUniqueOrThrow({ where: { id: res.sessionId } });
    expect(snapshotV1.parse(session.config).adpDerived).toBeUndefined();
    const payload = await buildSessionPayload(session, []);
    expect(payload.config.adpDerived).toBeUndefined();
  });

  it("a published preset is human-authored, so the flag does NOT carry over", async () => {
    envState.admins = [USER];
    // Even publishing a board that carried the marker yields a frozen,
    // hand-shipped preset the cron never touches — so its rank-vs-ADP signals
    // stay live, unlike the nightly Consensus boards.
    const published = await publishAsPreset(
      await mkSet({ name: `${T} Shipped`, derivedFrom: `test:${T}:shipped` }),
    );
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const res = await createSession(sessionInput(published.presetId));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const session = await db.draftSession.findUniqueOrThrow({ where: { id: res.sessionId } });
    expect(snapshotV1.parse(session.config).adpDerived).toBeUndefined();
  });
});
