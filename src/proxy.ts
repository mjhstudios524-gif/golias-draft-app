import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Webhooks and cron MUST stay public: Stripe/Clerk sign their own requests and a
// middleware change that protects them silently drops entitlements (PLAN.md §9).
// Cron routes verify CRON_SECRET inside the handler.
const isPublicRoute = createRouteMatcher([
  "/",
  "/pricing(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
  "/api/cron(.*)",
]);

const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Dev-only: with no Clerk keys, pass every request through (server/auth.ts
// substitutes a fixed local user). In production the clerkMiddleware path runs
// regardless and fails loudly on missing keys — never silently authless.
const passthrough = () => NextResponse.next();

export default clerkEnabled || process.env.NODE_ENV === "production"
  ? clerkMiddleware(async (auth, req) => {
      if (!isPublicRoute(req)) await auth.protect();
    })
  : passthrough;

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
