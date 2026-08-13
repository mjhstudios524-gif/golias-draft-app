"use client";

import { useMemo } from "react";
import { useDraft } from "./DraftRoom";
import { scarcitySummary } from "@/engine/scarcity";
import { isOnClock, picksUntilTurn, totalPicks } from "@/engine/snake";
import type { Pos } from "@/engine/types";

const PRIMARY_POS: Pos[] = ["QB", "RB", "WR", "TE", "DEF", "K"];

export function ScarcityBar() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);
  const recPosToggle = useDraft((s) => s.recPosToggle);

  const items = useMemo(() => scarcitySummary(state, pool), [state, pool]);
  const done = state.picks.length + 1 > totalPicks(state.config);
  if (done) return <div id="scarcityBar" />;

  const myClock = isOnClock(state, state.config.myTeamId);
  const gone = picksUntilTurn(state, state.config.myTeamId);
  const allowed = new Set(state.recPos);

  return (
    <div id="scarcityBar" className="show">
      {gone != null && (
        <span className="sc-item">
          {myClock ? (
            <>
              <b>You&rsquo;re on the clock</b> — next pick after {gone} more
            </>
          ) : (
            <>
              <b>{gone}</b> pick{gone === 1 ? "" : "s"} until you&rsquo;re up
            </>
          )}
        </span>
      )}
      {items.map((it) => (
        <span key={it.pos} className={`sc-item ${it.severity === "crit" ? "sc-crit" : it.severity === "warn" ? "sc-warn" : ""}`}>
          <span className={`pos-badge pos-${it.pos}`}>{it.pos}</span> {it.tierLeft} left in tier {it.tier}
          {it.severity === "crit" ? " ⚠" : ""}
        </span>
      ))}
      <span className="posfilter">
        <span className="pf-label">Suggest</span>
        {PRIMARY_POS.map((pos) => {
          const on = allowed.has(pos);
          return (
            <span
              key={pos}
              className={`pf-chip pf-${pos}${on ? " on" : " off"}`}
              title={on ? `Stop suggesting ${pos}` : `Suggest ${pos}`}
              onClick={() => recPosToggle(pos)}
            >
              {pos}
            </span>
          );
        })}
      </span>
    </div>
  );
}
