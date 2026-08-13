import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { MethodBadge, StatusBadge, TierBadge } from "@/components/rankings/badges";
import { ResolutionPanel } from "@/components/rankings/ResolutionPanel";
import type { UnmatchedEntry } from "@/components/rankings/api";

export default async function RankingSetPage({
  params,
}: {
  params: Promise<{ setId: string }>;
}) {
  const userId = await requireUser();
  const { setId } = await params;
  const set = await db.rankingSet.findUnique({
    where: { id: setId },
    include: {
      entries: {
        orderBy: [{ rank: { sort: "asc", nulls: "last" } }, { sourceRow: "asc" }],
      },
    },
  });
  // presets (userId null) are readable by everyone; uploads only by their owner
  if (!set || (set.userId != null && set.userId !== userId)) notFound();

  const unmatched: UnmatchedEntry[] = set.entries
    .filter((e) => e.matchMethod === "UNMATCHED")
    .map((e) => ({
      entryId: e.id,
      rawName: e.rawName,
      team: e.team,
      pos: e.pos,
      sourceRow: e.sourceRow,
    }));
  const linked = set.entries.filter((e) => e.playerId != null).length;

  return (
    <main className="setup-page">
      <p style={{ marginBottom: 10 }}>
        <Link href="/rankings" style={{ color: "var(--muted)", fontSize: 13 }}>
          ← All rankings
        </Link>
      </p>
      <h1>{set.name}</h1>
      <section className="setup-card">
        <div className="row-inline" style={{ alignItems: "center" }}>
          <TierBadge tier={set.dataTier} />
          <StatusBadge status={set.status} />
          <span style={{ color: "var(--muted)", fontSize: 13 }}>
            v{set.version} · {set.formatTag} · season {set.seasonYear} · {set.entries.length}{" "}
            entries ({linked} linked)
          </span>
        </div>
        {set.status === "DRAFT" && (
          <p className="setup-sub" style={{ marginTop: 10, marginBottom: 0 }}>
            This set is a draft — resolve the unmatched rows below and finalize it to make it
            draftable.
          </p>
        )}
      </section>

      {set.status === "DRAFT" && (
        <section className="setup-card">
          <h2>Resolve players</h2>
          <ResolutionPanel setId={set.id} initialUnmatched={unmatched} />
        </section>
      )}

      <section className="setup-card">
        <h2>Entries</h2>
        <div style={{ overflowX: "auto", maxHeight: "62vh", overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th style={{ cursor: "default" }}>Rank</th>
                <th style={{ cursor: "default" }}>Player</th>
                <th style={{ cursor: "default" }}>Team</th>
                <th style={{ cursor: "default" }}>Pos</th>
                <th style={{ cursor: "default" }}>ADP</th>
                <th style={{ cursor: "default" }}>Proj</th>
                <th style={{ cursor: "default" }}>Match</th>
                <th style={{ cursor: "default" }}>Row</th>
              </tr>
            </thead>
            <tbody>
              {set.entries.map((e) => (
                <tr key={e.id}>
                  <td className="rankcell">{e.rank ?? "-"}</td>
                  <td>{e.rawName}</td>
                  <td>{e.team ?? "-"}</td>
                  <td>
                    {e.pos ? <span className={`pos-badge pos-${e.pos}`}>{e.pos}</span> : "-"}
                  </td>
                  <td>{e.adp ?? "-"}</td>
                  <td>{e.projPoints ?? "-"}</td>
                  <td>
                    <MethodBadge method={e.matchMethod} />
                  </td>
                  <td style={{ color: "var(--muted)" }}>{e.sourceRow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
