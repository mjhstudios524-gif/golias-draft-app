// AUDIT RESULT 2026-08-14: PASSED — seeds {1,42,1337,2026,7}, 170/170 picks and
// 17/17 rec-turns IDENTICAL between Chromium-driven draft-room.html and the
// legacy reference module. Requires a scratch install of playwright to re-run.
// PLAN.md §4 step 3 — one-time transcription audit: drive the REAL
// draft-room.html in Chromium with a seeded Math.random, run full mock drafts
// clicking the top recommendation each turn, and byte-compare picks + per-turn
// recommendation reasons against the legacy reference module driven with the
// same seed. Three-way agreement (browser ↔ legacy .cjs ↔ TS port) closes the
// transcription-risk gap; the TS↔.cjs leg is already pinned by parity.test.ts.

"use strict";
const { chromium } = require("playwright");
const path = require("node:path");

const APP = "/Users/mattgolias/Desktop/golias-draft-app";
const HTML = "/Users/mattgolias/Desktop/GOLIAS-Draft-Tool/draft-room.html";
const { createLegacyEngine, mulberry32 } = require(path.join(APP, "src/engine/legacy/legacy-engine.cjs"));
const players = require(path.join(APP, "src/engine/__tests__/fixtures/players.superflex.json"));

const SEEDS = [1, 42, 1337, 2026, 7];
const MY_TEAM = 5; // teamOrder is [1..10] untouched (we never click shuffle)

const CONFIG = {
  numTeams: 10,
  teamOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  teamNames: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, "Team " + (i + 1)])),
  rosterSpec: { QB: 2, RB: 2, WR: 3, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 }, // page defaults
  flexEligibleBySlot: [["RB", "WR", "TE"]], // page default for 1 FLEX slot
  myTeamId: MY_TEAM,
  rankingSet: "superflex", // QB:2 → superflex list, matches the page's isSuperflexFormat
  mockDraft: true,
};

function runReference(seed) {
  const eng = createLegacyEngine(players, CONFIG, mulberry32(seed));
  eng.runMockAutoPicks();
  const turns = [];
  let guard = 0;
  while (eng.currentOverall() <= eng.totalPicksInDraft() && guard++ < 50) {
    if (!eng.isMyClock()) throw new Error("reference: not my clock at " + eng.currentOverall());
    const recs = eng.computeRecommendations();
    turns.push(recs.map((r) => `${r.p.id}|${r.reason}`));
    eng.draftPlayer(recs[0].p.id); // triggers bot autopicks
  }
  return {
    turns,
    picks: eng.state.picks.map((p) => [p.overall, p.round, p.pickInRound, p.teamId, p.playerId]),
  };
}

async function runBrowser(browser, seed) {
  const page = await browser.newPage();
  await page.addInitScript(`(() => {
    let a = ${seed} >>> 0;
    Math.random = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    try { localStorage.clear(); } catch {}
  })()`);
  await page.goto("file://" + HTML);

  await page.selectOption("#myTeamSelect", String(MY_TEAM));
  await page.check("#mockDraftToggle");
  await page.click("#startDraftBtn");

  const turns = [];
  let guard = 0;
  while (guard++ < 50) {
    const done = await page.locator("#onClockName").textContent();
    if (done === "Draft Complete") break;
    await page.waitForSelector("#recPanel.show .rec-chip");
    const chips = await page.$$eval("#recPanel .rec-chip", (els) =>
      els.map((el) => `${el.dataset.pid}|${el.getAttribute("title")}`),
    );
    turns.push(chips);
    await page.click("#recPanel .rec-chip"); // first chip = top recommendation
  }

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem("sfDraftRoomState_v1")));
  await page.close();
  return {
    turns,
    picks: state.picks.map((p) => [p.overall, p.round, p.pickInRound, p.teamId, p.playerId]),
  };
}

(async () => {
  const browser = await chromium.launch();
  let allOk = true;
  for (const seed of SEEDS) {
    const ref = runReference(seed);
    const web = await runBrowser(browser, seed);
    const picksEq = JSON.stringify(ref.picks) === JSON.stringify(web.picks);
    const turnsEq = JSON.stringify(ref.turns) === JSON.stringify(web.turns);
    console.log(
      `seed ${seed}: picks ${ref.picks.length}/${web.picks.length} ${picksEq ? "IDENTICAL" : "DIVERGED"}; ` +
        `rec turns ${ref.turns.length}/${web.turns.length} ${turnsEq ? "IDENTICAL" : "DIVERGED"}`,
    );
    if (!picksEq || !turnsEq) {
      allOk = false;
      for (let i = 0; i < Math.max(ref.turns.length, web.turns.length); i++) {
        if (JSON.stringify(ref.turns[i]) !== JSON.stringify(web.turns[i])) {
          console.log(`  first turn divergence at user turn ${i}:`);
          console.log(`    ref: ${JSON.stringify(ref.turns[i])}`);
          console.log(`    web: ${JSON.stringify(web.turns[i])}`);
          break;
        }
      }
      for (let i = 0; i < Math.max(ref.picks.length, web.picks.length); i++) {
        if (JSON.stringify(ref.picks[i]) !== JSON.stringify(web.picks[i])) {
          console.log(`  first pick divergence at overall ${i + 1}: ref ${JSON.stringify(ref.picks[i])} web ${JSON.stringify(web.picks[i])}`);
          break;
        }
      }
    }
  }
  await browser.close();
  console.log(allOk ? "\nAUDIT PASSED: browser === legacy reference on all seeds" : "\nAUDIT FAILED");
  process.exit(allOk ? 0 : 1);
})();
