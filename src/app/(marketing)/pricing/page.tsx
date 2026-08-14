import Link from "next/link";
import { requireUser, UnauthorizedError } from "@/server/auth";
import { getActiveEntitlement } from "@/server/entitlements";
import { currentSeason } from "@/lib/season";
import { stripeEnv } from "@/lib/env";
import { startCheckout } from "@/server/checkout";

// Public marketing page (in the proxy.ts public matcher): renders signed-out.
// The §9 free-vs-paid matrix, verbatim.
const MATRIX: { capability: string; free: string; paid: string }[] = [
  { capability: "Mock draft room (full engine, autopick, undo)", free: "✓", paid: "✓" },
  { capability: "Shipped presets (incl. the projections demo)", free: "✓", paid: "✓" },
  { capability: "Leagues configured", free: "1", paid: "Unlimited" },
  { capability: "Custom CSV rankings upload + mapper", free: "—", paid: "✓" },
  { capability: "Sleeper import (settings auto-config)", free: "✓ (into the free league)", paid: "✓" },
  { capability: "Sleeper live draft sync", free: "—", paid: "✓" },
  { capability: "Full custom scoring / VBD knobs", free: "Presets only", paid: "✓" },
];

function stripeConfigured(): boolean {
  try {
    stripeEnv();
    return true;
  } catch {
    return false; // no keys yet — page still renders, buy button degrades
  }
}

export default async function PricingPage() {
  let userId: string | null = null;
  try {
    userId = await requireUser();
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
  }
  const season = currentSeason(new Date());
  const entitlement = userId ? await getActiveEntitlement(userId, season.product) : null;

  return (
    <div className="setup-page">
      <h1>Season Pass — $8.99</h1>
      <p className="setup-sub">
        One payment, the whole {season.seasonYear} season. No subscription — access runs through
        Mar 1, {season.seasonYear + 1}.
      </p>

      <div className="setup-card">
        <h2>Free vs. Season Pass</h2>
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Free</th>
              <th>Season Pass</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX.map((row) => (
              <tr key={row.capability}>
                <td>{row.capability}</td>
                <td>{row.free}</td>
                <td>{row.paid}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="setup-sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Free mocks run the full recommendation engine — the pass unlocks the three draft-night
          features: your own rankings, live Sleeper sync, and custom scoring.
        </p>
      </div>

      <div className="setup-card">
        <h2>Unlock the {season.seasonYear} season</h2>
        {entitlement ? (
          <>
            <p className="setup-sub" style={{ marginBottom: 8 }}>
              Already unlocked — your season pass is active through{" "}
              {entitlement.expiresAt.toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
              })}
              .
            </p>
            <Link href="/billing" style={{ color: "var(--accent)" }}>
              View billing →
            </Link>
          </>
        ) : !stripeConfigured() ? (
          <p className="setup-sub" style={{ marginBottom: 0 }}>
            Purchases aren&apos;t configured in this environment yet — check back soon.
          </p>
        ) : userId ? (
          <form action={startCheckout}>
            <button className="primary" type="submit">
              Unlock the season — $8.99 →
            </button>
          </form>
        ) : (
          <p className="setup-sub" style={{ marginBottom: 0 }}>
            <Link href="/sign-in" style={{ color: "var(--accent)" }}>
              Sign in
            </Link>{" "}
            to unlock the season pass.
          </p>
        )}
      </div>
    </div>
  );
}
