"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { adminUserIds } from "@/lib/env";
import { Prisma } from "@/generated/prisma/client";

// Admin-gated "publish as preset" path (PLAN.md §6): lets the owner ship or
// refresh a shipped board mid-season without a deploy. It COPIES a READY
// upload into a preset row (userId null, kind PRESET) — the owner keeps their
// own set, and the preset lineage versions independently of it.

export type PublishResult =
  | { ok: true; presetId: string; version: number; entries: number }
  | { ok: false; error: string };

async function requireAdmin(): Promise<{ userId: string } | { error: string }> {
  const userId = await requireUser();
  if (!adminUserIds().includes(userId)) {
    return { error: "Publishing presets is restricted to the site owner" };
  }
  return { userId };
}

/**
 * Republish a READY, user-owned ranking set as a shipped free preset.
 *
 * Copies the set and every entry; the source row is never mutated. Re-running
 * it for the same (name, seasonYear) adds version+1 inside the preset's own
 * group and ARCHIVEs the versions it supersedes, so /rankings shows one live
 * preset per board while in-flight sessions (which snapshot their pool at
 * creation) are unaffected.
 */
export async function publishAsPreset(setId: string): Promise<PublishResult> {
  const admin = await requireAdmin();
  if ("error" in admin) return { ok: false, error: admin.error };

  const set = await db.rankingSet.findUnique({ where: { id: setId } });
  if (!set) return { ok: false, error: "Ranking set not found" };
  if (set.userId == null) return { ok: false, error: "That set is already a shipped preset" };
  // Publishing makes a private upload public — only the acting admin's own
  // sets are eligible, never another user's file.
  if (set.userId !== admin.userId) return { ok: false, error: "Ranking set not found" };
  if (set.status !== "READY") {
    return { ok: false, error: "Only READY sets can be published — finalize it first" };
  }

  const entries = await db.rankingEntry.findMany({
    where: { rankingSetId: set.id },
    orderBy: { sourceRow: "asc" },
  });
  if (entries.length === 0) return { ok: false, error: "That set has no entries to publish" };
  const unmatched = entries.filter((e) => e.matchMethod === "UNMATCHED").length;
  if (unmatched > 0) {
    return { ok: false, error: `${unmatched} entries are still unmatched — resolve them first` };
  }

  // Preset versioning mirrors createRankingSet, but in a group of its own: the
  // copy must never interleave versions with the owner's private lineage.
  const priorPreset = await db.rankingSet.findFirst({
    where: { userId: null, name: set.name, seasonYear: set.seasonYear },
    orderBy: { createdAt: "desc" },
    select: { groupId: true },
  });
  const groupId = priorPreset?.groupId ?? randomUUID();
  const version = priorPreset
    ? ((await db.rankingSet.aggregate({ where: { groupId }, _max: { version: true } }))._max
        .version ?? 0) + 1
    : 1;

  try {
    const preset = await db.$transaction(
      async (tx) => {
        const created = await tx.rankingSet.create({
          data: {
            groupId,
            version,
            userId: null, // shipped preset
            name: set.name,
            seasonYear: set.seasonYear,
            kind: "PRESET",
            status: "READY",
            dataTier: set.dataTier,
            formatTag: set.formatTag,
            adpContext: set.adpContext,
            headerFingerprint: set.headerFingerprint,
            columnMap:
              set.columnMap == null ? undefined : (set.columnMap as Prisma.InputJsonValue),
            rawCsv: null, // presets are not re-mappable; the owner keeps the source file
            // NOT copied: derivedFrom marks a board the nightly ADP cron owns
            // and refreshes in place (and is uniquely constrained per season).
            // A hand-published copy is neither — it is a frozen, human-authored
            // board, so its rank-vs-ADP signals stay live.
            derivedFrom: null,
          },
        });
        await tx.rankingEntry.createMany({
          data: entries.map((e) => ({
            rankingSetId: created.id,
            playerId: e.playerId,
            rawName: e.rawName,
            team: e.team,
            pos: e.pos,
            rank: e.rank,
            adp: e.adp,
            projPoints: e.projPoints,
            stats: e.stats == null ? undefined : (e.stats as Prisma.InputJsonValue),
            matchMethod: e.matchMethod,
            matchConfidence: e.matchConfidence,
            sourceRow: e.sourceRow,
          })),
        });
        await tx.rankingSet.updateMany({
          where: { groupId, status: "READY", NOT: { id: created.id } },
          data: { status: "ARCHIVED" },
        });
        return created;
      },
      { timeout: 30_000 },
    );
    return { ok: true, presetId: preset.id, version: preset.version, entries: entries.length };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "A concurrent publish created this version — retry" };
    }
    throw e;
  }
}

/** Retire a shipped preset (status ARCHIVED). Rows and entries are kept: a
 * session created from it snapshots its own pool, so nothing in flight breaks. */
export async function unpublishPreset(setId: string): Promise<PublishResult> {
  const admin = await requireAdmin();
  if ("error" in admin) return { ok: false, error: admin.error };

  const set = await db.rankingSet.findUnique({ where: { id: setId } });
  if (!set) return { ok: false, error: "Ranking set not found" };
  if (set.userId != null || set.kind !== "PRESET") {
    return { ok: false, error: "That set is not a shipped preset" };
  }
  if (set.status === "ARCHIVED") {
    return { ok: false, error: "That preset is already unpublished" };
  }
  const updated = await db.rankingSet.update({
    where: { id: set.id },
    data: { status: "ARCHIVED" },
  });
  const entries = await db.rankingEntry.count({ where: { rankingSetId: set.id } });
  return { ok: true, presetId: updated.id, version: updated.version, entries };
}

// Form-action wrappers for /rankings (server components post plain forms).
// They throw on failure: the buttons only render for eligible sets and admins,
// so a failure here is exceptional, not a normal user path.

export async function publishPresetAction(formData: FormData): Promise<void> {
  const res = await publishAsPreset(String(formData.get("setId") ?? ""));
  if (!res.ok) throw new Error(res.error);
  revalidatePath("/rankings");
}

export async function unpublishPresetAction(formData: FormData): Promise<void> {
  const res = await unpublishPreset(String(formData.get("setId") ?? ""));
  if (!res.ok) throw new Error(res.error);
  revalidatePath("/rankings");
}
