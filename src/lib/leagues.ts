import { z } from "zod";
import type { FlexEligibility, Pos, RosterSpec } from "@/engine/types";
import { FLEX_ELIGIBLE_DEFAULT } from "@/engine/format";
import { totalRounds } from "@/engine/snake";

// League boundary schemas + shared types (PLAN.md §7 League.rosterSpec/scoring
// Json columns). Pure module — no "server-only" — because LeagueForm shares the
// types client-side and the vitest suite exercises the schemas directly.

export const CURRENT_SEASON = 2026;

export const posSchema = z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]);
export const flexPosSchema = z.enum(["QB", "RB", "WR", "TE"]);

/** Input caps match the legacy setup screen (draft-room.html ~230-241). */
export const rosterSpecSchema = z.object({
  QB: z.number().int().min(0).max(6),
  RB: z.number().int().min(0).max(6),
  WR: z.number().int().min(0).max(6),
  TE: z.number().int().min(0).max(6),
  FLEX: z.number().int().min(0).max(6),
  DEF: z.number().int().min(0).max(3),
  K: z.number().int().min(0).max(3),
  BN: z.number().int().min(0).max(15),
});

export const scoringConfigSchema = z.object({
  name: z.string(),
  weights: z.record(z.string(), z.number()),
  posWeights: z.partialRecord(posSchema, z.record(z.string(), z.number())).optional(),
});

export const leagueInputSchema = z
  .object({
    name: z.string().trim().min(1, "League name is required").max(80),
    numTeams: z.number().int().min(4).max(20),
    rosterSpec: rosterSpecSchema,
    flexEligibleBySlot: z.array(z.array(flexPosSchema).min(1, "Each FLEX slot needs at least one eligible position")),
    scoring: scoringConfigSchema,
    rankingSetId: z.string().min(1).nullish(),
  })
  .refine((i) => i.flexEligibleBySlot.length === i.rosterSpec.FLEX, {
    message: "One eligibility list per FLEX slot is required",
  })
  .refine((i) => totalRounds(i.rosterSpec) > 0, { message: "Roster has no slots" });

export type LeagueInput = z.infer<typeof leagueInputSchema>;

export type LeagueActionResult = { ok: true; id: string } | { ok: false; error: string };

export type CreateSessionResult =
  | { ok: true; sessionId: string; skippedEntries: number }
  | { ok: false; error: string };

export interface RankingSetOption {
  id: string;
  name: string;
  version: number;
  dataTier: "RANK_ONLY" | "POINTS" | "FULL_STATS";
  formatTag: string;
  seasonYear: number;
}

export const DATA_TIER_LABELS: Record<RankingSetOption["dataTier"], string> = {
  RANK_ONLY: "ranks only",
  POINTS: "season points",
  FULL_STATS: "stat projections",
};

export const DEFAULT_NUM_TEAMS = 10;

export const DEFAULT_ROSTER_SPEC: RosterSpec = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  DEF: 1,
  K: 1,
  BN: 6,
};

// Stored rows may predate flexEligibleBySlot living inside the Json (dev
// harness leagues) — tolerate its absence, then reconcile to FLEX count.
const storedRosterSpecSchema = rosterSpecSchema.extend({
  flexEligibleBySlot: z.array(z.array(flexPosSchema)).optional(),
});

/** League.rosterSpec Json → engine shapes; null when unreadable. The
 * eligibility list is padded/truncated to exactly spec.FLEX entries. */
export function readLeagueRosterSpec(
  json: unknown,
): { spec: RosterSpec; flexEligibleBySlot: FlexEligibility } | null {
  const parsed = storedRosterSpecSchema.safeParse(json);
  if (!parsed.success) return null;
  const { flexEligibleBySlot: raw = [], ...spec } = parsed.data;
  const flexEligibleBySlot: FlexEligibility = Array.from({ length: spec.FLEX }, (_, i) => {
    const list = raw[i];
    return list && list.length > 0 ? (list as Pos[]) : [...FLEX_ELIGIBLE_DEFAULT];
  });
  return { spec, flexEligibleBySlot };
}
