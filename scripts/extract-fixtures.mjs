// Extracts the embedded player data from the legacy draft-room.html into JSON
// fixtures for the golden-master suite (PLAN.md §4). These fixtures are TEST
// DATA ONLY — the rankings are credited to FTN analysts and never ship as
// presets (PLAN.md §6 compliance note, §14 #1).
//
// Usage: node scripts/extract-fixtures.mjs [path-to-draft-room.html]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath =
  process.argv[2] ??
  join(here, "..", "..", "GOLIAS-Draft-Tool", "draft-room.html");
const outDir = join(here, "..", "src", "engine", "__tests__", "fixtures");

const html = readFileSync(sourcePath, "utf8");

// const _P='...'.split('|').map(e=>e.split(','));
const masterMatch = html.match(/const _P='([\s\S]*?)'\.split\('\|'\)/);
if (!masterMatch) throw new Error("could not locate the _P master string");
const master = masterMatch[1]
  .replace(/\\'/g, "'")
  .split("|")
  .map((e) => e.split(","));

function extractIndexList(constName) {
  const m = html.match(new RegExp(`const ${constName}=_mk\\('([\\d,]+)'\\)`));
  if (!m) throw new Error(`could not locate ${constName}`);
  return m[1].split(",").map((x) => Number(x));
}

// Mirrors _mk exactly (draft-room.html:343):
//   {id:+x+1, name:q[0], team:q[1], pos:q[2], rank:i+1, adp:q[3]?+q[3]:null}
function mk(indexes) {
  return indexes.map((x, i) => {
    const q = master[x];
    if (!q) throw new Error(`index ${x} out of range of master (${master.length})`);
    return {
      id: x + 1,
      name: q[0],
      team: q[1],
      pos: q[2],
      rank: i + 1,
      adp: q[3] ? Number(q[3]) : null,
    };
  });
}

const sfIdx = extractIndexList("PLAYERS_SUPERFLEX");
const stdIdx = extractIndexList("PLAYERS_STANDARD");
const superflex = mk(sfIdx);
const standard = mk(stdIdx);

// ---- Invariant assertions (hard facts verified against the source) ----
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
};

const VALID_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
for (const [label, list] of [
  ["superflex", superflex],
  ["standard", standard],
]) {
  assert(
    new Set(list.map((p) => p.id)).size === list.length,
    `${label}: duplicate ids`,
  );
  for (const p of list) {
    assert(p.name && p.team, `${label}: empty name/team for id ${p.id}`);
    assert(VALID_POS.has(p.pos), `${label}: bad pos '${p.pos}' (${p.name})`);
    assert(p.adp === null || Number.isFinite(p.adp), `${label}: bad adp (${p.name})`);
  }
}

const jaSF = superflex.find((p) => p.name === "Josh Allen");
const jaSTD = standard.find((p) => p.name === "Josh Allen");
assert(jaSF?.rank === 1, `Josh Allen superflex rank: expected 1, got ${jaSF?.rank}`);
assert(jaSTD?.rank === 29, `Josh Allen standard rank: expected 29, got ${jaSTD?.rank}`);

assert(master.length === 377, `master count: expected 377, got ${master.length}`);
assert(superflex.length === 361, `superflex count: expected 361, got ${superflex.length}`);
assert(standard.length === 361, `standard count: expected 361, got ${standard.length}`);

const sfIds = new Set(sfIdx);
const stdIds = new Set(stdIdx);
const onlySF = sfIdx.filter((i) => !stdIds.has(i)).length;
const onlySTD = stdIdx.filter((i) => !sfIds.has(i)).length;

// ---- Write fixtures ----
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "players.superflex.json"), JSON.stringify(superflex, null, 1));
writeFileSync(join(outDir, "players.standard.json"), JSON.stringify(standard, null, 1));

const posCounts = {};
for (const q of master) posCounts[q[2]] = (posCounts[q[2]] ?? 0) + 1;
console.log(`master: ${master.length} entries`, posCounts);
console.log(`superflex: ${superflex.length}, standard: ${standard.length}`);
console.log(`symmetric difference: ${onlySF} only-SF, ${onlySTD} only-STD`);
console.log(`null-ADP entries: SF ${superflex.filter((p) => p.adp === null).length}, STD ${standard.filter((p) => p.adp === null).length}`);
console.log(`wrote fixtures to ${outDir}`);
