import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { requireUser } from "@/server/auth";
import { getActiveEntitlement } from "@/server/entitlements";
import { currentSeason } from "@/lib/season";
import { createDevMockSession, devGrantSeason, devRevokeSeason } from "./actions";

export default async function DevDraftPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const userId = await requireUser();
  const season = currentSeason(new Date());
  const [sessions, entitlement] = await Promise.all([
    db.draftSession.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { _count: { select: { picks: true } }, league: { select: { name: true } } },
    }),
    getActiveEntitlement(userId, season.product),
  ]);

  return (
    <div className="setup-page">
      <h1>Dev Draft Harness</h1>
      <div className="setup-card">
        <h2>New Mock Session</h2>
        <p className="setup-sub">
          Creates a 10-team mock session from fixture data (dev only — fixtures never ship as presets).
        </p>
        <form action={createDevMockSession} className="row-inline">
          <div className="field">
            <label>Format</label>
            <select name="format" defaultValue="superflex">
              <option value="superflex">Superflex (2QB)</option>
              <option value="standard">1QB</option>
            </select>
          </div>
          <button className="primary" type="submit">
            Start Mock Draft →
          </button>
        </form>
      </div>
      <div className="setup-card">
        <h2>Season Pass ({season.product})</h2>
        <p className="setup-sub">
          Dev-only entitlement toggle — exercises the §9 paid gates without Stripe.{" "}
          {entitlement ? (
            <b style={{ color: "var(--good)" }}>
              Active through {entitlement.expiresAt.toISOString().slice(0, 10)}
            </b>
          ) : (
            <b>Not entitled (free tier)</b>
          )}
        </p>
        <div className="row-inline">
          <form action={devGrantSeason}>
            <button className="primary" type="submit" disabled={!!entitlement}>
              Grant season pass
            </button>
          </form>
          <form action={devRevokeSeason}>
            <button className="danger" type="submit" disabled={!entitlement}>
              Revoke
            </button>
          </form>
        </div>
      </div>
      <div className="setup-card">
        <h2>Recent Sessions</h2>
        {sessions.length === 0 && <p className="setup-sub">None yet.</p>}
        {sessions.map((s) => (
          <p key={s.id} style={{ margin: "6px 0" }}>
            <a href={`/draft/${s.id}`} style={{ color: "var(--accent)" }}>
              {s.league.name} — {s.mode} — {s._count.picks} picks — {s.status}
            </a>
          </p>
        ))}
      </div>
    </div>
  );
}
