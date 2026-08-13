import { NextResponse } from "next/server";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { finalizeSet, RankingsError } from "@/server/rankings/sets";

/** DRAFT → READY (PLAN.md §6): allowed only with zero UNMATCHED rows;
 * UNLINKED rows are fine. Only READY sets are draftable. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const { id } = await params;
  try {
    return NextResponse.json(await finalizeSet(userId, id));
  } catch (e) {
    if (e instanceof RankingsError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }
}
