import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";
import type { RankingEntry, RankingSet } from "@/generated/prisma/client";
import { normalizeName } from "@/lib/players/normalize";
import { assertEntitled } from "@/server/entitlements";
import { matchEntries } from "./match";
import type { MatchCandidate, NormalizedRow } from "./types";

// RankingSet storage + versioning + resolution workflow (PLAN.md §6).
// Lifecycle: DRAFT → (resolutions) → READY; READY sets are immutable.
// Re-upload under the same (userId, name, seasonYear) reuses the groupId and
// increments version; raw CSV text is kept for the LATEST version per group
// only (Postgres bloat bound).

export class RankingsError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID",
  ) {
    super(message);
    this.name = "RankingsError";
  }
}

export interface CreateRankingSetArgs {
  userId: string;
  name: string;
  seasonYear: number;
  formatTag: "1QB" | "SF";
  adpContext: "ONE_QB" | "SUPERFLEX" | "UNKNOWN";
  dataTier: "RANK_ONLY" | "POINTS" | "FULL_STATS";
  headerFingerprint?: string | null;
  columnMap?: unknown;
  rawCsv?: string | null;
  rows: NormalizedRow[];
}

export type RankingEntryWithCandidates = RankingEntry & { candidates?: MatchCandidate[] };

export interface SetSummary {
  total: number;
  matched: number;
  unmatched: number;
  unlinked: number;
}

export interface CreateRankingSetResult {
  set: RankingSet;
  entries: RankingEntryWithCandidates[];
  summary: SetSummary;
}

export async function createRankingSet(args: CreateRankingSetArgs): Promise<CreateRankingSetResult> {
  // §9 gate: CSV uploads are entitled-only. This path always creates kind
  // UPLOAD — shipped PRESET sets (exempt) are seeded outside it.
  await assertEntitled(args.userId, "Uploading custom rankings");
  const rows = [...args.rows].sort((a, b) => a.sourceRow - b.sourceRow);
  if (rows.length === 0) throw new RankingsError("a ranking set needs at least one row", "INVALID");

  const results = await matchEntries(
    rows.map((r) => ({ rawName: r.name, team: r.team, pos: r.pos })),
    { userId: args.userId },
  );

  // A player may appear once per set (unique [rankingSetId, playerId]) — a
  // second row matching the same player is demoted to the unmatched queue.
  const seen = new Set<string>();
  const candidatesBySourceRow = new Map<number, MatchCandidate[]>();
  const entryData = rows.map((row, i) => {
    let { playerId, matchMethod, confidence } = results[i];
    if (playerId !== null && seen.has(playerId)) {
      playerId = null;
      matchMethod = "UNMATCHED";
      confidence = null;
    } else if (playerId !== null) {
      seen.add(playerId);
    }
    if (matchMethod === "UNMATCHED" && results[i].candidates) {
      candidatesBySourceRow.set(row.sourceRow, results[i].candidates!);
    }
    return {
      playerId,
      // row.name (not the raw cell) so the alias written on manual resolution
      // uses the same string the matcher keyed on; the raw cell stays
      // recoverable via rawCsv + sourceRow
      rawName: row.name,
      team: row.team,
      pos: row.pos,
      rank: row.rank === null ? null : Math.round(row.rank),
      adp: row.adp,
      projPoints: row.projPoints,
      stats: row.stats ?? undefined,
      matchMethod,
      matchConfidence: confidence,
      sourceRow: row.sourceRow,
    };
  });

  // version within the group: reuse groupId of the latest same-named set
  const prior = await db.rankingSet.findFirst({
    where: { userId: args.userId, name: args.name, seasonYear: args.seasonYear },
    orderBy: { createdAt: "desc" },
    select: { groupId: true },
  });
  const groupId = prior?.groupId ?? randomUUID();
  const priorMax = prior
    ? await db.rankingSet.aggregate({ where: { groupId }, _max: { version: true } })
    : null;
  const version = (priorMax?._max.version ?? 0) + 1;

  let set: RankingSet;
  try {
    set = await db.$transaction(
      async (tx) => {
        const created = await tx.rankingSet.create({
          data: {
            groupId,
            version,
            userId: args.userId,
            name: args.name,
            seasonYear: args.seasonYear,
            kind: "UPLOAD",
            status: "DRAFT",
            dataTier: args.dataTier,
            formatTag: args.formatTag,
            adpContext: args.adpContext,
            headerFingerprint: args.headerFingerprint ?? null,
            columnMap:
              args.columnMap == null ? undefined : (args.columnMap as Prisma.InputJsonValue),
            rawCsv: args.rawCsv ?? null,
          },
        });
        await tx.rankingEntry.createMany({
          data: entryData.map((e) => ({ ...e, rankingSetId: created.id })),
        });
        // raw CSV kept on the latest version per group only
        await tx.rankingSet.updateMany({
          where: { groupId, NOT: { id: created.id } },
          data: { rawCsv: null },
        });
        return created;
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new RankingsError("a concurrent upload created this version — retry", "CONFLICT");
    }
    throw e;
  }

  const stored = await db.rankingEntry.findMany({
    where: { rankingSetId: set.id },
    orderBy: { sourceRow: "asc" },
  });
  const entries: RankingEntryWithCandidates[] = stored.map((e) => {
    const candidates = candidatesBySourceRow.get(e.sourceRow);
    return candidates ? { ...e, candidates } : e;
  });
  return { set, entries, summary: summarize(stored) };
}

function summarize(entries: readonly Pick<RankingEntry, "matchMethod">[]): SetSummary {
  let unmatched = 0;
  let unlinked = 0;
  for (const e of entries) {
    if (e.matchMethod === "UNMATCHED") unmatched++;
    else if (e.matchMethod === "UNLINKED") unlinked++;
  }
  return { total: entries.length, matched: entries.length - unmatched - unlinked, unmatched, unlinked };
}

async function requireDraftSet(userId: string, setId: string): Promise<RankingSet> {
  const set = await db.rankingSet.findUnique({ where: { id: setId } });
  if (!set || set.userId !== userId) throw new RankingsError("ranking set not found", "NOT_FOUND");
  if (set.status !== "DRAFT") {
    throw new RankingsError("ranking set is immutable once READY", "CONFLICT");
  }
  return set;
}

export interface ResolveEntryArgs {
  userId: string;
  setId: string;
  entryId: string;
  playerId: string | null;
  exclude?: boolean;
}

export type ResolveEntryResult = { excluded: true } | { excluded: false; entry: RankingEntry };

/** Manual resolution of one entry: link to a player (writes a user-scoped
 * PlayerAlias so the same name never asks twice), keep as UNLINKED, or
 * exclude (delete) the row from the set. */
export async function resolveEntry(args: ResolveEntryArgs): Promise<ResolveEntryResult> {
  await requireDraftSet(args.userId, args.setId);
  const entry = await db.rankingEntry.findUnique({ where: { id: args.entryId } });
  if (!entry || entry.rankingSetId !== args.setId) {
    throw new RankingsError("entry not found", "NOT_FOUND");
  }

  if (args.exclude) {
    await db.rankingEntry.delete({ where: { id: entry.id } });
    return { excluded: true };
  }

  if (args.playerId !== null) {
    const player = await db.player.findUnique({ where: { id: args.playerId } });
    if (!player) throw new RankingsError("player not found", "NOT_FOUND");
    const aliasKey = normalizeName(entry.rawName).nameKey;
    try {
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.rankingEntry.update({
          where: { id: entry.id },
          data: { playerId: player.id, matchMethod: "MANUAL", matchConfidence: 1 },
        });
        if (aliasKey.length > 0) {
          await tx.playerAlias.upsert({
            where: { aliasKey_scope: { aliasKey, scope: args.userId } },
            update: { playerId: player.id, createdBy: args.userId },
            create: { aliasKey, scope: args.userId, playerId: player.id, createdBy: args.userId },
          });
        }
        return u;
      });
      return { excluded: false, entry: updated };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new RankingsError("player is already linked to another entry in this set", "CONFLICT");
      }
      throw e;
    }
  }

  const updated = await db.rankingEntry.update({
    where: { id: entry.id },
    data: { playerId: null, matchMethod: "UNLINKED", matchConfidence: null },
  });
  return { excluded: false, entry: updated };
}

/** DRAFT → READY, allowed only when zero rows are still UNMATCHED (UNLINKED
 * is fine — unlinked entries are first-class on the board). Idempotent on an
 * already-READY set. */
export async function finalizeSet(userId: string, setId: string): Promise<RankingSet> {
  const set = await db.rankingSet.findUnique({ where: { id: setId } });
  if (!set || set.userId !== userId) throw new RankingsError("ranking set not found", "NOT_FOUND");
  if (set.status === "READY") return set;
  if (set.status !== "DRAFT") throw new RankingsError("ranking set is archived", "CONFLICT");

  const unmatched = await db.rankingEntry.count({
    where: { rankingSetId: setId, matchMethod: "UNMATCHED" },
  });
  if (unmatched > 0) {
    throw new RankingsError(`${unmatched} entries are still unmatched — resolve them first`, "CONFLICT");
  }
  return db.rankingSet.update({ where: { id: setId }, data: { status: "READY" } });
}

export type ListedSet = Omit<RankingSet, "rawCsv"> & { summary: SetSummary };

/** The user's own sets plus READY shipped presets (userId null), newest first.
 * rawCsv omitted (large); per-set match summary attached for the dashboard. */
export async function listSets(userId: string, seasonYear: number): Promise<ListedSet[]> {
  const sets = await db.rankingSet.findMany({
    where: { seasonYear, OR: [{ userId }, { userId: null, status: "READY" }] },
    omit: { rawCsv: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const counts = await db.rankingEntry.groupBy({
    by: ["rankingSetId", "matchMethod"],
    where: { rankingSetId: { in: sets.map((s) => s.id) } },
    _count: { _all: true },
  });
  const bySet = new Map<string, SetSummary>();
  for (const c of counts) {
    const s = bySet.get(c.rankingSetId) ?? { total: 0, matched: 0, unmatched: 0, unlinked: 0 };
    s.total += c._count._all;
    if (c.matchMethod === "UNMATCHED") s.unmatched += c._count._all;
    else if (c.matchMethod === "UNLINKED") s.unlinked += c._count._all;
    else s.matched += c._count._all;
    bySet.set(c.rankingSetId, s);
  }
  return sets.map((s) => ({
    ...s,
    summary: bySet.get(s.id) ?? { total: 0, matched: 0, unmatched: 0, unlinked: 0 },
  }));
}
