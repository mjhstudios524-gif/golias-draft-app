import Link from "next/link";

// Public landing (the only unauthenticated page besides /pricing). Static RSC.
export default function Home() {
  return (
    <div className="setup-page" style={{ maxWidth: 720, paddingTop: 48 }}>
      <h1 style={{ fontSize: 34, marginBottom: 6 }}>GOLIAS Draft Tool</h1>
      <p style={{ color: "var(--muted)", fontSize: 16, marginBottom: 28 }}>
        A live draft room that thinks with you — recommendations built from positional
        scarcity, tier cliffs, bye weeks, and who will actually still be on the board
        when you pick again.
      </p>

      <div className="setup-card">
        <h2>What you get</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9, fontSize: 14 }}>
          <li>
            <b>Free consensus boards</b> for PPR, Half-PPR, Standard, and Superflex —
            rebuilt nightly from thousands of real drafts, never stale on draft day.
          </li>
          <li>
            <b>Mock drafts</b> against realistic bot opponents, with the full
            recommendation engine and a draft board that resumes on any device.
          </li>
          <li>
            <b>Your own rankings</b> (season pass) — upload any CSV and the room shows
            where the market disagrees with you: value falling to you in green,
            reaches in amber.
          </li>
          <li>
            <b>Live Sleeper sync</b> (season pass) — import your league, and real
            draft-night picks flow onto your board automatically.
          </li>
        </ul>
      </div>

      <div className="row-inline" style={{ marginTop: 20 }}>
        <Link href="/dashboard">
          <button className="primary" style={{ fontSize: 15, padding: "10px 22px" }}>
            Open the draft room →
          </button>
        </Link>
        <Link href="/pricing">
          <button style={{ fontSize: 15, padding: "10px 22px" }}>Pricing — $8.99 season pass</button>
        </Link>
      </div>

      <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 40 }}>
        ADP data: FantasyFootballCalculator.com · Player data: Sleeper
      </p>
    </div>
  );
}
