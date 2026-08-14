import "server-only";
import { z } from "zod";
import { db } from "@/server/db";
import { matchEntries } from "@/server/rankings/match";
import { scoringConfigSchema } from "@/lib/leagues";
import type { LeagueFormat } from "@/engine/types";
import type { MatchInput } from "@/server/rankings/types";
import { ffcProvider } from "./ffc";
import { ADP_FORMATS, type AdpFormat, type AdpProvider, type StoredAdpEntry } from "./types";

// ADP sync + snapshot readers (PLAN.md §8a). Entries resolve to canonical
// players through the SAME staged matcher as CSV rankings; unmatched rows are
// kept with playerId null (the most-drafted ~250 names should all match — a
// spike in unmatched is a data signal, never a crash).

/** v1 scope (PLAN.md §8a): 12-team boards only. */
export const ADP_TEAMS = 12;

// Not a real user id ⇒ only GLOBAL alias rows apply (DSTs resolve there).
const MATCH_CTX = { userId: "system:adp-sync" };

export interface AdpSyncFormatResult {
  format: AdpFormat;
  total: number;
  matched: number;
  unmatched: number;
  totalDrafts: number;
}

export interface AdpSyncResult {
  ok: boolean;
  source: string;
  teams: number;
  total: number;
  matched: number;
  formats: AdpSyncFormatResult[];
}

export async function syncAdpSnapshots(provider: AdpProvider = ffcProvider): Promise<AdpSyncResult> {
  const formats: AdpSyncFormatResult[] = [];
  try {
    for (const format of ADP_FORMATS) {
      const snap = await provider.fetchSnapshot(format, ADP_TEAMS);
      const inputs: MatchInput[] = snap.entries.map((e) => ({
        rawName: e.rawName,
        team: e.team,
        pos: e.pos,
      }));
      const results = await matchEntries(inputs, MATCH_CTX);

      // DST second pass (PLAN.md §8a): FFC abbreviates some cities ("LA Rams
      // Defense") past the seeded name variants, but the team code itself is a
      // seeded GLOBAL alias key — re-run those rows through the same pipeline
      // keyed on the code. Deterministic; still stage-0, never fuzzy.
      const retry = snap.entries
        .map((e, i) => ({ e, i }))
        .filter(({ e, i }) => results[i].playerId === null && e.pos === "DEF" && e.team !== null);
      if (retry.length > 0) {
        const retried = await matchEntries(
          retry.map(({ e }) => ({ rawName: e.team!, team: e.team, pos: "DEF" as const })),
          MATCH_CTX,
        );
        retry.forEach(({ i }, j) => {
          if (retried[j].playerId !== null) results[i] = retried[j];
        });
      }

      const entries: StoredAdpEntry[] = snap.entries.map((e, i) => ({
        playerId: results[i].playerId,
        rawName: e.rawName,
        adp: e.adp,
        stdev: e.stdev,
        high: e.high,
        low: e.low,
        bye: e.bye,
        timesDrafted: e.timesDrafted,
      }));
      const unmatched = entries.filter((e) => e.playerId === null);
      if (unmatched.length > 0) {
        console.warn(
          `[adp-sync] ${provider.id} ${format}: ${unmatched.length}/${entries.length} unmatched: ` +
            unmatched.slice(0, 10).map((u) => u.rawName).join(", "),
        );
      }

      const data = {
        fetchedAt: snap.fetchedAt,
        totalDrafts: snap.totalDrafts,
        entries: entries as object[],
      };
      await db.adpSnapshot.upsert({
        where: {
          source_format_teams: { source: provider.id, format, teams: ADP_TEAMS },
        },
        update: data,
        create: { source: provider.id, format, teams: ADP_TEAMS, ...data },
      });
      formats.push({
        format,
        total: entries.length,
        matched: entries.length - unmatched.length,
        unmatched: unmatched.length,
        totalDrafts: snap.totalDrafts,
      });
    }
  } catch (err) {
    await db.playerSyncRun.create({
      data: {
        kind: "adp",
        changed: formats.reduce((n, f) => n + f.matched, 0),
        total: formats.reduce((n, f) => n + f.total, 0),
        ok: false,
      },
    });
    throw err;
  }

  const total = formats.reduce((n, f) => n + f.total, 0);
  const matched = formats.reduce((n, f) => n + f.matched, 0);
  await db.playerSyncRun.create({ data: { kind: "adp", changed: matched, total, ok: true } });
  return { ok: true, source: provider.id, teams: ADP_TEAMS, total, matched, formats };
}

// ---------------------------------------------------------------------------
// Snapshot readers — consumed by createSession attachment + the wizard indicator.

const storedEntrySchema = z
  .object({
    playerId: z.string().nullable(),
    rawName: z.string(),
    adp: z.number(),
  })
  .loose();

export interface LatestAdpSnapshot {
  source: string;
  format: AdpFormat;
  fetchedAt: Date;
  /** Canonical playerId → adp, matched entries only. */
  adpByPlayerId: Map<string, number>;
}

/** Latest stored snapshot for a format, or null when the cron has never run
 * (or the stored Json is unreadable — surfaced as "no live ADP", never a 500). */
export async function latestAdpSnapshot(
  format: AdpFormat,
  source = "ffc",
): Promise<LatestAdpSnapshot | null> {
  const row = await db.adpSnapshot.findUnique({
    where: { source_format_teams: { source, format, teams: ADP_TEAMS } },
  });
  if (!row) return null;
  const parsed = z.array(storedEntrySchema).safeParse(row.entries);
  if (!parsed.success) return null;
  const adpByPlayerId = new Map<string, number>();
  for (const e of parsed.data) if (e.playerId !== null) adpByPlayerId.set(e.playerId, e.adp);
  return { source: row.source, format: row.format as AdpFormat, fetchedAt: row.fetchedAt, adpByPlayerId };
}

/** League → snapshot format (PLAN.md §8a): superflex league → SF market;
 * else nearest rec-weight variant (1→PPR, 0.5→HALF_PPR, 0/absent→STANDARD). */
export function adpFormatForLeague(format: LeagueFormat, scoring: unknown): AdpFormat {
  if (format === "MULTI_QB") return "SF";
  const parsed = scoringConfigSchema.safeParse(scoring);
  const rec = parsed.success ? (parsed.data.weights["rec"] ?? 0) : 0;
  if (rec >= 0.75) return "PPR";
  if (rec >= 0.25) return "HALF_PPR";
  return "STANDARD";
}

/** format → fetchedAt ISO string for every stored snapshot (wizard indicator). */
export async function adpSnapshotMeta(source = "ffc"): Promise<Record<string, string>> {
  const rows = await db.adpSnapshot.findMany({
    where: { source, teams: ADP_TEAMS },
    select: { format: true, fetchedAt: true },
  });
  return Object.fromEntries(rows.map((r) => [r.format, r.fetchedAt.toISOString()]));
}

/** Which of the given ranking sets carry their own uploaded ADP column —
 * those keep upload precedence and never get live ADP attached. */
export async function setsWithUploadedAdp(setIds: string[]): Promise<string[]> {
  if (setIds.length === 0) return [];
  const rows = await db.rankingEntry.findMany({
    where: { rankingSetId: { in: setIds }, adp: { not: null } },
    select: { rankingSetId: true },
    distinct: ["rankingSetId"],
  });
  return rows.map((r) => r.rankingSetId);
}
