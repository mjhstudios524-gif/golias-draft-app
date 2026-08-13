import type {
  BaselineOptions,
  EnginePlayer,
  FlexEligibility,
  PlayerId,
  Pos,
  RosterSpec,
} from "./types";
import { BETA_1QB, BETA_MULTI_QB, computeBaselines, computeStarterDemand, type PointsByPos } from "./baseline";
import { leagueFormat } from "./format";

// PLAN.md §5 stage 1: VBD determines ORDERING only. Sorting by value desc
// yields rank (the valueRank ordinal) and every downstream module keeps
// consuming ordinals, so all tuned constants keep their calibrated meaning.

export interface ValueEntry {
  id: PlayerId;
  name: string;
  team: string;
  pos: Pos;
  adp: number | null;
  projPoints: number;
}

export interface RankOnlyEntry {
  id: PlayerId;
  name: string;
  team: string;
  pos: Pos;
  adp: number | null;
  sourceRank: number;
}

export interface ValueLeagueCtx {
  numTeams: number;
  rosterSpec: RosterSpec;
  flexEligibleBySlot: FlexEligibility;
  /** Default 0.5 blend (PLAN.md §5 decision). */
  lambda?: number;
  /** Default chosen by league format (BETA_1QB / BETA_MULTI_QB). */
  beta?: BaselineOptions["beta"];
}

function pointsByPos(entries: ValueEntry[]): PointsByPos {
  const byPos = { QB: [], RB: [], WR: [], TE: [], K: [], DEF: [] } as unknown as PointsByPos;
  entries.forEach((e) => byPos[e.pos]?.push(e.projPoints));
  (Object.keys(byPos) as Pos[]).forEach((pos) => byPos[pos].sort((a, b) => b - a));
  return byPos;
}

/** Deterministic ordering: value desc, then ADP asc (nulls last), then name. */
function compareForRank(a: { value: number; adp: number | null; name: string }, b: typeof a): number {
  if (b.value !== a.value) return b.value - a.value;
  const aAdp = a.adp ?? Infinity;
  const bAdp = b.adp ?? Infinity;
  if (aAdp !== bAdp) return aAdp - bAdp;
  return a.name.localeCompare(b.name);
}

/** Projections → VBD values → valueRank-ordinal EnginePlayers (Tiers A/B). */
export function computeValues(entries: ValueEntry[], ctx: ValueLeagueCtx): EnginePlayer[] {
  const format = leagueFormat(ctx.rosterSpec, ctx.flexEligibleBySlot);
  const lambda = ctx.lambda ?? 0.5;
  const beta = ctx.beta ?? (format === "MULTI_QB" ? BETA_MULTI_QB : BETA_1QB);

  const byPos = pointsByPos(entries);
  const demand = computeStarterDemand(byPos, ctx.numTeams, ctx.rosterSpec, ctx.flexEligibleBySlot);
  const { baselinePoints } = computeBaselines(byPos, demand, {
    lambda,
    beta,
    numTeams: ctx.numTeams,
    benchSlots: ctx.rosterSpec.BN,
  });

  const valued = entries.map((e) => ({
    ...e,
    value: e.projPoints - baselinePoints[e.pos],
  }));
  valued.sort(compareForRank);

  return valued.map((e, i) => ({
    id: e.id,
    name: e.name,
    team: e.team,
    pos: e.pos,
    rank: i + 1,
    adp: e.adp,
    projPoints: e.projPoints,
    value: e.value,
  }));
}

/**
 * Rank-only strict mode (v1 default for rank-only uploads; PLAN.md §14 #5):
 * value = −sourceRank, rank = sourceRank — the exact-legacy degeneration used
 * as the golden-parity harness.
 */
export function rankOnlyValues(entries: RankOnlyEntry[]): EnginePlayer[] {
  return entries
    .slice()
    .sort((a, b) => a.sourceRank - b.sourceRank)
    .map((e) => ({
      id: e.id,
      name: e.name,
      team: e.team,
      pos: e.pos,
      rank: e.sourceRank,
      adp: e.adp,
      value: -e.sourceRank,
    }));
}
