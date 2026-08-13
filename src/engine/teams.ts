/** One alias map applied at every ingestion boundary (CSV, providers, legacy
 * fixtures) so the engine and DB only ever see canonical codes (PLAN.md §4).
 * Canonical codes are Sleeper's. */
export const TEAM_ALIASES: Record<string, string> = {
  ARZ: "ARI",
  BLT: "BAL",
  HST: "HOU",
  CLV: "CLE",
  LA: "LAR",
  JAC: "JAX",
  WSH: "WAS",
  GNB: "GB",
  KAN: "KC",
  NOR: "NO",
  NWE: "NE",
  SFO: "SF",
  TAM: "TB",
  LVR: "LV",
  OAK: "LV",
  SD: "LAC",
  STL: "LAR",
};

const FREE_AGENT_CODES = new Set(["FA", "INA", ""]);

/** Canonical team code, or null for free agents / unknown-team markers. */
export function canonicalTeamCode(code: string | null | undefined): string | null {
  if (code == null) return null;
  const upper = code.trim().toUpperCase();
  if (FREE_AGENT_CODES.has(upper)) return null;
  return TEAM_ALIASES[upper] ?? upper;
}
