"use client";

import { useDraft } from "./DraftRoom";
import { pickForOverall, totalPicks, isOnClock, nextPickFor, picksUntilTurn } from "@/engine/snake";
import { rosterExportRows, csvSerialize } from "@/engine/export";

export function Topbar() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);
  const setUi = useDraft((s) => s.setUi);
  const undo = useDraft((s) => s.undo);
  const mode = useDraft((s) => s.mode);

  const config = state.config;
  const overall = state.picks.length + 1;
  const total = totalPicks(config);
  const done = overall > total;
  const capped = Math.min(overall, total);
  const { round, pickInRound, teamId } = pickForOverall(config, capped);
  const myClock = isOnClock(state, config.myTeamId);
  const nxt = nextPickFor(state, config.myTeamId);
  const away = picksUntilTurn(state, config.myTeamId);

  const nextPickText = done || nxt == null ? "-" : myClock ? "NOW" : `#${nxt} (${away} away)`;

  const exportCsv = () => {
    const csv = csvSerialize(rosterExportRows(state, pool));
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "draft_rosters.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div id="topbar">
      <div className="stat">
        <div className="label">Overall</div>
        <div className="value">{done ? total : overall}</div>
      </div>
      <div className="stat">
        <div className="label">Round</div>
        <div className="value">{round}</div>
      </div>
      <div className="stat">
        <div className="label">Pick</div>
        <div className="value">{pickInRound}</div>
      </div>
      <div className="stat">
        <div className="label">On The Clock</div>
        <div id="onClockName" className={`value${!done && teamId === config.myTeamId ? " isme" : ""}`}>
          {done ? "Draft Complete" : config.teamNames[teamId]}
        </div>
      </div>
      <div className="stat">
        <div className="label">Your Next Pick</div>
        <div className="value" style={{ color: !done && myClock ? "var(--good)" : undefined }}>
          {nextPickText}
        </div>
      </div>
      <div className="spacer" />
      <div className="actions">
        <button onClick={undo} disabled={state.picks.length === 0 || mode === "SLEEPER_SYNC"}>
          ↺ Undo Pick
        </button>
        <button onClick={exportCsv}>⬇ Export Rosters (CSV)</button>
        <button
          className="danger"
          onClick={() => setUi({ resetModalOpen: true })}
          disabled={mode === "SLEEPER_SYNC"}
        >
          Reset Draft
        </button>
      </div>
    </div>
  );
}
