/* eslint-disable */
// VERBATIM reference copy of the pure domain logic from the legacy
// GOLIAS-Draft-Tool/draft-room.html (~lines 342-1391). This module is the
// executable spec for the golden-master suite (PLAN.md §4) and is DELETED
// after port sign-off. The only permitted edits are mechanical:
//   - module-level globals (state, PLAYERS_RAW, playersById) -> closure params
//   - Math.random() -> injected rng()
//   - DOM / localStorage / render calls removed
// Do NOT "improve" anything here. Behavior bugs in the original are pinned
// on purpose (see PLAN.md §4 behavior-change register for the ones fixed in
// the real port).

"use strict";

const PRIMARY_POS = ["QB", "RB", "WR", "TE", "DEF", "K"];
const FLEX_ELIGIBLE = ["RB", "WR", "TE"];

// 2026 NFL bye weeks with the FTN alias codes, verbatim (source ~352).
const BYE_WEEKS = {
  CAR: 5, KC: 5, CIN: 6, DET: 6, MIA: 6, MIN: 6, BUF: 7, JAX: 7, LAC: 7, WAS: 7,
  HOU: 8, HST: 8, NO: 8, NYG: 8, SF: 8, PIT: 9, TEN: 9, CHI: 10, DEN: 10, PHI: 10, TB: 10,
  ATL: 11, CLE: 11, GB: 11, LAR: 11, LA: 11, NE: 11, SEA: 11,
  BAL: 13, BLT: 13, IND: 13, LV: 13, NYJ: 13, ARI: 14, ARZ: 14, DAL: 14,
};
function byeWeekFor(team) {
  return BYE_WEEKS[team] || null;
}

const TIER_MAX = { QB: 6, RB: 8, WR: 8, TE: 6, DEF: 6, K: 6 };

function isSuperflexFormat(spec, flexEligibleBySlot) {
  if (spec.QB >= 2) return true;
  return (flexEligibleBySlot || []).some((list) => list && list.includes("QB"));
}

/**
 * @param {Array<{id:number,name:string,team:string,pos:string,rank:number,adp:number|null}>} playersRawInput
 *   the active ranking list (fixtures/players.superflex.json or players.standard.json)
 * @param {{numTeams:number, teamOrder:number[], teamNames:Object, rosterSpec:Object,
 *          flexEligibleBySlot:string[][], myTeamId:number, rankingSet:'superflex'|'standard',
 *          mockDraft:boolean}} config
 * @param {() => number} rng   replaces Math.random
 */
function createLegacyEngine(playersRawInput, config, rng) {
  // deep-copy: computeTiers mutates player objects (pinned legacy behavior)
  const PLAYERS_RAW = playersRawInput.map((p) => ({ ...p }));

  let state = { config, picks: [], queue: [], recPos: PRIMARY_POS.slice() };

  // ---------------- ADP / survival (source ~358-375) ----------------
  function effectiveAdp(p) {
    if (!p || p.adp == null) return null;
    if (p.pos === "QB" && state && state.config && state.config.rankingSet === "superflex") return null;
    return p.adp;
  }

  function survivalProb(p, atOverall) {
    const a = effectiveAdp(p);
    if (a == null || atOverall == null) return null;
    const sigma = Math.max(6, 0.18 * a);
    return 1 / (1 + Math.exp((-1.7 * (a - atOverall)) / sigma));
  }

  // ---------------- Tiers (source ~381-404) ----------------
  function computeTiers() {
    const byPos = {};
    PLAYERS_RAW.forEach((p) => {
      (byPos[p.pos] = byPos[p.pos] || []).push(p);
    });
    Object.keys(byPos).forEach((pos) => {
      const list = byPos[pos].slice().sort((a, b) => a.rank - b.rank);
      if (list.length === 0) return;
      const gaps = [];
      for (let i = 1; i < list.length; i++) gaps.push(list[i].rank - list[i - 1].rank);
      const cap = TIER_MAX[pos] || 8;
      list[0].tier = 1;
      let tier = 1,
        sizeInTier = 1;
      for (let i = 1; i < list.length; i++) {
        const g = gaps[i - 1];
        const lo = Math.max(0, i - 5),
          hi = Math.min(gaps.length, i + 4);
        const win = gaps.slice(lo, hi).slice().sort((a, b) => a - b);
        const med = win.length ? win[Math.floor(win.length / 2)] : g;
        const thr = Math.max(2, med * 2);
        if (g >= thr || sizeInTier >= cap) {
          tier++;
          sizeInTier = 0;
        }
        list[i].tier = tier;
        sizeInTier++;
      }
    });
  }

  // ---------------- Player lookup (source ~1063-1070) ----------------
  let playersById = {};
  function buildPlayersById() {
    playersById = {};
    PLAYERS_RAW.forEach((p) => {
      playersById[p.id] = p;
    });
    computeTiers();
  }
  buildPlayersById();
  function playerById(id) {
    return playersById[id];
  }

  // ---------------- Draft engine (source ~604-659) ----------------
  function totalRounds() {
    const s = state.config.rosterSpec;
    return s.QB + s.RB + s.WR + s.TE + s.FLEX + s.DEF + s.K + s.BN;
  }
  function totalPicksInDraft() {
    return totalRounds() * state.config.numTeams;
  }

  function pickTeamForOverall(overall) {
    const n = state.config.numTeams;
    const round = Math.ceil(overall / n);
    const pickInRound = overall - (round - 1) * n;
    const order = state.config.teamOrder;
    const teamId = round % 2 === 1 ? order[pickInRound - 1] : order[n - pickInRound];
    return { round, pickInRound, teamId };
  }

  function currentOverall() {
    return state.picks.length + 1;
  }

  function draftedIdSet() {
    return new Set(state.picks.map((p) => p.playerId));
  }

  function draftPlayer(playerId, opts) {
    const silent = opts && opts.silent;
    const overall = currentOverall();
    if (overall > totalPicksInDraft()) return;
    const { round, pickInRound, teamId } = pickTeamForOverall(overall);
    state.picks.push({ overall, round, pickInRound, teamId, playerId });
    if (silent) return;
    if (state.config.mockDraft) runMockAutoPicks();
  }

  function undoPick() {
    if (state.picks.length === 0) return;
    if (state.config.mockDraft) {
      let removedUserPick = false;
      while (state.picks.length > 0 && !removedUserPick) {
        const p = state.picks.pop();
        if (p.teamId === state.config.myTeamId) removedUserPick = true;
      }
    } else {
      state.picks.pop();
    }
  }

  function resetDraft() {
    state.picks = [];
    if (state.config.mockDraft) runMockAutoPicks();
  }

  // ---------------- Team needs (source ~662-673) ----------------
  function computeTeamNeeds(teamId) {
    const { slots } = assignRosterSlots(teamId);
    const openSlots = slots.filter((s) => !s.player);
    const neededPositions = new Set();
    let bnOpen = false;
    openSlots.forEach((s) => {
      if (s.type === "BN") {
        bnOpen = true;
        return;
      }
      if (s.type === "FLEX") {
        (s.eligible || FLEX_ELIGIBLE).forEach((p) => neededPositions.add(p));
      } else neededPositions.add(s.type);
    });
    return { neededPositions, bnOpen };
  }

  // ---------------- Draft timing helpers (source ~676-692) ----------------
  function myNextPickOverall() {
    const cur = currentOverall(),
      total = totalPicksInDraft();
    if (cur > total) return null;
    const start = isMyClock() ? cur + 1 : cur;
    for (let o = start; o <= total; o++) {
      if (pickTeamForOverall(o).teamId === state.config.myTeamId) return o;
    }
    return null;
  }

  function picksBeforeMyNextTurn() {
    const cur = currentOverall();
    const nxt = myNextPickOverall();
    if (nxt == null) return null;
    return isMyClock() ? nxt - cur - 1 : nxt - cur;
  }

  // ---------------- Scarcity helpers (source ~695-731) ----------------
  function availableSortedByRank() {
    const drafted = draftedIdSet();
    return PLAYERS_RAW.filter((p) => !drafted.has(p.id)).sort((a, b) => a.rank - b.rank);
  }

  function tierRemaining(player, available) {
    return available.filter((p) => p.pos === player.pos && p.tier === player.tier).length;
  }

  function positionOutlook(pos, available, gone, nextPick) {
    const now = available.find((p) => p.pos === pos);
    if (!now) return { now: null, next: null, drop: 0 };
    let next = null;
    if (nextPick != null) {
      next = available.find((p) => p.pos === pos && (survivalProb(p, nextPick) || 0) >= 0.5) || null;
    }
    if (!next) {
      next = available.slice(Math.max(0, gone)).find((p) => p.pos === pos) || null;
    }
    const drop = next ? next.rank - now.rank : 80;
    return { now, next, drop };
  }

  function starterByeCounts(teamId) {
    const { slots } = assignRosterSlots(teamId);
    const counts = {};
    slots.forEach((s) => {
      if (!s.player || s.type === "BN") return;
      const b = byeWeekFor(s.player.team);
      if (b) counts[b] = (counts[b] || 0) + 1;
    });
    return counts;
  }

  // ---------------- Recommendations (source ~737-814) ----------------
  function computeRecommendations() {
    if (!state || !isMyClock()) return [];
    const available = availableSortedByRank();
    if (available.length === 0) return [];

    const allowedPos = new Set(state.recPos || PRIMARY_POS);
    const allowedAvail = available.filter((p) => allowedPos.has(p.pos));
    if (allowedAvail.length === 0) return [];

    const { neededPositions } = computeTeamNeeds(state.config.myTeamId);
    let pool =
      neededPositions.size > 0 ? allowedAvail.filter((p) => neededPositions.has(p.pos)) : allowedAvail.slice();
    if (pool.length === 0) pool = allowedAvail.slice();

    const goneRaw = picksBeforeMyNextTurn();
    const gone = goneRaw == null ? 0 : goneRaw;

    const nextPick = myNextPickOverall();
    const posInfo = {};
    pool.forEach((p) => {
      if (!posInfo[p.pos]) posInfo[p.pos] = positionOutlook(p.pos, available, gone, nextPick);
    });

    const bestOverallRank = available[0].rank;
    const myByes = starterByeCounts(state.config.myTeamId);

    const scored = pool.slice(0, 45).map((p) => {
      const info = posInfo[p.pos] || { drop: 0, next: null };
      const tierLeft = tierRemaining(p, available);
      const bye = byeWeekFor(p.team);
      const byeClash = !!(bye && (myByes[bye] || 0) >= 2);

      const surv = survivalProb(p, nextPick);

      let score = -p.rank + 0.55 * info.drop;
      if (tierLeft <= 2) score += 7;
      else if (tierLeft <= 4) score += 3;
      if (byeClash) score -= 4;
      if (surv != null) {
        if (surv >= 0.75) score -= 5;
        else if (surv <= 0.25) score += 5;
      }

      return { p, score, drop: info.drop, next: info.next, tierLeft, bye, byeClash, surv, adp: effectiveAdp(p) };
    });
    scored.sort((a, b) => b.score - a.score);

    const out = [];
    const perPos = {};
    for (const s of scored) {
      const c = perPos[s.p.pos] || 0;
      if (c >= 2) continue;
      perPos[s.p.pos] = c + 1;
      out.push(s);
      if (out.length >= 5) break;
    }

    out.forEach((s) => {
      const reasons = [];
      if (s.p.rank === bestOverallRank) reasons.push("Best available overall");
      if (s.surv != null && s.surv <= 0.25) reasons.push("ADP " + s.adp + " - gone before your next pick");
      if (s.drop >= 25) reasons.push("Big drop-off at " + s.p.pos + " after him");
      else if (s.drop >= 12) reasons.push(s.p.pos + " thins out before your next pick");
      if (s.tierLeft <= 2) reasons.push("Only " + s.tierLeft + " left in this " + s.p.pos + " tier");
      else if (s.tierLeft <= 4) reasons.push(s.tierLeft + " left in this " + s.p.pos + " tier");
      if (s.surv != null && s.surv >= 0.75) reasons.push("ADP " + s.adp + " - should still be here next turn");
      if (s.adp != null && s.adp - s.p.rank >= 25)
        reasons.push("going ~" + Math.round(s.adp - s.p.rank) + " picks later than his rank");
      if (s.byeClash) reasons.push("stacks your Week " + s.bye + " bye");
      if (reasons.length === 0) reasons.push("Strong value at " + s.p.pos);
      s.reason = reasons.slice(0, 2).join(" · ");
    });
    return out;
  }

  // ---------------- Scarcity summary (pure extraction of renderScarcityBar ~844-869) ----------------
  function scarcitySummary() {
    if (!state || currentOverall() > totalPicksInDraft()) return [];
    const available = availableSortedByRank();
    const { neededPositions } = computeTeamNeeds(state.config.myTeamId);
    const items = [];
    ["QB", "RB", "WR", "TE"].forEach((pos) => {
      if (neededPositions.size > 0 && !neededPositions.has(pos)) return;
      const best = available.find((p) => p.pos === pos);
      if (!best) return;
      const tierLeft = available.filter((p) => p.pos === pos && p.tier === best.tier).length;
      const severity = tierLeft <= 2 ? "crit" : tierLeft <= 4 ? "warn" : "";
      items.push({ pos, tier: best.tier, tierLeft, severity });
    });
    return items;
  }

  // ---------------- Queue / rec-pos toggles (source ~887-905) ----------------
  function toggleQueue(playerId) {
    if (!state.queue) state.queue = [];
    const i = state.queue.indexOf(playerId);
    if (i >= 0) state.queue.splice(i, 1);
    else state.queue.push(playerId);
  }

  function toggleRecPos(pos) {
    if (!state.recPos) state.recPos = PRIMARY_POS.slice();
    const i = state.recPos.indexOf(pos);
    if (i >= 0) state.recPos.splice(i, 1);
    else state.recPos.push(pos);
  }

  // ---------------- Mock draft engine (source ~969-1017) ----------------
  function weightedPick(pool) {
    if (pool.length === 0) return null;
    const roll = rng();
    if (roll < 0.08 && pool.length > 8) {
      const lo = Math.min(8, pool.length - 1);
      const hi = Math.min(28, pool.length - 1);
      const idx = lo + Math.floor(rng() * (hi - lo + 1));
      return pool[idx];
    }
    const topN = Math.min(4, pool.length);
    const weights = [0.55, 0.24, 0.13, 0.08].slice(0, topN);
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total,
      acc = 0,
      idx = 0;
    for (let i = 0; i < topN; i++) {
      acc += weights[i];
      if (r <= acc) {
        idx = i;
        break;
      }
    }
    return pool[idx];
  }

  function autoPickForTeam(teamId, availablePlayers) {
    const { neededPositions } = computeTeamNeeds(teamId);
    let pool;
    if (neededPositions.size > 0) {
      pool = availablePlayers.filter((p) => neededPositions.has(p.pos));
      if (pool.length === 0) pool = availablePlayers.slice();
    } else {
      pool = availablePlayers.slice();
    }
    pool.sort((a, b) => a.rank - b.rank);
    return weightedPick(pool);
  }

  function runMockAutoPicks() {
    if (!state || !state.config.mockDraft) return;
    let guard = 0;
    while (guard++ < 5000) {
      const overall = currentOverall();
      if (overall > totalPicksInDraft()) break;
      const { teamId } = pickTeamForOverall(overall);
      if (teamId === state.config.myTeamId) break;
      const drafted = draftedIdSet();
      const available = PLAYERS_RAW.filter((p) => !drafted.has(p.id));
      const pick = autoPickForTeam(teamId, available);
      if (!pick) break;
      draftPlayer(pick.id, { silent: true });
    }
  }

  // ---------------- Roster slots (source ~1020-1060) ----------------
  function buildSlotTemplate(spec, flexEligibleBySlot) {
    const slots = [];
    for (let i = 0; i < spec.QB; i++) slots.push({ type: "QB", label: "QB" + (i + 1) });
    for (let i = 0; i < spec.RB; i++) slots.push({ type: "RB", label: "RB" + (i + 1) });
    for (let i = 0; i < spec.WR; i++) slots.push({ type: "WR", label: "WR" + (i + 1) });
    for (let i = 0; i < spec.TE; i++) slots.push({ type: "TE", label: "TE" + (i + 1) });
    for (let i = 0; i < spec.FLEX; i++) {
      const eligible = (flexEligibleBySlot && flexEligibleBySlot[i]) || FLEX_ELIGIBLE;
      slots.push({ type: "FLEX", label: "FLEX" + (i + 1 > 1 ? i + 1 : ""), eligible });
    }
    for (let i = 0; i < spec.DEF; i++) slots.push({ type: "DEF", label: "DEF" + (i + 1 > 1 ? i + 1 : "") });
    for (let i = 0; i < spec.K; i++) slots.push({ type: "K", label: "K" + (i + 1 > 1 ? i + 1 : "") });
    for (let i = 0; i < spec.BN; i++) slots.push({ type: "BN", label: "BN" + (i + 1) });
    return slots;
  }

  function assignRosterSlots(teamId) {
    const spec = state.config.rosterSpec;
    const flexEligibleBySlot = state.config.flexEligibleBySlot || [];
    const slots = buildSlotTemplate(spec, flexEligibleBySlot).map((s) => ({ ...s, player: null }));
    const teamPicks = state.picks.filter((p) => p.teamId === teamId).sort((a, b) => a.overall - b.overall);
    const overflow = [];
    teamPicks.forEach((pk) => {
      const player = playerById(pk.playerId);
      if (!player) return;
      let slot = slots.find((s) => s.type === player.pos && !s.player);
      if (!slot) {
        slot = slots.find((s) => s.type === "FLEX" && !s.player && s.eligible && s.eligible.includes(player.pos));
      }
      if (!slot) {
        slot = slots.find((s) => s.type === "BN" && !s.player);
      }
      if (slot) {
        slot.player = player;
        slot.pickOverall = pk.overall;
      } else {
        overflow.push({ player, overall: pk.overall });
      }
    });
    return { slots, overflow };
  }

  // ---------------- Misc (source ~1093-1099, ~1216-1220) ----------------
  function flexEligibleUnion() {
    const bySlot = state.config.flexEligibleBySlot || [];
    const union = new Set();
    bySlot.forEach((list) => list.forEach((p) => union.add(p)));
    if (union.size === 0) FLEX_ELIGIBLE.forEach((p) => union.add(p));
    return ["QB", "RB", "WR", "TE"].filter((p) => union.has(p));
  }

  function isMyClock() {
    const overall = currentOverall();
    if (overall > totalPicksInDraft()) return false;
    return pickTeamForOverall(overall).teamId === state.config.myTeamId;
  }

  // ---------------- CSV export rows (source ~1368-1384, minus Blob/anchor) ----------------
  function rosterExportRows() {
    let rows = [["Team", "Slot", "Player", "NFL Team", "Position", "Bye", "Consensus Rank", "ADP", "Overall Pick"]];
    state.config.teamOrder.forEach((id) => {
      const { slots, overflow } = assignRosterSlots(id);
      const teamName = state.config.teamNames[id];
      slots.forEach((s) => {
        if (s.player)
          rows.push([
            teamName, s.label, s.player.name, s.player.team, s.player.pos,
            byeWeekFor(s.player.team) || "", s.player.rank, s.player.adp == null ? "" : s.player.adp, s.pickOverall,
          ]);
        else rows.push([teamName, s.label, "", "", "", "", "", "", ""]);
      });
      overflow.forEach((o) => {
        rows.push([
          teamName, "EXTRA", o.player.name, o.player.team, o.player.pos,
          byeWeekFor(o.player.team) || "", o.player.rank, o.player.adp == null ? "" : o.player.adp, o.overall,
        ]);
      });
    });
    return rows;
  }

  function csvSerialize(rows) {
    return rows
      .map((r) =>
        r
          .map((v) => {
            const s = String(v == null ? "" : v);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          })
          .join(","),
      )
      .join("\n");
  }

  return {
    get state() {
      return state;
    },
    players: PLAYERS_RAW,
    byeWeekFor,
    effectiveAdp,
    survivalProb,
    isSuperflexFormat,
    totalRounds,
    totalPicksInDraft,
    pickTeamForOverall,
    currentOverall,
    draftedIdSet,
    draftPlayer,
    undoPick,
    resetDraft,
    computeTeamNeeds,
    myNextPickOverall,
    picksBeforeMyNextTurn,
    availableSortedByRank,
    tierRemaining,
    positionOutlook,
    starterByeCounts,
    computeRecommendations,
    scarcitySummary,
    toggleQueue,
    toggleRecPos,
    weightedPick,
    autoPickForTeam,
    runMockAutoPicks,
    buildSlotTemplate,
    assignRosterSlots,
    flexEligibleUnion,
    isMyClock,
    playerById,
    rosterExportRows,
    csvSerialize,
  };
}

// Seedable RNG for deterministic golden runs (not part of the legacy file —
// the golden harness passes this in place of Math.random).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { createLegacyEngine, mulberry32, PRIMARY_POS, FLEX_ELIGIBLE, TIER_MAX, BYE_WEEKS };
