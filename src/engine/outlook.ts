import type { AdpContext, EnginePlayer, LeagueFormat, PositionOutlook, Pos } from "./types";
import { survivalProb } from "./adp";

export interface OutlookCtx {
  adpContext: AdpContext;
  league: LeagueFormat;
}

/**
 * Legacy positionOutlook (~706). `next` = best available at pos with
 * better-than-even survival odds at the caller's next pick. The legacy
 * `(survivalProb(p, nextPick) || 0) >= 0.5` null-coercion is load-bearing:
 * players with no usable ADP (all K/DEF, format-nulled QBs, unranked) always
 * fail the threshold and fall to the rank-order fallback, which assumes the
 * top `gone` available players (of ANY position) are off the board. drop = 80
 * sentinel when no successor exists at all.
 */
export function positionOutlook(
  pos: Pos,
  available: EnginePlayer[],
  gone: number,
  nextPick: number | null,
  ctx: OutlookCtx,
): PositionOutlook {
  const now = available.find((p) => p.pos === pos) ?? null;
  if (!now) return { now: null, next: null, drop: 0 };
  let next: EnginePlayer | null = null;
  if (nextPick != null) {
    next =
      available.find(
        (p) => p.pos === pos && (survivalProb(p, nextPick, ctx.adpContext, ctx.league) || 0) >= 0.5,
      ) ?? null;
  }
  if (!next) {
    next = available.slice(Math.max(0, gone)).find((p) => p.pos === pos) ?? null;
  }
  const drop = next ? next.rank - now.rank : 80;
  return { now, next, drop };
}
