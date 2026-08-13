"use client";

import { useMemo } from "react";
import { useDraft } from "./DraftRoom";
import { computeRecommendations } from "@/engine/recommend";

export function RecPanel() {
  const state = useDraft((s) => s.state);
  const pool = useDraft((s) => s.pool);
  const draftPlayer = useDraft((s) => s.draftPlayer);

  const recs = useMemo(() => computeRecommendations(state, pool), [state, pool]);
  if (recs.length === 0) return <div id="recPanel" />;

  return (
    <div id="recPanel" className="show">
      <span className="rec-title">Recommended for you</span>
      {recs.map((r) => (
        <div
          key={String(r.player.id)}
          className="rec-chip"
          title={r.reason}
          onClick={() => draftPlayer(r.player.id)}
        >
          <span className={`pos-badge pos-${r.player.pos}`}>{r.player.pos}</span>
          {r.player.name}
          <span className="rank">#{r.player.rank}</span>
          {r.bye != null && <span className={`byetag${r.byeClash ? " clash" : ""}`}>bye {r.bye}</span>}
          <span className="why">{r.reason}</span>
        </div>
      ))}
    </div>
  );
}
