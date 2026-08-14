import type { DraftProvider } from "@/server/providers/types";
import { sleeperProvider } from "@/server/providers/sleeper";

// Provider registry (PLAN.md §8). ESPN/Yahoo land here without touching call
// sites — each declares its own authSpec.

const providers: Record<string, DraftProvider> = {
  // TLeague is erased to unknown here: getLeague/normalizeLeagueConfig remain a
  // matched pair only through the same provider instance, which is the point.
  sleeper: sleeperProvider as DraftProvider,
};

export function getProvider(id: string): DraftProvider {
  const provider = providers[id];
  if (!provider) throw new Error(`Unknown draft provider: ${id}`);
  return provider;
}
