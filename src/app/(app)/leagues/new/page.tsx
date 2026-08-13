import { requireUser } from "@/server/auth";
import { listReadyRankingSets } from "@/server/leagues";
import { LeagueForm } from "@/components/leagues/LeagueForm";

export default async function NewLeaguePage() {
  await requireUser();
  const sets = await listReadyRankingSets();
  return (
    <div className="setup-page">
      <h1>New League</h1>
      <LeagueForm sets={sets} />
    </div>
  );
}
