import { NextResponse } from "next/server";
import { db } from "@/server/db";

/** Slim active-player index for client-side preview matching (PLAN.md §6):
 * the mapper mirrors the match pipeline in-browser for live match rates.
 * Public and statically cached — the daily player sync makes 24h staleness
 * the natural bound. */
export const revalidate = 86400;

export async function GET() {
  const players = await db.player.findMany({
    where: { active: true },
    select: {
      id: true,
      nameKey: true,
      pos: true,
      nflTeam: true,
      active: true,
      isTeamDefense: true,
      fullName: true,
    },
    orderBy: { id: "asc" },
  });
  return NextResponse.json(
    players.map(({ nflTeam, ...p }) => ({ ...p, team: nflTeam })),
  );
}
