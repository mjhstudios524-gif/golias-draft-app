import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/server/db";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { CANONICAL_FIELDS } from "@/lib/csv/headers";

// Mapping memory (PLAN.md §6): per-user profile keyed by the sha256 header
// fingerprint so re-uploads of the same source skip the mapper.

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

const mappingSchema = z.object({
  v: z.literal(1),
  columns: z.array(z.enum(CANONICAL_FIELDS).nullable()).min(1).max(60),
});

const postSchema = z.object({
  headerFingerprint: z.string().regex(FINGERPRINT_RE),
  mapping: mappingSchema,
});

async function authedUser(): Promise<string | NextResponse> {
  try {
    return await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw e;
  }
}

export async function GET(req: Request) {
  const userId = await authedUser();
  if (userId instanceof NextResponse) return userId;
  const fingerprint = new URL(req.url).searchParams.get("fingerprint");
  if (!fingerprint || !FINGERPRINT_RE.test(fingerprint)) {
    return NextResponse.json({ error: "invalid fingerprint" }, { status: 400 });
  }
  const profile = await db.mappingProfile.findUnique({
    where: { userId_headerFingerprint: { userId, headerFingerprint: fingerprint } },
  });
  return NextResponse.json({ mapping: profile?.mapping ?? null });
}

export async function POST(req: Request) {
  const userId = await authedUser();
  if (userId instanceof NextResponse) return userId;
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { headerFingerprint, mapping } = parsed.data;
  await db.mappingProfile.upsert({
    where: { userId_headerFingerprint: { userId, headerFingerprint } },
    update: { mapping },
    create: { userId, headerFingerprint, mapping },
  });
  return NextResponse.json({ ok: true });
}
