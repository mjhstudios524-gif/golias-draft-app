# GOLIAS Draft Tool

Production rebuild of the single-file fantasy football draft assistant. The full
implementation plan (architecture, data model, phasing, decision log) is in
[PLAN.md](./PLAN.md).

**Stack:** Next.js 16 (App Router) · TypeScript · Postgres (Neon) + Prisma 7 ·
Clerk · Stripe Checkout · Vercel. The draft math lives in `src/engine/` as a pure
TypeScript module tested directly with Vitest.

## Local development

```bash
pnpm install
cp .env.example .env   # fill in values — see checklist below
pnpm db:generate
pnpm dev
```

Useful scripts: `pnpm test` (engine suite) · `pnpm typecheck` · `pnpm lint` ·
`pnpm db:migrate` (needs a real DIRECT_DATABASE_URL) · `pnpm extract:fixtures`.

## Owner setup checklist (one-time, external services)

These require account access and are **not** automated by the repo:

1. **Neon** — create the database via the Vercel Marketplace integration
   (Storage → Neon). Copy the pooled URL into `DATABASE_URL` and the direct URL
   into `DIRECT_DATABASE_URL` (both locally and in Vercel env vars). Then run
   `pnpm db:migrate` once.
2. **Clerk** — create an application (dev instance for local). Copy
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` + `CLERK_SECRET_KEY`. Add a webhook
   endpoint for `user.created`, `user.updated`, `user.deleted` →
   `/api/webhooks/clerk`, and copy `CLERK_WEBHOOK_SIGNING_SECRET`. (Local dev
   works without the webhook — users are lazily upserted.)
3. **Stripe** — create the product “GOLIAS Draft Kit — 2026 Season” with a
   one-time $8.99 price; put the price ID in `STRIPE_PRICE_SEASON`. Add a
   webhook endpoint (production domain only — never a preview URL) for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `charge.refunded`, `charge.dispute.created` → `/api/webhooks/stripe`.
   Locally: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
   (its printed secret is your local `STRIPE_WEBHOOK_SECRET`).
4. **Vercel** — import the repo, set all env vars from `.env.example`,
   Node 24. Crons are defined in `vercel.json` (daily players dump 10:00 UTC,
   daily FFC ADP 10:30 UTC); Vercel sends them with the `CRON_SECRET` you set.
   The players-dump cron needs `maxDuration: 300` (Pro plan). After first
   deploy, trigger `/api/cron/sync-players` then `/api/cron/sync-adp` once
   manually (curl with `Authorization: Bearer $CRON_SECRET`) to seed
   production data before draft night.

## Engine purity

`src/engine/**` may not import React, Next, Prisma, or app code — enforced by
ESLint (`no-restricted-imports`) and kept honest by golden-master tests pinned
against the legacy tool (`src/engine/legacy/`, deleted after port sign-off).
See PLAN.md §4 for the port strategy and §11 for the test plan.
