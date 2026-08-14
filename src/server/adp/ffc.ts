import "server-only";
import { z } from "zod";
import { canonicalTeamCode } from "@/engine/teams";
import { CURRENT_SEASON } from "@/lib/leagues";
import type { Pos } from "@/engine/types";
import type { AdpFormat, AdpProvider, AdpProviderEntry, AdpProviderSnapshot } from "./types";

// Fantasy Football Calculator public ADP API (PLAN.md §8a — verified live
// 2026-08-13): GET /api/v1/adp/{slug}?teams=N&year=YYYY. No auth. Shapes
// confirmed against the recorded fixtures in __tests__/fixtures: player rows
// carry {player_id:int, name, position, team, adp:float, adp_formatted,
// times_drafted:int, high:int, low:int, stdev:float, bye:int}.

export const FFC_FORMAT_SLUGS: Record<AdpFormat, string> = {
  STANDARD: "standard",
  HALF_PPR: "half-ppr",
  PPR: "ppr",
  SF: "2qb", // FFC's superflex-shaped market ⇒ snapshots tagged adpContext SF
};

/** FFC position vocabulary (verified live): QB RB WR TE PK DEF. */
const FFC_POS: Record<string, Pos> = {
  QB: "QB",
  RB: "RB",
  WR: "WR",
  TE: "TE",
  PK: "K",
  K: "K",
  DEF: "DEF",
  DST: "DEF",
};

const ffcPlayer = z
  .object({
    name: z.string(),
    position: z.string().nullish(),
    team: z.string().nullish(),
    adp: z.number(),
    stdev: z.number().nullish(),
    high: z.number().nullish(),
    low: z.number().nullish(),
    bye: z.number().nullish(),
    times_drafted: z.number().nullish(),
  })
  .loose();

const ffcResponse = z
  .object({
    status: z.string(),
    meta: z
      .object({
        total_drafts: z.number(),
        start_date: z.string().nullish(),
        end_date: z.string().nullish(),
      })
      .loose(),
    players: z.array(ffcPlayer),
  })
  .loose();

/** Keys we consume or knowingly ignore — anything new gets logged once per parse. */
const KNOWN_PLAYER_KEYS = new Set([
  "player_id",
  "name",
  "position",
  "team",
  "adp",
  "adp_formatted",
  "times_drafted",
  "high",
  "low",
  "stdev",
  "bye",
]);

export function ffcAdpUrl(format: AdpFormat, teams: number, year = CURRENT_SEASON): string {
  return `https://fantasyfootballcalculator.com/api/v1/adp/${FFC_FORMAT_SLUGS[format]}?teams=${teams}&year=${year}`;
}

/** Pure response → provider snapshot (fixture-tested). Throws on a shape or
 * non-Success payload so the sync records a failed run instead of an empty board. */
export function parseFfcResponse(raw: unknown): AdpProviderSnapshot {
  const parsed = ffcResponse.parse(raw);
  if (parsed.status !== "Success") {
    throw new Error(`ffc adp: unexpected status ${JSON.stringify(parsed.status)}`);
  }

  const first = parsed.players[0];
  if (first) {
    const unknown = Object.keys(first).filter((k) => !KNOWN_PLAYER_KEYS.has(k));
    if (unknown.length > 0) console.warn(`[adp/ffc] unknown player keys: ${unknown.join(", ")}`);
  }

  const entries: AdpProviderEntry[] = parsed.players.map((p) => ({
    rawName: p.name,
    pos: FFC_POS[(p.position ?? "").toUpperCase()] ?? null,
    team: canonicalTeamCode(p.team ?? null),
    adp: p.adp,
    stdev: p.stdev ?? null,
    high: p.high ?? null,
    low: p.low ?? null,
    bye: p.bye ?? null,
    timesDrafted: p.times_drafted ?? null,
  }));

  return {
    fetchedAt: new Date(),
    totalDrafts: parsed.meta.total_drafts,
    startDate: parsed.meta.start_date ?? null,
    endDate: parsed.meta.end_date ?? null,
    entries,
  };
}

export const ffcProvider: AdpProvider = {
  id: "ffc",
  async fetchSnapshot(format, teams) {
    const res = await fetch(ffcAdpUrl(format, teams), { cache: "no-store" });
    if (!res.ok) throw new Error(`ffc adp fetch failed: ${res.status} (${format})`);
    return parseFfcResponse(await res.json());
  },
};
