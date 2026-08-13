// Drives the TS engine through a scenario, producing the SAME record shape as
// legacy-runner.cjs. Rank mode (rank = sourceRank) — the golden-parity harness.

import type { DraftConfig, DraftState, EnginePlayer, PlayerPool } from "../../types";
import { buildPlayerPool, availableSorted, draftedIdSet } from "../../pool";
import { totalPicks, isOnClock } from "../../snake";
import { applyPick } from "../../draft";
import { runAutoPicks } from "../../autopick";
import { computeRecommendations } from "../../recommend";
import { computeTeamNeeds, assignRosterSlots } from "../../roster";
import { scarcitySummary } from "../../scarcity";
import { rosterExportRows, csvSerialize } from "../../export";
import { mulberry32 } from "../../rng";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BYE_WEEKS } = require("../../legacy/legacy-engine.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildLegacyConfig } = require("./scenarios.cjs");

const round9 = (x: number) => Math.round(x * 1e9) / 1e9;

interface Scenario {
  config: { key: string };
  seed: number;
  policy: "top-rec" | "best-rank";
  key: string;
}

export function runTsScenario(players: EnginePlayer[], scenario: Scenario) {
  const legacyCfg = buildLegacyConfig(scenario.config, scenario.seed);
  const config: DraftConfig = {
    numTeams: legacyCfg.numTeams,
    teamOrder: legacyCfg.teamOrder,
    teamNames: legacyCfg.teamNames,
    rosterSpec: legacyCfg.rosterSpec,
    flexEligibleBySlot: legacyCfg.flexEligibleBySlot,
    myTeamId: legacyCfg.myTeamId,
    mockDraft: true,
    // The alias-keyed legacy map, verbatim — fixtures carry alias team codes
    // (HST/BLT/ARZ/LA) and both engines must resolve byes identically.
    byeWeeks: BYE_WEEKS,
    adpContext: "1QB", // the bundled FTN ADP is a 1QB-market number
  };

  const pool: PlayerPool = buildPlayerPool(players);
  const rng = mulberry32(scenario.seed);
  let state: DraftState = {
    config,
    picks: [],
    queue: [],
    recPos: ["QB", "RB", "WR", "TE", "DEF", "K"],
  };
  state = runAutoPicks(state, pool, rng);

  const turns = [];
  let guard = 0;
  while (state.picks.length + 1 <= totalPicks(config) && guard++ < 1000) {
    if (!isOnClock(state, config.myTeamId))
      throw new Error("ts runner: expected my clock at " + (state.picks.length + 1));
    const recs = computeRecommendations(state, pool);
    const needs = [...computeTeamNeeds(state, pool, config.myTeamId).neededPositions].sort();
    turns.push({
      overall: state.picks.length + 1,
      recs: recs.map((r) => ({
        id: r.player.id,
        score: round9(r.score),
        drop: r.drop,
        tierLeft: r.tierLeft,
        byeClash: r.byeClash,
        surv: r.surv == null ? null : round9(r.surv),
        reason: r.reason,
      })),
      needs,
      scarcity: scarcitySummary(state, pool),
    });
    const pickId =
      scenario.policy === "top-rec" && recs.length > 0
        ? recs[0].player.id
        : availableSorted(pool, draftedIdSet(state.picks))[0].id;
    state = applyPick(state, pickId, pool);
    state = runAutoPicks(state, pool, rng);
  }

  const rosters: Record<number, unknown> = {};
  config.teamOrder.forEach((id) => {
    const { slots, overflow } = assignRosterSlots(state, pool, id);
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
    picks: state.picks.map((p) => ({ overall: p.overall, teamId: p.teamId, playerId: p.playerId })),
    turns,
    rosters,
    tiers: players
      .map((p) => [p.id, pool.tiers.get(p.id)] as [number | string, number | undefined])
      .sort((a, b) => (a[0] as number) - (b[0] as number)),
    csv: csvSerialize(rosterExportRows(state, pool)),
  };
}
