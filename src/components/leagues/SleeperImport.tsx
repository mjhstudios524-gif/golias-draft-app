"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DATA_TIER_LABELS, type RankingSetOption } from "@/lib/leagues";
import {
  importSleeperLeague,
  lookupSleeper,
  previewSleeperLeague,
  type SleeperImportPreview,
  type SleeperLookupResult,
} from "@/server/providers/import-action";

// Sleeper import flow (PLAN.md §8): paste ref → (league picker) → confirmation
// with mapped settings, §8 IDP disclosure and seat detection → import.

type LeagueChoice = Extract<SleeperLookupResult, { kind: "leagues" }>;

function fmtStart(startTime: number | null): string {
  if (!startTime) return "no start time";
  return new Date(startTime).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const STATUS_LABELS: Record<string, string> = {
  pre_draft: "not started",
  drafting: "in progress",
  paused: "paused",
  complete: "complete",
};

export function SleeperImport({
  sets,
  hasLinkedSleeper,
}: {
  sets: RankingSetOption[];
  hasLinkedSleeper: boolean;
}) {
  const router = useRouter();
  const [ref, setRef] = useState("");
  const [choices, setChoices] = useState<LeagueChoice | null>(null);
  const [preview, setPreview] = useState<SleeperImportPreview | null>(null);
  const [draftId, setDraftId] = useState<string>("");
  const [mySeat, setMySeat] = useState<number>(1);
  const [rankingSetId, setRankingSetId] = useState(sets[0]?.id ?? "");
  const [linkUsername, setLinkUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyResult = (res: SleeperLookupResult) => {
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.kind === "leagues") {
      setChoices(res);
      setPreview(null);
      return;
    }
    setChoices(null);
    setPreview(res.preview);
    const firstSyncable = res.preview.drafts.find((d) => d.syncable);
    setDraftId(firstSyncable?.draftId ?? "");
    setMySeat(res.preview.detectedSeat ?? 1);
  };

  const lookup = async () => {
    setBusy(true);
    setError(null);
    applyResult(await lookupSleeper({ ref }));
    setBusy(false);
  };

  const pickLeague = async (leagueId: string) => {
    setBusy(true);
    setError(null);
    applyResult(await previewSleeperLeague({ leagueId }));
    setBusy(false);
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const res = await importSleeperLeague({
      leagueId: preview.leagueId,
      linkSleeperUsername: linkUsername.trim() || null,
      createSession: draftId ? { draftId, rankingSetId, mySeat } : null,
    });
    if (res.ok) {
      router.push(res.sessionId ? `/draft/${res.sessionId}` : "/dashboard");
      router.refresh();
    } else {
      setError(res.error);
      setBusy(false);
    }
  };

  const syncing = preview?.drafts.find((d) => d.draftId === draftId);

  return (
    <>
      <div className="setup-card">
        <h2>Find Your League</h2>
        <div className="setup-sub">
          Paste a Sleeper league URL or league ID — or enter your Sleeper username to pick from
          your leagues.
        </div>
        <div className="row-inline">
          <div className="field" style={{ minWidth: 320 }}>
            <label>League URL, League ID, or Username</label>
            <input
              type="text"
              value={ref}
              placeholder="https://sleeper.com/leagues/… or username"
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ref.trim() && !busy) void lookup();
              }}
            />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="primary" onClick={lookup} disabled={busy || !ref.trim()}>
              {busy ? "Looking up…" : "Look Up"}
            </button>
          </div>
        </div>
      </div>

      {choices && (
        <div className="setup-card">
          <h2>
            @{choices.username}&apos;s {choices.season} Leagues
          </h2>
          {choices.leagues.map((l) => (
            <div className="flexslot-row" key={l.leagueId}>
              <span className="flexslot-label">{l.numTeams} teams</span>
              <button onClick={() => pickLeague(l.leagueId)} disabled={busy}>
                {l.name}
              </button>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <>
          <div className="setup-card">
            <h2>{preview.name}</h2>
            <div className="setup-sub">
              {preview.numTeams} teams · Sleeper season {preview.season}
              {preview.isSuperflex ? " · Superflex/2QB" : ""}
            </div>
            <div className="field">
              <label>Scoring (mapped)</label>
              <div>
                {preview.scoringName} — {preview.ppr} PPR
                {preview.tePremium > 0 ? `, +${preview.tePremium} TE premium` : ""}, {preview.passTd}
                pt pass TD
              </div>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>Roster</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {preview.rosterSlots.map((s) => (
                  <span key={s.label} className={`pos-badge pos-${s.type}`} title={s.eligible?.join("/") ?? undefined}>
                    {s.label}
                  </span>
                ))}
              </div>
            </div>
            {preview.ignoredSlots.length > 0 && (
              <div
                className="setup-sub"
                role="note"
                style={{
                  border: "1px solid var(--accent2)",
                  borderRadius: 6,
                  padding: "8px 10px",
                  marginTop: 12,
                  marginBottom: 0,
                }}
              >
                This league has {preview.ignoredSlots.length} roster slot
                {preview.ignoredSlots.length > 1 ? "s" : ""} GOLIAS doesn&apos;t draft (
                {preview.ignoredSlots.join(", ")}). They&apos;ll be ignored — your board covers
                QB/RB/WR/TE/K/DEF only.
              </div>
            )}
            {preview.clampNotes.length > 0 && (
              <div className="setup-sub" role="note" style={{ marginTop: 8, marginBottom: 0 }}>
                Adjusted to app limits: {preview.clampNotes.join("; ")}.
              </div>
            )}
          </div>

          <div className="setup-card">
            <h2>Live Draft Sync</h2>
            {preview.drafts.length === 0 && (
              <div className="setup-sub" style={{ marginBottom: 0 }}>
                No drafts found for this league yet — import the league now and start a session
                later.
              </div>
            )}
            {preview.drafts.map((d) => (
              <div className="flexslot-row" key={d.draftId}>
                <label className="flexpos-opt" style={{ opacity: d.syncable ? 1 : 0.6 }}>
                  <input
                    type="radio"
                    name="sleeper-draft"
                    checked={draftId === d.draftId}
                    disabled={!d.syncable}
                    onChange={() => setDraftId(d.draftId)}
                  />
                  {d.type} draft · {STATUS_LABELS[d.status] ?? d.status} · {fmtStart(d.startTime)}
                  {d.message ? ` — ${d.message}` : ""}
                </label>
              </div>
            ))}
            {preview.drafts.length > 0 && (
              <div className="flexslot-row">
                <label className="flexpos-opt">
                  <input
                    type="radio"
                    name="sleeper-draft"
                    checked={draftId === ""}
                    onChange={() => setDraftId("")}
                  />
                  Just import the league (no live session)
                </label>
              </div>
            )}

            {draftId && (
              <div className="row-inline" style={{ marginTop: 12 }}>
                <div className="field">
                  <label>
                    My Seat{" "}
                    {preview.detectedSeat != null && (
                      <span style={{ fontWeight: "normal", color: "var(--accent)" }}>
                        (detected via your linked Sleeper account)
                      </span>
                    )}
                  </label>
                  <select value={mySeat} onChange={(e) => setMySeat(Number(e.target.value))}>
                    {preview.seats.map((s) => (
                      <option key={s.seat} value={s.seat}>
                        #{s.seat} — {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field" style={{ minWidth: 260 }}>
                  <label>Rankings for Recommendations</label>
                  <select value={rankingSetId} onChange={(e) => setRankingSetId(e.target.value)}>
                    {sets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} (v{s.version}, {s.formatTag}, {DATA_TIER_LABELS[s.dataTier]})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {!hasLinkedSleeper && (
            <div className="setup-card">
              <h2>Link Sleeper Username (optional)</h2>
              <div className="setup-sub">
                Save your Sleeper username once and future imports auto-detect your seat.
              </div>
              <div className="field" style={{ maxWidth: 320 }}>
                <label>Sleeper Username</label>
                <input
                  type="text"
                  value={linkUsername}
                  placeholder="your_sleeper_username"
                  onChange={(e) => setLinkUsername(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="setup-sub" style={{ color: "#ff6b6b" }} role="alert">
              {error}
            </div>
          )}
          <div className="startbar">
            <button
              className="primary"
              onClick={doImport}
              disabled={busy || (!!draftId && !rankingSetId)}
            >
              {busy
                ? "Importing…"
                : syncing
                  ? "Import League + Start Live Session →"
                  : "Import League →"}
            </button>
          </div>
        </>
      )}

      {error && !preview && (
        <div className="setup-sub" style={{ color: "#ff6b6b" }} role="alert">
          {error}
        </div>
      )}
    </>
  );
}
