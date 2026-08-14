// Shared ADP-provider contracts (PLAN.md §8a). Mirrors the draft-provider
// pattern: FFC is the first implementation; later sources implement the same
// interface and can be blended. NO "server-only" here: the wizard imports the
// AdpFormat vocabulary client-side for the attribution indicator.

import type { Pos } from "@/engine/types";

/** Snapshot format vocabulary — AdpSnapshot.format. Providers map their own
 * slugs onto it (FFC '2qb' → SF, which is why SF snapshots carry adpContext SF). */
export type AdpFormat = "STANDARD" | "HALF_PPR" | "PPR" | "SF";

export const ADP_FORMATS: readonly AdpFormat[] = ["STANDARD", "HALF_PPR", "PPR", "SF"];

export const ADP_FORMAT_LABELS: Record<AdpFormat, string> = {
  STANDARD: "Standard",
  HALF_PPR: "Half-PPR",
  PPR: "PPR",
  SF: "2QB/SF",
};

/** One provider row, canonicalized to engine vocabulary (pos/team) but NOT yet
 * identity-resolved — resolution runs through the shared matcher in sync.ts. */
export interface AdpProviderEntry {
  rawName: string;
  pos: Pos | null;
  team: string | null;
  adp: number;
  stdev: number | null;
  high: number | null;
  low: number | null;
  bye: number | null;
  timesDrafted: number | null;
}

export interface AdpProviderSnapshot {
  fetchedAt: Date;
  /** Provider's sampled-drafts count for its trailing window. */
  totalDrafts: number;
  startDate: string | null;
  endDate: string | null;
  entries: AdpProviderEntry[];
}

export interface AdpProvider {
  /** Stored as AdpSnapshot.source ('ffc'). */
  id: string;
  fetchSnapshot(format: AdpFormat, teams: number): Promise<AdpProviderSnapshot>;
}

/** AdpSnapshot.entries element after identity resolution (stored as Json).
 * Unmatched entries are kept with playerId null — never dropped. */
export interface StoredAdpEntry {
  playerId: string | null;
  rawName: string;
  adp: number;
  stdev: number | null;
  high: number | null;
  low: number | null;
  bye: number | null;
  timesDrafted: number | null;
}
