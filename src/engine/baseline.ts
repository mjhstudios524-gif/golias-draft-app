import type { BaselineOptions, BaselineResult, FlexEligibility, Pos, RosterSpec, StarterDemand } from "./types";

// PLAN.md §5: baselines from roster shape via greedy flex simulation. This is
// where superflex QB inflation becomes emergent — a QB-eligible flex slot hands
// its seats to QB13+ because they outscore the remaining RB/WR pool, dropping
// the QB baseline toward QB24 with zero format-specific code.

export const BETA_1QB: Record<Pos, number> = { QB: 0.7, RB: 2.6, WR: 2.6, TE: 0.7, K: 0, DEF: 0 };
export const BETA_MULTI_QB: Record<Pos, number> = { QB: 2.0, RB: 2.2, WR: 2.2, TE: 0.6, K: 0, DEF: 0 };

const ALL_POS: Pos[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Per-position projected points sorted DESCENDING. */
export type PointsByPos = Record<Pos, number[]>;

/**
 * Starter demand: dedicated slots (teams × spec[pos]) plus a greedy simulation
 * of every FLEX seat. Distinct flex slots process most-restrictive-first
 * (smallest eligibility set; ties keep config order); each of the `numTeams`
 * copies of a slot goes to the position whose next unconsumed player projects
 * highest, skipping exhausted pools.
 */
export function computeStarterDemand(
  byPos: PointsByPos,
  numTeams: number,
  spec: RosterSpec,
  flexEligibleBySlot: FlexEligibility,
): StarterDemand {
  const demand = {} as StarterDemand;
  const cursor = {} as Record<Pos, number>;
  ALL_POS.forEach((pos) => {
    demand[pos] = numTeams * (spec[pos as keyof RosterSpec] as number ?? 0);
    cursor[pos] = demand[pos];
  });

  const slots = (flexEligibleBySlot || [])
    .map((eligible, i) => ({ eligible, i }))
    .sort((a, b) => a.eligible.length - b.eligible.length || a.i - b.i);

  for (const slot of slots) {
    for (let t = 0; t < numTeams; t++) {
      let best: Pos | null = null;
      let bestPts = -Infinity;
      for (const pos of slot.eligible) {
        const pts = byPos[pos]?.[cursor[pos]];
        if (pts != null && pts > bestPts) {
          bestPts = pts;
          best = pos;
        }
      }
      if (best == null) continue; // every eligible pool exhausted
      cursor[best]++;
      demand[best]++;
    }
  }
  return demand;
}

/**
 * Baseline flavor: one λ knob interpolating VOLS (λ=0, value over last starter)
 * → VORP (λ=1, over last realistically-drafted via bench-propensity β).
 * benchTarget[pos] = teams × β[pos] × (benchSlots / Σβ). Index clamped to the
 * pool (min 1); clamped positions are reported, not silently absorbed.
 */
export function computeBaselines(
  byPos: PointsByPos,
  demand: StarterDemand,
  opts: BaselineOptions & { numTeams: number; benchSlots: number },
): BaselineResult & { clamped: Pos[] } {
  const sumBeta = ALL_POS.reduce((a, p) => a + (opts.beta[p] ?? 0), 0);
  const baselineIndex = {} as Record<Pos, number>;
  const baselinePoints = {} as Record<Pos, number>;
  const clamped: Pos[] = [];

  ALL_POS.forEach((pos) => {
    const poolList = byPos[pos] ?? [];
    const benchTarget = sumBeta > 0 ? opts.numTeams * (opts.beta[pos] ?? 0) * (opts.benchSlots / sumBeta) : 0;
    let idx = Math.round(demand[pos] + opts.lambda * benchTarget);
    if (idx < 1) idx = 1;
    if (poolList.length === 0) {
      baselineIndex[pos] = 0;
      baselinePoints[pos] = 0;
      return;
    }
    if (idx > poolList.length) {
      idx = poolList.length;
      clamped.push(pos);
    }
    baselineIndex[pos] = idx;
    baselinePoints[pos] = poolList[idx - 1];
  });

  return { demand, baselineIndex, baselinePoints, clamped };
}
