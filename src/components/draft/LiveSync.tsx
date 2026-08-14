"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useDraft } from "./DraftRoom";
import type { ProviderPickRow } from "@/stores/draftStore";

// SLEEPER_SYNC poller (PLAN.md §8): every 5s ±1s jitter, visible tab only, the
// server does all provider talking. Renders the LIVE banner above the scarcity
// bar; styles mirror #scarcityBar inline so this file stays self-contained.

const POLL_MS = 5000;
const JITTER_MS = 1000;
const DEGRADED_AFTER_SEC = 60;
const CORRECTED_FLASH_MS = 6000;

interface LiveResponse {
  status: string;
  picks: ProviderPickRow[];
  onClockSeat: number | null;
  corrected: boolean;
  syncedAt: string;
  staleSeconds: number;
  unresolved: Record<string, { name: string; pos: string | null; team: string | null }>;
}

const STATUS_LABEL: Record<string, string> = {
  pre_draft: "waiting for the draft to start",
  paused: "draft paused",
  complete: "draft complete — sync stopped",
};

export function LiveSync() {
  const sessionId = useDraft((s) => s.sessionId);
  const mode = useDraft((s) => s.mode);
  const applyProviderPicks = useDraft((s) => s.applyProviderPicks);
  const live = useDraft((s) => s.live);
  const picksLen = useDraft((s) => s.state.picks.length);

  const [paywalled, setPaywalled] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The timeout-chain closure needs current values without re-arming per pick.
  const picksLenRef = useRef(picksLen);
  const syncedAtRef = useRef(live.syncedAt);
  const stoppedRef = useRef(false);
  const bootedRef = useRef(false);
  useEffect(() => {
    picksLenRef.current = picksLen;
  }, [picksLen]);
  useEffect(() => {
    syncedAtRef.current = live.syncedAt;
  }, [live.syncedAt]);

  useEffect(() => {
    if (mode !== "SLEEPER_SYNC") return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (disposed || stoppedRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), POLL_MS + (Math.random() * 2 - 1) * JITTER_MS);
    };

    const poll = async () => {
      if (disposed || stoppedRef.current) return;
      if (document.visibilityState === "hidden") return; // resumed by visibilitychange
      try {
        // First poll bootstraps the full list: the server may have corrected
        // picks between the page render and now.
        const first = !bootedRef.current;
        const params = new URLSearchParams({
          sinceOverall: String(first ? 0 : picksLenRef.current),
        });
        if (!first && syncedAtRef.current) params.set("sinceSyncedAt", syncedAtRef.current);
        const res = await fetch(`/api/drafts/${sessionId}/live?${params}`);
        if (res.status === 402) {
          // §9: entitlement re-checked on the hot path — a revoked tab stops.
          stoppedRef.current = true;
          setPaywalled(true);
          return;
        }
        if (!res.ok) throw new Error(`live sync failed (${res.status})`);
        const data = (await res.json()) as LiveResponse;
        bootedRef.current = true;
        applyProviderPicks(data.picks, {
          corrected: data.corrected,
          replace: first,
          providerStatus: data.status,
          staleSeconds: data.staleSeconds,
          syncedAt: data.syncedAt,
          unresolved: data.unresolved,
        });
        setFetchError(null);
        if (data.status === "complete") {
          stoppedRef.current = true; // final reconcile applied — stop polling
          return;
        }
      } catch (e) {
        setFetchError(String(e)); // transient — keep polling; banner degrades past 60s
      }
      schedule();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
      else if (timer) clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionId, mode, applyProviderPicks]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (mode !== "SLEEPER_SYNC") return null;

  const barStyle: CSSProperties = {
    // mirrors #scarcityBar (globals.css) — the banner sits directly above it
    display: "flex",
    padding: "7px 18px",
    background: "var(--panel2)",
    borderBottom: "1px solid var(--border)",
    gap: 16,
    alignItems: "center",
    flexWrap: "wrap",
    fontSize: 12,
    color: "var(--muted)",
  };

  if (paywalled) {
    return (
      <div id="liveSyncBar" style={barStyle}>
        <span style={{ color: "var(--accent2)", fontWeight: 700 }}>LIVE SYNC PAUSED</span>
        <span>
          Live draft sync needs the season pass —{" "}
          <a href="/billing" style={{ color: "var(--accent)" }}>
            unlock everything for $8.99
          </a>
          .
        </span>
      </div>
    );
  }

  const sinceOk = live.lastLiveSyncAt != null ? Math.max(0, Math.round((now - live.lastLiveSyncAt) / 1000)) : null;
  const upstreamStale = live.staleSeconds != null ? live.staleSeconds + (sinceOk ?? 0) : null;
  const degraded =
    // Upstream staleness only signals trouble mid-draft: pre_draft/paused run
    // 45-60s TTLs by design (PLAN.md §8 cadence), so >60s is normal there.
    (live.providerStatus === "drafting" && upstreamStale != null && upstreamStale > DEGRADED_AFTER_SEC) ||
    (sinceOk != null && sinceOk > DEGRADED_AFTER_SEC) ||
    (sinceOk == null && fetchError != null);
  const complete = live.providerStatus === "complete";
  const showCorrected = live.correctedAt != null && now - live.correctedAt < CORRECTED_FLASH_MS;
  const statusNote = live.providerStatus ? STATUS_LABEL[live.providerStatus] : null;

  return (
    <div id="liveSyncBar" style={barStyle}>
      <span
        style={{
          fontWeight: 700,
          color: complete ? "var(--muted)" : degraded ? "var(--accent2)" : "var(--good)",
        }}
      >
        ● {degraded && !complete ? "LIVE SYNC DEGRADED" : "LIVE"}
      </span>
      <span>
        {sinceOk == null
          ? fetchError
            ? "connecting to sync…"
            : "connecting…"
          : complete
            ? STATUS_LABEL.complete
            : `synced ${sinceOk}s ago${statusNote ? ` — ${statusNote}` : ""}`}
      </span>
      {degraded && !complete && (
        <span style={{ color: "var(--accent2)" }}>
          Sleeper updates are delayed{upstreamStale != null ? ` (${upstreamStale}s behind)` : ""} — picks
          will catch up automatically.
        </span>
      )}
      {showCorrected && (
        <span style={{ color: "var(--accent2)", fontWeight: 700 }}>
          Picks were corrected by the commissioner.
        </span>
      )}
    </div>
  );
}
