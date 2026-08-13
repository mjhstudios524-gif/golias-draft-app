// Shared scenario matrix for parity + golden tests (PLAN.md §4 golden strategy).
// CommonJS so both vitest (TS) and scripts/gen-goldens.mjs can load it.

"use strict";

const { mulberry32 } = require("../../legacy/legacy-engine.cjs");

/** Deterministic shuffled team order derived from the seed (Fisher-Yates). */
function teamOrderFor(numTeams, seed) {
  const rng = mulberry32(seed + 1000);
  const order = Array.from({ length: numTeams }, (_, i) => i + 1);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function teamNames(n) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, "Team " + (i + 1)]));
}

// rankingSet must match what leagueFormat derives from the spec (legacy nulls
// QB ADP on rankingSet==='superflex'; the TS engine derives MULTI_QB from the
// roster shape — parity requires the two to agree).
const CONFIGS = [
  {
    key: "sf10",
    fixture: "superflex",
    rankingSet: "superflex",
    numTeams: 10,
    rosterSpec: { QB: 2, RB: 2, WR: 3, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 },
    flexEligibleBySlot: [["RB", "WR", "TE"]],
    myTeamSlot: 5, // 1-based position in the shuffled order
  },
  {
    key: "oneqb12",
    fixture: "standard",
    rankingSet: "standard",
    numTeams: 12,
    rosterSpec: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 },
    flexEligibleBySlot: [["RB", "WR", "TE"]],
    myTeamSlot: 8,
  },
  {
    key: "mixedflex8",
    fixture: "superflex",
    rankingSet: "superflex", // FLEX1 allows QB → superflex format
    numTeams: 8,
    rosterSpec: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, DEF: 1, K: 1, BN: 5 },
    flexEligibleBySlot: [
      ["QB", "RB", "WR", "TE"],
      ["RB"],
    ],
    myTeamSlot: 1,
  },
  {
    key: "wide4",
    fixture: "standard",
    rankingSet: "standard",
    numTeams: 4,
    rosterSpec: { QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 8 },
    flexEligibleBySlot: [["RB", "WR", "TE"]],
    myTeamSlot: 4,
  },
  {
    key: "big20",
    fixture: "standard",
    rankingSet: "standard",
    numTeams: 20,
    rosterSpec: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 3 },
    flexEligibleBySlot: [["RB", "WR", "TE"]],
    myTeamSlot: 13,
  },
];

const SEEDS = [42, 2026];
const POLICIES = ["top-rec", "best-rank"];

function buildLegacyConfig(c, seed) {
  const teamOrder = teamOrderFor(c.numTeams, seed);
  return {
    numTeams: c.numTeams,
    teamOrder,
    teamNames: teamNames(c.numTeams),
    rosterSpec: c.rosterSpec,
    flexEligibleBySlot: c.flexEligibleBySlot,
    myTeamId: teamOrder[c.myTeamSlot - 1],
    rankingSet: c.rankingSet,
    mockDraft: true,
  };
}

const scenarios = [];
for (const c of CONFIGS)
  for (const seed of SEEDS)
    for (const policy of POLICIES) scenarios.push({ config: c, seed, policy, key: `${c.key}-s${seed}-${policy}` });

module.exports = { CONFIGS, SEEDS, POLICIES, scenarios, buildLegacyConfig, teamOrderFor, teamNames };
