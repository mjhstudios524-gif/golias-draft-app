import type { EnginePlayer, PlayerId, Pos } from "./types";

export const TIER_MAX: Record<Pos, number> = { QB: 6, RB: 8, WR: 8, TE: 6, DEF: 6, K: 6 };

export interface TierOptions {
  /** Ascending metric the gaps run on. Default p.rank — the overall ordinal,
   * which in VBD mode already IS valueRank (PLAN.md §5). */
  metric?: (p: EnginePlayer) => number;
  caps?: Record<string, number>;
  /** Absolute gap floor inside max(floor, med*2). Legacy: 2 rank-steps. */
  gapFloor?: number;
}

/**
 * Adaptive positional tiering, generalized from legacy computeTiers (~381):
 * per position, sorted by metric ascending, a tier breaks where the gap to the
 * next player is >= max(gapFloor, 2 × local upper-median of gaps) — the window
 * is gaps[i-5 .. i+4) so the current gap sits inside its own window — or when
 * the per-position size cap is hit. Returns a Map instead of mutating players
 * (behavior-change register #4); tier numbers are identical to legacy.
 */
export function computeTiers(players: EnginePlayer[], opts: TierOptions = {}): Map<PlayerId, number> {
  const metric = opts.metric ?? ((p: EnginePlayer) => p.rank);
  const caps: Record<string, number> = opts.caps ?? TIER_MAX;
  const gapFloor = opts.gapFloor ?? 2;

  const out = new Map<PlayerId, number>();
  const byPos = new Map<string, EnginePlayer[]>();
  players.forEach((p) => {
    const list = byPos.get(p.pos);
    if (list) list.push(p);
    else byPos.set(p.pos, [p]);
  });

  byPos.forEach((posList, pos) => {
    const list = posList.slice().sort((a, b) => metric(a) - metric(b));
    if (list.length === 0) return;
    const gaps: number[] = [];
    for (let i = 1; i < list.length; i++) gaps.push(metric(list[i]) - metric(list[i - 1]));
    const cap = caps[pos] || 8;
    out.set(list[0].id, 1);
    let tier = 1,
      sizeInTier = 1;
    for (let i = 1; i < list.length; i++) {
      const g = gaps[i - 1];
      const lo = Math.max(0, i - 5),
        hi = Math.min(gaps.length, i + 4);
      const win = gaps.slice(lo, hi).slice().sort((a, b) => a - b);
      // Legacy's `win.length ? ... : g` fallback is unreachable for i>=1; preserved anyway.
      const med = win.length ? win[Math.floor(win.length / 2)] : g;
      const thr = Math.max(gapFloor, med * 2);
      if (g >= thr || sizeInTier >= cap) {
        tier++;
        sizeInTier = 0;
      }
      out.set(list[i].id, tier);
      sizeInTier++;
    }
  });

  return out;
}

/** Count of available players sharing `player`'s position and tier. Legacy ~700. */
export function tierRemaining(
  player: EnginePlayer,
  available: EnginePlayer[],
  tiers: ReadonlyMap<PlayerId, number>,
): number {
  const t = tiers.get(player.id);
  return available.filter((p) => p.pos === player.pos && tiers.get(p.id) === t).length;
}
