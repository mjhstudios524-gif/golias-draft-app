import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { db } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";
import { stripeEnv } from "@/lib/env";
import { stripe } from "@/server/stripe";
import { grantEntitlement, revokeByPaymentIntent } from "@/server/entitlements";

// Stripe webhook (PLAN.md §9). Raw body + signature verify, then two
// idempotency layers: WebhookEvent insert-unique on the event id, and the
// [userId, product] upsert inside grantEntitlement. Entitlements are granted
// ONLY here — never by the success page (it merely polls). This route must
// stay in the proxy.ts public matcher.

export async function POST(req: Request) {
  const payload = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";
  // Env read OUTSIDE the catch: a missing secret must 500 loudly (silent
  // revenue failure is a §15 top risk), not masquerade as a bad signature.
  const { STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY } = stripeEnv();

  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(payload, signature, STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  // Livemode-mismatch guard: an event minted in the other mode (test event at
  // a live endpoint or vice versa) is logged and skipped, never fulfilled.
  const keyIsLive = STRIPE_SECRET_KEY.startsWith("sk_live_");
  if (event.livemode !== keyIsLive) {
    console.error(
      `stripe webhook: livemode mismatch (event ${event.id} livemode=${event.livemode}, key live=${keyIsLive}) — skipping`,
    );
    return NextResponse.json({ received: true, skipped: "livemode-mismatch" });
  }

  try {
    await db.webhookEvent.create({ data: { id: event.id, source: "stripe", type: event.type } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    throw e;
  }

  try {
    await handleEvent(event);
  } catch (e) {
    // Failed AFTER the dedupe insert — free the id so Stripe's retry of this
    // event isn't swallowed as a duplicate.
    await db.webhookEvent.delete({ where: { id: event.id } }).catch(() => {});
    throw e;
  }

  return NextResponse.json({ received: true });
}

function paymentIntentIdOf(pi: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (typeof pi === "string") return pi;
  return pi?.id ?? null;
}

async function handleEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      // completed fires for async payment methods before the money moves —
      // only 'paid' grants (the async_payment_succeeded event follows).
      if (session.payment_status !== "paid") return;
      const userId = session.client_reference_id ?? session.metadata?.clerkUserId ?? null;
      if (!userId) {
        console.error(
          `stripe webhook: PAID checkout session ${session.id} carries no user id ` +
            `(client_reference_id / metadata.clerkUserId) — entitlement NOT granted, needs manual fulfillment`,
        );
        return; // 200: a retry cannot fix a missing id
      }
      // Buyers reach Checkout through requireUser(), but a paid session must
      // never be dropped on a missing mirror row (PLAN.md §9: webhook is not
      // dependent on the Clerk webhook having run).
      await db.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
      await grantEntitlement({
        userId,
        checkoutSessionId: session.id,
        paymentIntentId: paymentIntentIdOf(session.payment_intent),
        amountTotal: session.amount_total ?? 0,
        currency: session.currency ?? "usd",
      });
      return;
    }

    case "charge.refunded": {
      const charge = event.data.object;
      const pi = paymentIntentIdOf(charge.payment_intent);
      // charge.refunded fires for partial refunds too; `refunded` is true only
      // once the charge is FULLY refunded. Partial → log for manual review.
      if (!charge.refunded) {
        console.warn(
          `stripe webhook: partial refund on charge ${charge.id} (pi ${pi ?? "?"}) — entitlement kept, review manually`,
        );
        return;
      }
      if (pi) await revokeByPaymentIntent(pi, "refund");
      return;
    }

    case "charge.dispute.created": {
      const pi = paymentIntentIdOf(event.data.object.payment_intent);
      if (pi) await revokeByPaymentIntent(pi, "dispute");
      return;
    }

    default:
      return; // unknown types → 200 no-op
  }
}
