import { NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { syncAdpSnapshots } from "@/server/adp/sync";
import { deriveAdpPresets } from "@/server/presets/derive";

export const maxDuration = 180; // 4 provider calls + batch matching + preset derivation (PLAN.md §8a/§6)

/** Daily Vercel Cron alongside sync-players + manual admin/dev re-trigger for
 * draft-day. Public in the Clerk matcher; gated by CRON_SECRET instead. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${appEnv().CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await syncAdpSnapshots();
  // Free preset boards are derived from the snapshots this run just wrote, so
  // they refresh nightly with zero owner content work (PLAN.md §6).
  const presets = await deriveAdpPresets();
  return NextResponse.json({ ...result, presets });
}
