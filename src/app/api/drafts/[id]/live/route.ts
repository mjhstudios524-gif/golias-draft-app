import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { PaywallError, requireEntitlement } from "@/server/entitlements";
import { syncLiveDraft } from "@/server/livesync";

const sinceSchema = z.coerce.number().int().min(0).catch(0);

/**
 * Live-draft poll endpoint (PLAN.md §8): delta-shaped pull-through sync.
 * Entitlement is re-checked on every poll — a revoked user's open tab stops
 * syncing (§9: enforcement on the hot path itself, not just at start).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const { id } = await params;
  const url = new URL(req.url);
  const sinceOverall = sinceSchema.parse(url.searchParams.get("sinceOverall") ?? 0);
  // The client echoes the syncedAt of its last-applied response. Comparing it
  // against the correction watermark catches same-length rewrites the pick
  // count can't (undo + different re-pick between two polls).
  const sinceSyncedAtRaw = url.searchParams.get("sinceSyncedAt");
  const sinceSyncedAt = sinceSyncedAtRaw ? Date.parse(sinceSyncedAtRaw) : NaN;

  const session = await db.draftSession.findUnique({
    where: { id },
    select: { id: true, userId: true, mode: true, status: true, config: true },
  });
  if (!session || session.userId !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (session.mode !== "SLEEPER_SYNC") {
    return NextResponse.json({ error: "not a live-synced draft" }, { status: 409 });
  }

  try {
    await requireEntitlement(userId);
  } catch (e) {
    if (e instanceof PaywallError) return NextResponse.json({ error: e.message }, { status: 402 });
    throw e;
  }

  const state = await syncLiveDraft(session);

  // A client claiming MORE picks than we hold was truncated under it by a sync
  // another viewer triggered — it must rebuild even though THIS poll didn't
  // do the truncating. Same-length rewrites are caught by the correction
  // watermark instead. Corrected responses carry the full list.
  const corrected =
    state.corrected ||
    sinceOverall > state.picks.length ||
    (!Number.isNaN(sinceSyncedAt) &&
      state.lastCorrectedAt != null &&
      state.lastCorrectedAt > sinceSyncedAt);
  const base = corrected ? 0 : sinceOverall;

  return NextResponse.json({
    status: state.status,
    picks: state.picks.filter((p) => p.overall > base),
    onClockSeat: state.onClockSeat,
    corrected,
    syncedAt: state.syncedAt.toISOString(),
    staleSeconds: state.staleSeconds,
    unresolved: state.unresolved,
  });
}
