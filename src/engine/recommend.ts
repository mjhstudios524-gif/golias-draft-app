import type {
  DraftState,
  PlayerPool,
  Pos,
  PositionOutlook,
  Reason,
  Recommendation,
} from "./types";
import { isOnClock, nextPickFor, picksUntilTurn } from "./snake";
import { availableSorted, draftedIdSet } from "./pool";
import { computeTeamNeeds, starterByeCounts } from "./roster";
import { positionOutlook } from "./outlook";
import { effectiveAdp, survivalProb } from "./adp";
import { tierRemaining } from "./tiers";
import { byeWeekFor } from "./bye";
import { leagueFormat } from "./format";

// Legacy source: draft-room.html ~737-814. Every constant and rule is pinned:
// need-filtered pool with allowed-position toggles and fallback, top-45 scoring
// cap, score = -rank + 0.55·drop (+7/+3 tier, -4 bye, ±5 survival), stable sort,
// max 2 per position, top 5, reasons in fixed priority order (first 2 kept).

/** Reproduces the legacy reason strings verbatim (golden-compared). Number
 * interpolation matches JS template semantics: 35.7 → "35.7", 4 → "4". */
export function formatReason(r: Reason): string {
  switch (r.code) {
    case "BEST_OVERALL":
      return "Best available overall";
    case "GONE_SOON":
      return `ADP ${r.adp} - gone before your next pick`;
    case "BIG_DROP":
      return `Big drop-off at ${r.pos} after him`;
    case "THINS_OUT":
      return `${r.pos} thins out before your next pick`;
    case "TIER_LAST_FEW":
      return `Only ${r.n} left in this ${r.pos} tier`;
    case "TIER_FEW":
      return `${r.n} left in this ${r.pos} tier`;
    case "WILL_WAIT":
      return `ADP ${r.adp} - should still be here next turn`;
    case "FALLING":
      return `going ~${r.picksLater} picks later than his rank`;
    case "BYE_STACK":
      return `stacks your Week ${r.bye} bye`;
    case "STRONG_VALUE":
      return `Strong value at ${r.pos}`;
  }
}

export function computeRecommendations(state: DraftState, pool: PlayerPool): Recommendation[] {
  const config = state.config;
  if (!isOnClock(state, config.myTeamId)) return [];
  const available = availableSorted(pool, draftedIdSet(state.picks));
  if (available.length === 0) return [];

  const allowedPos = new Set<Pos>(state.recPos);
  const allowedAvail = available.filter((p) => allowedPos.has(p.pos));
  if (allowedAvail.length === 0) return [];

  const { neededPositions } = computeTeamNeeds(state, pool, config.myTeamId);
  let candidates =
    neededPositions.size > 0 ? allowedAvail.filter((p) => neededPositions.has(p.pos)) : allowedAvail.slice();
  if (candidates.length === 0) candidates = allowedAvail.slice();

  const goneRaw = picksUntilTurn(state, config.myTeamId);
  const gone = goneRaw == null ? 0 : goneRaw;
  const nextPick = nextPickFor(state, config.myTeamId);

  const league = leagueFormat(config.rosterSpec, config.flexEligibleBySlot);
  const ctx = { adpContext: config.adpContext, league };

  const posInfo = new Map<Pos, PositionOutlook>();
  candidates.forEach((p) => {
    if (!posInfo.has(p.pos)) posInfo.set(p.pos, positionOutlook(p.pos, available, gone, nextPick, ctx));
  });

  const bestOverallRank = available[0].rank;
  const myByes = starterByeCounts(state, pool, config.myTeamId);

  const scored = candidates.slice(0, 45).map((p) => {
    const info = posInfo.get(p.pos) ?? { now: null, next: null, drop: 0 };
    const tierLeft = tierRemaining(p, available, pool.tiers);
    const bye = byeWeekFor(p.team, config.byeWeeks);
    const byeClash = !!(bye && (myByes[bye] || 0) >= 2);
    const surv = survivalProb(p, nextPick, ctx.adpContext, ctx.league);
    const adp = effectiveAdp(p, ctx.adpContext, ctx.league);

    const base = -p.rank;
    const dropTerm = 0.55 * info.drop;
    const tierBonus = tierLeft <= 2 ? 7 : tierLeft <= 4 ? 3 : 0;
    const byePenalty = byeClash ? -4 : 0;
    const survivalNudge = surv != null ? (surv >= 0.75 ? -5 : surv <= 0.25 ? 5 : 0) : 0;
    const score = base + dropTerm + tierBonus + byePenalty + survivalNudge;

    return {
      player: p,
      score,
      scoreBreakdown: { base, drop: dropTerm, tierBonus, byePenalty, survivalNudge },
      drop: info.drop,
      next: info.next,
      tierLeft,
      bye,
      byeClash,
      surv,
      adp,
      reasons: [] as Reason[],
      reason: "",
    };
  });
  // Array.prototype.sort is stable — score ties keep rank order (pinned).
  scored.sort((a, b) => b.score - a.score);

  const out: Recommendation[] = [];
  const perPos: Partial<Record<Pos, number>> = {};
  for (const s of scored) {
    const c = perPos[s.player.pos] || 0;
    if (c >= 2) continue;
    perPos[s.player.pos] = c + 1;
    out.push(s);
    if (out.length >= 5) break;
  }

  out.forEach((s) => {
    const reasons: Reason[] = [];
    if (s.player.rank === bestOverallRank) reasons.push({ code: "BEST_OVERALL" });
    if (s.surv != null && s.surv <= 0.25) reasons.push({ code: "GONE_SOON", adp: s.adp! });
    if (s.drop >= 25) reasons.push({ code: "BIG_DROP", pos: s.player.pos });
    else if (s.drop >= 12) reasons.push({ code: "THINS_OUT", pos: s.player.pos });
    if (s.tierLeft <= 2) reasons.push({ code: "TIER_LAST_FEW", n: s.tierLeft, pos: s.player.pos });
    else if (s.tierLeft <= 4) reasons.push({ code: "TIER_FEW", n: s.tierLeft, pos: s.player.pos });
    if (s.surv != null && s.surv >= 0.75) reasons.push({ code: "WILL_WAIT", adp: s.adp! });
    if (s.adp != null && s.adp - s.player.rank >= 25)
      reasons.push({ code: "FALLING", picksLater: Math.round(s.adp - s.player.rank) });
    if (s.byeClash) reasons.push({ code: "BYE_STACK", bye: s.bye! });
    if (reasons.length === 0) reasons.push({ code: "STRONG_VALUE", pos: s.player.pos });
    s.reasons = reasons;
    s.reason = reasons.slice(0, 2).map(formatReason).join(" · ");
  });

  return out;
}
