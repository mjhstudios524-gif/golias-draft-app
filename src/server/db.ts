import "server-only";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaPg } from "@prisma/adapter-pg";
import { dbEnv } from "@/lib/env";

function createClient() {
  const connectionString = dbEnv().DATABASE_URL;
  // Neon's serverless driver speaks Neon's proxy protocol — for local Postgres
  // (dev) use the node-postgres adapter instead. Chosen by host, not NODE_ENV,
  // so preview deploys against Neon branches behave like production.
  const adapter = connectionString.includes("neon.tech")
    ? new PrismaNeon({ connectionString })
    : new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// Hot-reload-safe singleton in dev; fresh per instance in production (serverless).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
