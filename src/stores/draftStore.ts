"use client";

import { createStore, type StoreApi } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { DraftConfig, DraftState, EnginePlayer, PlayerId, PlayerPool, Pos } from "@/engine/types";
import { buildPlayerPool } from "@/engine/pool";
import { applyPick, undoLast, resetPicks, toggleQueue, toggleRecPos } from "@/engine/draft";
import { runAutoPicks, undoInMockDraft } from "@/engine/autopick";
import { isOnClock, pickForOverall } from "@/engine/snake";
import { mulberry32 } from "@/engine/rng";

export type DraftMode = "MOCK" | "MANUAL" | "SLEEPER_SYNC";

export interface SessionPayload {
  sessionId: string;
  mode: DraftMode;
  config: DraftConfig;
  players: EnginePlayer[];
  picks: { overall: number; teamSlot: number; playerId: string }[];
  queue: PlayerId[];
  recPos: Pos[];
  rngSeed: number;
}

export interface UiState {
  listTab: "available" | "drafted";
  posFilter: "ALL" | "FLEX" | Pos;
  search: string;
  sortCol: "rank" | "name" | "team" | "pos" | "bye" | "adp";
  sortDir: "asc" | "desc";
  rightTab: "board" | "rosters" | "queue";
  rosterTeamId: number;
  resetModalOpen: boolean;
}

interface SyncState {
  /** Pick count confirmed on the server. */
  lastSynced: number;
  /** Lowest truncation point since the last flush (undo/reset below lastSynced). */
  pendingTruncate: number | null;
  metaDirty: boolean;
  inFlight: boolean;
  lastError: string | null;
  lastFlushedAt: number | null;
}

export interface DraftStore {
  sessionId: string;
  mode: DraftMode;
  pool: PlayerPool;
  rngSeed: number;
  state: DraftState;
  ui: UiState;
  sync: SyncState;

  /** Mock mode: let bots draft up to the user's first turn (legacy enterDraftRoom). */
  kickoff: () => void;
  draftPlayer: (playerId: PlayerId) => void;
  undo: () => void;
  reset: () => void;
  queueToggle: (playerId: PlayerId) => void;
  recPosToggle: (pos: Pos) => void;
  setUi: (patch: Partial<UiState>) => void;
  flush: (opts?: { keepalive?: boolean }) => Promise<void>;
}

const FLUSH_IDLE_MS = 1500;
const FLUSH_BUFFER_MAX = 25;

export function createDraftStore(payload: SessionPayload): StoreApi<DraftStore> {
  const pool = buildPlayerPool(payload.players);
  const config = payload.config;

  // Server rows carry only (overall, teamSlot, playerId); round/pickInRound
  // re-derive from config — the DB never stores them (PLAN.md §7).
  const picks = payload.picks
    .slice()
    .sort((a, b) => a.overall - b.overall)
    .map((p) => {
      const { round, pickInRound } = pickForOverall(config, p.overall);
      return { overall: p.overall, round, pickInRound, teamId: p.teamSlot, playerId: p.playerId };
    });

  const initialState: DraftState = {
    config,
    picks,
    queue: payload.queue,
    recPos: payload.recPos,
  };

  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const store = createStore<DraftStore>()(
    subscribeWithSelector((set, get) => {
      const rng = () => {
        // Seed varies with draft position so bot runs differ per turn but stay
        // reproducible for a given session state.
        return mulberry32(payload.rngSeed + get().state.picks.length * 7919);
      };

      const scheduleFlush = (immediate = false) => {
        if (flushTimer) clearTimeout(flushTimer);
        const unsynced = get().state.picks.length - get().sync.lastSynced;
        if (immediate || unsynced >= FLUSH_BUFFER_MAX) {
          void get().flush();
        } else {
          flushTimer = setTimeout(() => void get().flush(), FLUSH_IDLE_MS);
        }
      };

      const registerTruncate = (newCount: number) => {
        const { sync } = get();
        if (newCount < sync.lastSynced) {
          set({
            sync: {
              ...get().sync,
              pendingTruncate: Math.min(sync.pendingTruncate ?? newCount, newCount),
            },
          });
        }
      };

      return {
        sessionId: payload.sessionId,
        mode: payload.mode,
        pool,
        rngSeed: payload.rngSeed,
        state: initialState,
        ui: {
          listTab: "available",
          posFilter: "ALL",
          search: "",
          sortCol: "rank",
          sortDir: "asc",
          rightTab: "board",
          rosterTeamId: config.myTeamId,
          resetModalOpen: false,
        },
        sync: {
          lastSynced: picks.length,
          pendingTruncate: null,
          metaDirty: false,
          inFlight: false,
          lastError: null,
          lastFlushedAt: null,
        },

        kickoff: () => {
          const { state: s, mode } = get();
          if (mode !== "MOCK") return;
          const next = runAutoPicks(s, pool, rng());
          if (next !== s && next.picks.length !== s.picks.length) {
            set({ state: next });
            scheduleFlush();
          }
        },

        draftPlayer: (playerId) => {
          const { state: s, mode } = get();
          if (mode === "SLEEPER_SYNC") return; // provider is the sole writer
          if (mode === "MOCK" && !isOnClock(s, s.config.myTeamId)) return; // bots are drafting
          let next = applyPick(s, playerId, pool);
          if (next === s) return; // duplicate/complete — reducer rejected it
          if (mode === "MOCK") next = runAutoPicks(next, pool, rng());
          set({ state: next });
          scheduleFlush(true); // own pick flushes immediately (PLAN.md §3)
        },

        undo: () => {
          const { state: s, mode } = get();
          if (mode === "SLEEPER_SYNC" || s.picks.length === 0) return;
          const next = mode === "MOCK" ? undoInMockDraft(s, pool, rng()) : undoLast(s);
          registerTruncate(Math.min(next.picks.length, s.picks.length - 1));
          set({ state: next });
          scheduleFlush(true);
        },

        reset: () => {
          const { state: s, mode } = get();
          if (mode === "SLEEPER_SYNC") return;
          let next = resetPicks(s); // queue + recPos survive (pinned)
          if (mode === "MOCK") next = runAutoPicks(next, pool, rng());
          registerTruncate(0);
          set({ state: next, ui: { ...get().ui, resetModalOpen: false } });
          scheduleFlush(true);
        },

        queueToggle: (playerId) => {
          set({ state: toggleQueue(get().state, playerId), sync: { ...get().sync, metaDirty: true } });
          scheduleFlush();
        },

        recPosToggle: (pos) => {
          set({ state: toggleRecPos(get().state, pos), sync: { ...get().sync, metaDirty: true } });
          scheduleFlush();
        },

        setUi: (patch) => set({ ui: { ...get().ui, ...patch } }),

        flush: async (opts) => {
          const { sync, state: s, sessionId } = get();
          if (sync.inFlight) return;
          const base = sync.pendingTruncate ?? sync.lastSynced;
          const upserts = s.picks.slice(base).map((p) => ({
            overall: p.overall,
            teamSlot: p.teamId,
            playerId: String(p.playerId),
            source: p.teamId === s.config.myTeamId ? "USER" : "AUTOPICK",
          }));
          if (upserts.length === 0 && sync.pendingTruncate == null && !sync.metaDirty) return;

          set({ sync: { ...sync, inFlight: true } });
          try {
            const res = await fetch(`/api/drafts/${sessionId}/sync`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              keepalive: opts?.keepalive ?? false,
              body: JSON.stringify({
                truncateAfter: sync.pendingTruncate ?? undefined,
                upserts,
                queuedPlayerIds: s.queue.map(String),
                recPositions: s.recPos,
              }),
            });
            if (!res.ok) throw new Error(`sync ${res.status}`);
            const { pickCount } = (await res.json()) as { pickCount: number };
            set({
              sync: {
                ...get().sync,
                lastSynced: pickCount,
                pendingTruncate: null,
                metaDirty: false,
                inFlight: false,
                lastError: null,
                lastFlushedAt: Date.now(),
              },
            });
            // picks may have accumulated while the request was in flight
            if (get().state.picks.length > pickCount) scheduleFlush();
          } catch (e) {
            set({ sync: { ...get().sync, inFlight: false, lastError: String(e) } });
            flushTimer = setTimeout(() => void get().flush(), 5000); // retry — idempotent by construction
          }
        },
      };
    }),
  );

  return store;
}
