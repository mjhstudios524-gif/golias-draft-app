"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { appEnv, stripeEnv } from "@/lib/env";
import { currentSeason } from "@/lib/season";
import { getActiveEntitlement } from "@/server/entitlements";
import { stripe } from "@/server/stripe";

// Checkout server action (PLAN.md §9): hosted Checkout, mode 'payment'.
// Deliberately NO idempotency key on session creation — abandon-and-retry
// should mint a fresh session; idempotency lives in webhook fulfillment.

export async function startCheckout(): Promise<void> {
  const userId = await requireUser();
  const season = currentSeason(new Date());
  if (await getActiveEntitlement(userId, season.product)) redirect("/billing");

  const base = appEnv().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: stripeEnv().STRIPE_PRICE_SEASON, quantity: 1 }],
    // Both carry the Clerk user id; the webhook reads client_reference_id
    // first, metadata.clerkUserId as fallback.
    client_reference_id: userId,
    metadata: { clerkUserId: userId, product: season.product },
    success_url: `${base}/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pricing`,
  });
  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  redirect(session.url);
}

export interface BillingState {
  active: boolean;
  product: string | null;
  expiresAt: string | null; // ISO — serializable across the action boundary
}

/** Polled by the success-redirect page while the webhook races the redirect (§9). */
export async function getBillingState(): Promise<BillingState> {
  const userId = await requireUser();
  const ent = await getActiveEntitlement(userId);
  return ent
    ? { active: true, product: ent.product, expiresAt: ent.expiresAt.toISOString() }
    : { active: false, product: null, expiresAt: null };
}
