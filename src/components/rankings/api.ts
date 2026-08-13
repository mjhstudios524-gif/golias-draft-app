// Client wrappers for the rankings API. /api/mapping-profiles is this
// cluster's; /api/ranking-sets, resolutions, finalize, and /api/players/index
// belong to the server ingestion cluster — the request/response shapes below
// are its PLAN.md §6 contract, with tolerant coercion so minor drift degrades
// to "no candidates / zero counts" instead of a crash.

import { CANONICAL_FIELDS, type CanonicalField, type ColumnMapping } from "@/lib/csv/headers";
import type { DataTier, NormalizedRow } from "@/lib/csv/normalizeRows";

export interface Candidate {
  playerId: string;
  fullName: string;
  pos: string;
  nflTeam: string | null;
  score?: number;
}

export interface UnmatchedEntry {
  entryId: string;
  rawName: string;
  team: string | null;
  pos: string | null;
  sourceRow: number | null;
  candidates?: Candidate[];
}

export interface MatchReport {
  total: number;
  countsByMethod: Record<string, number>;
  unmatched: UnmatchedEntry[];
}

export interface CreateSetPayload {
  name: string;
  seasonYear: number;
  formatTag: "1QB" | "SF";
  adpContext: "ONE_QB" | "SUPERFLEX" | "UNKNOWN";
  dataTier: DataTier;
  headerFingerprint: string | null;
  columnMap: { v: 1; columns: ColumnMapping };
  rawCsv: string;
  rows: NormalizedRow[];
}

export interface IndexPlayer {
  id: string;
  fullName: string;
  /** served by /api/players/index; recomputed client-side when absent */
  nameKey?: string;
  pos: string;
  nflTeam: string | null;
}

export type ResolutionAction = "MATCH" | "EXCLUDE" | "UNLINKED";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response body
  }
  if (!res.ok) {
    const msg =
      (isRecord(body) && str(body.error)) || `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body;
}

const post = (url: string, body: unknown, init?: RequestInit) =>
  request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

// ---------- mapping profiles (this cluster's route) ----------

const FIELD_SET: ReadonlySet<string> = new Set(CANONICAL_FIELDS);

export async function getMappingProfile(fingerprint: string): Promise<ColumnMapping | null> {
  try {
    const body = await request(`/api/mapping-profiles?fingerprint=${fingerprint}`);
    if (!isRecord(body) || !isRecord(body.mapping) || !Array.isArray(body.mapping.columns)) {
      return null;
    }
    return body.mapping.columns.map((c) =>
      typeof c === "string" && FIELD_SET.has(c) ? (c as CanonicalField) : null,
    );
  } catch {
    return null; // profile lookup is an optimization, never a blocker
  }
}

export async function saveMappingProfile(fingerprint: string, columns: ColumnMapping): Promise<void> {
  await post("/api/mapping-profiles", {
    headerFingerprint: fingerprint,
    mapping: { v: 1, columns },
  });
}

// ---------- ranking sets (server ingestion cluster's routes) ----------

function coerceCandidate(v: unknown): Candidate | null {
  if (!isRecord(v)) return null;
  const playerId = str(v.playerId) ?? str(v.id);
  const fullName = str(v.fullName) ?? str(v.name);
  if (!playerId || !fullName) return null;
  return {
    playerId,
    fullName,
    pos: str(v.pos) ?? "",
    nflTeam: str(v.nflTeam) ?? str(v.team),
    score: num(v.score) ?? undefined,
  };
}

function coerceUnmatched(v: unknown): UnmatchedEntry | null {
  if (!isRecord(v)) return null;
  const entryId = str(v.entryId) ?? str(v.id);
  const rawName = str(v.rawName) ?? str(v.name);
  if (!entryId || !rawName) return null;
  return {
    entryId,
    rawName,
    team: str(v.team),
    pos: str(v.pos),
    sourceRow: num(v.sourceRow),
    candidates: Array.isArray(v.candidates)
      ? v.candidates.map(coerceCandidate).filter((c): c is Candidate => c != null)
      : undefined,
  };
}

/** POST /api/ranking-sets responds { set, entries[], summary } — the report
 * (counts by matchMethod + unmatched list w/ fuzzy candidates) tallies from
 * the entries themselves. */
function coerceReport(v: unknown): MatchReport {
  const r = isRecord(v) ? v : {};
  const countsByMethod: Record<string, number> = {};
  const unmatched: UnmatchedEntry[] = [];
  const entries = Array.isArray(r.entries) ? r.entries : [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const method = str(e.matchMethod) ?? "UNKNOWN";
    countsByMethod[method] = (countsByMethod[method] ?? 0) + 1;
    if (method === "UNMATCHED") {
      const u = coerceUnmatched(e);
      if (u) unmatched.push(u);
    }
  }
  const summary = isRecord(r.summary) ? r.summary : {};
  const total = num(summary.total) ?? entries.length;
  return { total, countsByMethod, unmatched };
}

export async function createRankingSet(
  payload: CreateSetPayload,
): Promise<{ setId: string; report: MatchReport }> {
  const body = await post("/api/ranking-sets", payload);
  const r = isRecord(body) ? body : {};
  const setId = (isRecord(r.set) ? str(r.set.id) : null) ?? str(r.id) ?? str(r.setId);
  if (!setId) throw new ApiError("Upload succeeded but no set id was returned", 500);
  return { setId, report: coerceReport(r) };
}

export async function postResolution(
  setId: string,
  entryId: string,
  action: ResolutionAction,
  playerId?: string,
): Promise<void> {
  await post(`/api/ranking-sets/${setId}/resolutions`, {
    entryId,
    playerId: action === "MATCH" ? (playerId ?? null) : null,
    exclude: action === "EXCLUDE" ? true : undefined,
  });
}

export async function finalizeSet(setId: string): Promise<void> {
  await post(`/api/ranking-sets/${setId}/finalize`, {});
}

export async function fetchPlayersIndex(): Promise<IndexPlayer[]> {
  const body = await request("/api/players/index");
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.players)
      ? body.players
      : [];
  const out: IndexPlayer[] = [];
  for (const v of list) {
    if (!isRecord(v)) continue;
    const id = str(v.id) ?? str(v.playerId);
    const fullName = str(v.fullName) ?? str(v.name);
    if (!id || !fullName) continue;
    out.push({
      id,
      fullName,
      nameKey: str(v.nameKey) ?? undefined,
      pos: str(v.pos) ?? "",
      nflTeam: str(v.nflTeam) ?? str(v.team),
    });
  }
  return out;
}
