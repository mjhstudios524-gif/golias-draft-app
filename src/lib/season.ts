// Season window (PLAN.md §9, decision §14 #3): the product is the LEAGUE year —
// purchases Mar 1 of year Y through end of Feb of Y+1 all map to 'season-Y',
// expiring Mar 1 of Y+1. Late-Feb buyers therefore get the season that is
// actually being drafted/played, not a sliver of the outgoing one.
// Pure module (no "server-only"): shared by server code and unit tests.

export interface SeasonInfo {
  /** Entitlement.product key, e.g. 'season-2026' */
  product: string;
  seasonYear: number;
  /** Mar 1 of the following league year, 00:00:00 UTC */
  expiresAt: Date;
}

/** Boundaries are computed in UTC so the rollover instant is deterministic. */
export function currentSeason(now: Date): SeasonInfo {
  const year = now.getUTCFullYear();
  // getUTCMonth is 0-indexed: 2 = March. Jan/Feb belong to the prior league year.
  const seasonYear = now.getUTCMonth() >= 2 ? year : year - 1;
  return {
    product: `season-${seasonYear}`,
    seasonYear,
    expiresAt: new Date(Date.UTC(seasonYear + 1, 2, 1)),
  };
}
