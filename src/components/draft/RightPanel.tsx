"use client";

import { useMemo } from "react";
import { useDraft } from "./DraftRoom";
import { totalRounds, totalPicks, pickForOverall } from "@/engine/snake";
import { assignRosterSlots, byeSummary } from "@/engine/roster";
import { byeWeekFor } from "@/engine/bye";
import { draftedIdSet } from "@/engine/pool";
import type { Pick as EnginePick } from "@/engine/types";

export function RightPanel() {
  const rightTab = useDraft((s) => s.ui.rightTab);
  const setUi = useDraft((s) => s.setUi);

  return (
    <div id="rightpanel">
      <div className="toolbar">
        <div className="viewtabs" style={{ marginLeft: 0 }}>
          {(["board", "rosters", "queue"] as const).map((tab) => (
            <button
              key={tab}
              className={`viewtab${rightTab === tab ? " active" : ""}`}
              onClick={() => setUi({ rightTab: tab })}
            >
              {tab === "board" ? "Draft Board" : tab === "rosters" ? "Team Rosters" : "My Queue"}
            </button>
          ))}
        </div>
      </div>
      {rightTab === "board" && <BoardTab />}
      {rightTab === "rosters" && <RostersTab />}
      {rightTab === "queue" && <QueueTab />}
    </div>
  );
}

function BoardTab() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);

  const config = state.config;
  const rounds = totalRounds(config.rosterSpec);
  const total = totalPicks(config);
  const overallNow = state.picks.length + 1;
  const onClock = overallNow <= total ? pickForOverall(config, overallNow) : null;

  const pickMap = useMemo(() => {
    const m = new Map<string, EnginePick>();
    state.picks.forEach((pk) => m.set(`${pk.round}_${pk.teamId}`, pk));
    return m;
  }, [state.picks]);

  return (
    <div id="boardWrap">
      <table id="boardTable">
        <thead>
          <tr>
            <th className="roundcell">Rd</th>
            {config.teamOrder.map((id) => (
              <th key={id} className={`teamheader${id === config.myTeamId ? " mine" : ""}`}>
                {config.teamNames[id]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rounds }, (_, i) => i + 1).map((r) => (
            <tr key={r}>
              <td className="roundcell">{r}</td>
              {config.teamOrder.map((id) => {
                const pk = pickMap.get(`${r}_${id}`);
                const isOnClockCell = !pk && onClock != null && onClock.round === r && onClock.teamId === id;
                const player = pk ? pool.byId.get(pk.playerId) : null;
                return (
                  <td
                    key={id}
                    className={`pickcell${isOnClockCell ? " onclock" : ""}${id === config.myTeamId ? " mine" : ""}`}
                  >
                    {pk && (
                      <>
                        <div className="pn">{player?.name ?? "?"}</div>
                        <div className="pmeta">
                          {player ? `${player.pos} · ${player.team}` : ""} · #{pk.overall}
                        </div>
                      </>
                    )}
                    {isOnClockCell && <div className="pmeta">ON CLOCK</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RostersTab() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);
  const rosterTeamId = useDraft((s) => s.ui.rosterTeamId);
  const setUi = useDraft((s) => s.setUi);

  const config = state.config;
  const { slots, overflow } = useMemo(
    () => assignRosterSlots(state, pool, rosterTeamId),
    [state, pool, rosterTeamId],
  );
  const byes = useMemo(() => byeSummary(state, pool, rosterTeamId), [state, pool, rosterTeamId]);

  return (
    <div id="rosterWrap">
      <select
        id="rosterTeamSelect"
        value={rosterTeamId}
        onChange={(e) => setUi({ rosterTeamId: Number(e.target.value) })}
      >
        {config.teamOrder.map((id) => (
          <option key={id} value={id}>
            {config.teamNames[id]}
            {id === config.myTeamId ? " (You)" : ""}
          </option>
        ))}
      </select>
      <table id="rosterTable">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Player</th>
            <th>Team</th>
            <th>Pos</th>
            <th>Bye</th>
            <th>Rank</th>
            <th>Pick</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((s, i) =>
            s.player ? (
              <tr key={i}>
                <td className="slotname">{s.label}</td>
                <td>{s.player.name}</td>
                <td>{s.player.team}</td>
                <td>
                  <span className={`pos-badge pos-${s.player.pos}`}>{s.player.pos}</span>
                </td>
                <td>{byeWeekFor(s.player.team, config.byeWeeks) ?? "-"}</td>
                <td>{s.player.rank}</td>
                <td>#{s.pickOverall}</td>
              </tr>
            ) : (
              <tr key={i} className="empty">
                <td className="slotname">{s.label}</td>
                <td colSpan={6}>— empty —</td>
              </tr>
            ),
          )}
          {overflow.map((o, i) => (
            <tr key={`x${i}`}>
              <td className="slotname">EXTRA</td>
              <td>{o.player.name}</td>
              <td>{o.player.team}</td>
              <td>
                <span className={`pos-badge pos-${o.player.pos}`}>{o.player.pos}</span>
              </td>
              <td>{byeWeekFor(o.player.team, config.byeWeeks) ?? "-"}</td>
              <td>{o.player.rank}</td>
              <td>#{o.overall}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {byes.length > 0 && (
        <div id="byeSummary">
          <h3 className="bye-h">Bye Week Coverage (starters)</h3>
          {byes.map((w) => (
            <div key={w.week} className={`bye-row${w.stacked ? " bye-bad" : ""}`}>
              <b>Week {w.week}</b> — {w.starters.length} starter{w.starters.length > 1 ? "s" : ""} out:{" "}
              {w.starters.map((s) => `${s.player.name} (${s.label.replace(/\d+$/, "") || s.label})`).join(", ")}
              {w.stacked && <span className="bye-flag"> ⚠ stacked bye</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QueueTab() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);
  const draftPlayer = useDraft((s) => s.draftPlayer);
  const queueToggle = useDraft((s) => s.queueToggle);

  const drafted = useMemo(() => draftedIdSet(state.picks), [state.picks]);
  const queued = useMemo(
    () =>
      state.queue
        .map((id) => pool.byId.get(id))
        .filter((p) => p != null)
        .sort((a, b) => a.rank - b.rank),
    [state.queue, pool],
  );

  const config = state.config;
  const draftedStatus = (playerId: string | number) => {
    const pk = state.picks.find((x) => x.playerId === playerId);
    if (!pk) return null;
    return (
      <span className="draftedtag">
        Rd {pk.round}.{String(pk.pickInRound).padStart(2, "0")} — {config.teamNames[pk.teamId]}
      </span>
    );
  };

  return (
    <div id="queueWrap">
      <table id="queueTable">
        {queued.length === 0 ? (
          <tbody>
            <tr className="empty">
              <td>Your queue is empty — click the ☆ beside any player to add them here.</td>
            </tr>
          </tbody>
        ) : (
          <>
            <thead>
              <tr>
                <th />
                <th>Player</th>
                <th>Team</th>
                <th>Pos</th>
                <th>Bye</th>
                <th>Rank</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((p) => {
                const gone = drafted.has(p.id);
                return (
                  <tr
                    key={String(p.id)}
                    className={`qrow${gone ? " drafted-row" : ""}`}
                    onClick={() => {
                      if (gone) return;
                      draftPlayer(p.id); // store's guard handles mock-mode turn order
                    }}
                  >
                    <td
                      className="starcell"
                      onClick={(e) => {
                        e.stopPropagation();
                        queueToggle(p.id);
                      }}
                    >
                      ★
                    </td>
                    <td>{p.name}</td>
                    <td>{p.team}</td>
                    <td>
                      <span className={`pos-badge pos-${p.pos}`}>{p.pos}</span>
                    </td>
                    <td>{byeWeekFor(p.team, config.byeWeeks) ?? "-"}</td>
                    <td>{p.rank}</td>
                    <td>
                      {gone ? (
                        draftedStatus(p.id)
                      ) : (
                        <span style={{ color: "var(--good)", fontSize: 11 }}>Available</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </>
        )}
      </table>
    </div>
  );
}
