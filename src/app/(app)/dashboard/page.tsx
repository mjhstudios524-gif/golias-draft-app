import Link from "next/link";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { listLeagues } from "@/server/leagues";
import { readLeagueRosterSpec } from "@/lib/leagues";
import { leagueFormat } from "@/engine/format";

const MODE_LABELS: Record<string, string> = {
  MOCK: "Mock",
  MANUAL: "Manual",
  SLEEPER_SYNC: "Sleeper",
};

const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: "In progress",
  COMPLETE: "Complete",
  ABANDONED: "Abandoned",
};

function formatLabel(rosterSpecJson: unknown): string {
  const roster = readLeagueRosterSpec(rosterSpecJson);
  if (!roster) return "—";
  return leagueFormat(roster.spec, roster.flexEligibleBySlot) === "MULTI_QB" ? "SF/2QB" : "1QB";
}

function LinkButton({
  href,
  primary,
  children,
}: {
  href: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  // anchor with the design system's button look (button rules are element-scoped)
  return (
    <Link
      href={href}
      style={{
        display: "inline-block",
        padding: "8px 14px",
        borderRadius: 6,
        border: `1px solid ${primary ? "var(--accent)" : "var(--border)"}`,
        background: primary ? "var(--accent)" : "var(--panel2)",
        color: primary ? "#04222c" : "var(--text)",
        fontWeight: primary ? 700 : undefined,
        fontSize: 14,
        textDecoration: "none",
      }}
    >
      {children}
    </Link>
  );
}

export default async function DashboardPage() {
  const userId = await requireUser();
  const [leagues, sessions] = await Promise.all([
    listLeagues(userId),
    db.draftSession.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 25,
      select: {
        id: true,
        mode: true,
        status: true,
        updatedAt: true,
        league: { select: { name: true } },
        _count: { select: { picks: true } },
      },
    }),
  ]);

  return (
    <div className="setup-page">
      <h1>GOLIAS Draft Tool</h1>
      <div className="row-inline" style={{ margin: "14px 0 18px" }}>
        <LinkButton href="/draft/new" primary>
          New Draft →
        </LinkButton>
        <LinkButton href="/leagues/new">+ New League</LinkButton>
        <LinkButton href="/leagues/import">⇣ Import from Sleeper</LinkButton>
        <LinkButton href="/rankings">Rankings</LinkButton>
      </div>

      <div className="setup-card">
        <h2>Leagues</h2>
        {leagues.length === 0 ? (
          <p className="setup-sub" style={{ marginBottom: 0 }}>
            No leagues yet —{" "}
            <Link href="/leagues/new" style={{ color: "var(--accent)" }}>
              create your first league
            </Link>
            .
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Teams</th>
                <th>Format</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leagues.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/leagues/${l.id}`} style={{ color: "var(--text)" }}>
                      {l.name}
                    </Link>
                  </td>
                  <td>{l.numTeams}</td>
                  <td>{formatLabel(l.rosterSpec)}</td>
                  <td>
                    <Link href={`/leagues/${l.id}`} style={{ color: "var(--accent)" }}>
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="setup-card">
        <h2>Draft Sessions</h2>
        {sessions.length === 0 ? (
          <p className="setup-sub" style={{ marginBottom: 0 }}>
            No drafts yet —{" "}
            <Link href="/draft/new" style={{ color: "var(--accent)" }}>
              start one
            </Link>
            .
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>League</th>
                <th>Mode</th>
                <th>Picks</th>
                <th>Status</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.league.name}</td>
                  <td>{MODE_LABELS[s.mode] ?? s.mode}</td>
                  <td>{s._count.picks}</td>
                  <td>{STATUS_LABELS[s.status] ?? s.status}</td>
                  <td>{s.updatedAt.toISOString().slice(0, 10)}</td>
                  <td>
                    <Link href={`/draft/${s.id}`} style={{ color: "var(--accent)" }}>
                      {s.status === "IN_PROGRESS" ? "Resume →" : "View →"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
