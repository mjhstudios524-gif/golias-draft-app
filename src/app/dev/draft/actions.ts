"use server";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { grantEntitlement } from "@/server/entitlements";
import { currentSeason } from "@/lib/season";
import type { SnapshotV1 } from "@/server/sessions";

// DEV HARNESS ONLY (page 404s in production). Uses the extracted legacy
// fixtures as a stand-in player pool until the rankings pipeline + presets
// exist — fixture data never ships as a preset (PLAN.md §6).

const BYE_WEEKS_2026: Record<string, number> = {
  CAR: 5, KC: 5, CIN: 6, DET: 6, MIA: 6, MIN: 6, BUF: 7, JAX: 7, LAC: 7, WAS: 7,
  HOU: 8, HST: 8, NO: 8, NYG: 8, SF: 8, PIT: 9, TEN: 9, CHI: 10, DEN: 10, PHI: 10, TB: 10,
  ATL: 11, CLE: 11, GB: 11, LAR: 11, LA: 11, NE: 11, SEA: 11,
  BAL: 13, BLT: 13, IND: 13, LV: 13, NYJ: 13, ARI: 14, ARZ: 14, DAL: 14,
};

export async function createDevMockSession(formData: FormData) {
  if (process.env.NODE_ENV === "production") throw new Error("dev only");
  const userId = await requireUser();

  const superflex = formData.get("format") === "superflex";
  const numTeams = 10;
  const rngSeed = Math.floor(Math.random() * 2 ** 31);

  const fixture = superflex ? "players.superflex.json" : "players.standard.json";
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "src/engine/__tests__/fixtures", fixture), "utf8"),
  ) as { id: number; name: string; team: string; pos: string; rank: number; adp: number | null }[];

  const teamOrder = Array.from({ length: numTeams }, (_, i) => i + 1);
  for (let i = teamOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [teamOrder[i], teamOrder[j]] = [teamOrder[j], teamOrder[i]];
  }

  const snapshot: SnapshotV1 = {
    v: 1,
    numTeams,
    teamOrder,
    teamNames: Object.fromEntries(
      Array.from({ length: numTeams }, (_, i) => [String(i + 1), `Team ${i + 1}`]),
    ),
    rosterSpec: superflex
      ? { QB: 2, RB: 2, WR: 3, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 }
      : { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1, BN: 6 },
    flexEligibleBySlot: [["RB", "WR", "TE"]],
    myTeamId: teamOrder[4],
    byeWeeks: BYE_WEEKS_2026,
    adpContext: "1QB",
    rngSeed,
    players: raw.map((p) => ({
      id: String(p.id),
      name: p.name,
      team: p.team,
      pos: p.pos as SnapshotV1["players"][number]["pos"],
      rank: p.rank,
      adp: p.adp,
    })),
  };

  const league = await db.league.upsert({
    where: { id: `dev-league-${userId}-${superflex ? "sf" : "1qb"}` },
    update: {},
    create: {
      id: `dev-league-${userId}-${superflex ? "sf" : "1qb"}`,
      userId,
      name: superflex ? "Dev Superflex League" : "Dev 1QB League",
      seasonYear: 2026,
      numTeams,
      scoring: {},
      rosterSpec: snapshot.rosterSpec,
    },
  });

  const session = await db.draftSession.create({
    data: {
      userId,
      leagueId: league.id,
      mode: "MOCK",
      config: snapshot,
    },
  });

  redirect(`/draft/${session.id}`);
}

// Dev-only entitlement toggles so paid paths are testable locally without
// Stripe (charter: §9 gating). Deterministic fake Stripe ids per user+product.

export async function devGrantSeason() {
  if (process.env.NODE_ENV === "production") throw new Error("dev only");
  const userId = await requireUser();
  const product = currentSeason(new Date()).product;
  await grantEntitlement({
    userId,
    checkoutSessionId: `dev_cs_${userId}_${product}`,
    paymentIntentId: `dev_pi_${userId}_${product}`,
    amountTotal: 899,
    currency: "usd",
  });
  revalidatePath("/dev/draft");
}

export async function devRevokeSeason() {
  if (process.env.NODE_ENV === "production") throw new Error("dev only");
  const userId = await requireUser();
  const product = currentSeason(new Date()).product;
  // Revoke directly by [userId, product] so it also catches passes granted
  // through a real local `stripe listen` test.
  await db.entitlement.updateMany({
    where: { userId, product, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: "admin" },
  });
  revalidatePath("/dev/draft");
}
