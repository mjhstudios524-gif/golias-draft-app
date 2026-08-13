// Header-row detection + column auto-mapping (PLAN.md §6 "Column mapper").
// Mapping is by COLUMN INDEX (PapaParse header:false) because FantasyPros
// projection exports repeat headers (YDS/TDS appear in the passing, rushing,
// and receiving groups) and header:true silently clobbers them. Ambiguity
// always leaves a column unmapped for the user — never guess silently.

import { canonicalTeamCode } from "@/engine/teams";

/** Stat vocabulary = Sleeper scoring_settings keys (engine StatLine convention). */
export const STAT_FIELDS = [
  "pass_att",
  "pass_cmp",
  "pass_yd",
  "pass_td",
  "pass_int",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rec",
  "rec_yd",
  "rec_td",
  "fum_lost",
] as const;
export type StatField = (typeof STAT_FIELDS)[number];

export const CANONICAL_FIELDS = [
  "name",
  "team",
  "pos",
  "posRank",
  "rank",
  "adp",
  "bye",
  "points",
  ...STAT_FIELDS,
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

export const FIELD_LABELS: Record<CanonicalField, string> = {
  name: "Player name",
  team: "Team",
  pos: "Position",
  posRank: "Position rank",
  rank: "Overall rank",
  adp: "ADP",
  bye: "Bye week",
  points: "Projected points",
  pass_att: "Pass attempts",
  pass_cmp: "Completions",
  pass_yd: "Pass yards",
  pass_td: "Pass TDs",
  pass_int: "Interceptions",
  rush_att: "Rush attempts",
  rush_yd: "Rush yards",
  rush_td: "Rush TDs",
  rec: "Receptions",
  rec_yd: "Receiving yards",
  rec_td: "Receiving TDs",
  fum_lost: "Fumbles lost",
};

/** Index-aligned with the parsed columns; null = ignored. */
export type ColumnMapping = (CanonicalField | null)[];
export type Confidence = "high" | "medium" | "none";

export interface DetectedMapping {
  mapping: ColumnMapping;
  confidence: Confidence[];
}

const STAT_FIELD_SET: ReadonlySet<string> = new Set(STAT_FIELDS);
export function isStatField(f: CanonicalField): f is StatField {
  return STAT_FIELD_SET.has(f);
}

/** Trim + collapse whitespace + strip a residual BOM (first header cell). */
export function cleanCell(raw: string | null | undefined): string {
  return (raw ?? "").replace(/^﻿/, "").replace(/\s+/g, " ").trim();
}

// Unambiguous header spellings only. Bare ATT/YDS/TD(S) are deliberately
// absent — those are resolved by the duplicate-group inference below.
const FIELD_HEADER_REGEXES: readonly [CanonicalField, RegExp][] = [
  ["name", /^(player|player name|name|full name)$/],
  ["team", /^(team|tm|nfl team)$/],
  ["pos", /^(pos|position)$/],
  ["posRank", /^(pos rank|position rank|pos rk|posrk|prk)$/],
  ["rank", /^(rk|rank|ovr|overall|ecr|avg rk|avg rank|consensus)$/],
  ["adp", /^(adp|avg pick|avg draft pick|avg draft position|average draft position)$/],
  ["bye", /^bye( week)?$/],
  ["points", /^(fpts|fantasy pts|fantasy points|proj pts|proj points|projected pts|projected points|pts|points|misc fpts)$/],
  ["pass_att", /^(pass att|pass attempts|passing att|passing attempts)$/],
  ["pass_cmp", /^(cmp|comp|completions|pass cmp)$/],
  ["pass_yd", /^(pass yds?|pass yards|passing yds?|passing yards)$/],
  ["pass_td", /^(pass tds?|passing tds?)$/],
  ["pass_int", /^(ints?|interceptions|pass ints?)$/],
  ["rush_att", /^(rush att|rush attempts|rushing att|rushing attempts|car|carries)$/],
  ["rush_yd", /^(rush yds?|rush yards|rushing yds?|rushing yards)$/],
  ["rush_td", /^(rush tds?|rushing tds?)$/],
  ["rec", /^(rec|receptions)$/],
  ["rec_yd", /^(rec yds?|rec yards|receiving yds?|receiving yards)$/],
  ["rec_td", /^(rec tds?|receiving tds?)$/],
  ["fum_lost", /^(fl|fum|fumbles?|fum lost|fumbles lost)$/],
];

/** FantasyPros duplicate-group tokens (position depends on group context). */
const AMBIG_TOKEN_RE = /^(att|yds?|tds?)$/;

// Everything that marks a row as "looks like a header" — the field regexes,
// the ambiguous FP tokens, and known-but-unmapped columns (bye/tiers/SOS...).
const KNOWN_HEADER_REGEXES: readonly RegExp[] = [
  ...FIELD_HEADER_REGEXES.map(([, re]) => re),
  AMBIG_TOKEN_RE,
  /^tiers?$/,
  /^sos( season)?$/,
  /^ecr vs\.? adp$/,
  /^(best|worst|std dev|std\.? dev)$/,
  /^rank vs\.? adp$/,
];

function matchesKnownHeader(cell: string): boolean {
  const t = cleanCell(cell).toLowerCase();
  return KNOWN_HEADER_REGEXES.some((re) => re.test(t));
}

const HEADER_SCAN_LIMIT = 30;

/**
 * First row where >=2 cells match known header regexes (PLAN.md §6: preamble
 * rows are dropped above it). null => fully-manual mapping (Column A/B/C).
 */
export function detectHeaderRow(rows: readonly string[][]): number | null {
  const limit = Math.min(rows.length, HEADER_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    let hits = 0;
    for (const cell of rows[i]) {
      if (cell && matchesKnownHeader(cell)) hits++;
      if (hits >= 2) return i;
    }
  }
  return null;
}

const CANONICAL_TEAM_CODES = new Set([
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
  "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE",
  "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
]);

/** Value shapes for sniffing (first 20 data rows — the §6 tiebreak). */
export const POS_VALUE_RE = /^(qb|rb|wr|te|k|pk|dst|def|d\/st)\s*\.?\s*\d*$/i;
const NAME_VALUE_RE = /^[^\d,]*[a-z][^\d,]*\s+\S+/i;

const SNIFF_ROWS = 20;

/**
 * Auto-detect the column mapping: exact header regexes first, then the
 * FantasyPros duplicate-group inference, then value sniffing for columns the
 * headers left unresolved (or all columns in fully-manual mode).
 */
export function detectMapping(
  rows: readonly string[][],
  headerRowIndex: number | null,
): DetectedMapping {
  const dataStart = headerRowIndex == null ? 0 : headerRowIndex + 1;
  const dataRows = rows.slice(dataStart, dataStart + SNIFF_ROWS);
  const header = headerRowIndex == null ? null : rows[headerRowIndex];
  const ncols = header
    ? header.length
    : dataRows.reduce((m, r) => Math.max(m, r.length), 0);

  const mapping: ColumnMapping = Array.from({ length: ncols }, () => null);
  const confidence: Confidence[] = Array.from({ length: ncols }, () => "none" as Confidence);
  const claimed = new Set<CanonicalField>();

  // ---- pass 1: unambiguous header regexes -------------------------------
  if (header) {
    const hits = new Map<CanonicalField, number[]>();
    for (let c = 0; c < ncols; c++) {
      const low = cleanCell(header[c] ?? "").toLowerCase();
      for (const [field, re] of FIELD_HEADER_REGEXES) {
        if (re.test(low)) {
          const list = hits.get(field) ?? [];
          list.push(c);
          hits.set(field, list);
          break;
        }
      }
    }
    for (const [field, cols] of hits) {
      if (cols.length === 1) {
        // a field claimed twice is ambiguous — leave every claimant unmapped
        mapping[cols[0]] = field;
        confidence[cols[0]] = "high";
        claimed.add(field);
      }
    }

    // ---- pass 2: FP duplicate-group inference ---------------------------
    inferDuplicateGroups(header, mapping, confidence, claimed);
  }

  // ---- pass 3: value sniffing -------------------------------------------
  const sniffed = new Map<CanonicalField, number[]>();
  for (let c = 0; c < ncols; c++) {
    if (mapping[c] != null) continue;
    const vals = dataRows.map((r) => cleanCell(r[c])).filter((v) => v !== "");
    if (vals.length < 2) continue;
    const field = sniffColumn(vals);
    if (field && !claimed.has(field)) {
      const list = sniffed.get(field) ?? [];
      list.push(c);
      sniffed.set(field, list);
    }
  }
  for (const [field, cols] of sniffed) {
    if (cols.length === 1) {
      // two columns sniffing to the same field is ambiguous — map neither
      mapping[cols[0]] = field;
      confidence[cols[0]] = "medium";
      claimed.add(field);
    }
  }

  return { mapping, confidence };
}

/**
 * Classic FantasyPros projection order (PLAN.md §6): passing ATT,CMP,YDS,TDS,INTS
 * then rush ATT,YDS,TDS then rec REC,YDS,TDS then FL,FPTS. Bare ATT/YDS/TDS
 * columns are resolved positionally off the unambiguous anchors (CMP for the
 * passing run, REC for the receiving run); whatever remains must form at most
 * one ATT,YDS,TDS run in order — the rushing group — or it stays unmapped.
 */
function inferDuplicateGroups(
  header: readonly string[],
  mapping: ColumnMapping,
  confidence: Confidence[],
  claimed: Set<CanonicalField>,
): void {
  type Tok = "ATT" | "YDS" | "TDS";
  const toks = new Map<number, Tok>();
  for (let c = 0; c < mapping.length; c++) {
    if (mapping[c] != null) continue;
    const low = cleanCell(header[c] ?? "").toLowerCase();
    if (AMBIG_TOKEN_RE.test(low)) {
      toks.set(c, low.startsWith("att") ? "ATT" : low.startsWith("yd") ? "YDS" : "TDS");
    }
  }
  if (toks.size === 0) return;

  const assign = (c: number, field: StatField) => {
    if (claimed.has(field)) return;
    mapping[c] = field;
    confidence[c] = "medium";
    claimed.add(field);
    toks.delete(c);
  };

  const colOf = (field: CanonicalField): number | null => {
    const i = mapping.indexOf(field);
    return i === -1 ? null : i;
  };

  // passing run, anchored on CMP: [ATT, CMP, YDS, TDS, INTS]
  const cmp = colOf("pass_cmp");
  if (cmp != null) {
    if (toks.get(cmp - 1) === "ATT") assign(cmp - 1, "pass_att");
    if (toks.get(cmp + 1) === "YDS") assign(cmp + 1, "pass_yd");
    if (toks.get(cmp + 2) === "TDS") assign(cmp + 2, "pass_td");
  }

  // receiving run, anchored on REC: [REC, YDS, TDS]
  const rec = colOf("rec");
  if (rec != null) {
    if (toks.get(rec + 1) === "YDS") assign(rec + 1, "rec_yd");
    if (toks.get(rec + 2) === "TDS") assign(rec + 2, "rec_td");
  }

  // An INTS column with no CMP anchor means an unrecognized passing layout —
  // attributing leftover ATT/YDS/TDS to rushing would be a guess. Bail.
  if (colOf("pass_int") != null && cmp == null) return;

  // remaining tokens must be a subsequence of [ATT, YDS, TDS] starting at ATT
  const rest = [...toks.entries()].sort((a, b) => a[0] - b[0]);
  const seq = rest.map(([, t]) => t);
  const expected: Tok[] = ["ATT", "YDS", "TDS"];
  const isOrderedRun =
    seq.length > 0 &&
    seq[0] === "ATT" &&
    seq.every((t, i) => t === expected[i]) &&
    new Set(seq).size === seq.length;
  if (!isOrderedRun) return;
  const fieldFor: Record<Tok, StatField> = { ATT: "rush_att", YDS: "rush_yd", TDS: "rush_td" };
  for (const [c, t] of rest) assign(c, fieldFor[t]);
}

function sniffColumn(vals: string[]): CanonicalField | null {
  const frac = (pred: (v: string) => boolean) =>
    vals.filter(pred).length / vals.length;

  if (frac((v) => POS_VALUE_RE.test(v)) >= 0.7) return "pos";

  if (
    frac((v) => {
      const upper = v.toUpperCase();
      if (upper === "FA" || upper === "INA") return true;
      const code = canonicalTeamCode(v);
      return code != null && CANONICAL_TEAM_CODES.has(code);
    }) >= 0.7
  ) {
    return "team";
  }

  // overall rank: strictly-increasing distinct integers starting at 1 — any
  // looser shape (points, ADP, stats) is ambiguous and stays unmapped
  if (vals.every((v) => /^\d+$/.test(v))) {
    const nums = vals.map(Number);
    const increasing = nums.every((n, i) => i === 0 || n > nums[i - 1]);
    if (increasing && nums[0] === 1) return "rank";
  }

  if (frac((v) => NAME_VALUE_RE.test(v) && !POS_VALUE_RE.test(v)) >= 0.6) return "name";

  return null;
}

/**
 * Mapping memory key (PLAN.md §6): sha256 hex of the normalized header
 * signature, via Web Crypto so it runs identically in browser and Node.
 */
export async function headerFingerprint(headerCells: readonly string[]): Promise<string> {
  const signature = headerCells.map((c) => cleanCell(c).toLowerCase()).join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
