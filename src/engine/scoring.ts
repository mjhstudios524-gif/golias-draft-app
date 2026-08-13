import type { Pos, ScoringConfig, StatLine } from "./types";

// PLAN.md §5: canonical stat vocabulary = Sleeper scoring_settings keys, so
// Sleeper import is a filtered pass-through and CSV projections share the keys.

export function pointsFor(stat: StatLine, cfg: ScoringConfig, pos: Pos): number {
  let pts = 0;
  for (const k in stat) {
    const v = stat[k];
    if (v == null) continue;
    pts += v * ((cfg.weights[k] ?? 0) + (cfg.posWeights?.[pos]?.[k] ?? 0));
  }
  return pts;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Sleeper scoring_settings → ScoringConfig: copy every nonzero key (rounded to
 * 4dp — live values carry IEEE float noise like 0.10000000149011612), relocate
 * bonus_rec_te into posWeights.TE.rec (it is a per-TE-reception bonus). Unknown
 * keys are preserved, never dropped.
 */
export function sleeperScoringToConfig(
  scoringSettings: Record<string, number>,
  name = "Imported from Sleeper",
): ScoringConfig {
  const weights: Record<string, number> = {};
  let teRecBonus = 0;
  for (const [k, v] of Object.entries(scoringSettings)) {
    if (v == null || v === 0) continue;
    if (k === "bonus_rec_te") {
      teRecBonus = round4(v);
      continue;
    }
    weights[k] = round4(v);
  }
  const cfg: ScoringConfig = { name, weights };
  if (teRecBonus !== 0) cfg.posWeights = { TE: { rec: teRecBonus } };
  return cfg;
}

const BASE_OFFENSE = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  pass_2pt: 2,
  rush_yd: 0.1,
  rush_td: 6,
  rush_2pt: 2,
  rec_yd: 0.1,
  rec_td: 6,
  rec_2pt: 2,
  fum_lost: -2,
};

export const SCORING_PRESETS: Record<string, ScoringConfig> = {
  standard: { name: "Standard (non-PPR)", weights: { ...BASE_OFFENSE } },
  halfPpr: { name: "Half PPR", weights: { ...BASE_OFFENSE, rec: 0.5 } },
  fullPpr: { name: "Full PPR", weights: { ...BASE_OFFENSE, rec: 1 } },
  tePremium: {
    name: "Half PPR + TE Premium",
    weights: { ...BASE_OFFENSE, rec: 0.5 },
    posWeights: { TE: { rec: 0.5 } },
  },
  sixPtPassTd: { name: "Half PPR, 6pt Pass TD", weights: { ...BASE_OFFENSE, rec: 0.5, pass_td: 6 } },
};
