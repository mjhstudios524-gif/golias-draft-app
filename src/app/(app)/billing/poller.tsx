"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getBillingState } from "@/server/checkout";

const POLL_MS = 2000;
const MAX_TRIES = 15; // ~30s — webhook delivery is normally seconds

/**
 * Shown right after the Checkout success redirect while the entitlement
 * webhook races it (PLAN.md §9). Polls getBillingState until active, then
 * refreshes the server page.
 */
export function BillingPoller() {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      tries += 1;
      try {
        const state = await getBillingState();
        if (cancelled) return;
        if (state.active) {
          router.refresh();
          return;
        }
      } catch {
        // transient — keep polling
      }
      if (tries >= MAX_TRIES) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [router]);

  if (timedOut) {
    return (
      <p className="setup-sub" style={{ marginBottom: 0 }} role="alert">
        Payment received — activation is taking longer than usual. Refresh this page in a minute;
        if it still shows no pass, reply to your Stripe receipt email and it will be fixed
        manually.
      </p>
    );
  }
  return (
    <p className="setup-sub" style={{ marginBottom: 0 }} role="status">
      Finalizing your purchase… this usually takes a few seconds.
    </p>
  );
}
