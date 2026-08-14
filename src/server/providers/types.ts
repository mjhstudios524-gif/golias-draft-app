import type { FlexEligibility, Pos, RosterSpec, ScoringConfig, SlotDef } from "@/engine/types";

// Provider abstraction contracts (PLAN.md §8). Pure types — no "server-only" —
// so the fixture-tested normalizers and the vitest suite import them freely.
// Sleeper is auth 'none'; the interface still threads optional credentials so
// ESPN (cookie) / Yahoo (oauth2) never force a redesign, and credentials never
// reach the browser.

export type ProviderAuthSpec = "none" | "cookie" | "oauth2";

export interface ProviderContext {
  /** Decrypted provider credentials (cookie jar / oauth tokens); absent for 'none'. */
  credentials?: Record<string, string>;
}

export type ProviderErrorKind = "NotFound" | "RateLimited" | "Upstream" | "Schema";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** Present for RateLimited/Upstream HTTP failures. */
  readonly status?: number;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}

/** What a pasted import ref resolves to. Draft URLs are accepted because
 * Sleeper's share links are draft-scoped; the flow walks draft → league. */
export type ParsedLeagueRef =
  | { kind: "league"; leagueId: string }
  | { kind: "draft"; draftId: string }
  | { kind: "username"; username: string };

export interface ProviderLeagueSummary {
  leagueId: string;
  name: string;
  season: string;
  numTeams: number;
}

/** One seat on the draft board (seat = provider draft slot, 1..numTeams). */
export interface TeamSeat {
  seat: number;
  name: string;
  providerUserId: string | null;
  rosterId: number | null;
}

export interface NormalizedLeagueSettings {
  numTeams: number;
  /** Ordered board slots in provider order, legacy label spellings. */
  rosterSlots: SlotDef[];
  /** Provider slot tokens we cannot draft (IDP etc.) — shown, never silent. */
  ignoredSlots: string[];
  isSuperflex: boolean;
  scoring: ScoringConfig;
  /** Seats when known (league rosters); refined per-draft by ProviderDraftState. */
  teamSeats: TeamSeat[];
  /** Derived engine shapes (rosterSlots folded down for League.rosterSpec). */
  rosterSpec: RosterSpec;
  flexEligibleBySlot: FlexEligibility;
}

export type ProviderDraftType = "snake" | "linear" | "auction";

export interface ProviderDraftSummary {
  draftId: string;
  status: string; // provider vocabulary: pre_draft | drafting | paused | complete
  type: ProviderDraftType;
  season: string;
  startTime: number | null; // epoch ms
}

/** The key convergence point (PLAN.md §8): one precomputed overall→seat array
 * honoring snake/linear, reversal_round and traded picks. Everything downstream
 * (survival horizon, board, my-next-pick) is source-agnostic through it. */
export interface ProviderDraftState {
  draftId: string;
  leagueId: string | null;
  status: string;
  type: ProviderDraftType;
  numTeams: number;
  rounds: number;
  pickTimerSec: number | null;
  reversalRound: number; // 0 = plain snake
  startTime: number | null;
  /** Provider user id → seat (Sleeper draft_order). */
  seatByUserId: Record<string, number>;
  /** Seat → provider roster id (Sleeper slot_to_roster_id); null for mocks. */
  rosterIdBySeat: Record<number, number> | null;
  /** Index overall-1 → seat. Length numTeams * rounds. */
  pickOwnerByOverall: number[];
}

export interface NormalizedPick {
  overall: number; // Sleeper pick_no
  seat: number; // Sleeper draft_slot
  round: number;
  providerPlayerId: string;
  pickedByUserId: string | null;
  /** Sleeper marks autopicks with picked_by === "". */
  autopick: boolean;
  /** Render fallback when providerPlayerId doesn't resolve locally (PLAN.md §8). */
  metadata: { name: string; pos: string | null; team: string | null } | null;
}

export interface PicksResult {
  notModified: boolean;
  /** null iff notModified. */
  picks: NormalizedPick[] | null;
  etag: string | null;
}

export interface ResolvedPlayer {
  id: string; // Player.id
  fullName: string;
  pos: Pos;
  nflTeam: string | null;
}

/**
 * DraftProvider (PLAN.md §8). `TLeague` is the provider's raw league bundle:
 * fetched by getLeague, consumed by the PURE fixture-tested
 * normalizeLeagueConfig — the split keeps all I/O out of normalization.
 */
export interface DraftProvider<TLeague = unknown> {
  id: string;
  authSpec: ProviderAuthSpec;
  parseLeagueRef(input: string): ParsedLeagueRef | null;
  listLeaguesForUser(
    ctx: ProviderContext,
    userRef: string,
    season: string,
  ): Promise<ProviderLeagueSummary[]>;
  getLeague(ctx: ProviderContext, leagueId: string): Promise<TLeague>;
  /** PURE. */
  normalizeLeagueConfig(league: TLeague): NormalizedLeagueSettings;
  listDrafts(ctx: ProviderContext, leagueId: string): Promise<ProviderDraftSummary[]>;
  getDraft(ctx: ProviderContext, draftId: string): Promise<ProviderDraftState>;
  getPicks(ctx: ProviderContext, draftId: string, opts?: { etag?: string | null }): Promise<PicksResult>;
  /** Batch provider id → local Player via Player.sleeperId-style crosswalks. */
  resolvePlayers(providerPlayerIds: string[]): Promise<Map<string, ResolvedPlayer>>;
}
