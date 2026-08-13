import "server-only";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { env } from "@/lib/env";

function createClient() {
  const adapter = new PrismaNeon({ connectionString: env().DATABASE_URL });
  return new PrismaClient({ adapter });
}

// Hot-reload-safe singleton in dev; fresh per instance in production (serverless).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
