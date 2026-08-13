import { NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { syncPlayersFromSleeper } from "@/server/players/sync";

export const maxDuration = 300; // 14MB dump parse + ~4.3k upserts (Vercel Pro)

/** Daily Vercel Cron (PLAN.md §8) + manual admin/dev re-trigger.
 * Public in the Clerk matcher; gated by CRON_SECRET instead. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${appEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await syncPlayersFromSleeper();
  return NextResponse.json(result);
}
