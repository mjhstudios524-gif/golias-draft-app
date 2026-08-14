import "server-only";
import { z } from "zod";
import { db } from "@/server/db";
import type { DraftStatus, DraftMode } from "@/generated/prisma/client";
import { ProviderError, type DraftProvider } from "@/server/providers/types";
import { sleeperProvider } from "@/server/providers/sleeper";

// Live-draft pull-through sync engine (PLAN.md §8 "Live sync"). Clients poll
// our /live route; this module is the only thing that talks to the provider.
// Flow: freshness gate → single-flight lease (atomic row claim — POOLER-SAFE,
// never session advisory locks) → ETag picks fetch → one-transaction ingest
// with commissioner-undo reconciliation → adaptive TTL state machine.

const LEASE_SEC = 10;
const DRAFT_REFETCH_MS = 30_000; // draft object re-fetched every ≥30s or on pick change
const PRE_DRAFT_NEAR_START_MS = 5 * 60_000;
const STALLED_AFTER_TIMERS = 3; // >3×pick_timer with no pick → stalled (PLAN.md §8)
const STALLED_LONG_AFTER_TIMERS = 10; // our escalation point for the 15s→60s stretch
const BACKOFF_MIN_SEC = 8;
const BACKOFF_MAX_SEC = 120;
const MAX_UNRESOLVED_META = 500;

// ---------------- Config + scratch-state schemas ----------------

/** The slice of DraftSession.config the sync engine needs: the frozen snapshot
 * core plus the `sleeper` provider block written by the import flow. */
const liveConfigSchema = z
  .object({
    numTeams: z.number().int(),
    teamOrder: z.array(z.number().int()),
    /** Snapshot pool ids — picks resolving OUTSIDE this set need render
     * metadata just like sentinels (the room's pool won't know them). */
    players: z.array(z.object({ id: z.string() }).loose()),
    sleeper: z
      .object({
        providerDraftId: z.string(),
        pickTimerSec: z.number().nullable().optional(),
        /** Overall→seat, provider truth (3RR + traded picks baked in). */
        pickOwnerByOverall: z.array(z.number().int()),
      })
      .loose(),
  })
  .loose();
type LiveConfig = z.infer<typeof liveConfigSchema>;

const unresolvedMetaSchema = z.record(
  z.string(),
  z.object({ name: z.string(), pos: z.string().nullable(), team: z.string().nullable() }),
);

// DraftSync.etagDraft is repurposed as the engine's scratch state: the sleeper
// client's getDraft has no ETag support, the schema is frozen this phase, and
// cross-invocation sync state (backoff step, draft-object fetch age, unresolved
// -pick render metadata) needs a serverless-safe home. JSON keeps it readable.
const syncMetaSchema = z
  .object({
    draftFetchedAt: z.number().optional(), // epoch ms of last draft-object fetch
    startTime: z.number().nullable().optional(), // provider start_time (epoch ms)
    pickTimerSec: z.number().nullable().optional(),
    backoffSec: z.number().optional(), // current 429/5xx backoff step
    unresolved: unresolvedMetaSchema.optional(),
    /** Epoch ms of the last truncate+reinsert. The route compares it against
     * the client's last-seen syncedAt: a same-length rewrite between two polls
     * is invisible to the count check, so this watermark is what forces the
     * rebuild. */
    lastCorrectedAt: z.number().optional(),
  })
  .loose();
type SyncMeta = z.infer<typeof syncMetaSchema>;

function readSyncMeta(etagDraft: string | null): SyncMeta {
  if (!etagDraft || !etagDraft.startsWith("{")) return {};
  try {
    const parsed = syncMetaSchema.safeParse(JSON.parse(etagDraft));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeSyncMeta(meta: SyncMeta): string {
  return JSON.stringify(meta);
}

// ---------------- Result shape ----------------

export interface LivePickRow {
  overall: number;
  teamSlot: number;
  playerId: string;
}

export interface LiveSyncState {
  /** Provider vocabulary: pre_draft | drafting | paused | complete. */
  status: string;
  sessionStatus: DraftStatus;
  /** ALL persisted picks, overall-ordered (the route delta-shapes them). */
  picks: LivePickRow[];
  /** Provider seat on the clock (pickOwnerByOverall), null when done. */
  onClockSeat: number | null;
  /** True when THIS sync truncated+reinserted after a commissioner undo. */
  corrected: boolean;
  /** Epoch ms of the most recent correction ever, from sync meta (route watermark). */
  lastCorrectedAt: number | null;
  syncedAt: Date;
  staleSeconds: number;
  /** Render fallback for 'sleeper:<id>' sentinel picks (PLAN.md §8 metadata). */
  unresolved: Record<string, { name: string; pos: string | null; team: string | null }>;
}

export interface LiveSessionRef {
  id: string;
  mode: DraftMode;
  status: DraftStatus;
  config: unknown;
}

// ---------------- TTL state machine (PLAN.md §8 adaptive cadence) ----------------

export interface TtlInputs {
  status: string;
  startTime: number | null; // epoch ms
  pickTimerSec: number | null;
  lastPickAt: Date | null;
  now: Date;
}

export function computeTtlSec(i: TtlInputs): number {
  switch (i.status) {
    case "pre_draft":
      return i.startTime != null && i.startTime - i.now.getTime() <= PRE_DRAFT_NEAR_START_MS
        ? 10
        : 60;
    case "drafting": {
      if (i.pickTimerSec && i.lastPickAt) {
        const quietSec = (i.now.getTime() - i.lastPickAt.getTime()) / 1000;
        if (quietSec > STALLED_LONG_AFTER_TIMERS * i.pickTimerSec) return 60;
        if (quietSec > STALLED_AFTER_TIMERS * i.pickTimerSec) return 15;
      }
      return 4; // snaps back automatically: any pick refreshes lastPickAt
    }
    case "paused":
      return 45;
    case "complete":
      return 3600; // final state; the COMPLETE session gate stops sync anyway
    default:
      return 15; // unknown provider vocabulary — poll cautiously, never stop
  }
}

// ---------------- Engine ----------------

/**
 * Pull-through sync for one SLEEPER_SYNC session. Fresh cache → serve DB;
 * stale → claim the lease; losers serve the DB copy; the winner refreshes from
 * the provider. `opts.provider` is the test seam (defaults to Sleeper).
 */
export async function syncLiveDraft(
  session: LiveSessionRef,
  opts: { provider?: DraftProvider } = {},
): Promise<LiveSyncState> {
  if (session.mode !== "SLEEPER_SYNC") {
    throw new Error(`live sync requires a SLEEPER_SYNC session (got ${session.mode})`);
  }
  const provider = opts.provider ?? sleeperProvider;
  const cfg = liveConfigSchema.parse(session.config);

  // Create-on-first-call: the import flow seeds this row, but a missed seed
  // must self-heal. syncedAt epoch 0 ⇒ immediately stale ⇒ first poll ingests.
  const sync = await db.draftSync.upsert({
    where: { sessionId: session.id },
    update: {},
    create: { sessionId: session.id, providerStatus: "pre_draft", syncedAt: new Date(0), ttlSec: 60 },
  });

  const now = Date.now();
  const fresh = (now - sync.syncedAt.getTime()) / 1000 < sync.ttlSec;
  const backingOff = sync.nextAllowedAt != null && sync.nextAllowedAt.getTime() > now;
  if (session.status === "COMPLETE" || fresh || backingOff) {
    return serveFromDb(session, cfg, sync);
  }

  if (!(await claimLease(session.id))) {
    // Lease loser: another invocation is fetching right now — serve the DB copy.
    return serveFromDb(session, cfg, sync);
  }

  // Won the lease, but a racing winner may have completed a sync between our
  // freshness read and the claim — re-read and skip the upstream hit if so.
  const claimed = await db.draftSync.findUniqueOrThrow({ where: { sessionId: session.id } });
  if ((Date.now() - claimed.syncedAt.getTime()) / 1000 < claimed.ttlSec) {
    await db.draftSync.update({ where: { sessionId: session.id }, data: { claimedUntil: null } });
    return serveFromDb(session, cfg, claimed);
  }

  try {
    return await refreshFromProvider(session, cfg, claimed, provider);
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    // 429/5xx/etc → exponential backoff in nextAllowedAt, serve stale
    // (PLAN.md §8: 8s → … → 120s; the client shows "degraded" past 60s).
    const meta = readSyncMeta(claimed.etagDraft);
    const backoffSec = meta.backoffSec
      ? Math.min(meta.backoffSec * 2, BACKOFF_MAX_SEC)
      : BACKOFF_MIN_SEC;
    const updated = await db.draftSync.update({
      where: { sessionId: session.id },
      data: {
        nextAllowedAt: new Date(Date.now() + backoffSec * 1000),
        claimedUntil: null,
        etagDraft: writeSyncMeta({ ...meta, backoffSec }),
      },
    });
    console.warn(
      `[livesync] ${session.id}: provider ${e.kind}${e.status ? ` (${e.status})` : ""} — backing off ${backoffSec}s`,
    );
    return serveFromDb(session, cfg, updated);
  }
}

/** Single-flight lease claim — ONE atomic statement against the row (PLAN.md
 * §8). Deliberately not pg advisory locks: through PgBouncer transaction
 * pooling a session-scoped unlock can land on a different backend. */
async function claimLease(sessionId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ sessionId: string }[]>`
    UPDATE "DraftSync"
    SET "claimedUntil" = now() + make_interval(secs => ${LEASE_SEC})
    WHERE "sessionId" = ${sessionId}
      AND ("claimedUntil" IS NULL OR "claimedUntil" < now())
    RETURNING "sessionId"
  `;
  return rows.length > 0;
}

type SyncRow = {
  providerStatus: string;
  syncedAt: Date;
  etagDraft: string | null;
};

async function serveFromDb(
  session: LiveSessionRef,
  cfg: LiveConfig,
  sync: SyncRow,
  corrected = false,
): Promise<LiveSyncState> {
  const picks = await db.pick.findMany({
    where: { sessionId: session.id },
    orderBy: { overall: "asc" },
    select: { overall: true, teamSlot: true, playerId: true },
  });
  const meta = readSyncMeta(sync.etagDraft);
  return {
    status: sync.providerStatus,
    sessionStatus: session.status,
    picks,
    onClockSeat: onClockSeat(cfg, picks.length, sync.providerStatus),
    corrected,
    lastCorrectedAt: meta.lastCorrectedAt ?? null,
    syncedAt: sync.syncedAt,
    staleSeconds: Math.max(0, Math.floor((Date.now() - sync.syncedAt.getTime()) / 1000)),
    unresolved: meta.unresolved ?? {},
  };
}

function onClockSeat(cfg: LiveConfig, pickCount: number, status: string): number | null {
  if (status === "complete") return null;
  const owners = cfg.sleeper.pickOwnerByOverall;
  return pickCount < owners.length ? owners[pickCount] : null;
}

async function refreshFromProvider(
  session: LiveSessionRef,
  cfg: LiveConfig,
  sync: SyncRow & { etagPicks: string | null },
  provider: DraftProvider,
): Promise<LiveSyncState> {
  const meta = readSyncMeta(sync.etagDraft);
  const draftId = cfg.sleeper.providerDraftId;

  const pickRes = await provider.getPicks({}, draftId, { etag: sync.etagPicks });

  let lastCorrectedAt = meta.lastCorrectedAt ?? null;
  let corrected = false;
  let picksChanged = false;
  let unresolved = meta.unresolved ?? {};

  if (!pickRes.notModified) {
    const normalized = [...(pickRes.picks ?? [])].sort((a, b) => a.overall - b.overall);
    const resolved = await provider.resolvePlayers(normalized.map((p) => p.providerPlayerId));

    // seat → engine teamId through the snapshot's teamOrder (seat n =
    // teamOrder[n-1]; identity for provider boards). Unresolved players get a
    // 'sleeper:<id>' sentinel — a live pick must never fail ingestion.
    const mapped: LivePickRow[] = normalized.map((p) => ({
      overall: p.overall,
      teamSlot: cfg.teamOrder[p.seat - 1] ?? p.seat,
      playerId: resolved.has(p.providerPlayerId)
        ? String(resolved.get(p.providerPlayerId)!.id)
        : `sleeper:${p.providerPlayerId}`,
    }));

    // Sleeper returns the FULL pick list every time, so unresolved render
    // metadata rebuilds from scratch (self-pruning after corrections).
    // Covers BOTH sentinel picks AND canonical players absent from the session
    // snapshot pool (common for late-round picks against a short ranking set) —
    // either way the room's pool can't render them without this map.
    const snapshotIds = new Set(cfg.players.map((p) => p.id));
    const nextUnresolved: NonNullable<SyncMeta["unresolved"]> = {};
    for (const p of normalized) {
      if (!p.metadata) continue;
      const hit = resolved.get(p.providerPlayerId);
      const finalId = hit ? String(hit.id) : `sleeper:${p.providerPlayerId}`;
      if (hit && snapshotIds.has(finalId)) continue;
      if (Object.keys(nextUnresolved).length >= MAX_UNRESOLVED_META) break;
      nextUnresolved[finalId] = p.metadata;
    }
    unresolved = nextUnresolved;

    const existing = await db.pick.findMany({
      where: { sessionId: session.id },
      orderBy: { overall: "asc" },
      select: { overall: true, playerId: true },
    });
    const byOverall = new Map(mapped.map((p) => [p.overall, p]));

    // Commissioner-undo reconciliation: first stored overall where provider
    // truth disagrees (different player, or the pick no longer exists).
    let divergeAt: number | null = null;
    for (const row of existing) {
      const prov = byOverall.get(row.overall);
      if (!prov || prov.playerId !== row.playerId) {
        divergeAt = row.overall;
        break;
      }
    }

    if (divergeAt != null) {
      corrected = true;
      lastCorrectedAt = Date.now();
      picksChanged = true;
      const reinsert = mapped.filter((p) => p.overall >= divergeAt);
      await db.$transaction([
        db.pick.deleteMany({ where: { sessionId: session.id, overall: { gte: divergeAt } } }),
        ...(reinsert.length > 0
          ? [
              db.pick.createMany({
                data: reinsert.map((p) => ({ sessionId: session.id, source: "PROVIDER" as const, ...p })),
                skipDuplicates: true,
              }),
            ]
          : []),
      ]);
    } else {
      const fresh = mapped.filter((p) => p.overall > existing.length);
      if (fresh.length > 0) {
        picksChanged = true;
        await db.pick.createMany({
          data: fresh.map((p) => ({ sessionId: session.id, source: "PROVIDER" as const, ...p })),
          skipDuplicates: true,
        });
      }
    }
  }

  // Draft object: status/startTime/pick_timer. Refetched on pick change or
  // every ≥30s — not per poll (PLAN.md §8).
  let status = sync.providerStatus;
  let startTime = meta.startTime ?? null;
  let pickTimerSec = meta.pickTimerSec ?? cfg.sleeper.pickTimerSec ?? null;
  let draftFetchedAt = meta.draftFetchedAt;
  if (picksChanged || draftFetchedAt == null || Date.now() - draftFetchedAt >= DRAFT_REFETCH_MS) {
    const draft = await provider.getDraft({}, draftId);
    status = draft.status;
    startTime = draft.startTime;
    pickTimerSec = draft.pickTimerSec;
    draftFetchedAt = Date.now();
  }

  let sessionStatus: DraftStatus = session.status;
  if (status === "complete" && session.status !== "COMPLETE") {
    // Final reconcile just ran above; mark the session and stop (the COMPLETE
    // gate short-circuits every later poll before the provider is touched).
    await db.draftSession.update({ where: { id: session.id }, data: { status: "COMPLETE" } });
    sessionStatus = "COMPLETE";
  }

  const lastPick = await db.pick.findFirst({
    where: { sessionId: session.id },
    orderBy: { overall: "desc" },
    select: { createdAt: true },
  });
  const syncedAt = new Date();
  const ttlSec = computeTtlSec({
    status,
    startTime,
    pickTimerSec,
    lastPickAt: lastPick?.createdAt ?? null,
    now: syncedAt,
  });

  await db.draftSync.update({
    where: { sessionId: session.id },
    data: {
      providerStatus: status,
      syncedAt,
      ttlSec,
      etagPicks: pickRes.etag ?? sync.etagPicks,
      etagDraft: writeSyncMeta({
        draftFetchedAt,
        startTime,
        pickTimerSec,
        unresolved,
        ...(lastCorrectedAt != null && { lastCorrectedAt }),
        // success clears the backoff step (next failure restarts at 8s)
      }),
      claimedUntil: null, // release — a held lease would stretch a 4s ttl to 10s
      nextAllowedAt: null,
    },
  });

  const picks = await db.pick.findMany({
    where: { sessionId: session.id },
    orderBy: { overall: "asc" },
    select: { overall: true, teamSlot: true, playerId: true },
  });

  return {
    status,
    sessionStatus,
    picks,
    onClockSeat: onClockSeat(cfg, picks.length, status),
    corrected,
    lastCorrectedAt,
    syncedAt,
    staleSeconds: 0,
    unresolved,
  };
}
