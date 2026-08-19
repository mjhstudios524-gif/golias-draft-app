import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";
import { Pos } from "@/generated/prisma/enums";
import { currentSeason } from "@/lib/season";
import { ADP_TEAMS } from "@/server/adp/sync";
import type { AdpFormat } from "@/server/adp/types";

// Derived preset boards (PLAN.md §6 "Free presets", §8a).
//
// The app ships with NO third-party rankings, so the free presets are built
// from the FFC market ADP the cron already syncs nightly: the app is never
// empty on day one and the boards self-update through draft season with zero
// owner content work. The owner's hand-authored board stays an optional upsell
// published through the admin path.
//
// CONSEQUENCE (why RankingSet.derivedFrom exists): a board derived FROM market
// ADP cannot also be judged AGAINST market ADP. Rank and ADP are the same
// underlying number here, diverging only as noise in the deep tail, so the
// room suppresses the value/reach colouring and the "falling past his rank"
// reason for these sets. Everything that measures ADP against the PICK NUMBER
// — tiers, scarcity, drop-off, roster needs, survival probability, VBD
// baselines — stays fully active.

/** RankingEntry.matchMethod for derived rows: identity came from the ADP
 * sync's own staged match (or straight off the Player table for tail rows),
 * not from parsing a user's CSV, so none of the upload match stages apply.
 * Anything that is not UNMATCHED/UNLINKED counts as matched downstream. */
export const DERIVED_MATCH_METHOD = "DERIVED";

/** ~400 keeps a 20-team, deep-bench league from running dry in the last
 * rounds; FFC only covers the most-drafted ~210-256. */
export const TARGET_BOARD_SIZE = 400;

/** Tail candidates ordered by Sleeper popularity. D/ST is handled separately
 * (see the tail backfill) because the dump carries no search_rank for the 32
 * team-defense pseudo-players. Tail players legitimately have no ADP — the
 * engine already treats null ADP correctly (survival returns null, the cell
 * renders '-'). */
const TAIL_POSITIONS: Pos[] = [Pos.QB, Pos.RB, Pos.WR, Pos.TE, Pos.K];

const PLAYER_SELECT = { id: true, fullName: true, pos: true, nflTeam: true } as const;

interface PresetSpec {
  name: string;
  formatTag: "1QB" | "SF";
  adpContext: "ONE_QB" | "SUPERFLEX";
}

/** One preset per ADP snapshot format. The SF snapshot is a genuinely
 * different market (QB-inflated), which is exactly what formatTag/adpContext
 * carry into the engine's generalized ADP rule (PLAN.md §5). */
const PRESET_BY_FORMAT: Record<AdpFormat, PresetSpec> = {
  PPR: { name: "Consensus PPR", formatTag: "1QB", adpContext: "ONE_QB" },
  HALF_PPR: { name: "Consensus Half-PPR", formatTag: "1QB", adpContext: "ONE_QB" },
  STANDARD: { name: "Consensus Standard", formatTag: "1QB", adpContext: "ONE_QB" },
  SF: { name: "Consensus Superflex", formatTag: "SF", adpContext: "SUPERFLEX" },
};

const snapshotEntrySchema = z
  .object({
    playerId: z.string().nullable(),
    adp: z.number(),
  })
  .loose();

export interface DerivedPresetSummary {
  format: AdpFormat;
  name: string;
  setId: string;
  derivedFrom: string;
  /** entries taken from the ADP snapshot (rank 1..fromAdp) */
  fromAdp: number;
  /** entries appended by the tail backfill (adp null) */
  tail: number;
  total: number;
  /** false ⇒ an existing preset row was refreshed in place */
  created: boolean;
}

export interface DeriveAdpPresetsResult {
  ok: boolean;
  seasonYear: number;
  boards: DerivedPresetSummary[];
}

export interface DeriveAdpPresetsOptions {
  source?: string;
  teams?: number;
  seasonYear?: number;
  targetSize?: number;
}

/** Build/refresh one shipped preset RankingSet per stored ADP snapshot.
 * Idempotent: safe to run on every cron tick. */
export async function deriveAdpPresets(
  opts: DeriveAdpPresetsOptions = {},
): Promise<DeriveAdpPresetsResult> {
  const source = opts.source ?? "ffc";
  const teams = opts.teams ?? ADP_TEAMS;
  const seasonYear = opts.seasonYear ?? currentSeason(new Date()).seasonYear;
  const targetSize = opts.targetSize ?? TARGET_BOARD_SIZE;

  const snapshots = await db.adpSnapshot.findMany({
    where: { source, teams },
    orderBy: { format: "asc" },
  });

  const boards: DerivedPresetSummary[] = [];
  for (const snap of snapshots) {
    const spec = PRESET_BY_FORMAT[snap.format as AdpFormat];
    // A format we have no preset spec for is skipped, never guessed at.
    if (!spec) continue;
    boards.push(await derivePreset(snap, spec, { seasonYear, targetSize }));
  }
  return { ok: true, seasonYear, boards };
}

interface DerivableSnapshot {
  source: string;
  format: string;
  entries: unknown;
}

interface EntryRow {
  playerId: string;
  rawName: string;
  team: string | null;
  pos: Pos;
  rank: number;
  adp: number | null;
  matchMethod: string;
  sourceRow: number;
}

async function derivePreset(
  snap: DerivableSnapshot,
  spec: PresetSpec,
  ctx: { seasonYear: number; targetSize: number },
): Promise<DerivedPresetSummary> {
  const derivedFrom = `${snap.source}:${snap.format}`;
  const parsed = z.array(snapshotEntrySchema).safeParse(snap.entries);
  if (!parsed.success) {
    throw new Error(`[derive-presets] unreadable AdpSnapshot entries for ${derivedFrom}`);
  }

  // Ordering IS the board: ADP ascending. The playerId tie-break keeps the
  // result deterministic — FFC rounds ADP to 2dp and ties are common deeper in.
  // Unmatched snapshot rows (playerId null) are dropped: they cannot be drafted.
  const ordered = parsed.data
    .filter((e): e is { playerId: string; adp: number } => e.playerId !== null)
    .sort((a, b) => a.adp - b.adp || a.playerId.localeCompare(b.playerId));

  const seen = new Set<string>();
  const unique: { playerId: string; adp: number }[] = [];
  for (const e of ordered) {
    if (seen.has(e.playerId)) continue;
    seen.add(e.playerId);
    unique.push(e);
  }

  const covered = await db.player.findMany({
    where: { id: { in: unique.map((e) => e.playerId) } },
    select: PLAYER_SELECT,
  });
  const byId = new Map(covered.map((p) => [p.id, p]));

  const rows: EntryRow[] = [];
  for (const e of unique) {
    const p = byId.get(e.playerId);
    // A snapshot id whose Player row has since vanished: drop it rather than
    // ship a board row nothing can resolve.
    if (!p) continue;
    rows.push(entryRow(p, rows.length + 1, e.adp));
  }
  const fromAdp = rows.length;

  // TAIL BACKFILL — everyone the market hasn't priced yet, in Sleeper
  // popularity order (nulls last), continuing the same rank sequence.
  const need = Math.max(0, ctx.targetSize - rows.length);
  if (need > 0) {
    const boardIds = rows.map((r) => r.playerId);

    // D/ST is reserved out of the general ordering: Sleeper publishes no
    // search_rank for the 32 team-defense pseudo-players, so ordering by
    // searchRank-nulls-last would push every one of them past a ~400-row board
    // and leave the snapshot's 15-26 defenses as the entire supply — a 16+
    // team league could not fill its DEF slots at all. They take the tail's
    // LAST slots instead: still bottom-of-board (in RANK_ONLY mode the rank IS
    // the value, and a DST that no one drafts belongs there), but guaranteed
    // to exist.
    const missingDsts = await db.player.findMany({
      where: { active: true, pos: Pos.DEF, id: { notIn: boardIds } },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      select: PLAYER_SELECT,
    });
    const reservedDsts = missingDsts.slice(0, need);

    const skillTake = need - reservedDsts.length;
    const tail =
      skillTake > 0
        ? await db.player.findMany({
            where: { active: true, pos: { in: TAIL_POSITIONS }, id: { notIn: boardIds } },
            orderBy: [
              { searchRank: { sort: "asc", nulls: "last" } },
              { fullName: "asc" },
              { id: "asc" },
            ],
            take: skillTake,
            select: PLAYER_SELECT,
          })
        : [];

    for (const p of tail) rows.push(entryRow(p, rows.length + 1, null));
    for (const p of reservedDsts) rows.push(entryRow(p, rows.length + 1, null));
  }

  const data = {
    name: spec.name,
    seasonYear: ctx.seasonYear,
    kind: "PRESET",
    status: "READY",
    dataTier: "RANK_ONLY",
    formatTag: spec.formatTag,
    adpContext: spec.adpContext,
    derivedFrom,
  } as const;

  const existing = await db.rankingSet.findFirst({
    where: { userId: null, kind: "PRESET", derivedFrom, seasonYear: ctx.seasonYear },
    orderBy: { version: "desc" },
    select: { id: true },
  });

  // VERSIONING: presets refresh IN PLACE (same row, version stays 1) rather
  // than versioning like uploads do. A nightly cron would otherwise mint a new
  // version every single night — hundreds by December — for what is one
  // continuously-updated board, and Leagues pin a specific version, so every
  // league's default would silently go stale each night. In-flight drafts are
  // unaffected either way: a session freezes its resolved player pool into
  // DraftSession.config at creation (PLAN.md §6/§7).
  const setId = await db.$transaction(
    async (tx) => {
      let id: string;
      if (existing) {
        await tx.rankingSet.update({ where: { id: existing.id }, data });
        await tx.rankingEntry.deleteMany({ where: { rankingSetId: existing.id } });
        id = existing.id;
      } else {
        // The findFirst above is check-then-create: a retried or overlapping
        // cron run can pass the check concurrently. @@unique([derivedFrom,
        // seasonYear]) makes the duplicate impossible at the DB level; losing
        // that race is benign, so adopt the winner's row and refresh it.
        try {
          const created = await tx.rankingSet.create({
            data: { ...data, groupId: randomUUID(), version: 1, userId: null },
            select: { id: true },
          });
          id = created.id;
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") throw e;
          const winner = await tx.rankingSet.findFirstOrThrow({
            where: { derivedFrom, seasonYear: ctx.seasonYear },
            select: { id: true },
          });
          await tx.rankingSet.update({ where: { id: winner.id }, data });
          await tx.rankingEntry.deleteMany({ where: { rankingSetId: winner.id } });
          id = winner.id;
        }
      }
      await tx.rankingEntry.createMany({
        data: rows.map((r) => ({ ...r, rankingSetId: id })),
      });
      return id;
    },
    { timeout: 30_000 },
  );

  return {
    format: snap.format as AdpFormat,
    name: spec.name,
    setId,
    derivedFrom,
    fromAdp,
    tail: rows.length - fromAdp,
    total: rows.length,
    created: existing === null,
  };
}

function entryRow(
  p: { id: string; fullName: string; pos: Pos; nflTeam: string | null },
  rank: number,
  adp: number | null,
): EntryRow {
  return {
    playerId: p.id,
    // Canonical name, not the provider's cell: identity is already resolved,
    // and FFC spellings ("LA Rams Defense") would read as noise on the board.
    // The provider string stays recoverable from AdpSnapshot.entries.
    rawName: p.fullName,
    team: p.nflTeam,
    pos: p.pos,
    rank,
    adp,
    matchMethod: DERIVED_MATCH_METHOD,
    sourceRow: rank,
  };
}
