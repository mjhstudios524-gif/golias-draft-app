import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { listReadyRankingSets } from "@/server/leagues";
import {
  DEFAULT_ROSTER_SPEC,
  readLeagueRosterSpec,
  scoringConfigSchema,
} from "@/lib/leagues";
import { FLEX_ELIGIBLE_DEFAULT } from "@/engine/format";
import { LeagueForm, type LeagueFormInitial } from "@/components/leagues/LeagueForm";

export default async function LeagueEditPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const userId = await requireUser();
  const { leagueId } = await params;
  const league = await db.league.findUnique({ where: { id: leagueId } });
  if (!league || league.userId !== userId) notFound();
  const sets = await listReadyRankingSets();

  const roster = readLeagueRosterSpec(league.rosterSpec);
  const scoring = scoringConfigSchema.safeParse(league.scoring);
  const initial: LeagueFormInitial = {
    id: league.id,
    name: league.name,
    numTeams: league.numTeams,
    rosterSpec: roster?.spec ?? DEFAULT_ROSTER_SPEC,
    flexEligibleBySlot: roster?.flexEligibleBySlot ?? [[...FLEX_ELIGIBLE_DEFAULT]],
    scoring: scoring.success ? scoring.data : null,
    rankingSetId: league.rankingSetId,
  };

  return (
    <div className="setup-page">
      <h1>Edit League</h1>
      <p className="setup-sub">
        Changes apply to future drafts only — a session in progress keeps its frozen snapshot.
      </p>
      <LeagueForm sets={sets} initial={initial} />
    </div>
  );
}
