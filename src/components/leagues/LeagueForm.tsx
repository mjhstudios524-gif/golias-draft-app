"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Pos, RosterSpec, ScoringConfig } from "@/engine/types";
import { FLEX_ELIGIBLE_DEFAULT } from "@/engine/format";
import { SCORING_PRESETS } from "@/engine/scoring";
import { totalRounds } from "@/engine/snake";
import {
  DATA_TIER_LABELS,
  DEFAULT_NUM_TEAMS,
  DEFAULT_ROSTER_SPEC,
  type RankingSetOption,
} from "@/lib/leagues";
import { createLeague, updateLeague } from "@/server/leagues";

const FLEX_POS: Pos[] = ["QB", "RB", "WR", "TE"];
const SPEC_FIELDS: { key: keyof RosterSpec; label: string; max: number }[] = [
  { key: "QB", label: "QB", max: 6 },
  { key: "RB", label: "RB", max: 6 },
  { key: "WR", label: "WR", max: 6 },
  { key: "TE", label: "TE", max: 6 },
  { key: "FLEX", label: "FLEX", max: 6 },
  { key: "DEF", label: "DEF", max: 3 },
  { key: "K", label: "K", max: 3 },
  { key: "BN", label: "Bench", max: 15 },
];

export interface LeagueFormInitial {
  id: string;
  name: string;
  numTeams: number;
  rosterSpec: RosterSpec;
  flexEligibleBySlot: Pos[][];
  scoring: ScoringConfig | null;
  rankingSetId: string | null;
}

/** The preset key whose PPR / TE premium / pass-TD triple matches, if any. */
function presetKeyFor(ppr: number, tePrem: number, passTd: number): string | null {
  for (const [key, cfg] of Object.entries(SCORING_PRESETS)) {
    if (
      (cfg.weights.rec ?? 0) === ppr &&
      (cfg.posWeights?.TE?.rec ?? 0) === tePrem &&
      (cfg.weights.pass_td ?? 4) === passTd
    ) {
      return key;
    }
  }
  return null;
}

/** The three controls write a full ScoringConfig weights map (PLAN.md §5). */
function buildScoring(ppr: number, tePrem: number, passTd: number): ScoringConfig {
  const weights: Record<string, number> = { ...SCORING_PRESETS.standard.weights, pass_td: passTd };
  if (ppr > 0) weights.rec = ppr;
  const name = [
    ppr === 1 ? "Full PPR" : ppr === 0.5 ? "Half PPR" : "Standard",
    tePrem > 0 ? "TE Premium" : null,
    passTd === 6 ? "6pt Pass TD" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  const cfg: ScoringConfig = { name, weights };
  if (tePrem > 0) cfg.posWeights = { TE: { rec: tePrem } };
  return cfg;
}

export function LeagueForm({
  sets,
  initial,
}: {
  sets: RankingSetOption[];
  initial?: LeagueFormInitial;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [numTeams, setNumTeams] = useState(initial?.numTeams ?? DEFAULT_NUM_TEAMS);
  const [spec, setSpec] = useState<RosterSpec>(initial?.rosterSpec ?? DEFAULT_ROSTER_SPEC);
  const [flexElig, setFlexElig] = useState<Pos[][]>(
    initial?.flexEligibleBySlot ??
      Array.from({ length: (initial?.rosterSpec ?? DEFAULT_ROSTER_SPEC).FLEX }, () => [
        ...FLEX_ELIGIBLE_DEFAULT,
      ]),
  );
  const [ppr, setPpr] = useState(initial?.scoring?.weights.rec ?? 0.5);
  const [tePrem, setTePrem] = useState(initial?.scoring?.posWeights?.TE?.rec ?? 0);
  const [passTd, setPassTd] = useState(initial?.scoring?.weights.pass_td === 6 ? 6 : 4);
  const [rankingSetId, setRankingSetId] = useState(initial?.rankingSetId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const presetKey = useMemo(() => presetKeyFor(ppr, tePrem, passTd), [ppr, tePrem, passTd]);

  const setSpecField = (key: keyof RosterSpec, raw: number, max: number) => {
    const v = Math.max(0, Math.min(max, Number.isFinite(raw) ? Math.floor(raw) : 0));
    setSpec((s) => ({ ...s, [key]: v }));
    if (key === "FLEX") {
      setFlexElig((lists) =>
        Array.from({ length: v }, (_, i) => lists[i] ?? [...FLEX_ELIGIBLE_DEFAULT]),
      );
    }
  };

  const toggleFlexPos = (slot: number, pos: Pos) => {
    setFlexElig((lists) =>
      lists.map((list, i) => {
        if (i !== slot) return list;
        if (list.includes(pos)) {
          return list.length > 1 ? list.filter((p) => p !== pos) : list; // keep ≥1 eligible
        }
        return FLEX_POS.filter((p) => p === pos || list.includes(p)); // canonical order
      }),
    );
  };

  const applyPreset = (key: string) => {
    const cfg = SCORING_PRESETS[key];
    if (!cfg) return;
    setPpr(cfg.weights.rec ?? 0);
    setTePrem(cfg.posWeights?.TE?.rec ?? 0);
    setPassTd(cfg.weights.pass_td === 6 ? 6 : 4);
  };

  const rounds = totalRounds(spec);
  const starters = rounds - spec.BN;
  const picks = rounds * numTeams;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const input = {
      name,
      numTeams,
      rosterSpec: spec,
      flexEligibleBySlot: flexElig,
      scoring: buildScoring(ppr, tePrem, passTd),
      rankingSetId: rankingSetId || null,
    };
    const res = initial ? await updateLeague({ id: initial.id, ...input }) : await createLeague(input);
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    } else {
      setError(res.error);
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="setup-card">
        <h2>League Setup</h2>
        <div className="row-inline">
          <div className="field" style={{ minWidth: 220 }}>
            <label>League Name</label>
            <input
              type="text"
              value={name}
              placeholder="My League"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Number of Teams</label>
            <input
              type="number"
              min={4}
              max={20}
              value={numTeams}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                setNumTeams(Math.max(4, Math.min(20, Number.isFinite(v) ? Math.floor(v) : 4)));
              }}
            />
          </div>
        </div>
      </div>

      <div className="setup-card">
        <h2>Roster Spots (per team)</h2>
        <div className="roster-grid">
          {SPEC_FIELDS.map(({ key, label, max }) => (
            <div className="field" key={key}>
              <label>{label}</label>
              <input
                type="number"
                min={0}
                max={max}
                value={spec[key]}
                onChange={(e) => setSpecField(key, e.target.valueAsNumber, max)}
              />
            </div>
          ))}
        </div>
        {spec.FLEX > 0 && (
          <div className="field" style={{ marginTop: 14 }}>
            <label>
              FLEX slot eligible positions{" "}
              <span style={{ fontWeight: "normal", color: "var(--muted)" }}>
                (set independently per FLEX slot)
              </span>
            </label>
            {flexElig.map((list, i) => (
              <div className="flexslot-row" key={i}>
                <span className="flexslot-label">{i === 0 ? "FLEX" : `FLEX${i + 1}`}</span>
                <div className="flexpos-group">
                  {FLEX_POS.map((pos) => (
                    <label className="flexpos-opt" key={pos}>
                      <input
                        type="checkbox"
                        checked={list.includes(pos)}
                        onChange={() => toggleFlexPos(i, pos)}
                      />
                      {pos}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="setup-sub" style={{ marginTop: 12, marginBottom: 0 }}>
          Starters: <b>{starters}</b> &nbsp;|&nbsp; Total roster spots: <b>{rounds}</b>{" "}
          &nbsp;|&nbsp; Rounds: <b>{rounds}</b> &nbsp;|&nbsp; Total picks in draft: <b>{picks}</b>
        </div>
      </div>

      <div className="setup-card">
        <h2>Scoring</h2>
        <div className="setup-sub">
          Scoring re-prices the board only for ranking sets with stat projections (PLAN.md data
          tiers) — rank-only sets draft exactly by their ranks.
        </div>
        <div className="row-inline">
          <div className="field">
            <label>Preset</label>
            <select value={presetKey ?? "custom"} onChange={(e) => applyPreset(e.target.value)}>
              {presetKey === null && (
                <option value="custom" disabled>
                  Custom
                </option>
              )}
              {Object.entries(SCORING_PRESETS).map(([key, cfg]) => (
                <option key={key} value={key}>
                  {cfg.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>PPR</label>
            <select value={String(ppr)} onChange={(e) => setPpr(Number(e.target.value))}>
              <option value="0">0 (Standard)</option>
              <option value="0.5">0.5 (Half)</option>
              <option value="1">1 (Full)</option>
            </select>
          </div>
          <div className="field">
            <label>TE Premium (per rec)</label>
            <input
              type="number"
              min={0}
              max={2}
              step={0.25}
              value={tePrem}
              onChange={(e) => {
                const v = e.target.valueAsNumber;
                setTePrem(Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 0);
              }}
            />
          </div>
          <div className="field">
            <label>Pass TD</label>
            <select value={String(passTd)} onChange={(e) => setPassTd(Number(e.target.value))}>
              <option value="4">4 pts</option>
              <option value="6">6 pts</option>
            </select>
          </div>
        </div>
      </div>

      <div className="setup-card">
        <h2>Default Rankings</h2>
        <div className="setup-sub">Preselected ranking set when starting a new draft.</div>
        <div className="field" style={{ maxWidth: 420 }}>
          <label>Ranking Set</label>
          <select value={rankingSetId} onChange={(e) => setRankingSetId(e.target.value)}>
            <option value="">None — choose per draft</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} (v{s.version}, {s.formatTag}, {DATA_TIER_LABELS[s.dataTier]})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="setup-sub" style={{ color: "#ff6b6b" }} role="alert">
          {error}
        </div>
      )}
      <div className="startbar">
        <button className="primary" onClick={submit} disabled={submitting || !name.trim()}>
          {submitting ? "Saving…" : initial ? "Save League" : "Create League →"}
        </button>
      </div>
    </>
  );
}
