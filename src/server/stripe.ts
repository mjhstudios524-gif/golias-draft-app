import "server-only";
import Stripe from "stripe";
import { stripeEnv } from "@/lib/env";

// Lazy singleton so `next build` and non-billing requests never touch Stripe
// env. Deliberately NO apiVersion override — the SDK pins its tested version;
// SDK major bumps are reviewed changes with a `stripe trigger` re-test
// (PLAN.md §9).

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) client = new Stripe(stripeEnv().STRIPE_SECRET_KEY);
  return client;
}
