"use client";

import { useMemo } from "react";
import { useDraft } from "./DraftRoom";
import { computeRecommendations } from "@/engine/recommend";
import { draftedIdSet } from "@/engine/pool";
import { isOnClock } from "@/engine/snake";
import { byeWeekFor } from "@/engine/bye";
import { effectiveAdp, adpSignal } from "@/engine/adp";
import { flexEligibleUnion, leagueFormat } from "@/engine/format";
import type { EnginePlayer, Pos } from "@/engine/types";

const SORTS = ["rank", "name", "team", "pos", "bye", "adp"] as const;
const SORT_LABELS: Record<(typeof SORTS)[number], string> = {
  rank: "Rank",
  name: "Player",
  team: "Team",
  pos: "Pos",
  bye: "Bye",
  adp: "ADP",
};

export function PlayerList() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);
  const ui = useDraft((s) => s.ui);
  const mode = useDraft((s) => s.mode);
  const setUi = useDraft((s) => s.setUi);
  const draftPlayer = useDraft((s) => s.draftPlayer);
  const queueToggle = useDraft((s) => s.queueToggle);

  const config = state.config;
  const byes = config.byeWeeks;
  const league = leagueFormat(config.rosterSpec, config.flexEligibleBySlot);
  const drafted = useMemo(() => draftedIdSet(state.picks), [state.picks]);
  const myClock = isOnClock(state, config.myTeamId);

  const recommendedIds = useMemo(() => {
    if (!myClock || ui.listTab !== "available") return new Set<string | number>();
    return new Set(computeRecommendations(state, pool).map((r) => r.player.id));
  }, [state, pool, myClock, ui.listTab]);

  const list = useMemo(() => {
    let l =
      ui.listTab === "available"
        ? pool.players.filter((p) => !drafted.has(p.id))
        : pool.players.filter((p) => drafted.has(p.id));
    if (ui.posFilter !== "ALL") {
      if (ui.posFilter === "FLEX") {
        const union = flexEligibleUnion(config.flexEligibleBySlot);
        l = l.filter((p) => union.includes(p.pos));
      } else l = l.filter((p) => p.pos === ui.posFilter);
    }
    if (ui.search) {
      const q = ui.search.toLowerCase();
      l = l.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.team.toLowerCase().includes(q) ||
          p.pos.toLowerCase().includes(q),
      );
    }
    const dir = ui.sortDir === "asc" ? 1 : -1;
    const col = ui.sortCol;
    return l.slice().sort((a, b) => {
      let av: number | string | null = col === "bye" ? byeWeekFor(a.team, byes) : a[col];
      let bv: number | string | null = col === "bye" ? byeWeekFor(b.team, byes) : b[col];
      if (av == null) av = 99999;
      if (bv == null) bv = 99999;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [pool, drafted, ui.listTab, ui.posFilter, ui.search, ui.sortCol, ui.sortDir, config.flexEligibleBySlot, byes]);

  const queuedIds = useMemo(() => new Set(state.queue), [state.queue]);

  const posTabs: { val: UiPosFilter; label: string }[] = [
    { val: "ALL", label: "All" },
    { val: "QB", label: "QB" },
    { val: "RB", label: "RB" },
    { val: "WR", label: "WR" },
    { val: "TE", label: "TE" },
    { val: "FLEX", label: `FLEX (${flexEligibleUnion(config.flexEligibleBySlot).join("/")})` },
    { val: "K", label: "K" },
    { val: "DEF", label: "DEF" },
  ];
  type UiPosFilter = "ALL" | "FLEX" | Pos;

  const draftedStatus = (p: EnginePlayer) => {
    const pk = state.picks.find((x) => x.playerId === p.id);
    if (!pk) return null;
    return (
      <span className="draftedtag">
        Rd {pk.round}.{String(pk.pickInRound).padStart(2, "0")} — {config.teamNames[pk.teamId]}
      </span>
    );
  };

  const adpCell = (p: EnginePlayer) => {
    const sig = adpSignal(p, config.adpContext, league);
    if (sig === "na") return <span className="adp-na">-</span>;
    if (sig === "superflex-qb")
      return (
        <span className="adp-na" title="1QB ADP - not meaningful in superflex">
          {p.adp}*
        </span>
      );
    // On an ADP-derived board rank IS the ADP ordering, so value/reach would
    // only ever fire on deep-tail noise — render the number plainly (PLAN.md §6).
    const cls = config.adpDerived
      ? ""
      : sig === "value"
        ? "adp-val"
        : sig === "reach"
          ? "adp-reach"
          : "";
    return <span className={cls}>{p.adp}</span>;
  };
  void effectiveAdp; // display uses adpSignal; effectiveAdp feeds the engine paths

  return (
    <div id="leftpanel">
      <div className="toolbar">
        <input
          type="text"
          id="searchBox"
          placeholder="Search player, team, position..."
          value={ui.search}
          onChange={(e) => setUi({ search: e.target.value })}
        />
        <div className="viewtabs">
          <button
            className={`viewtab${ui.listTab === "available" ? " active" : ""}`}
            onClick={() => setUi({ listTab: "available" })}
          >
            Available
          </button>
          <button
            className={`viewtab${ui.listTab === "drafted" ? " active" : ""}`}
            onClick={() => setUi({ listTab: "drafted" })}
          >
            Drafted
          </button>
        </div>
      </div>
      <div className="toolbar">
        <div className="postabs">
          {posTabs.map((t) => (
            <button
              key={t.val}
              className={`postab${ui.posFilter === t.val ? " active" : ""}`}
              onClick={() => setUi({ posFilter: t.val })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="scrollarea">
        <table id="playerTable">
          <thead>
            <tr>
              <th />
              {SORTS.map((col) => (
                <th
                  key={col}
                  className={ui.sortCol === col ? "sorted" : ""}
                  onClick={() =>
                    setUi(
                      ui.sortCol === col
                        ? { sortDir: ui.sortDir === "asc" ? "desc" : "asc" }
                        : { sortCol: col, sortDir: "asc" },
                    )
                  }
                >
                  {SORT_LABELS[col]}
                </th>
              ))}
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const isDrafted = drafted.has(p.id);
              const isQueued = queuedIds.has(p.id);
              return (
                <tr
                  key={String(p.id)}
                  className={`playerrow${recommendedIds.has(p.id) ? " recommended" : ""}${isDrafted ? " drafted-row" : ""}${isQueued ? " queued" : ""}`}
                  onClick={() => {
                    if (ui.listTab !== "available") return;
                    if (mode === "MOCK" && !myClock) return; // bots are drafting; wait your turn
                    draftPlayer(p.id);
                  }}
                >
                  <td
                    className="starcell"
                    onClick={(e) => {
                      e.stopPropagation();
                      queueToggle(p.id);
                    }}
                  >
                    {isQueued ? "★" : "☆"}
                  </td>
                  <td className="rankcell">{p.rank}</td>
                  <td>{p.name}</td>
                  <td>{p.team}</td>
                  <td>
                    <span className={`pos-badge pos-${p.pos}`}>{p.pos}</span>
                  </td>
                  <td>{byeWeekFor(p.team, byes) ?? "-"}</td>
                  <td>{adpCell(p)}</td>
                  <td>
                    {isDrafted ? (
                      draftedStatus(p)
                    ) : (
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>Available</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
