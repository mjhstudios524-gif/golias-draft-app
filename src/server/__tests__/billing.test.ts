import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Env must exist BEFORE @/server/db (adapter built at import) and @/lib/env are
// pulled in — vi.hoisted runs ahead of the hoisted static imports. Fake Stripe
// keys: signature verify + generateTestHeaderString never touch the network.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://mattgolias@localhost:5432/golias_dev";
  process.env.DIRECT_DATABASE_URL ??= process.env.DATABASE_URL;
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_suite_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_billing_suite_fake";
  process.env.STRIPE_PRICE_SEASON = "price_billing_suite_fake";
});
vi.mock("server-only", () => ({}));

import { db } from "@/server/db";
import { stripe } from "@/server/stripe";
import {
  assertCanCreateLeague,
  getActiveEntitlement,
  grantEntitlement,
  isPresetScoring,
  PaywallError,
  requireEntitlement,
  revokeByPaymentIntent,
} from "@/server/entitlements";
import { currentSeason } from "@/lib/season";
import { POST } from "@/app/api/webhooks/stripe/route";

const SECRET = "whsec_billing_suite_fake";
// Unique run prefix: the suite shares the dev database with the dev server and
// possibly concurrent suites — every row it creates is namespaced + cleaned up.
const T = `bt${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const PRODUCT = currentSeason(new Date()).product;

let evtSeq = 0;
function makeEvent(
  type: string,
  object: Record<string, unknown>,
  opts: { id?: string; livemode?: boolean } = {},
): string {
  return JSON.stringify({
    id: opts.id ?? `evt_${T}_${++evtSeq}`,
    object: "event",
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    livemode: opts.livemode ?? false,
    pending_webhooks: 0,
    request: null,
    type,
    data: { object },
  });
}

function checkoutSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `cs_${T}_a`,
    object: "checkout.session",
    payment_status: "paid",
    client_reference_id: `${T}_user`,
    metadata: {},
    payment_intent: `pi_${T}_a`,
    amount_total: 899,
    currency: "usd",
    livemode: false,
    ...over,
  };
}

async function post(payload: string, signature?: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: payload,
      headers: {
        "stripe-signature":
          signature ?? stripe().webhooks.generateTestHeaderString({ payload, secret: SECRET }),
      },
    }),
  );
}

const userId = `${T}_user`;

beforeAll(async () => {
  await db.user.create({ data: { id: userId, email: `${T}@test.local`, name: "Billing Test" } });
});

afterAll(async () => {
  await db.webhookEvent.deleteMany({ where: { id: { startsWith: `evt_${T}` } } });
  await db.league.deleteMany({ where: { userId: { startsWith: T } } });
  await db.user.deleteMany({ where: { id: { startsWith: T } } }); // cascades entitlements
  await db.$disconnect();
});

describe("stripe webhook route — signature + livemode guards", () => {
  it("rejects a bad signature with 400 and stores nothing", async () => {
    const payload = makeEvent("checkout.session.completed", checkoutSession());
    const res = await post(payload, "t=123,v1=deadbeef");
    expect(res.status).toBe(400);
    expect(await getActiveEntitlement(userId)).toBeNull();
  });

  it("skips (200) a livemode-mismatched event without fulfilling or consuming the id", async () => {
    const evtId = `evt_${T}_livemode`;
    const payload = makeEvent(
      "checkout.session.completed",
      checkoutSession({ id: `cs_${T}_live`, livemode: true }),
      { id: evtId, livemode: true },
    );
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "livemode-mismatch" });
    expect(await getActiveEntitlement(userId)).toBeNull();
    expect(await db.webhookEvent.findUnique({ where: { id: evtId } })).toBeNull();
  });

  it("returns 200 and logs loudly when a paid session has no user id", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = makeEvent(
      "checkout.session.completed",
      checkoutSession({ id: `cs_${T}_nouser`, client_reference_id: null, metadata: {} }),
    );
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(`cs_${T}_nouser`));
    spy.mockRestore();
    expect(await getActiveEntitlement(userId)).toBeNull();
  });

  it("ignores unknown event types with a 200 no-op", async () => {
    const res = await post(makeEvent("invoice.paid", { id: `in_${T}` }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
  });
});

describe("stripe webhook route — grant / refund / dispute / re-buy lifecycle", () => {
  const grantPayload = makeEvent("checkout.session.completed", checkoutSession());

  it("grants on checkout.session.completed with payment_status=paid", async () => {
    const res = await post(grantPayload);
    expect(res.status).toBe(200);
    const ent = await getActiveEntitlement(userId);
    expect(ent).toMatchObject({
      product: PRODUCT,
      stripeCheckoutSessionId: `cs_${T}_a`,
      stripePaymentIntentId: `pi_${T}_a`,
      amountTotal: 899,
      currency: "usd",
      revokedAt: null,
    });
    expect(ent!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("dedupes an exact event replay via WebhookEvent (single row, single grant)", async () => {
    const res = await post(grantPayload); // same event id
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(await db.entitlement.count({ where: { userId } })).toBe(1);
  });

  it("is idempotent for the same checkout session under a NEW event id (row upsert)", async () => {
    const res = await post(makeEvent("checkout.session.completed", checkoutSession()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true });
    expect(await db.entitlement.count({ where: { userId } })).toBe(1);
    expect((await getActiveEntitlement(userId))!.stripeCheckoutSessionId).toBe(`cs_${T}_a`);
  });

  it("does not grant a completed session whose payment_status is not paid", async () => {
    const other = `${T}_unpaid_user`;
    await db.user.create({ data: { id: other } });
    const res = await post(
      makeEvent(
        "checkout.session.completed",
        checkoutSession({ id: `cs_${T}_unpaid`, client_reference_id: other, payment_status: "unpaid" }),
      ),
    );
    expect(res.status).toBe(200);
    expect(await getActiveEntitlement(other)).toBeNull();
  });

  it("keeps the entitlement on a PARTIAL refund (log-only)", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post(
      makeEvent("charge.refunded", {
        id: `ch_${T}_a`,
        object: "charge",
        refunded: false, // partial: not fully refunded
        amount: 899,
        amount_refunded: 400,
        payment_intent: `pi_${T}_a`,
      }),
    );
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("partial refund"));
    spy.mockRestore();
    expect(await getActiveEntitlement(userId)).not.toBeNull();
  });

  it("revokes on a FULL charge.refunded", async () => {
    const res = await post(
      makeEvent("charge.refunded", {
        id: `ch_${T}_a`,
        object: "charge",
        refunded: true,
        amount: 899,
        amount_refunded: 899,
        payment_intent: `pi_${T}_a`,
      }),
    );
    expect(res.status).toBe(200);
    expect(await getActiveEntitlement(userId)).toBeNull();
    const row = await db.entitlement.findUnique({
      where: { userId_product: { userId, product: PRODUCT } },
    });
    expect(row!.revokedAt).not.toBeNull();
    expect(row!.revokeReason).toBe("refund");
  });

  it("re-buy after refund: async_payment_succeeded upserts the row and clears revokedAt", async () => {
    const res = await post(
      makeEvent(
        "checkout.session.async_payment_succeeded",
        checkoutSession({ id: `cs_${T}_b`, payment_intent: `pi_${T}_b` }),
      ),
    );
    expect(res.status).toBe(200);
    const ent = await getActiveEntitlement(userId);
    expect(ent).toMatchObject({
      stripeCheckoutSessionId: `cs_${T}_b`,
      stripePaymentIntentId: `pi_${T}_b`,
      revokedAt: null,
      revokeReason: null,
    });
    expect(await db.entitlement.count({ where: { userId } })).toBe(1);
  });

  it("revokes on charge.dispute.created", async () => {
    const res = await post(
      makeEvent("charge.dispute.created", {
        id: `dp_${T}`,
        object: "dispute",
        payment_intent: `pi_${T}_b`,
      }),
    );
    expect(res.status).toBe(200);
    expect(await getActiveEntitlement(userId)).toBeNull();
    const row = await db.entitlement.findUnique({
      where: { userId_product: { userId, product: PRODUCT } },
    });
    expect(row!.revokeReason).toBe("dispute");
  });
});

describe("requireEntitlement / getActiveEntitlement states", () => {
  const stateUser = `${T}_state_user`;

  beforeAll(async () => {
    await db.user.create({ data: { id: stateUser } });
  });

  it("free (no row) → PaywallError", async () => {
    await expect(requireEntitlement(stateUser)).rejects.toBeInstanceOf(PaywallError);
  });

  it("entitled → resolves with the row", async () => {
    await grantEntitlement({
      userId: stateUser,
      checkoutSessionId: `cs_${T}_state`,
      paymentIntentId: `pi_${T}_state`,
      amountTotal: 899,
      currency: "usd",
    });
    const ent = await requireEntitlement(stateUser);
    expect(ent.product).toBe(PRODUCT);
  });

  it("expired → PaywallError", async () => {
    await db.entitlement.update({
      where: { userId_product: { userId: stateUser, product: PRODUCT } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(requireEntitlement(stateUser)).rejects.toBeInstanceOf(PaywallError);
  });

  it("revoked → PaywallError (even when unexpired)", async () => {
    await db.entitlement.update({
      where: { userId_product: { userId: stateUser, product: PRODUCT } },
      data: { expiresAt: new Date(Date.now() + 86_400_000) },
    });
    expect(await requireEntitlement(stateUser)).toBeTruthy(); // sanity: active again
    expect(await revokeByPaymentIntent(`pi_${T}_state`, "admin")).toBe(1);
    await expect(requireEntitlement(stateUser)).rejects.toBeInstanceOf(PaywallError);
  });
});

describe("assertCanCreateLeague — free tier league quota (§9)", () => {
  const quotaUser = `${T}_quota_user`;

  beforeAll(async () => {
    await db.user.create({ data: { id: quotaUser } });
  });

  it("first league is free; second requires the pass; pass lifts the cap", async () => {
    await expect(assertCanCreateLeague(quotaUser)).resolves.toBeUndefined();
    await db.league.create({
      data: {
        userId: quotaUser,
        name: "Quota League",
        seasonYear: 2026,
        numTeams: 10,
        scoring: {},
        rosterSpec: {},
      },
    });
    await expect(assertCanCreateLeague(quotaUser)).rejects.toBeInstanceOf(PaywallError);
    await grantEntitlement({
      userId: quotaUser,
      checkoutSessionId: `cs_${T}_quota`,
      paymentIntentId: `pi_${T}_quota`,
      amountTotal: 899,
      currency: "usd",
    });
    await expect(assertCanCreateLeague(quotaUser)).resolves.toBeUndefined();
  });
});

describe("isPresetScoring — §9 'presets only' free scoring", () => {
  it("accepts shipped presets and the form's generated equivalents (name ignored)", () => {
    expect(
      isPresetScoring({
        weights: {
          pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
          rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
          rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
          rec: 0.5,
        },
      }),
    ).toBe(true);
    // TE premium variant with posWeights
    expect(
      isPresetScoring({
        weights: {
          pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
          rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
          rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
          rec: 0.5,
        },
        posWeights: { TE: { rec: 0.5 } },
      }),
    ).toBe(true);
    // absent key and explicit 0 compare equal
    expect(
      isPresetScoring({
        weights: {
          pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
          rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
          rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
          rec: 0,
        },
      }),
    ).toBe(true);
  });

  it("rejects combinations no preset ships (full PPR + 6pt pass TD, custom TE premium)", () => {
    expect(
      isPresetScoring({
        weights: {
          pass_yd: 0.04, pass_td: 6, pass_int: -2, pass_2pt: 2,
          rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
          rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
          rec: 1,
        },
      }),
    ).toBe(false);
    expect(
      isPresetScoring({
        weights: {
          pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
          rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
          rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
          rec: 0.5,
        },
        posWeights: { TE: { rec: 1 } },
      }),
    ).toBe(false);
  });
});
