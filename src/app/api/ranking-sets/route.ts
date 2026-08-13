import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { createRankingSet, listSets, RankingsError } from "@/server/rankings/sets";

const posSchema = z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]);

// NormalizedRow (src/server/rankings/types.ts) — the client mapper's output
const rowSchema = z.object({
  sourceRow: z.number().int().min(0),
  rawName: z.string().max(300),
  name: z.string().min(1).max(300),
  team: z.string().max(20).nullable(),
  pos: posSchema.nullable(),
  rank: z.number().nullable(),
  posRank: z.number().nullable(),
  adp: z.number().nullable(),
  byeWeek: z.number().int().min(1).max(18).nullable(),
  projPoints: z.number().nullable(),
  stats: z.record(z.string(), z.number()).nullable(),
});

const createBody = z.object({
  name: z.string().min(1).max(120),
  seasonYear: z.number().int().min(2020).max(2100),
  formatTag: z.enum(["1QB", "SF"]),
  adpContext: z.enum(["ONE_QB", "SUPERFLEX", "UNKNOWN"]).default("UNKNOWN"),
  dataTier: z.enum(["RANK_ONLY", "POINTS", "FULL_STATS"]),
  headerFingerprint: z.string().max(200).nullish(),
  columnMap: z.unknown().optional(),
  rawCsv: z.string().max(5_500_000).nullish(), // parse cap is 5 MB (PLAN.md §6)
  rows: z.array(rowSchema).min(1).max(5000),
});

function domainError(e: RankingsError) {
  const status = e.code === "NOT_FOUND" ? 404 : e.code === "CONFLICT" ? 409 : 400;
  return NextResponse.json({ error: e.message }, { status });
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const body = await req.json().catch(() => null);
  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  try {
    const result = await createRankingSet({ userId, ...parsed.data });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof RankingsError) return domainError(e);
    throw e;
  }
}

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await requireUser();
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
  const seasonYear = z.coerce
    .number()
    .int()
    .min(2020)
    .max(2100)
    .safeParse(new URL(req.url).searchParams.get("seasonYear"));
  if (!seasonYear.success) {
    return NextResponse.json({ error: "seasonYear query param required" }, { status: 400 });
  }
  return NextResponse.json(await listSets(userId, seasonYear.data));
}
