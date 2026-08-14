import { db } from "@/server/db";
import type {
  DraftProvider,
  PicksResult,
  ProviderContext,
  ProviderDraftState,
  ProviderDraftSummary,
  ProviderLeagueSummary,
  ResolvedPlayer,
} from "@/server/providers/types";
import { SleeperClient } from "@/server/providers/sleeper/client";
import {
  normalizeDraftType,
  normalizeSleeperDraft,
  normalizeSleeperLeague,
  normalizeSleeperPicks,
  parseSleeperLeagueRef,
  type SleeperLeagueBundle,
} from "@/server/providers/sleeper/normalize";

// Sleeper DraftProvider (PLAN.md §8): I/O glue only — all shape work lives in
// the pure, fixture-tested normalize module. Auth spec 'none'; the shared
// client is stateless so one instance serves every request.

const client = new SleeperClient();

/** Exposed for the import flow (username → league picker, seat linking). */
export function sleeperClient(): SleeperClient {
  return client;
}

export const sleeperProvider: DraftProvider<SleeperLeagueBundle> = {
  id: "sleeper",
  authSpec: "none",

  parseLeagueRef: parseSleeperLeagueRef,

  async listLeaguesForUser(
    _ctx: ProviderContext,
    userRef: string,
    season: string,
  ): Promise<ProviderLeagueSummary[]> {
    const leagues = await client.getUserLeagues(userRef, season);
    return leagues.map((l) => ({
      leagueId: l.league_id,
      name: l.name,
      season: l.season,
      numTeams: l.total_rosters,
    }));
  },

  async getLeague(_ctx: ProviderContext, leagueId: string): Promise<SleeperLeagueBundle> {
    const [league, users, rosters] = await Promise.all([
      client.getLeague(leagueId),
      client.getLeagueUsers(leagueId),
      client.getLeagueRosters(leagueId),
    ]);
    return { league, users, rosters };
  },

  normalizeLeagueConfig: normalizeSleeperLeague,

  async listDrafts(_ctx: ProviderContext, leagueId: string): Promise<ProviderDraftSummary[]> {
    const drafts = await client.getLeagueDrafts(leagueId);
    return drafts.map((d) => ({
      draftId: d.draft_id,
      status: d.status,
      type: normalizeDraftType(d.type),
      season: d.season,
      startTime: d.start_time ?? null,
    }));
  },

  async getDraft(_ctx: ProviderContext, draftId: string): Promise<ProviderDraftState> {
    const draft = await client.getDraft(draftId);
    const traded = draft.type === "auction" ? [] : await client.getDraftTradedPicks(draftId);
    return normalizeSleeperDraft(draft, traded);
  },

  async getPicks(
    _ctx: ProviderContext,
    draftId: string,
    opts: { etag?: string | null } = {},
  ): Promise<PicksResult> {
    const res = await client.getDraftPicks(draftId, { etag: opts.etag });
    if (res.notModified) return { notModified: true, picks: null, etag: res.etag };
    return { notModified: false, picks: normalizeSleeperPicks(res.data), etag: res.etag };
  },

  async resolvePlayers(providerPlayerIds: string[]): Promise<Map<string, ResolvedPlayer>> {
    const ids = [...new Set(providerPlayerIds)].filter(Boolean);
    if (ids.length === 0) return new Map();
    const rows = await db.player.findMany({
      where: { sleeperId: { in: ids } },
      select: { id: true, sleeperId: true, fullName: true, pos: true, nflTeam: true },
    });
    return new Map(
      rows.map((r) => [
        r.sleeperId as string,
        { id: r.id, fullName: r.fullName, pos: r.pos, nflTeam: r.nflTeam },
      ]),
    );
  },
};
