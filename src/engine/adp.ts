import type { AdpContext, EnginePlayer, LeagueFormat } from "./types";

// Legacy source: draft-room.html ~358-375 and adpCellHtml ~1294.

/**
 * The generalized FTN rule (PLAN.md §5): a QB's ADP is meaningless when it was
 * measured in a 1QB market but the league is multi-QB. UNKNOWN sources are
 * treated as 1QB, preserving the legacy default.
 */
export function effectiveAdp(
  p: EnginePlayer | null | undefined,
  sourceContext: AdpContext,
  league: LeagueFormat,
): number | null {
  if (!p || p.adp == null) return null;
  if (p.pos === "QB" && sourceContext !== "SF" && league === "MULTI_QB") return null;
  return p.adp;
}

/**
 * Rough chance a player is still on the board at `atOverall`. Logistic centred
 * on ADP with a spread that widens for later picks: sigma = max(6, 0.18·adp),
 * slope 1.7. Exactly 0.5 when atOverall === adp.
 */
export function survivalProb(
  p: EnginePlayer | null | undefined,
  atOverall: number | null,
  sourceContext: AdpContext,
  league: LeagueFormat,
): number | null {
  const a = effectiveAdp(p, sourceContext, league);
  if (a == null || atOverall == null) return null;
  const sigma = Math.max(6, 0.18 * a);
  return 1 / (1 + Math.exp((-1.7 * (a - atOverall)) / sigma));
}

export type AdpSignal = "na" | "superflex-qb" | "value" | "reach" | "neutral";

/** Pure classifier behind the legacy ADP cell coloring (adpCellHtml ~1294):
 * green when the market lets him fall ≥20 past his rank, amber when taken ≥20 early. */
export function adpSignal(p: EnginePlayer, sourceContext: AdpContext, league: LeagueFormat): AdpSignal {
  if (p.adp == null) return "na";
  if (effectiveAdp(p, sourceContext, league) == null) return "superflex-qb";
  const d = p.adp - p.rank;
  if (d >= 20) return "value";
  if (d <= -20) return "reach";
  return "neutral";
}
