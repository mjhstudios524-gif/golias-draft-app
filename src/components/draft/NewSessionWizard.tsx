"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DATA_TIER_LABELS, type RankingSetOption } from "@/lib/leagues";
import { ADP_FORMAT_LABELS, type AdpFormat } from "@/server/adp/types";
import { createSession } from "@/server/sessions-create";

export interface WizardLeague {
  id: string;
  name: string;
  numTeams: number;
  rankingSetId: string | null;
  /** Display label from leagueFormat ("1QB" | "Superflex/2QB"). */
  formatLabel: string;
  /** Which live AdpSnapshot format this league would attach (PLAN.md §8a). */
  adpFormat: AdpFormat;
}

/** Server-computed ADP attribution inputs for the indicator line. */
export interface WizardAdpInfo {
  /** format → fetchedAt ISO string for the stored FFC snapshots. */
  snapshots: Record<string, string>;
  /** Ranking sets carrying their own ADP column (upload precedence). */
  setsWithUploadedAdp: string[];
}

interface SeatState {
  teamOrder: number[];
  teamNames: Record<number, string>;
  myTeamId: number;
}

function freshSeats(numTeams: number): SeatState {
  return {
    teamOrder: Array.from({ length: numTeams }, (_, i) => i + 1),
    teamNames: {},
    myTeamId: 1,
  };
}

function defaultSetFor(league: WizardLeague | undefined, sets: RankingSetOption[]): string {
  if (league?.rankingSetId && sets.some((s) => s.id === league.rankingSetId)) {
    return league.rankingSetId;
  }
  return sets[0]?.id ?? "";
}

export function NewSessionWizard({
  userId,
  leagues,
  sets,
  adp,
}: {
  userId: string;
  leagues: WizardLeague[];
  sets: RankingSetOption[];
  adp?: WizardAdpInfo;
}) {
  const router = useRouter();
  const [leagueId, setLeagueId] = useState(leagues[0]?.id ?? "");
  const [mode, setMode] = useState<"MOCK" | "MANUAL">("MOCK");
  const [rankingSetId, setRankingSetId] = useState(() => defaultSetFor(leagues[0], sets));
  const [seats, setSeats] = useState<SeatState>(() => freshSeats(leagues[0]?.numTeams ?? 0));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const league = leagues.find((l) => l.id === leagueId);

  const pickLeague = (id: string) => {
    setLeagueId(id);
    const next = leagues.find((l) => l.id === id);
    setSeats(freshSeats(next?.numTeams ?? 0));
    setRankingSetId(defaultSetFor(next, sets));
  };

  const shuffleOrder = () => {
    setSeats((s) => {
      const order = [...s.teamOrder];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return { ...s, teamOrder: order };
    });
  };

  const nameFor = (teamId: number) => seats.teamNames[teamId]?.trim() || `Team ${teamId}`;

  // ADP attribution (PLAN.md §8a): upload precedence, else the live FFC
  // snapshot the selected league's format would attach at session creation.
  const adpIndicator = (() => {
    if (!adp || !rankingSetId) return null;
    // A Consensus board IS the market ordering, so its ADP is not "yours" and
    // the rank-vs-ADP signals are off on it (PLAN.md §6) — say so plainly.
    const derived = sets.find((s) => s.id === rankingSetId)?.derivedFrom;
    if (derived) return "ADP: FFC consensus — this board's own ordering";
    if (adp.setsWithUploadedAdp.includes(rankingSetId)) return "ADP: from your upload";
    const fetched = league ? adp.snapshots[league.adpFormat] : undefined;
    if (!league || !fetched) return "ADP: no live snapshot available yet";
    return `ADP: FFC ${ADP_FORMAT_LABELS[league.adpFormat]}, updated ${new Date(fetched).toLocaleDateString()}`;
  })();

  const start = async () => {
    if (!league || !rankingSetId) return;
    setSubmitting(true);
    setError(null);
    const res = await createSession({
      userId,
      leagueId: league.id,
      mode,
      rankingSetId,
      myTeamId: seats.myTeamId,
      teamOrder: seats.teamOrder,
      teamNames: Object.fromEntries(
        seats.teamOrder.map((id) => [String(id), nameFor(id)]),
      ),
    });
    if (res.ok) {
      router.push(`/draft/${res.sessionId}`);
    } else {
      setError(res.error);
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="setup-card">
        <h2>League</h2>
        {leagues.length === 0 ? (
          <p className="setup-sub" style={{ marginBottom: 0 }}>
            No leagues yet —{" "}
            <Link href="/leagues/new" style={{ color: "var(--accent)" }}>
              create a league
            </Link>{" "}
            first.
          </p>
        ) : (
          <div className="row-inline">
            <div className="field" style={{ minWidth: 220 }}>
              <label>League</label>
              <select value={leagueId} onChange={(e) => pickLeague(e.target.value)}>
                {leagues.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            {league && (
              <div className="setup-sub" style={{ marginBottom: 6 }}>
                {league.numTeams} teams · {league.formatLabel} ·{" "}
                <Link href={`/leagues/${league.id}`} style={{ color: "var(--accent)" }}>
                  edit league
                </Link>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="setup-card">
        <h2>Mode</h2>
        <div className="row-inline">
          <label className="flexpos-opt" style={{ fontSize: 14 }}>
            <input type="radio" name="mode" checked={mode === "MOCK"} onChange={() => setMode("MOCK")} />
            Mock draft — bots pick for every other team
          </label>
          <label className="flexpos-opt" style={{ fontSize: 14 }}>
            <input
              type="radio"
              name="mode"
              checked={mode === "MANUAL"}
              onChange={() => setMode("MANUAL")}
            />
            Manual tracking — you enter every pick as it happens
          </label>
        </div>
      </div>

      <div className="setup-card">
        <h2>Rankings</h2>
        {sets.length === 0 ? (
          <p className="setup-sub" style={{ marginBottom: 0 }}>
            The free consensus boards haven&rsquo;t been generated yet (they refresh
            nightly from public draft data). In the meantime you can{" "}
            <Link href="/rankings" style={{ color: "var(--accent)" }}>
              upload your own rankings
            </Link>{" "}
            to draft with.
          </p>
        ) : (
          <div className="field" style={{ maxWidth: 420 }}>
            <label>Ranking Set</label>
            <select value={rankingSetId} onChange={(e) => setRankingSetId(e.target.value)}>
              {sets.some((s) => s.derivedFrom) && (
                <optgroup label="Public consensus boards — updated nightly">
                  {sets
                    .filter((s) => s.derivedFrom)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.formatTag})
                      </option>
                    ))}
                </optgroup>
              )}
              {sets.some((s) => !s.derivedFrom) && (
                <optgroup label="Your rankings">
                  {sets
                    .filter((s) => !s.derivedFrom)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} (v{s.version}, {s.formatTag}, {DATA_TIER_LABELS[s.dataTier]})
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
            {adpIndicator && (
              <div
                className="setup-sub"
                style={{ marginTop: 6, marginBottom: 0 }}
                title="ADP data: FantasyFootballCalculator.com"
              >
                {adpIndicator}
              </div>
            )}
          </div>
        )}
      </div>

      {league && (
        <div className="setup-card">
          <h2>Teams &amp; Draft Order</h2>
          <div className="row-inline">
            <div className="field">
              <label>My Team</label>
              <select
                value={seats.myTeamId}
                onChange={(e) => setSeats((s) => ({ ...s, myTeamId: Number(e.target.value) }))}
              >
                {seats.teamOrder.map((teamId, i) => (
                  <option key={teamId} value={teamId}>
                    {nameFor(teamId)} (pick {i + 1})
                  </option>
                ))}
              </select>
            </div>
            <button type="button" onClick={shuffleOrder}>
              🔀 Randomize Draft Order
            </button>
          </div>
          <div className="roster-grid" style={{ marginTop: 12 }}>
            {seats.teamOrder.map((teamId, i) => (
              <div className="field" key={teamId}>
                <label>
                  Pick {i + 1}
                  {teamId === seats.myTeamId ? " — you" : ""}
                </label>
                <input
                  type="text"
                  value={seats.teamNames[teamId] ?? ""}
                  placeholder={`Team ${teamId}`}
                  onChange={(e) =>
                    setSeats((s) => ({
                      ...s,
                      teamNames: { ...s.teamNames, [teamId]: e.target.value },
                    }))
                  }
                />
              </div>
            ))}
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
          onClick={start}
          disabled={submitting || !league || !rankingSetId}
        >
          {submitting ? "Building draft…" : "Start Draft →"}
        </button>
      </div>
    </>
  );
}
