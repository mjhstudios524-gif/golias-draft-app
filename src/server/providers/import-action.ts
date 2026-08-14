"use server";

import { z } from "zod";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { assertCanCreateLeague, assertEntitled, PaywallError } from "@/server/entitlements";
import { CURRENT_SEASON, scoringConfigSchema } from "@/lib/leagues";
import { totalRounds } from "@/engine/snake";
import type { RosterSpec, ScoringConfig } from "@/engine/types";
import { snapshotV1, type SnapshotV1 } from "@/server/sessions";
import { buildSnapshotPlayers, mapAdpContext } from "@/server/snapshot-players";
import { ProviderError, type TeamSeat } from "@/server/providers/types";
import { sleeperClient, sleeperProvider } from "@/server/providers/sleeper";
import {
  normalizeSleeperDraft,
  normalizeSleeperLeague,
  parseSleeperLeagueRef,
  seatsFromDraft,
  type SleeperLeagueBundle,
} from "@/server/providers/sleeper/normalize";

// Sleeper import flow actions (PLAN.md §8): paste ref → (league picker) →
// confirmation preview → League (+ optional SLEEPER_SYNC session). Every action
// re-derives the user and re-fetches provider truth — client payloads carry
// choices, never settings.

const AUCTION_MESSAGE =
  "Auction drafts aren't supported — GOLIAS covers snake and linear drafts only (PLAN.md §8).";

// ---------------- Result shapes (types only — erased from the action module) ----------------

export interface SleeperDraftOption {
  draftId: string;
  status: string;
  type: string;
  season: string;
  startTime: number | null;
  /** false = auction (capability-gated out with `message`). */
  supported: boolean;
  /** Non-complete + supported → offer live sync. */
  syncable: boolean;
  message: string | null;
}

export interface SleeperImportPreview {
  leagueId: string;
  name: string;
  season: string;
  numTeams: number;
  scoringName: string;
  ppr: number;
  tePremium: number;
  passTd: number;
  rosterSlots: { label: string; type: string; eligible: string[] | null }[];
  ignoredSlots: string[];
  isSuperflex: boolean;
  seats: { seat: number; name: string; providerUserId: string | null }[];
  /** Auto-detected via the stored User.sleeperUserId (decision #7). */
  detectedSeat: number | null;
  linkedSleeperUsername: boolean;
  drafts: SleeperDraftOption[];
  /** Roster counts clamped into app caps, if any (disclosed, never silent). */
  clampNotes: string[];
}

export type SleeperLookupResult =
  | { ok: true; kind: "preview"; preview: SleeperImportPreview }
  | {
      ok: true;
      kind: "leagues";
      username: string;
      season: string;
      leagues: { leagueId: string; name: string; season: string; numTeams: number }[];
    }
  | { ok: false; error: string };

export type SleeperImportResult =
  | { ok: true; leagueId: string; sessionId: string | null }
  | { ok: false; error: string };

// ---------------- Internals ----------------

function providerErrorMessage(e: unknown): string {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case "NotFound":
        return "Sleeper couldn't find that — double-check the league URL, ID, or username.";
      case "RateLimited":
        return "Sleeper is rate-limiting requests — wait a minute and try again.";
      case "Schema":
        return "Sleeper returned an unexpected response shape — try again, and report this if it persists.";
      default:
        return "Sleeper is unreachable right now — try again shortly.";
    }
  }
  throw e;
}

/** Caps mirror rosterSpecSchema (lib/leagues.ts) so the stored League row stays
 * readable by readLeagueRosterSpec. Clamps are disclosed in the preview. */
const SPEC_CAPS: Record<keyof RosterSpec, number> = {
  QB: 6, RB: 6, WR: 6, TE: 6, FLEX: 6, DEF: 3, K: 3, BN: 15,
};

function clampRosterSpec(spec: RosterSpec): { spec: RosterSpec; notes: string[] } {
  const out = { ...spec };
  const notes: string[] = [];
  for (const key of Object.keys(SPEC_CAPS) as (keyof RosterSpec)[]) {
    if (out[key] > SPEC_CAPS[key]) {
      notes.push(`${key} slots reduced ${out[key]} → ${SPEC_CAPS[key]} (app limit)`);
      out[key] = SPEC_CAPS[key];
    }
  }
  return { spec: out, notes };
}

async function fetchBundle(leagueId: string): Promise<SleeperLeagueBundle> {
  return (await sleeperProvider.getLeague({}, leagueId)) as SleeperLeagueBundle;
}

async function buildPreview(userId: string, leagueId: string): Promise<SleeperImportPreview> {
  const bundle = await fetchBundle(leagueId);
  const normalized = normalizeSleeperLeague(bundle);
  const drafts = await sleeperClient().getLeagueDrafts(leagueId);

  const draftOptions: SleeperDraftOption[] = drafts.map((d) => {
    const supported = d.type !== "auction";
    return {
      draftId: d.draft_id,
      status: d.status,
      type: d.type,
      season: d.season,
      startTime: d.start_time ?? null,
      supported,
      syncable: supported && d.status !== "complete",
      message: supported ? null : AUCTION_MESSAGE,
    };
  });

  // Seats come from the first syncable draft's board when one exists (that is
  // the board a session would use); league rosters otherwise.
  let seats: TeamSeat[] = normalized.teamSeats;
  let detectedSeat: number | null = null;
  const me = await db.user.findUnique({ where: { id: userId }, select: { sleeperUserId: true } });
  const firstSyncable = draftOptions.find((d) => d.syncable);
  if (firstSyncable) {
    const draft = await sleeperClient().getDraft(firstSyncable.draftId);
    seats = seatsFromDraft(draft, bundle.users, bundle.rosters);
  }
  if (me?.sleeperUserId) {
    detectedSeat = seats.find((s) => s.providerUserId === me.sleeperUserId)?.seat ?? null;
  }

  const { notes } = clampRosterSpec(normalized.rosterSpec);

  return {
    leagueId,
    name: bundle.league.name,
    season: bundle.league.season,
    numTeams: normalized.numTeams,
    scoringName: normalized.scoring.name,
    ppr: normalized.scoring.weights.rec ?? 0,
    tePremium: normalized.scoring.posWeights?.TE?.rec ?? 0,
    passTd: normalized.scoring.weights.pass_td ?? 0,
    rosterSlots: normalized.rosterSlots.map((s) => ({
      label: s.label,
      type: s.type,
      eligible: s.eligible ? [...s.eligible] : null,
    })),
    ignoredSlots: normalized.ignoredSlots,
    isSuperflex: normalized.isSuperflex,
    seats: seats.map((s) => ({ seat: s.seat, name: s.name, providerUserId: s.providerUserId })),
    detectedSeat,
    linkedSleeperUsername: !!me?.sleeperUserId,
    drafts: draftOptions,
    clampNotes: notes,
  };
}

// ---------------- Actions ----------------

const lookupInput = z.object({ ref: z.string().trim().min(1).max(200) });

export async function lookupSleeper(raw: unknown): Promise<SleeperLookupResult> {
  const userId = await requireUser();
  const parsed = lookupInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Enter a Sleeper league URL, league ID, or username" };

  const ref = parseSleeperLeagueRef(parsed.data.ref);
  if (!ref) {
    return {
      ok: false,
      error: "That doesn't look like a Sleeper league URL, league ID, or username.",
    };
  }

  try {
    if (ref.kind === "username") {
      const user = await sleeperClient().getUserByUsername(ref.username);
      const season = (await sleeperClient().getNflState()).season;
      const leagues = await sleeperProvider.listLeaguesForUser({}, user.user_id, season);
      if (leagues.length === 0) {
        return { ok: false, error: `No ${season} Sleeper leagues found for @${ref.username}.` };
      }
      return { ok: true, kind: "leagues", username: ref.username, season, leagues };
    }
    let leagueId: string;
    if (ref.kind === "draft") {
      const draft = await sleeperClient().getDraft(ref.draftId);
      if (!draft.league_id) {
        return { ok: false, error: "That draft isn't attached to a league (mock drafts can't be imported)." };
      }
      leagueId = draft.league_id;
    } else {
      leagueId = ref.leagueId;
    }
    return { ok: true, kind: "preview", preview: await buildPreview(userId, leagueId) };
  } catch (e) {
    return { ok: false, error: providerErrorMessage(e) };
  }
}

const previewInput = z.object({ leagueId: z.string().regex(/^\d+$/) });

export async function previewSleeperLeague(raw: unknown): Promise<SleeperLookupResult> {
  const userId = await requireUser();
  const parsed = previewInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Missing league id" };
  try {
    return { ok: true, kind: "preview", preview: await buildPreview(userId, parsed.data.leagueId) };
  } catch (e) {
    return { ok: false, error: providerErrorMessage(e) };
  }
}

const importInput = z.object({
  leagueId: z.string().regex(/^\d+$/),
  /** Optional one-time link (decision #7) — saved as User.sleeperUserId. */
  linkSleeperUsername: z.string().trim().max(64).nullish(),
  createSession: z
    .object({
      draftId: z.string().regex(/^\d+$/),
      rankingSetId: z.string().min(1),
      mySeat: z.number().int().min(1),
    })
    .nullish(),
});

export async function importSleeperLeague(raw: unknown): Promise<SleeperImportResult> {
  const userId = await requireUser();
  const parsed = importInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid import request" };
  }
  const input = parsed.data;

  try {
    const bundle = await fetchBundle(input.leagueId);
    const normalized = normalizeSleeperLeague(bundle);

    if (normalized.numTeams < 4 || normalized.numTeams > 20) {
      return { ok: false, error: `${normalized.numTeams}-team leagues aren't supported (4–20).` };
    }

    if (input.linkSleeperUsername) {
      try {
        const sleeperUser = await sleeperClient().getUserByUsername(input.linkSleeperUsername);
        await db.user.update({ where: { id: userId }, data: { sleeperUserId: sleeperUser.user_id } });
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === "NotFound")) throw e;
        return { ok: false, error: `Sleeper username "${input.linkSleeperUsername}" doesn't exist.` };
      }
    }

    const { spec: clampedSpec } = clampRosterSpec(normalized.rosterSpec);
    const leagueData = {
      name: bundle.league.name.slice(0, 80) || "Sleeper League",
      seasonYear: CURRENT_SEASON,
      provider: "sleeper",
      providerLeagueId: input.leagueId,
      numTeams: normalized.numTeams,
      // ScoringConfig with the raw provider blob alongside (PLAN.md §7) —
      // scoringConfigSchema strips the extra key at every read boundary.
      scoring: {
        ...normalized.scoring,
        raw: { source: "sleeper", scoring_settings: bundle.league.scoring_settings },
      },
      rosterSpec: {
        ...clampedSpec,
        flexEligibleBySlot: normalized.flexEligibleBySlot,
        ignoredSlots: normalized.ignoredSlots,
      },
    };

    // Idempotent by (user, provider league): re-importing refreshes settings
    // instead of stacking duplicate League rows.
    const existing = await db.league.findFirst({
      where: { userId, provider: "sleeper", providerLeagueId: input.leagueId },
      select: { id: true },
    });
    // §9 matrix: settings import is free into the one free league; the free-tier
    // league quota applies to NEW league rows only (re-import always allowed).
    if (!existing) {
      try {
        await assertCanCreateLeague(userId);
      } catch (e) {
        if (e instanceof PaywallError) {
          return { ok: false, error: "Free tier includes one league — unlock the season pass for unlimited leagues." };
        }
        throw e;
      }
    }
    const league = existing
      ? await db.league.update({ where: { id: existing.id }, data: leagueData })
      : await db.league.create({ data: { userId, ...leagueData } });

    let sessionId: string | null = null;
    if (input.createSession) {
      // §9 matrix: LIVE draft sync is a paid feature (the poll route re-checks too).
      try {
        await assertEntitled(userId, "sleeper-live-sync");
      } catch (e) {
        if (e instanceof PaywallError) {
          return {
            ok: false,
            error: "Live Sleeper draft sync needs the season pass — the league itself was imported.",
          };
        }
        throw e;
      }
      const result = await createSleeperSession({
        userId,
        leagueId: league.id,
        bundle,
        clampedSpec,
        flexEligibleBySlot: normalized.flexEligibleBySlot,
        leagueScoring: normalized.scoring,
        ...input.createSession,
      });
      if (!result.ok) return result;
      sessionId = result.sessionId;
    }
    return { ok: true, leagueId: league.id, sessionId };
  } catch (e) {
    return { ok: false, error: providerErrorMessage(e) };
  }
}

// ---------------- SLEEPER_SYNC session creation ----------------

// Replicates createSession's snapshot glue (sessions-create.ts) rather than
// importing it: that module is "use server" (actions only — it can't export
// its inline snapshot steps), and its input contract is manual/mock-shaped.
// The heavy lifting (buildSnapshotPlayers, snapshotV1) is shared already.
async function createSleeperSession(args: {
  userId: string;
  leagueId: string;
  bundle: SleeperLeagueBundle;
  clampedSpec: RosterSpec;
  flexEligibleBySlot: SnapshotV1["flexEligibleBySlot"];
  leagueScoring: ScoringConfig;
  draftId: string;
  rankingSetId: string;
  mySeat: number;
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const { userId, leagueId, bundle, draftId, rankingSetId, mySeat } = args;

  // Idempotency: providerDraftId is unique — a re-import resumes the session.
  const existing = await db.draftSession.findUnique({
    where: { providerDraftId: draftId },
    select: { id: true, userId: true },
  });
  if (existing) {
    if (existing.userId === userId) return { ok: true, sessionId: existing.id };
    return { ok: false, error: "That Sleeper draft is already synced by another account." };
  }

  const rawDraft = await sleeperClient().getDraft(draftId);
  const traded = rawDraft.type === "auction" ? [] : await sleeperClient().getDraftTradedPicks(draftId);
  const draft = normalizeSleeperDraft(rawDraft, traded);

  if (draft.type === "auction") return { ok: false, error: AUCTION_MESSAGE };
  if (draft.status === "complete") {
    return { ok: false, error: "That draft is complete — the league was imported without a live session." };
  }
  if (draft.leagueId !== bundle.league.league_id) {
    return { ok: false, error: "That draft doesn't belong to the imported league." };
  }
  const n = draft.numTeams;
  if (mySeat < 1 || mySeat > n) return { ok: false, error: "Pick a seat inside the draft." };

  // The board is draft.rounds long; bench absorbs any roster/rounds mismatch
  // (keeper drafts run short) so totalPicks matches provider truth exactly.
  const spec = { ...args.clampedSpec };
  const diff = draft.rounds - totalRounds(spec);
  if (spec.BN + diff < 0) {
    return {
      ok: false,
      error: `This draft has only ${draft.rounds} rounds but the roster has ${
        totalRounds(spec) - spec.BN
      } starters — keeper drafts shorter than the starting lineup aren't supported yet.`,
    };
  }
  spec.BN += diff;

  const set = await db.rankingSet.findUnique({
    where: { id: rankingSetId },
    include: { entries: { orderBy: { sourceRow: "asc" } } },
  });
  if (!set || set.status !== "READY" || (set.userId != null && set.userId !== userId)) {
    return { ok: false, error: "That ranking set is not available (it must be READY)" };
  }

  const matchedIds = set.entries.flatMap((e) => (e.playerId ? [e.playerId] : []));
  const [playerRows, byeRows] = await Promise.all([
    matchedIds.length
      ? db.player.findMany({
          where: { id: { in: matchedIds } },
          select: { id: true, fullName: true, pos: true, nflTeam: true },
        })
      : Promise.resolve([]),
    db.teamBye.findMany({ where: { seasonYear: CURRENT_SEASON } }),
  ]);

  // FULL_STATS prices stat lines under this league's scoring; other tiers
  // never read it (same rule as sessions-create.ts).
  let scoring: z.infer<typeof scoringConfigSchema> = { name: "unset", weights: {} };
  if (set.dataTier === "FULL_STATS") {
    const sc = scoringConfigSchema.safeParse(args.leagueScoring);
    if (!sc.success) return { ok: false, error: "Imported scoring settings are unreadable" };
    scoring = sc.data;
  }

  const { players } = buildSnapshotPlayers({
    setId: set.id,
    tier: set.dataTier,
    entries: set.entries,
    matched: new Map(playerRows.map((p) => [p.id, p])),
    ctx: { numTeams: n, rosterSpec: spec, flexEligibleBySlot: args.flexEligibleBySlot, scoring },
  });
  if (players.length === 0) {
    return { ok: false, error: "That ranking set has no draftable players for this league" };
  }

  const seats = seatsFromDraft(rawDraft, bundle.users, bundle.rosters);
  const teamNames = Object.fromEntries(seats.map((s) => [String(s.seat), s.name]));

  const snapshot = snapshotV1.parse({
    v: 1,
    numTeams: n,
    // Seat ids ARE round-1 order for provider boards; deviations (3RR, trades)
    // live in sleeper.pickOwnerByOverall below, not in teamOrder.
    teamOrder: Array.from({ length: n }, (_, i) => i + 1),
    teamNames,
    rosterSpec: spec,
    flexEligibleBySlot: args.flexEligibleBySlot,
    myTeamId: mySeat,
    byeWeeks: Object.fromEntries(byeRows.map((b) => [b.teamCode, b.week])),
    adpContext: mapAdpContext(set.adpContext),
    rngSeed: Math.floor(Math.random() * 2 ** 31),
    players,
  });

  const session = await db.draftSession.create({
    data: {
      userId,
      leagueId,
      mode: "SLEEPER_SYNC",
      providerDraftId: draftId,
      config: {
        ...snapshot,
        // Provider block for the live-sync route (PLAN.md §8). snapshotV1.parse
        // strips it for the room; the sync layer reads it with its own schema.
        sleeper: {
          providerDraftId: draftId,
          providerLeagueId: bundle.league.league_id,
          type: draft.type,
          reversalRound: draft.reversalRound,
          pickTimerSec: draft.pickTimerSec,
          pickOwnerByOverall: draft.pickOwnerByOverall,
          rosterIdBySeat: draft.rosterIdBySeat,
          seatByUserId: draft.seatByUserId,
        },
      },
    },
  });

  // Seed the pull-through cache row as already-stale: the first /live poll
  // claims the lease and does the initial ingest (PLAN.md §8 cadence).
  await db.draftSync.upsert({
    where: { sessionId: session.id },
    update: {},
    create: {
      sessionId: session.id,
      providerStatus: draft.status,
      syncedAt: new Date(0),
      ttlSec: draft.status === "pre_draft" ? 60 : 4,
    },
  });

  return { ok: true, sessionId: session.id };
}
