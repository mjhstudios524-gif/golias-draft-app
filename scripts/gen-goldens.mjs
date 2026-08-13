// Generates the committed golden-master JSONs from the LEGACY engine
// (PLAN.md §4 step 4). Goldens outlive the legacy module: after port sign-off
// legacy-engine.cjs is deleted and golden.test.ts remains the rank-mode
// regression suite. Regenerate ONLY if the legacy file itself is re-audited.
//
// Usage: node scripts/gen-goldens.mjs

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const testsDir = join(here, "..", "src", "engine", "__tests__");
const outDir = join(testsDir, "golden");

const { runLegacyScenario } = require(join(testsDir, "helpers", "legacy-runner.cjs"));
const { scenarios } = require(join(testsDir, "helpers", "scenarios.cjs"));

const fixtures = {
  superflex: JSON.parse(readFileSync(join(testsDir, "fixtures", "players.superflex.json"), "utf8")),
  standard: JSON.parse(readFileSync(join(testsDir, "fixtures", "players.standard.json"), "utf8")),
};

mkdirSync(outDir, { recursive: true });
for (const scenario of scenarios) {
  const record = runLegacyScenario(fixtures[scenario.config.fixture], scenario);
  // fixture name travels with the golden so golden.test.ts is self-contained
  const golden = { fixture: scenario.config.fixture, scenario: { key: scenario.key, config: scenario.config, seed: scenario.seed, policy: scenario.policy }, record };
  writeFileSync(join(outDir, `${scenario.key}.golden.json`), JSON.stringify(golden));
  console.log(`wrote ${scenario.key}.golden.json (${record.picks.length} picks, ${record.turns.length} user turns)`);
}
console.log(`\n${scenarios.length} goldens written to ${outDir}`);
