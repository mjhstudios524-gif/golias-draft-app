import { requireUser } from "@/server/auth";
import { listReadyRankingSets } from "@/server/leagues";
import { db } from "@/server/db";
import { SleeperImport } from "@/components/leagues/SleeperImport";

export default async function ImportLeaguePage() {
  const userId = await requireUser();
  const [sets, user] = await Promise.all([
    listReadyRankingSets(),
    db.user.findUnique({ where: { id: userId }, select: { sleeperUserId: true } }),
  ]);
  return (
    <div className="setup-page">
      <h1>Import from Sleeper</h1>
      <SleeperImport sets={sets} hasLinkedSleeper={!!user?.sleeperUserId} />
    </div>
  );
}
