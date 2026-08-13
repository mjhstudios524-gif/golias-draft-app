"use client";

// Column-mapper table (PLAN.md §6): one row per CSV column — detected label,
// canonical-field dropdown (+ Ignore), confidence dot, 5-row value preview.

import {
  CANONICAL_FIELDS,
  FIELD_LABELS,
  type CanonicalField,
  type ColumnMapping,
  type Confidence,
} from "@/lib/csv/headers";

const CONFIDENCE_META: Record<Confidence, { color: string; title: string }> = {
  high: { color: "var(--good)", title: "Matched a known header" },
  medium: { color: "var(--accent2)", title: "Inferred from column position or values" },
  none: { color: "#4a5160", title: "Not auto-detected" },
};

function ConfidenceDot({ level }: { level: Confidence }) {
  const meta = CONFIDENCE_META[level];
  return (
    <span
      title={meta.title}
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 99,
        background: meta.color,
        marginRight: 8,
        verticalAlign: "middle",
      }}
    />
  );
}

export function MappingTable({
  columnLabels,
  previews,
  mapping,
  confidence,
  onChange,
}: {
  columnLabels: string[];
  previews: string[][];
  mapping: ColumnMapping;
  confidence: Confidence[];
  onChange: (col: number, field: CanonicalField | null) => void;
}) {
  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
      <table>
        <thead>
          <tr>
            <th style={{ cursor: "default" }}>Column</th>
            <th style={{ cursor: "default" }}>Maps to</th>
            <th style={{ cursor: "default" }}>Preview (first 5 rows)</th>
          </tr>
        </thead>
        <tbody>
          {columnLabels.map((label, c) => (
            <tr key={c}>
              <td style={{ whiteSpace: "nowrap" }}>
                <ConfidenceDot level={confidence[c] ?? "none"} />
                <b>{label}</b>
              </td>
              <td>
                <select
                  aria-label={`Field for ${label}`}
                  value={mapping[c] ?? ""}
                  onChange={(e) => onChange(c, (e.target.value || null) as CanonicalField | null)}
                >
                  <option value="">— Ignore —</option>
                  {CANONICAL_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABELS[f]}
                    </option>
                  ))}
                </select>
              </td>
              <td style={{ color: "var(--muted)", fontSize: 12 }}>
                {(previews[c] ?? []).filter((v) => v !== "").join(" · ") || (
                  <span style={{ fontStyle: "italic" }}>empty</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
