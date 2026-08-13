import Link from "next/link";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { UploadFlow } from "@/components/rankings/UploadFlow";
import { StatusBadge, TierBadge } from "@/components/rankings/badges";

export default async function RankingsPage() {
  const userId = await requireUser();
  const sets = await db.rankingSet.findMany({
    where: { OR: [{ userId }, { userId: null }] }, // own sets + shipped presets
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { entries: true } } },
  });
  const pending = sets.length
    ? await db.rankingEntry.groupBy({
        by: ["rankingSetId"],
        where: { rankingSetId: { in: sets.map((s) => s.id) }, matchMethod: "UNMATCHED" },
        _count: { _all: true },
      })
    : [];
  const pendingBySet = new Map(pending.map((p) => [p.rankingSetId, p._count._all]));

  return (
    <main className="setup-page">
      <h1>Rankings</h1>
      <p className="setup-sub">
        Upload a rankings or projections CSV, resolve any players the matcher could not identify,
        and the set becomes draftable once it is READY.
      </p>
      <UploadFlow />
      <section className="setup-card">
        <h2>Ranking sets</h2>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ cursor: "default" }}>Name</th>
                <th style={{ cursor: "default" }}>Version</th>
                <th style={{ cursor: "default" }}>Source</th>
                <th style={{ cursor: "default" }}>Tier</th>
                <th style={{ cursor: "default" }}>Status</th>
                <th style={{ cursor: "default" }}>Entries</th>
                <th style={{ cursor: "default" }}>Created</th>
              </tr>
            </thead>
            <tbody>
              {sets.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ color: "var(--muted)", fontStyle: "italic" }}>
                    No ranking sets yet — upload one above.
                  </td>
                </tr>
              )}
              {sets.map((s) => {
                const unresolved = pendingBySet.get(s.id) ?? 0;
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/rankings/${s.id}`} style={{ color: "var(--accent)" }}>
                        {s.name}
                      </Link>
                    </td>
                    <td>v{s.version}</td>
                    <td style={{ color: "var(--muted)" }}>
                      {s.userId == null ? "Preset" : s.kind === "PRESET" ? "Preset" : "Upload"}
                    </td>
                    <td>
                      <TierBadge tier={s.dataTier} />
                    </td>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                    <td>
                      {s._count.entries}
                      {unresolved > 0 && (
                        <span style={{ color: "var(--accent2)", fontSize: 11, marginLeft: 6 }}>
                          {unresolved} unresolved
                        </span>
                      )}
                    </td>
                    <td style={{ color: "var(--muted)" }}>
                      {s.createdAt.toISOString().slice(0, 10)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
