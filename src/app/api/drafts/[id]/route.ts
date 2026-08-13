import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { buildSessionPayload } from "@/server/sessions";

/** Rehydration snapshot for resume / a second device (PLAN.md §3). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const { id } = await params;
  const session = await db.draftSession.findUnique({
    where: { id },
    include: { picks: { orderBy: { overall: "asc" } } },
  });
  if (!session || session.userId !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(buildSessionPayload(session, session.picks));
}
