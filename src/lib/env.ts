import "server-only";
import { z } from "zod";

// Validated lazily, per service group, on first server access — so `next build`
// and CI pass without secrets, and a dev environment with only DATABASE_URL can
// run everything that doesn't touch Stripe/Clerk. A missing var fails loudly at
// the first request that needs THAT service, naming the exact variables.

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
    const parsed = groups[key].safeParse(process.env);
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
