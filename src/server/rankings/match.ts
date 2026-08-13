import "server-only";
import { db } from "@/server/db";
import { normalizeName } from "@/lib/players/normalize";
import { canonicalTeamCode } from "@/engine/teams";
import type { Pos } from "@/engine/types";
import type { MatchCandidate, MatchInput, MatchPlayer, MatchResult } from "./types";

// Staged identity matcher (PLAN.md §6). Deterministic and auditable: a stage
// wins only with EXACTLY ONE candidate — two or more falls through, never
// guesses. Stage order: 0 PlayerAlias (user scope beats GLOBAL) → 1
// nameKey+pos+team → 2 nameKey+pos → 3 nameKey+team → 4 unique nameKey among
// active (suffix side-channel breaks Jr/Sr collisions) → 5 fuzzy Jaro-Winkler.
// DSTs resolve via stage 0 (282 seeded GLOBAL alias rows); no fuzzy for DSTs.

export interface MatchContext {
  userId: string;
}

/** Confidence is a UI signal graded by stage strength, not a probability. */
const CONFIDENCE: Record<string, number> = {
  ALIAS: 1,
  EXACT_FULL: 1,
  EXACT_POS: 0.95,
  EXACT_TEAM: 0.9,
  EXACT_NAME: 0.85,
};

const FUZZY_THRESHOLD = 0.92;
const FUZZY_MIN_GAP = 0.03;
const FUZZY_TOP_N = 5;

/** Jaro-Winkler similarity, implemented inline (no dependency — PLAN.md §6).
 * Standard parameters: scaling 0.1, prefix capped at 4. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const matchDist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(lb - 1, i + matchDist);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;

  // transpositions: matched chars out of order, counted raw then halved in-formula
  let transposed = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transposed++;
    k++;
  }

  const m = matches;
  const jaro = (m / la + m / lb + (m - transposed / 2) / m) / 3;

  let prefix = 0;
  const maxPrefix = Math.min(4, la, lb);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Matcher-internal view of one input: normalized once, up front. */
export interface PreparedInput {
  nameKey: string;
  suffix: string | null;
  team: string | null;
  pos: Pos | null;
}

export function prepareInput(input: MatchInput): PreparedInput {
  const { nameKey, suffix } = normalizeName(input.rawName);
  return { nameKey, suffix, team: canonicalTeamCode(input.team), pos: input.pos };
}

/** Stages 1-4 over the players sharing the input's nameKey. Pure — exported
 * for unit tests (the seeded DB has no suffixed collision pair to exercise
 * the side channel against). Returns null when every stage falls through. */
export function exactMatch(
  input: PreparedInput,
  candidates: readonly MatchPlayer[],
): MatchResult | null {
  const one = (list: readonly MatchPlayer[]): MatchPlayer | null =>
    list.length === 1 ? list[0] : null;

  if (input.pos !== null && input.team !== null) {
    const hit = one(candidates.filter((p) => p.pos === input.pos && p.team === input.team));
    if (hit) return { playerId: hit.id, matchMethod: "EXACT_FULL", confidence: CONFIDENCE.EXACT_FULL };
  }
  if (input.pos !== null) {
    const hit = one(candidates.filter((p) => p.pos === input.pos));
    if (hit) return { playerId: hit.id, matchMethod: "EXACT_POS", confidence: CONFIDENCE.EXACT_POS };
  }
  if (input.team !== null) {
    const hit = one(candidates.filter((p) => p.team === input.team));
    if (hit) return { playerId: hit.id, matchMethod: "EXACT_TEAM", confidence: CONFIDENCE.EXACT_TEAM };
  }

  const active = candidates.filter((p) => p.active);
  let hit = one(active);
  if (!hit && active.length >= 2) {
    // suffix side-channel: an input "Jr." uniquely picks the Jr. row of a
    // collision pair; a suffix-less input uniquely picks the suffix-less row
    hit = one(
      input.suffix !== null
        ? active.filter((p) => p.suffix === input.suffix)
        : active.filter((p) => !p.suffix),
    );
  }
  if (hit) return { playerId: hit.id, matchMethod: "EXACT_NAME", confidence: CONFIDENCE.EXACT_NAME };
  return null;
}

/** Stage 5 over a pool pre-sorted by playerId asc (determinism). Pure —
 * exported for unit tests. Accepts only a UNIQUE candidate at/above the
 * threshold whose lead over the runner-up is at least the minimum gap;
 * otherwise UNMATCHED carrying the top-5 candidates for the resolution UI. */
export function fuzzyMatch(input: PreparedInput, pool: readonly MatchPlayer[]): MatchResult {
  const scored = pool.map((p) => ({ p, score: jaroWinkler(input.nameKey, p.nameKey) }));
  scored.sort((x, y) => y.score - x.score || (x.p.id < y.p.id ? -1 : x.p.id > y.p.id ? 1 : 0));

  const aboveThreshold = scored.filter((x) => x.score >= FUZZY_THRESHOLD).length;
  const best = scored[0];
  const secondScore = scored[1]?.score ?? 0;
  if (best && aboveThreshold === 1 && best.score - secondScore >= FUZZY_MIN_GAP) {
    return { playerId: best.p.id, matchMethod: "FUZZY", confidence: best.score };
  }

  const candidates: MatchCandidate[] = scored.slice(0, FUZZY_TOP_N).map((x) => ({
    playerId: x.p.id,
    fullName: x.p.fullName,
    pos: x.p.pos,
    team: x.p.team,
    score: x.score,
  }));
  return { playerId: null, matchMethod: "UNMATCHED", confidence: null, candidates };
}

const PLAYER_SELECT = {
  id: true,
  fullName: true,
  nameKey: true,
  suffix: true,
  pos: true,
  nflTeam: true,
  active: true,
  isTeamDefense: true,
} as const;

type PlayerRow = {
  id: string;
  fullName: string;
  nameKey: string;
  suffix: string | null;
  pos: Pos;
  nflTeam: string | null;
  active: boolean;
  isTeamDefense: boolean;
};

function toMatchPlayer(row: PlayerRow): MatchPlayer {
  return {
    id: row.id,
    fullName: row.fullName,
    nameKey: row.nameKey,
    suffix: row.suffix,
    pos: row.pos,
    team: row.nflTeam,
    active: row.active,
    isTeamDefense: row.isTeamDefense,
  };
}

/** Batch matcher: ONE prefetch of alias rows + candidate players for the whole
 * input set (plus one lazy fetch of the active pool iff any row reaches the
 * fuzzy stage) — never per-row queries. Result array is index-aligned. */
export async function matchEntries(
  inputs: readonly MatchInput[],
  ctx: MatchContext,
): Promise<MatchResult[]> {
  const prepared = inputs.map(prepareInput);
  const keys = [...new Set(prepared.map((p) => p.nameKey).filter((k) => k.length > 0))];

  const [aliasRows, keyPlayerRows] =
    keys.length > 0
      ? await Promise.all([
          db.playerAlias.findMany({
            where: { aliasKey: { in: keys }, scope: { in: ["GLOBAL", ctx.userId] } },
            orderBy: { id: "asc" },
          }),
          db.player.findMany({
            where: { nameKey: { in: keys } },
            select: PLAYER_SELECT,
            orderBy: { id: "asc" },
          }),
        ])
      : [[], []];

  // GLOBAL first so a user-scoped alias overwrites it — user scope wins
  const aliasMap = new Map<string, string>();
  for (const a of aliasRows) if (a.scope === "GLOBAL") aliasMap.set(a.aliasKey, a.playerId);
  for (const a of aliasRows) if (a.scope === ctx.userId) aliasMap.set(a.aliasKey, a.playerId);

  const byKey = new Map<string, MatchPlayer[]>();
  for (const row of keyPlayerRows as PlayerRow[]) {
    const p = toMatchPlayer(row);
    const list = byKey.get(p.nameKey);
    if (list) list.push(p);
    else byKey.set(p.nameKey, [p]);
  }

  const results: (MatchResult | null)[] = prepared.map((prep) => {
    if (prep.nameKey.length === 0) {
      return { playerId: null, matchMethod: "UNMATCHED", confidence: null };
    }
    const aliased = aliasMap.get(prep.nameKey);
    if (aliased !== undefined) {
      return { playerId: aliased, matchMethod: "ALIAS", confidence: CONFIDENCE.ALIAS };
    }
    const exact = exactMatch(prep, byKey.get(prep.nameKey) ?? []);
    if (exact) return exact;
    if (prep.pos === "DEF") {
      // no fuzzy for DSTs (PLAN.md §6) — straight to the unmatched queue
      return { playerId: null, matchMethod: "UNMATCHED", confidence: null };
    }
    return null; // needs the fuzzy stage
  });

  if (results.some((r) => r === null)) {
    const poolRows = (await db.player.findMany({
      where: { active: true, isTeamDefense: false, pos: { not: "DEF" } },
      select: PLAYER_SELECT,
      orderBy: { id: "asc" },
    })) as PlayerRow[];
    const pool = poolRows.map(toMatchPlayer);
    const byPos = new Map<Pos, MatchPlayer[]>();
    for (const p of pool) {
      const list = byPos.get(p.pos);
      if (list) list.push(p);
      else byPos.set(p.pos, [p]);
    }
    for (let i = 0; i < results.length; i++) {
      if (results[i] !== null) continue;
      const prep = prepared[i];
      results[i] = fuzzyMatch(prep, prep.pos !== null ? (byPos.get(prep.pos) ?? []) : pool);
    }
  }

  return results as MatchResult[];
}

export async function matchEntry(input: MatchInput, ctx: MatchContext): Promise<MatchResult> {
  return (await matchEntries([input], ctx))[0];
}
