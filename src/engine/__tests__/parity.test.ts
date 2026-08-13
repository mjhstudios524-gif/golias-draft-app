// THE port exit gate (PLAN.md §4): the TS engine in rank mode must reproduce
// the legacy engine turn-for-turn across seeded full mock drafts — picks,
// recommendation ids + scores + verbatim reason strings, needs, scarcity,
// rosters, tiers, and CSV export.

import { describe, it, expect } from "vitest";
import type { EnginePlayer } from "../types";
import { runTsScenario } from "./helpers/ts-runner";
import superflexPlayers from "./fixtures/players.superflex.json";
import standardPlayers from "./fixtures/players.standard.json";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runLegacyScenario } = require("./helpers/legacy-runner.cjs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scenarios } = require("./helpers/scenarios.cjs");

const fixtures: Record<string, EnginePlayer[]> = {
  superflex: superflexPlayers as EnginePlayer[],
  standard: standardPlayers as EnginePlayer[],
};

describe("legacy ↔ TS parity across seeded full mock drafts", () => {
  for (const scenario of scenarios) {
    it(scenario.key, () => {
      const players = fixtures[scenario.config.fixture];
      const legacy = runLegacyScenario(players, scenario);
      const ts = runTsScenario(players, scenario);

      // Compare piecewise for actionable failures before the full deep-equal.
      expect(ts.picks).toEqual(legacy.picks);
      expect(ts.turns.length).toBe(legacy.turns.length);
      for (let i = 0; i < legacy.turns.length; i++) {
        expect(ts.turns[i]).toEqual(legacy.turns[i]);
      }
      expect(ts.tiers).toEqual(legacy.tiers);
      expect(ts.rosters).toEqual(legacy.rosters);
      expect(ts.csv).toEqual(legacy.csv);
    });
  }
});
