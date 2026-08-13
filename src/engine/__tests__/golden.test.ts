// Replays the committed golden-master JSONs (generated from the legacy engine
// by scripts/gen-goldens.mjs) through the TS engine in rank mode. This suite
// is the permanent rank-mode regression gate — it survives the deletion of
// legacy-engine.cjs after port sign-off (PLAN.md §4 step 5).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnginePlayer } from "../types";
import { runTsScenario } from "./helpers/ts-runner";
import superflexPlayers from "./fixtures/players.superflex.json";
import standardPlayers from "./fixtures/players.standard.json";

const fixtures: Record<string, EnginePlayer[]> = {
  superflex: superflexPlayers as EnginePlayer[],
  standard: standardPlayers as EnginePlayer[],
};

const goldenDir = join(__dirname, "golden");
const goldenFiles = readdirSync(goldenDir).filter((f) => f.endsWith(".golden.json"));

describe("golden-master replay (rank mode)", () => {
  it("has the full scenario matrix committed", () => {
    expect(goldenFiles.length).toBe(20);
  });

  for (const file of goldenFiles) {
    it(file.replace(".golden.json", ""), () => {
      const golden = JSON.parse(readFileSync(join(goldenDir, file), "utf8"));
      const ts = runTsScenario(fixtures[golden.fixture], golden.scenario);
      expect(ts.picks).toEqual(golden.record.picks);
      expect(ts.turns).toEqual(golden.record.turns);
      expect(ts.tiers).toEqual(golden.record.tiers);
      expect(ts.rosters).toEqual(golden.record.rosters);
      expect(ts.csv).toEqual(golden.record.csv);
    });
  }
});
