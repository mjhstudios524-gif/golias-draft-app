import type { FlexEligibility, LeagueFormat, Pos, RosterSpec } from "./types";

export const FLEX_ELIGIBLE_DEFAULT: Pos[] = ["RB", "WR", "TE"];

// Legacy isSuperflexFormat (~411), demoted to metadata (PLAN.md §5): selects the
// multi-QB bench-propensity vector and drives the ADP-nulling rule.
export function leagueFormat(spec: RosterSpec, flexEligibleBySlot: FlexEligibility): LeagueFormat {
  if (spec.QB >= 2) return "MULTI_QB";
  return (flexEligibleBySlot || []).some((list) => list && list.includes("QB")) ? "MULTI_QB" : "1QB";
}

/** Union of all FLEX slots' eligibility; empty → default RB/WR/TE. Ordered QB,RB,WR,TE. Legacy ~1093. */
export function flexEligibleUnion(flexEligibleBySlot: FlexEligibility): Pos[] {
  const union = new Set<Pos>();
  (flexEligibleBySlot || []).forEach((list) => list.forEach((p) => union.add(p)));
  if (union.size === 0) FLEX_ELIGIBLE_DEFAULT.forEach((p) => union.add(p));
  return (["QB", "RB", "WR", "TE"] as Pos[]).filter((p) => union.has(p));
}
