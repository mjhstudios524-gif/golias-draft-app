"use client";

// CSV upload flow (PLAN.md §6): dropzone → decode → PapaParse (header:false,
// mapping by column index) → header detection → column mapper with live
// data-tier badge → fingerprint check against saved MappingProfile →
// normalize → POST /api/ranking-sets → match report → resolution → finalize.

import { useRef, useState } from "react";
import Papa from "papaparse";
import Link from "next/link";
import { decodeCsvBuffer } from "@/lib/csv/decode";
import {
  cleanCell,
  detectHeaderRow,
  detectMapping,
  headerFingerprint,
  type CanonicalField,
  type ColumnMapping,
  type Confidence,
} from "@/lib/csv/headers";
import { computeDataTier, mappingErrors, normalizeRows } from "@/lib/csv/normalizeRows";
import {
  createRankingSet,
  getMappingProfile,
  saveMappingProfile,
  type MatchReport,
} from "./api";
import { MappingTable } from "./MappingTable";
import { ResolutionPanel } from "./ResolutionPanel";
import { MethodBadge, TierBadge } from "./badges";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLS = 60;

const TIER_NOTES: Record<string, string> = {
  RANK_ONLY: "ranks only — the engine runs in legacy rank mode",
  POINTS: "season points — VBD on the source's points, scoring sliders locked",
  FULL_STATS: "full stat lines — scoring-driven VBD, sliders active",
};

interface ParsedFile {
  fileName: string;
  rawCsv: string;
  rows: string[][];
  headerRowIndex: number | null;
  ncols: number;
  fingerprint: string | null;
  profileApplied: boolean;
}

function colLetter(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

export function UploadFlow() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [file, setFile] = useState<ParsedFile | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [confidence, setConfidence] = useState<Confidence[]>([]);
  const [name, setName] = useState("");
  const [formatTag, setFormatTag] = useState<"1QB" | "SF">("1QB");
  const [seasonYear, setSeasonYear] = useState(2026);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ setId: string; report: MatchReport } | null>(null);

  function reset() {
    setFile(null);
    setCreated(null);
    setError(null);
    setMapping([]);
    setConfidence([]);
    setName("");
  }

  async function onFile(f: File) {
    setError(null);
    if (!/\.(csv|tsv|txt)$/i.test(f.name)) {
      setError("Unsupported file type — upload a .csv, .tsv, or .txt export.");
      return;
    }
    if (f.size > MAX_BYTES) {
      setError("File is larger than the 5 MB limit.");
      return;
    }
    setReading(true);
    try {
      const { text } = decodeCsvBuffer(await f.arrayBuffer());
      const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: "greedy" });
      const rows = parsed.data;
      if (rows.length === 0) {
        setError("The file appears to be empty.");
        return;
      }
      const headerRowIndex = detectHeaderRow(rows);
      const dataRows = rows.length - (headerRowIndex == null ? 0 : headerRowIndex + 1);
      if (dataRows > MAX_ROWS) {
        setError(`Too many rows (${dataRows}) — the limit is ${MAX_ROWS}.`);
        return;
      }
      const detected = detectMapping(rows, headerRowIndex);
      const ncols = detected.mapping.length;
      if (ncols > MAX_COLS) {
        setError(`Too many columns (${ncols}) — the limit is ${MAX_COLS}.`);
        return;
      }

      let fingerprint: string | null = null;
      let nextMapping = detected.mapping;
      let nextConfidence = detected.confidence;
      let profileApplied = false;
      if (headerRowIndex != null) {
        fingerprint = await headerFingerprint(rows[headerRowIndex]);
        const saved = await getMappingProfile(fingerprint);
        if (saved && saved.length === ncols) {
          nextMapping = saved;
          nextConfidence = saved.map((fld) => (fld != null ? "high" : "none"));
          profileApplied = true;
        }
      }

      setFile({
        fileName: f.name,
        rawCsv: text,
        rows,
        headerRowIndex,
        ncols,
        fingerprint,
        profileApplied,
      });
      setMapping(nextMapping);
      setConfidence(nextConfidence);
      setName(f.name.replace(/\.(csv|tsv|txt)$/i, ""));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    } finally {
      setReading(false);
    }
  }

  function setField(col: number, field: CanonicalField | null) {
    // a canonical field maps to at most one column — reassigning moves it
    setMapping((prev) => prev.map((cur, i) => (i === col ? field : cur === field ? null : cur)));
    setConfidence((prev) =>
      prev.map((cv, i) => (i === col ? "high" : mapping[i] === field && field != null ? "none" : cv)),
    );
  }

  async function submit() {
    if (!file) return;
    const dataTier = computeDataTier(mapping);
    if (mappingErrors(mapping).length > 0 || dataTier == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const rows = normalizeRows(file.rows, mapping, file.headerRowIndex);
      if (rows.length === 0) {
        setError("No data rows found — check the player-name column mapping.");
        return;
      }
      const { setId, report } = await createRankingSet({
        name: name.trim() || file.fileName,
        seasonYear,
        formatTag,
        // the ADP column's market follows the declared format when one exists
        adpContext: mapping.includes("adp")
          ? formatTag === "SF"
            ? "SUPERFLEX"
            : "ONE_QB"
          : "UNKNOWN",
        dataTier,
        headerFingerprint: file.fingerprint,
        columnMap: { v: 1, columns: mapping },
        rawCsv: file.rawCsv,
        rows,
      });
      if (file.fingerprint) {
        // mapping memory (§6): best-effort — never blocks the upload
        void saveMappingProfile(file.fingerprint, mapping).catch(() => {});
      }
      setCreated({ setId, report });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---------- phase C: match report + resolution ----------
  if (created) {
    const { setId, report } = created;
    const matchedCount = report.total - report.unmatched.length;
    return (
      <section className="setup-card">
        <h2>Match report</h2>
        <p className="setup-sub">
          {matchedCount} of {report.total} rows matched automatically.{" "}
          <Link href={`/rankings/${setId}`} style={{ color: "var(--accent)" }}>
            View the set
          </Link>
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
          {Object.entries(report.countsByMethod).map(([method, count]) => (
            <span key={method} style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
              <MethodBadge method={method} />
              <b style={{ fontSize: 13 }}>{count}</b>
            </span>
          ))}
        </div>
        <ResolutionPanel setId={setId} initialUnmatched={report.unmatched} />
      </section>
    );
  }

  // ---------- phase B: column mapper ----------
  if (file) {
    const header = file.headerRowIndex == null ? null : file.rows[file.headerRowIndex];
    const dataStart = file.headerRowIndex == null ? 0 : file.headerRowIndex + 1;
    const previewRows = file.rows.slice(dataStart, dataStart + 5);
    const columnLabels = Array.from({ length: file.ncols }, (_, c) => {
      const h = header ? cleanCell(header[c]) : "";
      return h !== "" ? h : `Column ${colLetter(c)}`;
    });
    const previews = Array.from({ length: file.ncols }, (_, c) =>
      previewRows.map((r) => cleanCell(r[c])),
    );
    const tier = computeDataTier(mapping);
    const errors = mappingErrors(mapping);

    return (
      <section className="setup-card">
        <h2>Map columns — {file.fileName}</h2>
        {file.profileApplied && (
          <p className="setup-sub" style={{ color: "var(--good)" }}>
            Saved column mapping applied from a previous upload of this source.
          </p>
        )}
        {file.headerRowIndex == null && (
          <p className="setup-sub">
            No header row detected — map the columns manually below.
          </p>
        )}
        <div className="row-inline" style={{ marginBottom: 14 }}>
          <div className="field">
            <label htmlFor="set-name">Set name</label>
            <input
              id="set-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ minWidth: 220 }}
            />
          </div>
          <div className="field">
            <label htmlFor="set-format">Format</label>
            <select
              id="set-format"
              value={formatTag}
              onChange={(e) => setFormatTag(e.target.value as "1QB" | "SF")}
            >
              <option value="1QB">1QB</option>
              <option value="SF">Superflex</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="set-season">Season</label>
            <input
              id="set-season"
              type="number"
              value={seasonYear}
              onChange={(e) => setSeasonYear(Number(e.target.value) || 2026)}
              style={{ width: 90 }}
            />
          </div>
        </div>
        <MappingTable
          columnLabels={columnLabels}
          previews={previews}
          mapping={mapping}
          confidence={confidence}
          onChange={setField}
        />
        <div className="row-inline" style={{ marginTop: 14, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Unlocks:</span>
          {tier ? (
            <>
              <TierBadge tier={tier} />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{TIER_NOTES[tier]}</span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: "#ff6b6b" }}>nothing yet — mapping incomplete</span>
          )}
        </div>
        {errors.map((e) => (
          <p key={e} style={{ color: "#ff6b6b", fontSize: 13, margin: "8px 0 0" }}>
            {e}
          </p>
        ))}
        {error && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</p>}
        <div className="startbar">
          <button onClick={reset} disabled={submitting}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={submitting || errors.length > 0}
          >
            {submitting ? "Uploading…" : "Upload & match players"}
          </button>
        </div>
      </section>
    );
  }

  // ---------- phase A: dropzone ----------
  return (
    <section className="setup-card">
      <h2>Upload rankings</h2>
      <p className="setup-sub">
        Any rankings or projections export — the mapper adapts to the columns it finds.
      </p>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a rankings file"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void onFile(f);
        }}
        style={{
          border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
          background: dragOver ? "rgba(76,201,240,0.06)" : "transparent",
          borderRadius: 10,
          padding: "34px 16px",
          textAlign: "center",
          color: "var(--muted)",
          cursor: "pointer",
        }}
      >
        {reading ? "Reading file…" : "Drop a rankings file here, or click to browse"}
        <div style={{ fontSize: 12, marginTop: 6 }}>.csv / .tsv / .txt — up to 5 MB, 5,000 rows</div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {error && <p style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</p>}
    </section>
  );
}
