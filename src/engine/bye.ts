/** Bye table is injected per-season data (PLAN.md §4) — never hardcoded here.
 * Unknown/missing team codes (FA etc.) return null, matching legacy byeWeekFor (~356). */
export function byeWeekFor(team: string, byeWeeks: Record<string, number>): number | null {
  return byeWeeks[team] || null;
}
