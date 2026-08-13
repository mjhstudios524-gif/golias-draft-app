"use client";

// Unmatched-entry resolution UI (PLAN.md §6 stage 7): per row, top-5 one-click
// candidates + full-player search + exclude / keep-unlinked. Server-provided
// candidates win when present; otherwise suggestions come from the players
// index ordered by Jaro–Winkler (display ordering only — the authoritative
// matcher is server-side). Finalize unlocks at zero unresolved rows.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeName } from "@/lib/players/normalize";
import {
  fetchPlayersIndex,
  finalizeSet,
  postResolution,
  type Candidate,
  type IndexPlayer,
  type ResolutionAction,
  type UnmatchedEntry,
} from "./api";
import { jaroWinkler } from "./similarity";

interface KeyedPlayer extends IndexPlayer {
  nameKey: string;
}

function suggest(entry: UnmatchedEntry, index: KeyedPlayer[]): Candidate[] {
  const key = normalizeName(entry.rawName).nameKey;
  if (!key) return [];
  const pool = entry.pos ? index.filter((p) => p.pos === entry.pos) : index;
  return (pool.length ? pool : index)
    .map((p) => ({ p, score: jaroWinkler(key, p.nameKey) }))
    .sort((a, b) => b.score - a.score || a.p.fullName.localeCompare(b.p.fullName))
    .slice(0, 5)
    .map(({ p, score }) => ({
      playerId: p.id,
      fullName: p.fullName,
      pos: p.pos,
      nflTeam: p.nflTeam,
      score,
    }));
}

export function ResolutionPanel({
  setId,
  initialUnmatched,
  onResolved,
}: {
  setId: string;
  initialUnmatched: UnmatchedEntry[];
  onResolved?: (action: ResolutionAction) => void;
}) {
  const router = useRouter();
  const [unmatched, setUnmatched] = useState(initialUnmatched);
  const [index, setIndex] = useState<KeyedPlayer[]>([]);
  const [searches, setSearches] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPlayersIndex()
      .then((players) => {
        if (cancelled) return;
        setIndex(
          players.map((p) => ({ ...p, nameKey: p.nameKey ?? normalizeName(p.fullName).nameKey })),
        );
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the player index — search is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = useMemo(() => {
    const map = new Map<string, Candidate[]>();
    for (const e of unmatched) {
      map.set(e.entryId, e.candidates?.length ? e.candidates.slice(0, 5) : suggest(e, index));
    }
    return map;
  }, [unmatched, index]);

  async function resolve(entry: UnmatchedEntry, action: ResolutionAction, playerId?: string) {
    setBusy(entry.entryId);
    setError(null);
    try {
      await postResolution(setId, entry.entryId, action, playerId);
      setUnmatched((prev) => prev.filter((e) => e.entryId !== entry.entryId));
      onResolved?.(action);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resolution failed");
    } finally {
      setBusy(null);
    }
  }

  async function finalize() {
    setFinalizing(true);
    setError(null);
    try {
      await finalizeSet(setId);
      router.push(`/rankings/${setId}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Finalize failed");
      setFinalizing(false);
    }
  }

  const playerLabel = (c: Candidate) =>
    `${c.fullName} (${c.pos}${c.nflTeam ? ` · ${c.nflTeam}` : ""})`;

  return (
    <div>
      {unmatched.length > 0 && (
        <p className="setup-sub">
          Unlinked entries still appear on the draft board and can be drafted manually, but they
          are excluded from Sleeper live-pick auto-matching.
        </p>
      )}
      {unmatched.map((entry) => {
        const isBusy = busy === entry.entryId;
        const search = searches[entry.entryId] ?? "";
        const q = search.trim().toLowerCase();
        const results =
          q.length >= 2
            ? index.filter((p) => p.fullName.toLowerCase().includes(q)).slice(0, 8)
            : [];
        return (
          <div
            key={entry.entryId}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 10,
              background: "var(--panel2)",
              opacity: isBusy ? 0.6 : 1,
            }}
          >
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <b>{entry.rawName}</b>
              {entry.pos && <span className={`pos-badge pos-${entry.pos}`}>{entry.pos}</span>}
              {entry.team && <span style={{ color: "var(--muted)" }}>{entry.team}</span>}
              {entry.sourceRow != null && (
                <span style={{ color: "var(--muted)", fontSize: 11 }}>row {entry.sourceRow}</span>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {(suggestions.get(entry.entryId) ?? []).map((c) => (
                <button
                  key={c.playerId}
                  disabled={isBusy}
                  onClick={() => void resolve(entry, "MATCH", c.playerId)}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  title={c.score != null ? `similarity ${c.score.toFixed(3)}` : undefined}
                >
                  {playerLabel(c)}
                </button>
              ))}
            </div>
            <div className="row-inline" style={{ marginTop: 8 }}>
              <input
                type="text"
                placeholder="Search all players…"
                value={search}
                onChange={(e) =>
                  setSearches((prev) => ({ ...prev, [entry.entryId]: e.target.value }))
                }
                style={{ minWidth: 200 }}
              />
              <button disabled={isBusy} onClick={() => void resolve(entry, "EXCLUDE")}>
                Exclude row
              </button>
              <button disabled={isBusy} onClick={() => void resolve(entry, "UNLINKED")}>
                Keep unlinked
              </button>
            </div>
            {results.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                {results.map((p) => (
                  <button
                    key={p.id}
                    disabled={isBusy}
                    onClick={() => void resolve(entry, "MATCH", p.id)}
                    style={{ fontSize: 12, padding: "5px 10px" }}
                  >
                    {playerLabel({ playerId: p.id, fullName: p.fullName, pos: p.pos, nflTeam: p.nflTeam })}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {error && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</p>}
      <div className="startbar" style={{ alignItems: "center" }}>
        <span style={{ color: unmatched.length ? "var(--accent2)" : "var(--good)", fontSize: 13 }}>
          {unmatched.length ? `${unmatched.length} unresolved` : "All rows resolved"}
        </span>
        <button
          className="primary"
          disabled={unmatched.length > 0 || finalizing}
          onClick={() => void finalize()}
        >
          {finalizing ? "Finalizing…" : "Finalize set"}
        </button>
      </div>
    </div>
  );
}
