import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env; Node 24's loadEnvFile covers the CLI path.
try {
  process.loadEnvFile(".env");
} catch {
  // no .env yet (CI, fresh clone) — env vars may come from the environment itself
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Migrations use the DIRECT (unpooled) Neon URL; runtime queries go through
    // the PrismaNeon driver adapter with the pooled URL (src/server/db.ts).
    // The Vercel Marketplace integration injects Neon's own variable names —
    // accepted as fallbacks (mirrors src/lib/env.ts, kept inline because this
    // file runs standalone under the prisma CLI). Placeholder keeps `prisma
    // generate` working in CI where no DB exists; migrate against the
    // placeholder fails loudly, which is correct.
    url:
      process.env.DIRECT_DATABASE_URL ??
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.POSTGRES_URL_NON_POOLING ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_PRISMA_URL ??
      "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
});
