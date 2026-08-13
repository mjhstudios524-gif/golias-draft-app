// Parsed rows + column mapping → NormalizedRow[] (PLAN.md §6): numeric
// coercion, canonical team codes, combined FantasyPros pos+posRank split,
// and the data-tier computation that decides which engine features light up.

import type { Pos } from "@/engine/types";
import type { NormalizedRow } from "@/server/rankings/types";
import { canonicalTeamCode } from "@/engine/teams";
import { cleanCell, isStatField, type ColumnMapping, type StatField } from "./headers";

export type { NormalizedRow };

export type DataTier = "RANK_ONLY" | "POINTS" | "FULL_STATS";

/**
 * §6.2 tier rules: >=3 mapped stat columns → FULL_STATS; else a points
 * column → POINTS; else a rank column → RANK_ONLY; else null (invalid).
 */
export function computeDataTier(mapping: ColumnMapping): DataTier | null {
  const statCount = new Set(mapping.filter((f) => f != null && isStatField(f))).size;
  if (statCount >= 3) return "FULL_STATS";
  if (mapping.includes("points")) return "POINTS";
  if (mapping.includes("rank")) return "RANK_ONLY";
  return null;
}

/** §6.2 validation: name required; one of rank / points / >=3 stat columns. */
export function mappingErrors(mapping: ColumnMapping): string[] {
  const errors: string[] = [];
  if (!mapping.includes("name")) errors.push("A player-name column is required.");
  if (computeDataTier(mapping) == null) {
    errors.push("Map a rank column, a points column, or at least 3 stat columns.");
  }
  return errors;
}

const NULLISH = new Set(["", "-", "–", "—", "n/a", "na", "null"]);

function coerceNumber(raw: string | undefined): number | null {
  const v = cleanCell(raw).replace(/[$,%]/g, "");
  if (NULLISH.has(v.toLowerCase())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function coerceInt(raw: string | undefined): number | null {
  const n = coerceNumber(raw);
  return n == null ? null : Math.round(n);
}

/** NFL byes live in weeks 1–18; anything else is junk data → null. */
function coerceByeWeek(raw: string | undefined): number | null {
  const n = coerceInt(raw);
  return n != null && n >= 1 && n <= 18 ? n : null;
}

const POS_CELL_RE = /^(qb|rb|wr|te|k|pk|dst|def|d\/st)\s*\.?\s*(\d+)?$/i;

/** "WR1" → {pos:"WR", posRank:1}; DST/D-ST → DEF; PK → K. */
export function parsePosCell(raw: string | undefined): { pos: Pos | null; posRank: number | null } {
  const m = POS_CELL_RE.exec(cleanCell(raw));
  if (!m) return { pos: null, posRank: null };
  const base = m[1].toUpperCase();
  const pos: Pos =
    base === "DST" || base === "D/ST" ? "DEF" : base === "PK" ? "K" : (base as Pos);
  return { pos, posRank: m[2] ? Number(m[2]) : null };
}

export function normalizeRows(
  rows: readonly string[][],
  mapping: ColumnMapping,
  headerRowIndex: number | null,
): NormalizedRow[] {
  const colOf = (field: string): number => mapping.indexOf(field as ColumnMapping[number]);
  const nameCol = colOf("name");
  if (nameCol === -1) return [];
  const teamCol = colOf("team");
  const posCol = colOf("pos");
  const posRankCol = colOf("posRank");
  const rankCol = colOf("rank");
  const adpCol = colOf("adp");
  const byeCol = colOf("bye");
  const pointsCol = colOf("points");
  const statCols: [StatField, number][] = [];
  mapping.forEach((f, i) => {
    if (f != null && isStatField(f)) statCols.push([f, i]);
  });

  const header = headerRowIndex == null ? null : rows[headerRowIndex];
  const dataStart = headerRowIndex == null ? 0 : headerRowIndex + 1;
  const out: NormalizedRow[] = [];

  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    const rawName = row[nameCol] ?? "";
    const name = cleanCell(rawName);
    if (name === "") continue;
    // some exports repeat the header row mid-file (pagination) — skip those
    if (header && name.toLowerCase() === cleanCell(header[nameCol]).toLowerCase()) continue;

    const fromPosCol = parsePosCell(posCol === -1 ? undefined : row[posCol]);
    const explicitPosRank = posRankCol === -1 ? null : coerceInt(row[posRankCol]);

    let stats: Record<string, number> | null = null;
    for (const [field, col] of statCols) {
      const v = coerceNumber(row[col]);
      if (v != null) {
        (stats ??= {})[field] = v;
      }
    }

    out.push({
      sourceRow: r + 1, // 1-based row number in the parsed file
      rawName,
      name,
      team: teamCol === -1 ? null : canonicalTeamCode(cleanCell(row[teamCol]) || null),
      pos: fromPosCol.pos,
      posRank: explicitPosRank ?? fromPosCol.posRank,
      rank: rankCol === -1 ? null : coerceInt(row[rankCol]),
      adp: adpCol === -1 ? null : coerceNumber(row[adpCol]),
      byeWeek: byeCol === -1 ? null : coerceByeWeek(row[byeCol]),
      projPoints: pointsCol === -1 ? null : coerceNumber(row[pointsCol]),
      stats,
    });
  }
  return out;
}
