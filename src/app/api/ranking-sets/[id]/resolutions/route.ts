import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { resolveEntry, RankingsError } from "@/server/rankings/sets";

// Manual resolution of one entry (PLAN.md §6 unmatched queue): link a player,
// keep as unlinked (playerId null), or exclude the row from the set.
const body = z
  .object({
    entryId: z.string().min(1),
    playerId: z.string().min(1).nullable(),
    exclude: z.boolean().optional(),
  })
  .refine((d) => !d.exclude || d.playerId === null, {
    message: "an excluded entry cannot also link a player",
  });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const { id } = await params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = await resolveEntry({ userId, setId: id, ...parsed.data });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof RankingsError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }
}
