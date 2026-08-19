import Link from "next/link";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { adminUserIds } from "@/lib/env";
import { publishPresetAction, unpublishPresetAction } from "@/server/presets/publish";
import { UploadFlow } from "@/components/rankings/UploadFlow";
import { Badge, StatusBadge, TierBadge } from "@/components/rankings/badges";

/** Admin UI is additive — an unconfigured admin env means "nobody is admin",
 * never a broken page (the privileged actions still validate loudly). */
function isAdminUser(userId: string): boolean {
  try {
    return adminUserIds().includes(userId);
  } catch {
    return false;
  }
}

export default async function RankingsPage() {
  const userId = await requireUser();
  const admin = isAdminUser(userId);
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

  // Shipped presets (userId null) get their own section — they are what a
  // brand-new account drafts with on day one (PLAN.md §6). Retired ones stay
  // visible to the admin who archived them.
  const presets = sets.filter((s) => s.userId == null && (admin || s.status === "READY"));
  const mine = sets.filter((s) => s.userId != null);
  const ownCols = admin ? 8 : 7;

  return (
    <main className="setup-page">
      <h1>Rankings</h1>
      <p className="setup-sub">
        Upload a rankings or projections CSV, resolve any players the matcher could not identify,
        and the set becomes draftable once it is READY.
      </p>

      <section className="setup-card">
        <h2>Free presets</h2>
        <p className="setup-sub">
          Ready-to-draft boards that ship with the app — no upload required.
        </p>
        {presets.length === 0 ? (
          <p style={{ color: "var(--muted)", fontStyle: "italic", margin: 0 }}>
            No presets are published yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th style={{ cursor: "default" }}>Name</th>
                  <th style={{ cursor: "default" }}>Format</th>
                  <th style={{ cursor: "default" }}>Tier</th>
                  <th style={{ cursor: "default" }}>Entries</th>
                  <th style={{ cursor: "default" }}>Updated</th>
                  {admin && <th style={{ cursor: "default" }}>Admin</th>}
                </tr>
              </thead>
              <tbody>
                {presets.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="row-inline" style={{ alignItems: "center", gap: 8 }}>
                        <Link href={`/rankings/${s.id}`} style={{ color: "var(--accent)" }}>
                          {s.name}
                        </Link>
                        <Badge label="Free preset" tone="accent" />
                        {s.derivedFrom && (
                          <Badge
                            label="Auto-updated nightly"
                            tone="good"
                            title={`Derived from live market ADP (${s.derivedFrom}) — the nightly ADP sync keeps it current.`}
                          />
                        )}
                        {s.status !== "READY" && <StatusBadge status={s.status} />}
                      </div>
                    </td>
                    <td style={{ color: "var(--muted)" }}>{s.formatTag}</td>
                    <td>
                      <TierBadge tier={s.dataTier} />
                    </td>
                    <td>{s._count.entries}</td>
                    <td style={{ color: "var(--muted)" }}>
                      {s.createdAt.toISOString().slice(0, 10)}
                    </td>
                    {admin && (
                      <td>
                        {s.status === "READY" && (
                          <form action={unpublishPresetAction}>
                            <input type="hidden" name="setId" value={s.id} />
                            <button className="danger" type="submit">
                              Unpublish
                            </button>
                          </form>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
                {admin && <th style={{ cursor: "default" }}>Admin</th>}
              </tr>
            </thead>
            <tbody>
              {mine.length === 0 && (
                <tr>
                  <td colSpan={ownCols} style={{ color: "var(--muted)", fontStyle: "italic" }}>
                    No ranking sets yet — upload one above.
                  </td>
                </tr>
              )}
              {mine.map((s) => {
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
                      {s.kind === "PRESET" ? "Preset" : "Upload"}
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
                    {admin && (
                      <td>
                        {s.status === "READY" && unresolved === 0 && (
                          <form action={publishPresetAction}>
                            <input type="hidden" name="setId" value={s.id} />
                            <button className="primary" type="submit">
                              Publish as preset
                            </button>
                          </form>
                        )}
                      </td>
                    )}
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
