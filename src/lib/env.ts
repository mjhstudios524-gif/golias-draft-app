import "server-only";
import { z } from "zod";

// Validated lazily, per service group, on first server access — so `next build`
// and CI pass without secrets, and a dev environment with only DATABASE_URL can
// run everything that doesn't touch Stripe/Clerk. A missing var fails loudly at
// the first request that needs THAT service, naming the exact variables.

// Neon's Vercel Marketplace integration injects its own variable names; accept
// them as fallbacks so attaching the database "just works" without renaming.
const NEON_POOLED_FALLBACKS = ["POSTGRES_PRISMA_URL", "POSTGRES_URL"] as const;
const NEON_DIRECT_FALLBACKS = ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"] as const;

function firstEnv(primary: string, fallbacks: readonly string[]): string | undefined {
  if (process.env[primary]) return process.env[primary];
  for (const name of fallbacks) if (process.env[name]) return process.env[name];
  return undefined;
}

export function resolvedDatabaseUrl(): string | undefined {
  return firstEnv("DATABASE_URL", NEON_POOLED_FALLBACKS);
}
export function resolvedDirectDatabaseUrl(): string | undefined {
  return firstEnv("DIRECT_DATABASE_URL", NEON_DIRECT_FALLBACKS) ?? resolvedDatabaseUrl();
}

const groups = {
  db: z.object({
    DATABASE_URL: z.url(),
    DIRECT_DATABASE_URL: z.url(),
  }),
  clerk: z.object({
    CLERK_SECRET_KEY: z.string().min(1),
    CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
  }),
  stripe: z.object({
    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),
    STRIPE_PRICE_SEASON: z.string().min(1),
  }),
  app: z.object({
    NEXT_PUBLIC_APP_URL: z.url(),
    CRON_SECRET: z.string().min(16),
    ADMIN_USER_IDS: z.string().default(""),
  }),
};

type Groups = { [K in keyof typeof groups]: z.infer<(typeof groups)[K]> };
const cache: Partial<Groups> = {};

function group<K extends keyof typeof groups>(key: K): Groups[K] {
  if (!cache[key]) {
    const input =
      key === "db"
        ? {
            DATABASE_URL: resolvedDatabaseUrl(),
            DIRECT_DATABASE_URL: resolvedDirectDatabaseUrl(),
          }
        : process.env;
    const parsed = groups[key].safeParse(input);
    if (!parsed.success) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid or missing environment variables (${key}): ${missing}`);
    }
    cache[key] = parsed.data as Groups[K];
  }
  return cache[key] as Groups[K];
}

export const dbEnv = () => group("db");
export const clerkEnv = () => group("clerk");
export const stripeEnv = () => group("stripe");
export const appEnv = () => group("app");

export function adminUserIds(): string[] {
  return appEnv()
    .ADMIN_USER_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
