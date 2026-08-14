import "server-only";
import { db } from "@/server/db";
import type { Entitlement } from "@/generated/prisma/client";
import { SCORING_PRESETS } from "@/engine/scoring";
import { currentSeason } from "@/lib/season";

// Entitlement reads + fulfillment (PLAN.md §9). Enforcement is server-side
// only: the §9 call sites throw PaywallError, mapped to 402 in API routes and
// to a friendly { ok: false, error } in server actions. UI gating is cosmetic.

export class PaywallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaywallError";
  }
}

const UPSELL = "unlock everything for $8.99 (one payment, whole season)";

/**
 * The user's usable entitlement for `product` (default: the current season),
 * or null. Revoked or expired rows read as absent.
 */
export async function getActiveEntitlement(
  userId: string,
  product?: string,
): Promise<Entitlement | null> {
  const now = new Date();
  const ent = await db.entitlement.findUnique({
    where: { userId_product: { userId, product: product ?? currentSeason(now).product } },
  });
  if (!ent || ent.revokedAt !== null || ent.expiresAt.getTime() <= now.getTime()) return null;
  return ent;
}

/** Hot-path gate (live-sync poll route, etc.): active entitlement or 402. */
export async function requireEntitlement(userId: string): Promise<Entitlement> {
  const ent = await getActiveEntitlement(userId);
  if (!ent) throw new PaywallError(`This feature needs the season pass — ${UPSELL}.`);
  return ent;
}

/** Feature-named gate for the §9 call sites (better upsell copy than the generic throw). */
export async function assertEntitled(userId: string, feature: string): Promise<void> {
  if (!(await getActiveEntitlement(userId))) {
    throw new PaywallError(`${feature} is part of the season pass — ${UPSELL}.`);
  }
}

/** §9 matrix: free tier = 1 league; entitled = unlimited. */
export async function assertCanCreateLeague(userId: string): Promise<void> {
  if (await getActiveEntitlement(userId)) return;
  const count = await db.league.count({ where: { userId } });
  if (count >= 1) {
    throw new PaywallError(`The free tier includes one league — ${UPSELL} and add as many as you like.`);
  }
}

/** §9 matrix: custom scoring beyond the shipped presets is entitled-only. */
export async function assertScoringAllowed(
  userId: string,
  scoring: PresetComparableScoring,
): Promise<void> {
  if (isPresetScoring(scoring)) return;
  await assertEntitled(userId, "Custom scoring beyond the shipped presets");
}

type WeightsLike = Partial<Record<string, number>> | undefined;

export interface PresetComparableScoring {
  weights: Partial<Record<string, number>>;
  posWeights?: Partial<Record<string, Partial<Record<string, number>>>>;
}

function weightsEqual(a: WeightsLike, b: WeightsLike): boolean {
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if ((a?.[k] ?? 0) !== (b?.[k] ?? 0)) return false;
  }
  return true;
}

/**
 * True when the numbers match a shipped preset. Name is ignored (LeagueForm
 * generates labels like "Half PPR + TE Premium"); missing keys count as 0 so
 * `{ rec: 0 }` and an absent `rec` compare equal.
 */
export function isPresetScoring(scoring: PresetComparableScoring): boolean {
  return Object.values(SCORING_PRESETS).some((preset) => {
    if (!weightsEqual(scoring.weights, preset.weights)) return false;
    const aPos = scoring.posWeights ?? {};
    const bPos = preset.posWeights ?? {};
    for (const pos of new Set([...Object.keys(aPos), ...Object.keys(bPos)])) {
      if (!weightsEqual(aPos[pos], (bPos as Record<string, WeightsLike>)[pos])) return false;
    }
    return true;
  });
}

export interface GrantEntitlementArgs {
  userId: string;
  checkoutSessionId: string;
  paymentIntentId: string | null;
  /** Stripe amount_total in minor units (899 = $8.99). */
  amountTotal: number;
  currency: string;
  /** Test seam; grants use the wall clock. */
  now?: Date;
}

/**
 * Fulfillment (webhook-only caller in production). UPSERT on [userId, product]
 * updating the Stripe ids and CLEARING revokedAt — a refunded user who re-buys
 * must not hit the unique constraint (PLAN.md §9).
 */
export async function grantEntitlement(args: GrantEntitlementArgs): Promise<Entitlement> {
  const now = args.now ?? new Date();
  const season = currentSeason(now);
  const fields = {
    stripeCheckoutSessionId: args.checkoutSessionId,
    stripePaymentIntentId: args.paymentIntentId,
    amountTotal: args.amountTotal,
    currency: args.currency,
    purchasedAt: now,
    expiresAt: season.expiresAt,
    revokedAt: null,
    revokeReason: null,
  };
  return db.entitlement.upsert({
    where: { userId_product: { userId: args.userId, product: season.product } },
    update: fields,
    create: { userId: args.userId, product: season.product, ...fields },
  });
}

/** Refund/dispute path; keyed on payment intent because that's what charge events carry. */
export async function revokeByPaymentIntent(
  paymentIntentId: string,
  reason: "refund" | "dispute" | "admin",
): Promise<number> {
  const res = await db.entitlement.updateMany({
    where: { stripePaymentIntentId: paymentIntentId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: reason },
  });
  return res.count;
}
