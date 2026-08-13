// Shared rankings-ingestion contracts (PLAN.md §6). NO "server-only" here:
// the client cluster imports these types (and mirrors the match pipeline for
// preview match rates), so this module must stay importable from the browser.

import type { Pos } from "@/engine/types";

/** One CSV row after client-side parse + column mapping, pre-matching.
 * `name` is the cleaned display name the mapper extracted (adornments like
 * embedded team/pos stripped); `rawName` is the untouched source cell.
 * Matching and alias memory key off `name` — identically on client preview
 * and server authoritative — so the two can never disagree. */
export interface NormalizedRow {
  sourceRow: number;
  rawName: string;
  name: string;
  /** canonical team code (via canonicalTeamCode) or null */
  team: string | null;
  pos: Pos | null;
  rank: number | null;
  posRank: number | null;
  adp: number | null;
  byeWeek: number | null;
  projPoints: number | null;
  stats: Record<string, number> | null;
}

/** Stage attribution for the audit trail (PLAN.md §6 match pipeline).
 * MANUAL/UNLINKED are assigned by the resolution workflow, never the matcher. */
export type MatchMethod =
  | "ALIAS"
  | "EXACT_FULL"
  | "EXACT_POS"
  | "EXACT_TEAM"
  | "EXACT_NAME"
  | "FUZZY"
  | "UNMATCHED";

export interface MatchInput {
  rawName: string;
  /** canonical team code or null (defensively re-canonicalized by the matcher) */
  team: string | null;
  pos: Pos | null;
}

/** Slim Player projection the matcher operates on (also the shape served by
 * GET /api/players/index for client-side preview matching). */
export interface MatchPlayer {
  id: string;
  fullName: string;
  nameKey: string;
  suffix: string | null;
  pos: Pos;
  team: string | null;
  active: boolean;
  isTeamDefense: boolean;
}

/** Fuzzy suggestion for the manual-resolution UI. */
export interface MatchCandidate {
  playerId: string;
  fullName: string;
  pos: Pos;
  team: string | null;
  score: number;
}

export interface MatchResult {
  playerId: string | null;
  matchMethod: MatchMethod;
  confidence: number | null;
  /** top-5 fuzzy candidates, present only when UNMATCHED and fuzzy ran
   * (never for DSTs — no fuzzy for DSTs per PLAN.md §6) */
  candidates?: MatchCandidate[];
}
