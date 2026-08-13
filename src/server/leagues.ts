"use server";

import { z } from "zod";
import { db } from "@/server/db";
import { requireUser, UnauthorizedError } from "@/server/auth";
import {
  CURRENT_SEASON,
  leagueInputSchema,
  type LeagueActionResult,
  type LeagueInput,
  type RankingSetOption,
} from "@/lib/leagues";

// League CRUD server actions (PLAN.md §3 route map). Actions are POST-reachable
// outside the UI, so every one re-derives the user from the session and never
// trusts client-supplied ids.

async function rankingSetUsable(userId: string, id: string): Promise<boolean> {
  const set = await db.rankingSet.findUnique({
    where: { id },
    select: { status: true, userId: true },
  });
  return !!set && set.status === "READY" && (set.userId == null || set.userId === userId);
}

function leagueData(input: LeagueInput) {
  return {
    name: input.name,
    numTeams: input.numTeams,
    scoring: input.scoring,
    // flexEligibleBySlot lives inside the rosterSpec Json (PLAN.md §7)
    rosterSpec: { ...input.rosterSpec, flexEligibleBySlot: input.flexEligibleBySlot },
    rankingSetId: input.rankingSetId ?? null,
  };
}

export async function createLeague(raw: unknown): Promise<LeagueActionResult> {
  const userId = await requireUser();
  const parsed = leagueInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid league settings" };
  }
  const input = parsed.data;
  if (input.rankingSetId && !(await rankingSetUsable(userId, input.rankingSetId))) {
    return { ok: false, error: "That ranking set is not available (it must be READY)" };
  }
  const league = await db.league.create({
    data: { userId, seasonYear: CURRENT_SEASON, ...leagueData(input) },
  });
  return { ok: true, id: league.id };
}

export async function updateLeague(raw: unknown): Promise<LeagueActionResult> {
  const userId = await requireUser();
  const idParsed = z.object({ id: z.string().min(1) }).loose().safeParse(raw);
  if (!idParsed.success) return { ok: false, error: "Missing league id" };
  const parsed = leagueInputSchema.safeParse(raw); // unknown keys (id) are stripped
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid league settings" };
  }
  const input = parsed.data;
  const existing = await db.league.findUnique({
    where: { id: idParsed.data.id },
    select: { userId: true },
  });
  if (!existing || existing.userId !== userId) return { ok: false, error: "League not found" };
  if (input.rankingSetId && !(await rankingSetUsable(userId, input.rankingSetId))) {
    return { ok: false, error: "That ranking set is not available (it must be READY)" };
  }
  await db.league.update({ where: { id: idParsed.data.id }, data: leagueData(input) });
  return { ok: true, id: idParsed.data.id };
}

export async function listLeagues(userId: string) {
  const authed = await requireUser();
  if (userId !== authed) throw new UnauthorizedError("cannot list another user's leagues");
  return db.league.findMany({ where: { userId: authed }, orderBy: { createdAt: "desc" } });
}

/** READY sets visible to the caller: their own uploads + shipped presets. */
export async function listReadyRankingSets(): Promise<RankingSetOption[]> {
  const userId = await requireUser();
  return db.rankingSet.findMany({
    where: { status: "READY", OR: [{ userId: null }, { userId }] },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      version: true,
      dataTier: true,
      formatTag: true,
      seasonYear: true,
    },
  });
}
