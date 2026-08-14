import { NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { syncAdpSnapshots } from "@/server/adp/sync";

export const maxDuration = 120; // 4 provider calls + batch matching (PLAN.md §8a)

/** Daily Vercel Cron alongside sync-players + manual admin/dev re-trigger for
 * draft-day. Public in the Clerk matcher; gated by CRON_SECRET instead. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${appEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await syncAdpSnapshots();
  return NextResponse.json(result);
}
