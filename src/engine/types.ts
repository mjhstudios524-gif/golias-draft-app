// Frozen engine contracts (PLAN.md §4 module map). Every module takes explicit
// parameters — no module-level state anywhere in src/engine.

export type Pos = "QB" | "RB" | "WR" | "TE" | "K" | "DEF";

/** Injected randomness source — replaces every legacy Math.random call site. */
export type Rng = () => number;

/** Legacy fixtures use numeric ids; production uses Player.id / 'custom:<hash>'. Opaque to the engine. */
export type PlayerId = number | string;

export interface RosterSpec {
  QB: number;
  RB: number;
  WR: number;
  TE: number;
  FLEX: number;
  DEF: number;
  K: number;
  BN: number;
}

/** Eligibility list per FLEX slot, index-aligned with the slot order. */
export type FlexEligibility = Pos[][];

/** Which draft market an ADP/rankings source was measured in (PLAN.md §5). */
export type AdpContext = "1QB" | "SF" | "UNKNOWN";

/** '1QB' | 'MULTI_QB' — derived by format.ts, never stored. */
export type LeagueFormat = "1QB" | "MULTI_QB";

export interface DraftConfig {
  numTeams: number;
  /** Round-1 pick order as team ids (1..numTeams, arbitrary order). */
  teamOrder: number[];
  teamNames: Record<number, string>;
  rosterSpec: RosterSpec;
  flexEligibleBySlot: FlexEligibility;
  myTeamId: number;
  mockDraft: boolean;
  /** Injected per-season bye map, canonical team codes only (never hardcoded). */
  byeWeeks: Record<string, number>;
  /** ADP market of the active ranking source — drives the QB-ADP-nulling rule. */
  adpContext: AdpContext;
}

/**
 * A player in the session's resolved pool. `rank` is the overall ordinal the
 * engine's math runs on: sourceRank in rank mode, valueRank in VBD mode
 * (PLAN.md §5 "everything ordinal stays ordinal").
 */
export interface EnginePlayer {
  id: PlayerId;
  name: string;
  team: string; // canonical code; 'FA' allowed (byeWeekFor → null)
  pos: Pos;
  rank: number; // 1-based overall ordinal
  adp: number | null;
  projPoints?: number; // present in POINTS/FULL_STATS tiers
  value?: number; // VBD value (points over baseline); absent in rank mode
}

export interface Pick {
  overall: number;
  round: number;
  pickInRound: number;
  teamId: number;
  playerId: PlayerId;
}

/** The whole draft. Everything else is derived (PLAN.md §3 invariant). */
export interface DraftState {
  config: DraftConfig;
  picks: Pick[];
  queue: PlayerId[];
  recPos: Pos[];
}

/** Immutable per-session player pool + derived lookups (built once). */
export interface PlayerPool {
  players: EnginePlayer[]; // as provided; not necessarily sorted
  byId: ReadonlyMap<PlayerId, EnginePlayer>;
  /** From computeTiers — replaces the legacy p.tier mutation. */
  tiers: ReadonlyMap<PlayerId, number>;
}

// ---------------- Roster slots ----------------

export interface SlotDef {
  type: Pos | "FLEX" | "BN";
  /** Exact legacy spellings: QB1..QBn, FLEX/FLEX2..., DEF/DEF2..., K/K2..., BN1.. */
  label: string;
  /** FLEX slots only. */
  eligible?: Pos[];
}

export interface FilledSlot extends SlotDef {
  player: EnginePlayer | null;
  pickOverall?: number;
}

export interface RosterAssignment {
  slots: FilledSlot[];
  overflow: { player: EnginePlayer; overall: number }[];
}

export interface TeamNeeds {
  neededPositions: Set<Pos>;
  // NOTE: legacy bnOpen is intentionally dropped (behavior-change register #3).
}

// ---------------- Outlook / recommendations ----------------

export interface PositionOutlook {
  now: EnginePlayer | null;
  next: EnginePlayer | null;
  /** rank-unit drop; 80 sentinel when no successor exists. */
  drop: number;
}

export type Reason =
  | { code: "BEST_OVERALL" }
  | { code: "GONE_SOON"; adp: number }
  | { code: "BIG_DROP"; pos: Pos }
  | { code: "THINS_OUT"; pos: Pos }
  | { code: "TIER_LAST_FEW"; n: number; pos: Pos } // tierLeft <= 2 ("Only {n} left...")
  | { code: "TIER_FEW"; n: number; pos: Pos } // tierLeft <= 4 ("{n} left...")
  | { code: "WILL_WAIT"; adp: number }
  | { code: "FALLING"; picksLater: number }
  | { code: "BYE_STACK"; bye: number }
  | { code: "STRONG_VALUE"; pos: Pos };

export interface ScoreBreakdown {
  base: number; // -rank
  drop: number; // 0.55 * drop
  tierBonus: number; // +7 | +3 | 0
  byePenalty: number; // -4 | 0
  survivalNudge: number; // -5 | +5 | 0
}

export interface Recommendation {
  player: EnginePlayer;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  drop: number;
  next: EnginePlayer | null;
  tierLeft: number;
  bye: number | null;
  byeClash: boolean;
  surv: number | null;
  adp: number | null;
  /** All fired reasons in legacy priority order (before the keep-2 truncation). */
  reasons: Reason[];
  /** Legacy-identical string: first 2 reasons joined with ' · '. */
  reason: string;
}

export interface ScarcityItem {
  pos: Pos;
  tier: number;
  tierLeft: number;
  severity: "crit" | "warn" | "";
}

// ---------------- Scoring / VBD (PLAN.md §5) ----------------

/** Canonical stat vocabulary = Sleeper scoring_settings keys, extensible. */
export type StatKey = string;

export type StatLine = Partial<Record<StatKey, number>>;

export interface ScoringConfig {
  name: string;
  weights: Partial<Record<StatKey, number>>;
  /** Positional modifiers; TE premium = posWeights.TE.rec (⇄ Sleeper bonus_rec_te). */
  posWeights?: Partial<Record<Pos, Partial<Record<StatKey, number>>>>;
}

/** Per-position count of league-wide startable players (dedicated + flex-sim share). */
export type StarterDemand = Record<Pos, number>;

export interface BaselineOptions {
  /** 0 = VOLS, 1 = VORP; default 0.5 blend (PLAN.md §5). */
  lambda: number;
  /** Bench-propensity vector; K/DEF always 0. */
  beta: Record<Pos, number>;
}

export interface BaselineResult {
  demand: StarterDemand;
  /** Index (1-based count) of the baseline player per position after the lambda blend. */
  baselineIndex: Record<Pos, number>;
  baselinePoints: Record<Pos, number>;
}
