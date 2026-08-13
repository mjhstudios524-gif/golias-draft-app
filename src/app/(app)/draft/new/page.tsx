import { requireUser } from "@/server/auth";
import { listLeagues, listReadyRankingSets } from "@/server/leagues";
import { readLeagueRosterSpec } from "@/lib/leagues";
import { leagueFormat } from "@/engine/format";
import { NewSessionWizard, type WizardLeague } from "@/components/draft/NewSessionWizard";

export default async function NewDraftPage() {
  const userId = await requireUser();
  const [leagues, sets] = await Promise.all([listLeagues(userId), listReadyRankingSets()]);

  const wizardLeagues: WizardLeague[] = leagues.flatMap((l) => {
    const roster = readLeagueRosterSpec(l.rosterSpec);
    if (!roster) return []; // unreadable legacy row — fix via the league editor
    return [
      {
        id: l.id,
        name: l.name,
        numTeams: l.numTeams,
        rankingSetId: l.rankingSetId,
        formatLabel:
          leagueFormat(roster.spec, roster.flexEligibleBySlot) === "MULTI_QB"
            ? "Superflex/2QB"
            : "1QB",
      },
    ];
  });

  return (
    <div className="setup-page">
      <h1>New Draft</h1>
      <NewSessionWizard userId={userId} leagues={wizardLeagues} sets={sets} />
    </div>
  );
}
