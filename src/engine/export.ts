import type { DraftState, PlayerPool } from "./types";
import { assignRosterSlots } from "./roster";
import { byeWeekFor } from "./bye";

// Legacy source: draft-room.html ~1368-1391 (minus the Blob/anchor download).

export type ExportCell = string | number;

/** Exact legacy row schema: header, one row per slot INCLUDING empty slots,
 * overflow rows labeled EXTRA, null ADP → empty string. */
export function rosterExportRows(state: DraftState, pool: PlayerPool): ExportCell[][] {
  const rows: ExportCell[][] = [
    ["Team", "Slot", "Player", "NFL Team", "Position", "Bye", "Consensus Rank", "ADP", "Overall Pick"],
  ];
  state.config.teamOrder.forEach((id) => {
    const { slots, overflow } = assignRosterSlots(state, pool, id);
    const teamName = state.config.teamNames[id];
    slots.forEach((s) => {
      if (s.player)
        rows.push([
          teamName,
          s.label,
          s.player.name,
          s.player.team,
          s.player.pos,
          byeWeekFor(s.player.team, state.config.byeWeeks) || "",
          s.player.rank,
          s.player.adp == null ? "" : s.player.adp,
          s.pickOverall!,
        ]);
      else rows.push([teamName, s.label, "", "", "", "", "", "", ""]);
    });
    overflow.forEach((o) => {
      rows.push([
        teamName,
        "EXTRA",
        o.player.name,
        o.player.team,
        o.player.pos,
        byeWeekFor(o.player.team, state.config.byeWeeks) || "",
        o.player.rank,
        o.player.adp == null ? "" : o.player.adp,
        o.overall,
      ]);
    });
  });
  return rows;
}

/** Legacy quoting rule: quote iff /[",\n]/, embedded quotes doubled. */
export function csvSerialize(rows: ExportCell[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v == null ? "" : v);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(","),
    )
    .join("\n");
}
