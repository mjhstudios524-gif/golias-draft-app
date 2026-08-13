// Small inline badges for rankings surfaces (tier / set status / matchMethod).
// Pure presentational — safe in both server and client trees.

import type { CSSProperties } from "react";

type Tone = "good" | "warn" | "accent" | "muted" | "danger";

const TONES: Record<Tone, { color: string; bg: string; border: string }> = {
  good: { color: "#7ee0c2", bg: "rgba(42,157,143,0.14)", border: "rgba(42,157,143,0.45)" },
  warn: { color: "var(--accent2)", bg: "rgba(255,183,3,0.12)", border: "rgba(255,183,3,0.4)" },
  accent: { color: "var(--accent)", bg: "rgba(76,201,240,0.1)", border: "rgba(76,201,240,0.4)" },
  muted: { color: "var(--muted)", bg: "var(--panel2)", border: "var(--border)" },
  danger: { color: "#ff8787", bg: "rgba(255,107,107,0.12)", border: "rgba(255,107,107,0.4)" },
};

export function Badge({ label, tone, title }: { label: string; tone: Tone; title?: string }) {
  const t = TONES[tone];
  const style: CSSProperties = {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: "0.4px",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
    color: t.color,
    background: t.bg,
    border: `1px solid ${t.border}`,
  };
  return (
    <span style={style} title={title}>
      {label}
    </span>
  );
}

const TIERS: Record<string, { tone: Tone; label: string; title: string }> = {
  RANK_ONLY: {
    tone: "muted",
    label: "Rank only",
    title: "Ordinal ranks — legacy engine mode. Upload projections or points to unlock scoring-driven VBD.",
  },
  POINTS: {
    tone: "warn",
    label: "Points",
    title: "Season points — VBD on the given points; scoring sliders locked.",
  },
  FULL_STATS: {
    tone: "good",
    label: "Full stats",
    title: "Stat-line projections — scoring-config-driven VBD, sliders active.",
  },
};

export function TierBadge({ tier }: { tier: string }) {
  const t = TIERS[tier] ?? { tone: "muted" as Tone, label: tier, title: tier };
  return <Badge label={t.label} tone={t.tone} title={t.title} />;
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Tone = status === "READY" ? "good" : status === "DRAFT" ? "warn" : "muted";
  return <Badge label={status} tone={tone} />;
}

const METHOD_TONES: Record<string, Tone> = {
  ALIAS: "accent",
  EXACT_FULL: "good",
  EXACT_POS: "good",
  EXACT_TEAM: "good",
  EXACT_NAME: "good",
  FUZZY: "warn",
  MANUAL: "accent",
  UNLINKED: "warn",
  EXCLUDED: "muted",
  UNMATCHED: "danger",
};

export function MethodBadge({ method }: { method: string }) {
  return <Badge label={method.replace(/_/g, " ")} tone={METHOD_TONES[method] ?? "muted"} />;
}
