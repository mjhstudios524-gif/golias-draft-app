import { z } from "zod";
import { ProviderError } from "@/server/providers/types";

// Sleeper HTTP client (PLAN.md §8 verified surface): read-only, no auth,
// ETags honored. Schemas are .loose() — Sleeper is an undocumented contract,
// so unknown keys pass through and NOVEL keys are logged once per endpoint
// rather than ever failing a live draft.

const BASE_URL = "https://api.sleeper.app/v1";
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------- Schemas (fields we consume; everything else passes through) ----------------

export const sleeperUserSchema = z
  .object({
    user_id: z.string(),
    username: z.string().nullish(),
    display_name: z.string().nullish(),
  })
  .loose();

export const sleeperLeagueSchema = z
  .object({
    league_id: z.string(),
    name: z.string(),
    season: z.string(),
    status: z.string(),
    total_rosters: z.number().int(),
    roster_positions: z.array(z.string()),
    scoring_settings: z.record(z.string(), z.number().nullable()),
    draft_id: z.string().nullish(),
  })
  .loose();

export const sleeperLeagueUserSchema = z
  .object({
    user_id: z.string(),
    display_name: z.string().nullish(),
    metadata: z.object({ team_name: z.string().nullish() }).loose().nullish(),
  })
  .loose();

export const sleeperRosterSchema = z
  .object({
    roster_id: z.number().int(),
    owner_id: z.string().nullish(),
  })
  .loose();

export const sleeperDraftSchema = z
  .object({
    draft_id: z.string(),
    league_id: z.string().nullish(),
    type: z.string(),
    status: z.string(),
    season: z.string(),
    start_time: z.number().nullish(),
    settings: z
      .object({
        teams: z.number().int(),
        rounds: z.number().int(),
        pick_timer: z.number().nullish(),
        reversal_round: z.number().nullish(),
      })
      .loose(),
    // user_id → slot; null before order assignment.
    draft_order: z.record(z.string(), z.number().int()).nullish(),
    // slot (string key) → roster_id; null for mock drafts.
    slot_to_roster_id: z.record(z.string(), z.number().int()).nullish(),
  })
  .loose();

export const sleeperPickSchema = z
  .object({
    pick_no: z.number().int(),
    round: z.number().int(),
    draft_slot: z.number().int(),
    player_id: z.string(),
    picked_by: z.string(), // "" = autopick (verified fixture behavior)
    roster_id: z.number().int().nullish(),
    is_keeper: z.boolean().nullish(),
    metadata: z
      .object({
        first_name: z.string().nullish(),
        last_name: z.string().nullish(),
        position: z.string().nullish(),
        team: z.string().nullish(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export const sleeperTradedPickSchema = z
  .object({
    season: z.string(),
    round: z.number().int(),
    roster_id: z.number().int(), // original owner's roster
    previous_owner_id: z.number().int().nullish(),
    owner_id: z.number().int(), // current owner's roster
  })
  .loose();

export const sleeperNflStateSchema = z
  .object({
    season: z.string(),
    league_season: z.string().nullish(),
    season_type: z.string().nullish(),
  })
  .loose();

export type SleeperUser = z.infer<typeof sleeperUserSchema>;
export type SleeperLeague = z.infer<typeof sleeperLeagueSchema>;
export type SleeperLeagueUser = z.infer<typeof sleeperLeagueUserSchema>;
export type SleeperRoster = z.infer<typeof sleeperRosterSchema>;
export type SleeperDraft = z.infer<typeof sleeperDraftSchema>;
export type SleeperPick = z.infer<typeof sleeperPickSchema>;
export type SleeperTradedPick = z.infer<typeof sleeperTradedPickSchema>;
export type SleeperNflState = z.infer<typeof sleeperNflStateSchema>;

// ---------------- Unknown-key logging ----------------

// Keys observed in recorded fixtures (2026-08) that we deliberately don't
// consume. Anything NOT in schema shape ∪ this list is genuinely novel and
// logged once per endpoint+key, so a mid-season contract shift is visible in
// logs without ever breaking a draft.
const EXPECTED_EXTRA_KEYS: Record<string, readonly string[]> = {
  league: [
    "metadata", "settings", "avatar", "company_id", "season_type", "shard", "sport",
    "last_message_id", "last_author_avatar", "last_author_display_name", "last_author_id",
    "last_author_is_bot", "last_message_attachment", "last_message_text_map",
    "last_message_time", "last_pinned_message_id", "last_read_id", "previous_league_id",
    "group_id", "bracket_id", "bracket_overrides_id", "loser_bracket_id",
    "loser_bracket_overrides_id",
  ],
  user: ["avatar", "is_bot", "metadata", "is_owner", "league_id", "settings"],
  roster: ["players", "starters", "reserve", "taxi", "settings", "metadata", "league_id", "co_owners", "keepers", "player_map"],
  draft: [
    "created", "creators", "last_message_id", "last_message_time", "last_picked",
    "metadata", "season_type", "sport",
  ],
  pick: ["draft_id", "reactions"],
  traded_pick: [],
  nfl_state: [
    "week", "leg", "previous_season", "season_start_date", "display_week",
    "league_create_season", "season_has_scores",
  ],
};

const loggedNovelKeys = new Set<string>();

export function logUnknownKeys(endpoint: string, shapeKeys: Iterable<string>, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const known = new Set([...shapeKeys, ...(EXPECTED_EXTRA_KEYS[endpoint] ?? [])]);
  for (const key of Object.keys(value)) {
    if (known.has(key)) continue;
    const sig = `${endpoint}.${key}`;
    if (loggedNovelKeys.has(sig)) continue;
    loggedNovelKeys.add(sig);
    console.warn(`[sleeper] novel key in ${endpoint} response: ${key}`);
  }
}

// ---------------- Client ----------------

export interface SleeperClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type OkResult<T> = { notModified: false; data: T; etag: string | null };
type NotModifiedResult = { notModified: true; data: null; etag: string | null };

export class SleeperClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SleeperClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** GET + zod parse. `etag` sends If-None-Match; 304 → notModified. */
  private async get<S extends z.ZodType>(
    path: string,
    schema: S,
    endpoint: string,
    opts: { etag?: string | null } = {},
  ): Promise<OkResult<z.output<S>> | NotModifiedResult> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.etag) headers["if-none-match"] = opts.etag;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      throw new ProviderError("Upstream", `sleeper fetch failed for ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (res.status === 304) return { notModified: true, data: null, etag: res.headers.get("etag") ?? opts.etag ?? null };
    if (res.status === 404) throw new ProviderError("NotFound", `sleeper: ${path} not found`, 404);
    if (res.status === 429) throw new ProviderError("RateLimited", `sleeper: rate limited on ${path}`, 429);
    if (!res.ok) throw new ProviderError("Upstream", `sleeper: HTTP ${res.status} on ${path}`, res.status);

    let raw: unknown;
    try {
      raw = await res.json();
    } catch {
      throw new ProviderError("Schema", `sleeper: non-JSON body on ${path}`);
    }
    // Sleeper 200s with a literal null body for unknown ids/usernames.
    if (raw === null) throw new ProviderError("NotFound", `sleeper: ${path} returned null`, 200);

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        "Schema",
        `sleeper: unexpected shape on ${path}: ${parsed.error.issues[0]?.message ?? "parse error"}`,
      );
    }
    const shapeKeys =
      schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
    if (Array.isArray(parsed.data)) {
      const itemSchema = schema instanceof z.ZodArray ? schema.element : null;
      const itemKeys = itemSchema instanceof z.ZodObject ? Object.keys(itemSchema.shape) : [];
      for (const item of parsed.data.slice(0, 3)) logUnknownKeys(endpoint, itemKeys, item);
    } else {
      logUnknownKeys(endpoint, shapeKeys, parsed.data);
    }
    return { notModified: false, data: parsed.data, etag: res.headers.get("etag") };
  }

  private async getData<S extends z.ZodType>(path: string, schema: S, endpoint: string): Promise<z.output<S>> {
    const res = await this.get(path, schema, endpoint);
    // no etag sent → 304 impossible
    return (res as OkResult<z.output<S>>).data;
  }

  getNflState(): Promise<SleeperNflState> {
    return this.getData("/state/nfl", sleeperNflStateSchema, "nfl_state");
  }

  getUserByUsername(username: string): Promise<SleeperUser> {
    return this.getData(`/user/${encodeURIComponent(username)}`, sleeperUserSchema, "user");
  }

  getUserLeagues(userId: string, season: string): Promise<SleeperLeague[]> {
    return this.getData(
      `/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`,
      z.array(sleeperLeagueSchema),
      "league",
    );
  }

  getLeague(leagueId: string): Promise<SleeperLeague> {
    return this.getData(`/league/${encodeURIComponent(leagueId)}`, sleeperLeagueSchema, "league");
  }

  getLeagueUsers(leagueId: string): Promise<SleeperLeagueUser[]> {
    return this.getData(`/league/${encodeURIComponent(leagueId)}/users`, z.array(sleeperLeagueUserSchema), "user");
  }

  getLeagueRosters(leagueId: string): Promise<SleeperRoster[]> {
    return this.getData(`/league/${encodeURIComponent(leagueId)}/rosters`, z.array(sleeperRosterSchema), "roster");
  }

  getLeagueDrafts(leagueId: string): Promise<SleeperDraft[]> {
    return this.getData(`/league/${encodeURIComponent(leagueId)}/drafts`, z.array(sleeperDraftSchema), "draft");
  }

  getDraft(draftId: string): Promise<SleeperDraft> {
    return this.getData(`/draft/${encodeURIComponent(draftId)}`, sleeperDraftSchema, "draft");
  }

  getDraftTradedPicks(draftId: string): Promise<SleeperTradedPick[]> {
    return this.getData(
      `/draft/${encodeURIComponent(draftId)}/traded_picks`,
      z.array(sleeperTradedPickSchema),
      "traded_pick",
    );
  }

  /** ETag-aware — the live-sync hot path (PLAN.md §8: 304 = cheap no-op). */
  getDraftPicks(
    draftId: string,
    opts: { etag?: string | null } = {},
  ): Promise<OkResult<SleeperPick[]> | NotModifiedResult> {
    return this.get(`/draft/${encodeURIComponent(draftId)}/picks`, z.array(sleeperPickSchema), "pick", opts);
  }
}
