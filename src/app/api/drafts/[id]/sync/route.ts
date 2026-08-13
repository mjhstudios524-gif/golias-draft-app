import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { requireUser, UnauthorizedError } from "@/server/auth";

const bodySchema = z.object({
  truncateAfter: z.number().int().min(0).optional(),
  upserts: z
    .array(
      z.object({
        overall: z.number().int().min(1),
        teamSlot: z.number().int().min(1),
        playerId: z.string().min(1),
        source: z.enum(["USER", "AUTOPICK", "PROVIDER"]),
      }),
    )
    .max(500),
  queuedPlayerIds: z.array(z.string()).max(500).optional(),
  recPositions: z.array(z.enum(["QB", "RB", "WR", "TE", "K", "DEF"])).optional(),
});

/**
 * Batched idempotent pick persistence (PLAN.md §3). Idempotency comes from
 * @@unique([sessionId, overall]) + skipDuplicates — retries and races are safe.
 * During MOCK/MANUAL sessions the client is the source of truth; this endpoint
 * follows.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const { id } = await params;

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const body = parsed.data;

  const session = await db.draftSession.findUnique({ where: { id }, select: { id: true, userId: true, mode: true } });
  if (!session || session.userId !== userId) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (session.mode === "SLEEPER_SYNC") {
    // provider is the sole writer for live drafts (client "flush" should never fire there)
    return NextResponse.json({ error: "live sessions are provider-written" }, { status: 409 });
  }

  const pickCount = await db.$transaction(async (tx) => {
    if (body.truncateAfter != null) {
      await tx.pick.deleteMany({ where: { sessionId: id, overall: { gt: body.truncateAfter } } });
    }
    if (body.upserts.length > 0) {
      await tx.pick.createMany({
        data: body.upserts.map((u) => ({ sessionId: id, ...u })),
        skipDuplicates: true,
      });
    }
    await tx.draftSession.update({
      where: { id },
      data: {
        ...(body.queuedPlayerIds !== undefined && { queuedPlayerIds: body.queuedPlayerIds }),
        ...(body.recPositions !== undefined && { recPositions: body.recPositions }),
      },
    });
    return tx.pick.count({ where: { sessionId: id } });
  });

  return NextResponse.json({ pickCount });
}
