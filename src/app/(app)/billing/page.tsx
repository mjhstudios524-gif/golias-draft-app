import Link from "next/link";
import { requireUser } from "@/server/auth";
import { getActiveEntitlement } from "@/server/entitlements";
import { currentSeason } from "@/lib/season";
import { stripeEnv } from "@/lib/env";
import { startCheckout } from "@/server/checkout";
import { BillingPoller } from "./poller";

function stripeConfigured(): boolean {
  try {
    stripeEnv();
    return true;
  } catch {
    return false;
  }
}

const expiryFmt: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string | string[] }>;
}) {
  const userId = await requireUser();
  const params = await searchParams;
  const justPurchased = typeof params.session_id === "string" && params.session_id.length > 0;
  const season = currentSeason(new Date());
  const entitlement = await getActiveEntitlement(userId, season.product);

  return (
    <div className="setup-page">
      <h1>Billing</h1>

      <div className="setup-card">
        <h2>Season Pass</h2>
        {entitlement ? (
          <>
            <p className="setup-sub" style={{ marginBottom: 8 }}>
              <b style={{ color: "var(--good)" }}>Active</b> — {entitlement.product} unlocked
              through {entitlement.expiresAt.toLocaleDateString("en-US", expiryFmt)}.
            </p>
            <p className="setup-sub" style={{ marginBottom: 0 }}>
              Purchased{" "}
              {entitlement.purchasedAt.toLocaleDateString("en-US", expiryFmt)} · $
              {(entitlement.amountTotal / 100).toFixed(2)}{" "}
              {entitlement.currency.toUpperCase()}
            </p>
          </>
        ) : justPurchased ? (
          // The entitlement webhook races this redirect by seconds (PLAN.md §9)
          // — poll briefly instead of telling a paying user they own nothing.
          <BillingPoller />
        ) : (
          <>
            <p className="setup-sub">
              No season pass for the {season.seasonYear} season — the free tier includes one
              league, mock drafts, and the shipped preset rankings.
            </p>
            {stripeConfigured() ? (
              <form action={startCheckout}>
                <button className="primary" type="submit">
                  Unlock the season — $8.99 →
                </button>
              </form>
            ) : (
              <p className="setup-sub" style={{ marginBottom: 0 }}>
                Purchases aren&apos;t configured in this environment yet.
              </p>
            )}
          </>
        )}
      </div>

      <div className="setup-card">
        <h2>What the pass unlocks</h2>
        <p className="setup-sub" style={{ marginBottom: 8 }}>
          Unlimited leagues, custom CSV rankings upload, Sleeper live draft sync, and full custom
          scoring.{" "}
          <Link href="/pricing" style={{ color: "var(--accent)" }}>
            See the full comparison →
          </Link>
        </p>
        <p className="setup-sub" style={{ marginBottom: 0 }}>
          One-time payment per season; access always runs through Mar 1. Refund questions:{" "}
          <a href="mailto:mgolias@mjh-studios.com" style={{ color: "var(--accent)" }}>
            mgolias@mjh-studios.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
