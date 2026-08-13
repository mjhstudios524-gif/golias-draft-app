// Drives the verbatim legacy engine through a scenario and serializes the
// observable record compared by parity/golden tests. Legacy side of PLAN.md §4.

"use strict";

const { createLegacyEngine, mulberry32 } = require("../../legacy/legacy-engine.cjs");
const { buildLegacyConfig } = require("./scenarios.cjs");

const round9 = (x) => Math.round(x * 1e9) / 1e9;

function runLegacyScenario(players, scenario) {
  const cfg = buildLegacyConfig(scenario.config, scenario.seed);
  const eng = createLegacyEngine(players, cfg, mulberry32(scenario.seed));
  eng.runMockAutoPicks();

  const turns = [];
  let guard = 0;
  while (eng.currentOverall() <= eng.totalPicksInDraft() && guard++ < 1000) {
    if (!eng.isMyClock()) throw new Error("legacy runner: expected my clock at " + eng.currentOverall());
    const recs = eng.computeRecommendations();
    const needs = [...eng.computeTeamNeeds(cfg.myTeamId).neededPositions].sort();
    turns.push({
      overall: eng.currentOverall(),
      recs: recs.map((r) => ({
        id: r.p.id,
        score: round9(r.score),
        drop: r.drop,
        tierLeft: r.tierLeft,
        byeClash: r.byeClash,
        surv: r.surv == null ? null : round9(r.surv),
        reason: r.reason,
      })),
      needs,
      scarcity: eng.scarcitySummary(),
    });
    const pickId =
      scenario.policy === "top-rec" && recs.length > 0 ? recs[0].p.id : eng.availableSortedByRank()[0].id;
    eng.draftPlayer(pickId); // mock mode: triggers bot autopicks through next user turn
  }

  const rosters = {};
  cfg.teamOrder.forEach((id) => {
    const { slots, overflow } = eng.assignRosterSlots(id);
    rosters[id] = {
      slots: slots.map((s) => ({
        label: s.label,
        playerId: s.player ? s.player.id : null,
        pickOverall: s.player ? s.pickOverall : null,
      })),
      overflow: overflow.map((o) => ({ playerId: o.player.id, overall: o.overall })),
    };
  });

  return {
    key: scenario.key,
    picks: eng.state.picks.map((p) => ({ overall: p.overall, teamId: p.teamId, playerId: p.playerId })),
    turns,
    rosters,
    tiers: eng.players
      .map((p) => [p.id, p.tier])
      .sort((a, b) => a[0] - b[0]),
    csv: eng.csvSerialize(eng.rosterExportRows()),
  };
}

module.exports = { runLegacyScenario };
