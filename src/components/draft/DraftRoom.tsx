"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useStore, type StoreApi } from "zustand";
import { createDraftStore, type DraftStore, type SessionPayload } from "@/stores/draftStore";
import { Topbar } from "./Topbar";
import { RecPanel } from "./RecPanel";
import { LiveSync } from "./LiveSync";
import { ScarcityBar } from "./ScarcityBar";
import { PlayerList } from "./PlayerList";
import { RightPanel } from "./RightPanel";
import { ResetModal } from "./ResetModal";

const StoreCtx = createContext<StoreApi<DraftStore> | null>(null);

export function useDraft<T>(selector: (s: DraftStore) => T): T {
  const store = useContext(StoreCtx);
  if (!store) throw new Error("useDraft outside <DraftRoom>");
  return useStore(store, selector);
}

export function DraftRoom({ payload }: { payload: SessionPayload }) {
  const [store] = useState(() => createDraftStore(payload));

  useEffect(() => {
    store.getState().kickoff();
    const onPageHide = () => {
      void store.getState().flush({ keepalive: true });
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onPageHide();
    });
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [store]);

  return (
    <StoreCtx.Provider value={store}>
      <div id="draftroom" style={{ display: "flex" }}>
        <Topbar />
        <RecPanel />
        {payload.mode === "SLEEPER_SYNC" && <LiveSync />}
        <ScarcityBar />
        <div id="mainarea">
          <PlayerList />
          <RightPanel />
        </div>
        <SyncNote />
        <ResetModal />
      </div>
    </StoreCtx.Provider>
  );
}

function SyncNote() {
  const sync = useDraft((s) => s.sync);
  const total = useDraft((s) => s.state.picks.length);
  const text = sync.lastError
    ? `Sync error — retrying (${total - sync.lastSynced} picks unsaved)`
    : sync.lastSynced < total
      ? "Saving…"
      : sync.lastFlushedAt
        ? "All picks saved"
        : "";
  if (!text) return null;
  return <div className="sync-note">{text}</div>;
}
