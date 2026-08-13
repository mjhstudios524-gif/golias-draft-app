import "server-only";
import { z } from "zod";

// Validated lazily on first server access (not at module load), so `next build`
// and CI pass without secrets. A missing var fails loudly at the first request
// that needs it, with the full list of problems.
const schema = z.object({
  DATABASE_URL: z.url(),
  DIRECT_DATABASE_URL: z.url(),
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_SEASON: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.url(),
  CRON_SECRET: z.string().min(16),
  ADMIN_USER_IDS: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const missing = parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ");
      throw new Error(`Invalid or missing environment variables: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function adminUserIds(): string[] {
  return env()
    .ADMIN_USER_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
