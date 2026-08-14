# GOLIAS Draft Tool — Production Rebuild Plan

**Status (2026-08-14):** Phases 0–3 built, tested (319 green incl. golden parity + three-way transcription audit), and committed in `golias-draft-app`. Remaining before launch: owner-authored presets, external accounts (GitHub/Clerk/Neon/Stripe per README), first deploy + pre-launch checklist (§12). Phase 4 items deferred post-launch.
**Source of truth for domain logic:** `draft-room.html` (~1,400 lines, vanilla JS). The logic is sound and is preserved; this plan generalizes it (rank → configurable value) without changing its behavior shape.
**Date context:** 2026-08-12. Fantasy draft season peaks late August through Labor Day. The phasing in §13 front-loads the draft-critical path.

---

## 1. Goals and non-goals

**Build:** a production web app — Next.js (App Router) + TypeScript + Postgres/Prisma on Vercel, Clerk auth, Stripe Checkout one-time seasonal unlock — that ports the existing draft room and recommendation engine, replaces bundled rankings with user-uploaded CSVs plus 2–3 owner-generated presets, replaces raw rank with a league-configurable VBD/VORP value model, and adds Sleeper league import with live draft-pick sync behind a provider abstraction (ESPN/Yahoo later).

**Non-goals for v1:** auction drafts, IDP scoring, multi-user shared draft rooms, ESPN/Yahoo providers (interface only), native mobile apps, migrating old localStorage drafts.

---

## 2. What exists today — domain logic inventory

Verified by direct read of `draft-room.html`. Line refs are landmarks for the port.

| # | Logic | Where | Behavior |
|---|---|---|---|
| 1 | **Snake order** | `pickTeamForOverall` ~610 | `round = ceil(overall/n)`; odd rounds walk `teamOrder` forward, even rounds reverse. Helpers: `currentOverall`, `isMyClock`, `myNextPickOverall` (starts at cur+1 when on the clock), `picksBeforeMyNextTurn`. |
| 2 | **Adaptive tiering** | `computeTiers` ~381 | Per position, rank-sorted; tier break when `gap >= max(2, 2 × median(local gap window i−5..i+4))` or per-pos size cap (QB 6, RB 8, WR 8, TE 6, DEF 6, K 6). Dense elite runs still split; sparse tails don't fragment. |
| 3 | **ADP survival** | `survivalProb` ~370 | Logistic `1/(1+exp(−1.7·(adp−pick)/σ))`, `σ = max(6, 0.18·adp)`. `effectiveAdp` ~362 nulls QB ADP in superflex (bundled FTN ADP is a 1QB-market number). |
| 4 | **Superflex detection** | `isSuperflexFormat` ~411 | `QB ≥ 2` or any FLEX slot eligible for QB → swaps to the second hardcoded ranking list. |
| 5 | **Roster slots** | `buildSlotTemplate`/`assignRosterSlots` ~1020/1036 | Greedy in pick order: dedicated slot → first eligible FLEX → bench → overflow ("EXTRA"). Per-slot FLEX eligibility lists. Greedy is order-dependent (pinned behavior, not a bug). |
| 6 | **Team needs** | `computeTeamNeeds` ~662 | Open non-bench slots → needed-position set (FLEX expands to eligibility). |
| 7 | **Positional outlook** | `positionOutlook` ~706 | `next` = best at pos with survival ≥ 0.5 at my next pick; rank-order fallback (skip top `gone`) when no ADP; `drop = next.rank − now.rank`, default 80 when no successor. |
| 8 | **Recommendation engine** | `computeRecommendations` ~737 | Pool = available ∩ user position toggles ∩ needs (fallback to allowed when empty). Scores top **45**: `score = −rank + 0.55·drop`; +7/+3 tier scarcity (≤2/≤4 left); −4 bye clash (≥2 starters share bye); −5 if survival ≥ 0.75 / +5 if ≤ 0.25. Shortlist: max 2 per position, top 5. Reason strings in a fixed priority order, max 2, joined by " · ". |
| 9 | **Mock autopick** | `weightedPick`/`autoPickForTeam` ~969/988 | Needs-filtered, rank-sorted pool. 8% "sleeper reach" uniform over indices 8–28; else weighted top-4 (0.55/0.24/0.13/0.08). Bots draft silently until user's turn. |
| 10 | **Bye weeks** | ~352, `starterByeCounts` ~722 | Static per-season table with FTN alias codes (HST/LA/BLT/ARZ). Rec penalty at ≥2 shared-bye starters; roster view flags "stacked" at ≥3. |
| 11 | **Undo** | `undoPick` ~637 | Mock mode: pop picks back through the user's own last pick (whole turn). Manual: pop one. |
| 12 | **Misc** | — | Queue (star toggle, drafted entries retained), board grid with on-clock cell, roster tab with EXTRA rows, CSV export with proper quoting, localStorage resume, search/sort (nulls last), ADP cell coloring (value ≥ +20 green / reach ≤ −20 amber / `*` for 1QB figure in superflex), scarcity bar, "suggest" position toggles, mobile stacked layout with column hiding at 900/560px. |

**Data quirks that inform ingestion design:** D/ST entries are nickname-only ("Broncos"), double-spaced names exist ("Keenan  Allen"), team codes ARZ/BLT/HST/LA/INA/FA appear, many K/DEF/deep players have null ADP.

---

## 3. Architecture overview

One Next.js App Router app (Next 16.x, React 19, TS strict) on Vercel. Three load-bearing decisions:

1. **The engine is a pure, framework-free TS module** (`src/engine/`) with zero React/Next/Prisma imports, enforced by an ESLint `no-restricted-imports` rule (no monorepo needed). Vitest tests it directly in a Node environment. It runs **client-side** in the draft room — a mock draft fires up to `numTeams−1` bot picks per user pick and must be instant, exactly like the original.
2. **The invariant from the original is kept:** `state = {config, picks[], queue[], recPos[]}` is the whole draft; everything else (availability, tiers, needs, outlook, recommendations, roster slots, board) is derived by pure functions. The server stores state; it never derives from it.
3. **One `DraftState` shape for all three modes** — `MOCK`, `MANUAL` (tracking an in-person draft), `SLEEPER_SYNC` (live). Mode only changes *who writes picks*. In live mode the provider poller is the sole writer and manual drafting/undo are disabled; recommendations, queue, scarcity, board, and rosters work unchanged because they only read state.

### Repo layout

```
src/
  app/
    (marketing)/page.tsx                  # public landing
    (app)/dashboard/page.tsx              # leagues, resumable sessions, entitlement state
    (app)/leagues/new/  (app)/leagues/[leagueId]/
    (app)/rankings/  (app)/rankings/[setId]/   # CSV mapper + match review
    (app)/draft/new/                      # session wizard (league, mode, ranking set, seat)
    (app)/draft/[sessionId]/              # THE draft room (client subtree)
    (app)/billing/  (app)/settings/
    api/drafts/[id]/sync/route.ts         # POST: batched pick persistence
    api/drafts/[id]/live/route.ts         # GET: Sleeper pull-through poll (entitlement-gated)
    api/drafts/[id]/route.ts              # GET: rehydration snapshot
    api/ranking-sets/...                  # upload, resolutions, finalize
    api/players/index/route.ts            # slim player index for client-side match preview
    api/webhooks/stripe/route.ts  api/webhooks/clerk/route.ts
    api/cron/sync-players/route.ts        # daily Sleeper players dump
  engine/                                 # PURE — the Vitest surface (see §4)
  server/                                 # server-only ("server-only" import guard)
    db.ts  auth.ts  entitlements.ts  stripe.ts
    providers/  (types.ts, registry.ts, sleeper/)
    rankings/   (match.ts, normalize.ts)
  stores/draftStore.ts                    # zustand factory
  components/draft/  components/rankings/  components/ui/
  lib/schemas.ts  lib/env.ts  lib/season.ts
prisma/schema.prisma   presets/*.csv   scripts/
```

### Draft-room data flow

- **Store:** Zustand (per-mount vanilla store, `subscribeWithSelector`). The room has ~7 sibling regions reading overlapping slices; selectors keep bot-pick bursts at 60fps where context/useReducer would re-render the tree. The store's core is the engine's pure reducer — no logic lives in the store.
- **Derived data** (availability, needs, outlook, recommendations, roster slots, board) computes client-side via memoized selectors; at ~450 players and the 45-candidate scorer cap a full recompute is sub-millisecond. Values, valueRanks, and tiers are precomputed once into the session snapshot.
- **Persistence:** optimistic local apply, then a debounced idempotent batch to `POST /api/drafts/[id]/sync` (flush at 1.5s idle / 25 buffered picks / immediately on the user's own pick / on `pagehide` via `fetch(..., {keepalive: true})` with `navigator.sendBeacon` as fallback — both carry the same-origin Clerk session cookie). Route handler, not a server action — actions serialize per client and can't fire-and-forget. During MOCK/MANUAL sessions the client is source of truth and the server is a follower; the sync payload is `{upserts[], truncateAfter?, queuedPlayerIds?, recPositions?}` applied in one transaction, idempotent by `@@unique([sessionId, overall])` + `skipDuplicates`.
- **Resume/cross-device:** the RSC loader hydrates the store from session + picks. localStorage holds only unflushed pending ops; pending ops flush first, then server wins. True divergence (both ahead) → explicit "which copy?" prompt; no CRDT machinery for a single-user tool.
- **Undo** runs the engine reducer locally (`undoLast` / mock-mode `undoLastUserTurn`) and enqueues `truncateAfter`.

### Realtime posture

No push infrastructure in v1. Each draft session has exactly one interested browser. Clients poll our `/live` route at 5s while a Sleeper draft is in progress (details §8). Vercel's native WebSocket support (public beta June 2026) is instance-pinned without broadcast — not something to bet draft season on. SSE via Fluid Compute is a drop-in upgrade later behind the same delta response shape.

### Postgres on Vercel (verified Aug 2026)

Vercel Postgres is sunset; **Neon via the Vercel Marketplace** is the path (`@vercel/postgres` is unmaintained — do not use). **Prisma ORM 7**: Rust-free client default, driver adapters mandatory → `@prisma/adapter-neon` over the pooled (`-pooler`) URL at runtime, `directUrl` for migrations, `prisma.config.ts` + `prisma-client` generator with explicit output. Node runtime everywhere — no edge functions anywhere (they only complicate Prisma/Clerk/Stripe). Pin Prisma/Neon adapter minors; no preview features, so mid-season upgrades are never forced.

---

## 4. The engine port

**Strategy: extract verbatim → pin with golden masters → generalize with tests already green.** Nothing is "improved" until the pinned suite proves the TS port is equivalent to the JS original. This is the riskiest, most draft-critical workstream and lands first (§13).

### Module map (`src/engine/`)

| Module | Exports | Source landmark |
|---|---|---|
| `types.ts` | `Pos`, `RosterSpec`, `SlotDef`, `DraftConfig`, `Pick`, `ValuedPlayer`, `DraftState`, `Recommendation`, `Rng` | — |
| `rng.ts` | `mulberry32(seed)` — the single injected randomness source | replaces `Math.random` (~471, ~969) |
| `snake.ts` | `totalRounds`, `totalPicks`, `pickForOverall`, `currentOverall`, `isOnClock`, `nextPickFor`, `picksUntilTurn`, `buildPickOwnerByOverall` | ~604–692 |
| `format.ts` | `leagueFormat(spec, flexEligibility): '1QB' \| 'MULTI_QB'`, `flexEligibleUnion` | ~411, ~1093 |
| `scoring.ts` | `pointsFor(statLine, config, pos)`, `sleeperScoringToConfig`, presets | new |
| `baseline.ts` | `computeStarterDemand` (greedy flex simulation), `baselinePoints`, beta tables | new |
| `value.ts` | `computeValues → ValuedPlayer[]` (+ `valueRank`), data-tier adapters | new |
| `adp.ts` | `effectiveAdp(p, sourceTag, leagueFormat)`, `survivalProb`, `adpSignal` | ~362–375, ~1294 |
| `tiers.ts` | `computeTiers(items, valueOf, caps): Map<id, tier>` — generalized, non-mutating | ~381 |
| `roster.ts` | `buildSlotTemplate`, `assignRosterSlots`, `computeTeamNeeds`, `starterByeCounts`, `byeSummary` | ~1020, ~1036, ~662, ~722, ~943 |
| `outlook.ts` | `availableSortedByValue`, `tierRemaining`, `positionOutlook` | ~695–720 |
| `recommend.ts` | `computeRecommendations` + `scoreBreakdown` + structured reasons + `formatReason` | ~737–814 |
| `autopick.ts` | `weightedPick(pool, rng)`, `autoPickForTeam`, `runAutoPicks` (pure reducer) | ~969–1017 |
| `draft.ts` | reducers: `applyPick`, `undoLast`, `undoLastUserTurn`, `reset`, `toggleQueue`, `toggleRecPos` | ~625–659, ~887–905 |
| `bye.ts` | `byeWeekFor(team, byeMap)` — bye table is injected data, never hardcoded | ~352 |
| `teams.ts` | `canonicalTeamCode` — one alias map (HST→HOU, BLT→BAL, ARZ→ARI, LA→LAR, JAC→JAX, WSH→WAS, OAK→LV, SD→LAC, STL→LAR, INA/FA→null) applied at every ingestion boundary; the engine only ever sees canonical codes | ~352 aliases |
| `export.ts` | `rosterExportRows` + `csvSerialize` (same row schema, quoting pinned) | ~1368 |
| `scarcity.ts` | `scarcitySummary` (tier-left per pos; warn ≤4 / crit ≤2) | ~844 |

Every function that today reads globals (`state`, `PLAYERS_RAW`) takes explicit parameters instead.

### Behavior contracts that must survive the port (the subtle ones)

The full inventory lives in the test plan (§11 fixtures); these are the ones easy to get silently wrong:

- **Scoring pool cap of 45**; shortlist max 2 per position, stop at 5; score ties keep rank order (stable sort — pinned by test).
- **Reason strings**: exact text, fixed priority order (best-overall → gone-before-next-pick → drop ≥25/≥12 → tier ≤2/≤4 → will-wait ≥0.75 → falling ≥25 past rank → bye stack → fallback "Strong value at POS"), first 2 kept, `' · '` separator. Ported as structured `{code, params}[]` plus a formatter reproducing the strings verbatim (golden-compared).
- **`positionOutlook`**: the `(survivalProb(p, nextPick) || 0) >= 0.5` coercion means null-survival players (all K/DEF; superflex QBs) always fail the ADP path and fall to the rank-order fallback; exact 0.5 passes; **drop default 80** when no successor; drop 0 on the user's final pick.
- **Survival σ floor of 6** (active for ADP ≤ 33.3); logistic slope 1.7; exactly 0.5 at pick == ADP.
- **Tier medians are upper-median over the window `gaps[i−5 .. i+4)`** — the current gap sits inside its own window; threshold `max(2, med×2)` with `g >= thr` inclusive; size caps force breaks; a uniform gap-2 run does *not* break (thr 4) while a gap-2 inside a gap-1 run does (thr 2).
- **`weightedPick`**: sleeper branch requires `roll < 0.08` **and** `pool.length > 8`; band is `[min(8,len−1), min(28,len−1)]` inclusive; top-N weights implicitly renormalize for pools < 4; net unconditional idx-0 probability 0.506.
- **Undo (mock)** pops through the user's last pick. Known dead-end in the original: undo before the user has ever picked pops everything and stalls the mock draft — pinned in goldens, then fixed (see change register).
- **Reset preserves queue and recPos.** Queue retains drafted players (rendered struck-through). Bench-only-open needs → empty set → best-available fallback pool.
- **Roster greedy order-dependence** (e.g. FLEX1 [RB,WR] + FLEX2 [RB]: RB-then-WR strands the WR) is pinned, not fixed.
- **CSV export**: header row, empty-slot rows included, EXTRA rows, null ADP → empty string, quote iff `/[",\n]/` with doubled quotes.

### Intentional behavior changes (each registered + tested; everything else bit-for-bit)

| # | Change | Why |
|---|---|---|
| 1 | `applyPick` rejects already-drafted playerIds | Unreachable via the old UI; required once picks arrive over the network |
| 2 | Mock undo with zero user picks re-runs autopicks instead of stalling | Confirmed dead-end in the original |
| 3 | `bnOpen` dropped from `computeTeamNeeds` return | Dead output; zero readers |
| 4 | `computeTiers` returns a `Map` instead of mutating players | Purity; identical tier numbers |
| 5 | Injected seedable RNG everywhere | Determinism; draft-order shuffle seed stored on the session for audit |
| 6 | Reasons become structured `{code, params}` + formatter | String-identical output; UI consumes structured form |

### Golden-master strategy

1. `scripts/extract-fixtures.mjs` parses `draft-room.html` → `players.superflex.json` / `players.standard.json`; asserts the known invariants (377 master entries; 361 per list; Josh Allen SF #1 / STD #29). **These fixtures are test data only — they do not ship as presets** (see §6 compliance note).
2. Copy the pure functions verbatim into `src/engine/legacy/legacy-engine.cjs` (only mechanical edits: globals → params, `Math.random` → rng). This is the executable spec.
3. One-time transcription audit: a seeded Playwright run drives the real `draft-room.html` (monkey-patched `Math.random`), scripts 5 full mock drafts, dumps localStorage state + rec-panel text per turn; byte-compare with the legacy module. Three-way agreement (browser ↔ legacy copy ↔ TS port) removes copy-paste risk.
4. `scripts/gen-goldens.mjs` runs the legacy module over a config × seed matrix (~24 runs: 10-team SF, 12-team 1QB, 8-team mixed-flex, 4-team, 20-team, tiny-bench overflow × 4 seeds × 2 user policies), recording picks, rosters, tiers, and at every user turn: recommendation ids, formatted reasons, per-term scores, outlook, needs, scarcity — committed as human-diffable JSON.
5. `golden.test.ts` replays every golden through the TS engine (strings exact; floats at 1e-9 — `Math.exp` isn't IEEE-mandated correctly-rounded, so CI pins Node 24). Port module by module with goldens green throughout; then flip internals to VBD **with rank mode still golden-green** (rank mode ships as the behavior of rank-only uploads). Legacy module deleted after sign-off; golden JSONs stay as rank-mode regression tests.

Cost: ~2 dev-days including the Playwright audit; the golden suite runs in seconds.

---

## 5. Scoring config + VBD engine (the core generalization)

### ScoringConfig

Canonical stat vocabulary = **Sleeper's `scoring_settings` keys verbatim** (verified against live league objects), so Sleeper import is a filtered pass-through and CSV projections map onto the same keys:

```ts
interface ScoringConfig {
  name: string;
  weights: Partial<Record<StatKey, number>>;                     // pass_yd, pass_td, rec, rec_yd, fum_lost, ...
  posWeights?: Partial<Record<Pos, Partial<Record<StatKey, number>>>>;  // TE premium = posWeights.TE.rec (⇄ Sleeper bonus_rec_te)
}
// pointsFor(stat, cfg, pos) = Σ stat[k] · (weights[k] + posWeights[pos]?.[k])
```

UI controls (PPR 0/0.5/1/custom, TE premium, pass TD 4/6, yardage divisors, INT/fumble penalties, optional bonuses) are typed accessors over the map. Sleeper floats round to 4 dp on ingest (`0.10000000149…` noise is real); unknown keys are preserved, never dropped. Stored as Zod-validated JSONB.

### VBD: `value(p) = projPoints(p) − baselinePoints(pos)`

**Baselines from roster shape via greedy flex simulation** (`computeStarterDemand`): start with dedicated demand (`teams × spec[pos]`), then process each distinct FLEX slot most-restrictive-eligibility-first; each of the `teams` copies of a slot goes to the position whose next-best unconsumed player projects highest. This answers "who would actually fill this flex slot by value," per-slot eligibility included.

**The superflex insight — this deletes the dual hardcoded ranking lists:** with a QB-eligible flex, after dedicated slots consume QB1–12, QB13+ project far above the remaining RB/WR pool, so the simulation hands essentially all superflex slots to QB. QB demand → ~2×teams, the QB baseline drops from ~QB12 to ~QB24, and every startable QB's value inflates by the difference — *emergently, with zero format-specific code*. 2QB leagues get the same effect through dedicated demand. Worked example (12-team, 1QB/2RB/3WR/1TE/1FLEX, half-PPR): starter demand QB 12 / RB 30 / WR 42 / TE 12; flipping FLEX to QB-eligible moves it to QB 24 / RB 24 / WR 36 / TE 12 and QB1 leapfrogs RB1 in value, matching market behavior.

**Baseline flavor:** one knob, `λ ∈ [0,1]` interpolating VOLS (λ=0, value over last starter) → VORP (λ=1, over last realistically-drafted via bench-propensity vectors `beta` per format). **Default λ = 0.5 blend** — pure VOLS overprices onesie positions, pure VORP flattens elite RB/WR; markets price between. Exposed in league settings as VOLS/Blend/VORP presets. Baselines compute **once at draft start** (static during the draft; in-draft scarcity remains the job of drop/tier/survival terms, preserving the legacy engine's shape and determinism).

**What remains of `isSuperflexFormat`:** demoted to `leagueFormat()` metadata for (a) selecting the multi-QB beta vector and (b) the generalized ADP rule:

```ts
// the FTN hardcode, now data-driven — every ranking set carries adpContext: '1QB' | 'SF' | 'UNKNOWN'
if (p.pos === 'QB' && source.adpContext !== 'SF' && league === 'MULTI_QB') return null;
```

(UNKNOWN defaults to the 1QB behavior, preserving today's semantics. The converse mismatch — SF-tagged ADP in a 1QB league — warns, never silently reorders.) `survivalProb` ports unchanged.

### Integration into the recommendation engine — two stages

**Stage 1 (ships for draft season): everything ordinal stays ordinal.** Sorting players by value desc yields `valueRank`, an overall ordinal exactly like the legacy consensus rank. Tiers, drop-off, the `−rank` score term, ADP deltas (±20 signal, ≥25 reason), and display all run on `valueRank`. Every calibrated constant (tier `max(2, med×2)`, drop 12/25/80, 0.55 weight, +7/+3/−4/±5) keeps its tuned meaning with **zero re-tuning risk**, and a rank-only ranking set reproduces the legacy tool bit-for-bit (`value = −sourceRank`) — which is precisely the golden-parity harness. VBD changes *which order the players are in*; nothing else.

**Stage 2 (post-launch experiment, behind an `engineMode` flag):** score on PPG-scaled raw value (`scaledValue = value / PPG` where `PPG` = average value gap per pick across the draftable pool), letting real positional cliffs express convexity the ordinal view flattens. The design is specified (per-draft exchange rate keeps the tuned weights meaningful; drop becomes value-drop/PPG; tier threshold floor becomes `2·PPG`), but it is deliberately **not** in the draft-season critical path — unit-scale drift is the identified risk and it needs side-by-side evaluation, not a launch-week bet.

### Data tiers (per ranking set — determines which engine features light up)

| Tier | Upload contains | Engine behavior | Scoring sliders |
|---|---|---|---|
| **FULL_STATS** | stat-line projection columns | `pointsFor` → true config-driven VBD; sliders re-price the whole board live | active |
| **POINTS** | a season-points column | VBD on given points; baselines still roster-driven so format handling stays intact | locked, with notice ("points were priced under the source's scoring") |
| **RANK_ONLY** (v1 default) | ordinal ranks | `value = −sourceRank` — exact legacy engine behavior (also the golden-parity mode), with a banner: "upload projections or points to unlock scoring-driven VBD" | n/a (legacy mode) |
| **RANK_ONLY, curve-estimated** (post-launch) | ordinal ranks | rank → estimated stat line via shipped positional curves → `pointsFor` → VBD | active (they rescore the curve stat lines) |

**Positional curves (post-launch — decision 2026-08-13, see §14 #5):** `engine/data/curves-2026.json` stores, per position and positional finish, the 3-year weighted-mean historical **stat line** (not points) — smoothed over finish, tail-extended by decay — regenerated annually by `scripts/fit-curves.ts` from public season-total stat data (aggregate historical shapes we compute ourselves; consistent with the no-third-party-rankings rule). Storing stat lines means one artifact serves every scoring config, TE premium included; K/DEF curves are naturally flat so they sort late without special-casing. Deferred out of the draft-season critical path: rank-only uploads run in strict legacy mode for v1, which is zero-risk and zero extra work; the FULL_STATS preset is the VBD demo.

---

## 6. Rankings ingestion — CSV upload, column mapper, identity resolution, presets

### Parse (client-side, PapaParse 5.x)

- `header: false` — mapping is by **column index**, because FantasyPros projection exports repeat headers (`YDS`/`TDS` appear in passing, rushing, and receiving groups) and `header: true` silently clobbers them. Duplicate-header groups are inferred positionally (classic FP order `[ATT, CMP, YDS, TDS, INTS | ATT, YDS, TDS | REC, YDS, TDS | FL, FPTS]`); ambiguity leaves columns unmapped for the user — never guess silently.
- Encoding pipeline before parsing: BOM sniff (UTF-8 / UTF-16LE / UTF-16BE), `TextDecoder('utf-8', {fatal:true})` with windows-1252 fallback (Excel legacy smart quotes — `Ja'Marr` arrives curly), residual-BOM strip from the first header cell.
- Preamble rows dropped (header = first row where ≥2 cells match known header regexes); no qualifying row → fully manual mapping with Column A/B/C labels.
- Limits: 5 MB, 5,000 rows, 60 columns; `.csv/.tsv/.txt`.

### Column mapper

Auto-detect via header regex + value sniffing on the first 20 data rows (name, team, pos — including FantasyPros' combined `WR1`-style pos+posRank column, split on ingest — rank/ECR, ADP, projected points, and stat columns passYds/passTD/int/rushYds/rushTD/rec/recYds/recTD/fumbles…). Five-row preview, per-column dropdown override, confidence indicators, validation (name required; at least one of rank / points / ≥3 stat columns). A live data-tier badge shows what the file will unlock. **Mapping memory:** `sha256(normalized header signature)` per user → re-uploads of the same source skip the mapper.

### Player identity resolution

Canonical `Player` table is seeded from the Sleeper dump (§8). One shared normalizer runs identically client-side (preview match rates) and server-side (authoritative): NFKD → strip diacritics → lowercase → straighten apostrophes → collapse whitespace (the legacy data itself contains `"Keenan  Allen"`) → strip suffix token (jr/sr/ii/iii/iv/v — **preserved in a side channel** for Pittman-Jr-style collision breaks) → delete non-alphanumerics. This deliberately matches Sleeper's `search_full_name` convention so seed keys align for free.

**Match pipeline** — staged, deterministic, auditable; a stage wins only with **exactly one** candidate (≥2 falls through, never guesses); every entry records `matchMethod` + confidence:

1. `PlayerAlias` hit (user scope, then GLOBAL — resolution memory so a file never asks twice)
2. `nameKey + pos + team` → 3. `nameKey + pos` (team mismatches are common: offseason moves, stale files) → 4. `nameKey + team` → 5. unique `nameKey` among active players
6. Fuzzy: Jaro–Winkler ≥ 0.92 within position, accepted only if unique above threshold **and** best − runner-up ≥ 0.03, candidates evaluated in sorted order (deterministic)
7. Unmatched queue → manual resolution UI (top-5 fuzzy candidates one-click + search + "exclude" / "keep as unlinked")

**D/ST branch** runs first: enumerable alias set per team (`Broncos` / `Denver D/ST` / `DEN DST` / …) through the same normalizer; no fuzzy for DSTs. Team codes normalize through the single alias map before matching. **Unlinked entries** remain first-class: they appear on the board and can be drafted manually, but are flagged and excluded from Sleeper live-pick auto-matching (stated in the UI).

### Storage & versioning

`RankingSet` (relational `RankingEntry` rows for per-row match audit and the resolution workflow) with `groupId` + `version`: sets are **immutable once READY**; re-upload creates version+1 in the same group. A league points at a specific version (with an "v3 available — update?" nudge); a draft session snapshots resolved players at creation and never changes mid-draft. Raw CSV text stored for audit/re-map (**latest version per group only** — older versions drop the raw text to bound Postgres bloat). Upload flow: `DRAFT → (resolutions) → READY`; only READY sets are draftable.

### Free presets (owner-generated — compliance note)

The legacy file's rankings are credited to named FTN analysts with FTN ADP. **That data cannot ship in a commercial product.** It becomes private test fixtures only. Shipped presets are three owner-authored CSVs living in `presets/`, ingested through the exact same pipeline via `prisma db seed` (presets eat our own dog food):

1. **House Board — 1QB** (RANK_ONLY)
2. **House Board — Superflex** (RANK_ONLY)
3. **House Projections 2026** (FULL_STATS, generated by `scripts/generate-projections.ts` from public/open historical data + an owner-editable overrides CSV) — this preset is the free demo of the full scoring-config-driven VBD engine.

Presets do **not** carry a hand-maintained ADP column — ADP comes from the live ADP service (§8a, decision 2026-08-13), which attaches current market ADP to *any* ranking set (presets and uploads alike) at draft-session snapshot time. A user-uploaded ADP column, when present, takes precedence. An admin-gated "publish as preset" upload path (allowlisted user IDs) allows mid-season preset refresh without a deploy.

---

## 7. Data model (unified Prisma schema)

Reconciled across subsystem designs; JSONB where data is read/written as a unit, relational where rows need constraints/audit.

```prisma
enum DraftMode   { MOCK MANUAL SLEEPER_SYNC }
enum DraftStatus { IN_PROGRESS COMPLETE ABANDONED }
enum PickSource  { USER AUTOPICK PROVIDER }
enum Pos         { QB RB WR TE K DEF }
enum SetKind     { PRESET UPLOAD }
enum SetStatus   { DRAFT READY ARCHIVED }
enum DataTier    { RANK_ONLY POINTS FULL_STATS }
enum AdpContext  { ONE_QB SUPERFLEX UNKNOWN }

model User {
  id        String   @id            // Clerk user ID as PK — no surrogate
  email     String?
  name      String?
  sleeperUserId String?             // linked once for "my seat" detection
  deletedAt DateTime?               // user.deleted webhook; GDPR path
  createdAt DateTime @default(now())
  entitlements Entitlement[]
  leagues      League[]
  rankingSets  RankingSet[]
  sessions     DraftSession[]
}

model Entitlement {
  id                      String    @id @default(cuid())
  userId                  String
  user                    User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  product                 String    // 'season-2026'
  stripeCheckoutSessionId String    @unique      // row-level idempotency
  stripePaymentIntentId   String?   @unique
  amountTotal             Int
  currency                String
  purchasedAt             DateTime
  expiresAt               DateTime
  revokedAt               DateTime?
  revokeReason            String?   // 'refund' | 'dispute' | 'admin'
  @@unique([userId, product])
}

model WebhookEvent {                 // event-level idempotency (Stripe evt_ / svix msg id)
  id         String   @id
  source     String                  // 'stripe' | 'clerk'
  type       String
  receivedAt DateTime @default(now())
}

model Player {
  id               String   @id @default(cuid())
  sleeperId        String?  @unique  // numeric string, or team code for D/ST
  fullName         String
  nameKey          String             // normalizer output (Sleeper search_full_name-compatible)
  suffix           String?            // 'jr','sr','iii' side channel
  pos              Pos
  nflTeam          String?            // canonical code; null = FA
  active           Boolean  @default(true)
  injuryStatus     String?
  isTeamDefense    Boolean  @default(false)
  espnId           String?  @unique   // crosswalks ship free in the Sleeper dump —
  yahooId          String?  @unique   // bootstraps ESPN/Yahoo providers later
  gsisId           String?
  sportradarId     String?
  updatedAt        DateTime @updatedAt
  @@index([nameKey, pos])
  @@index([pos, nflTeam])
}

model PlayerAlias {                  // resolution memory
  id        String @id @default(cuid())
  aliasKey  String
  playerId  String
  scope     String                   // 'GLOBAL' | userId
  createdBy String
  @@unique([aliasKey, scope])
}

model TeamBye {                      // byes are NOT in any Sleeper endpoint — first-party seasonal data
  seasonYear Int
  teamCode   String                  // canonical codes only
  week       Int
  @@id([seasonYear, teamCode])
}

model League {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id])
  name             String
  seasonYear       Int
  provider         String   @default("manual")   // 'manual' | 'sleeper'
  providerLeagueId String?
  numTeams         Int
  scoring          Json     // ScoringConfig (zod-validated at boundary); raw provider blob kept alongside for audit
  rosterSpec       Json     // {QB,RB,WR,TE,FLEX,DEF,K,BN, flexEligibleBySlot: Pos[][], ignoredSlots}
  rankingSetId     String?  // default set for new sessions
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  sessions         DraftSession[]
  @@index([userId])
}

model RankingSet {
  id                String    @id @default(cuid())
  groupId           String                       // stable across versions
  version           Int       @default(1)
  userId            String?                      // null ⇒ shipped preset
  user              User?     @relation(fields: [userId], references: [id])
  name              String
  seasonYear        Int
  kind              SetKind
  status            SetStatus @default(DRAFT)
  dataTier          DataTier
  formatTag         String                       // '1QB' | 'SF' — which market the ordering assumes
  adpContext        AdpContext @default(UNKNOWN)
  headerFingerprint String?
  columnMap         Json?                        // saved mapper config
  rawCsv            String?                      // audit/re-map; capped
  createdAt         DateTime  @default(now())
  entries           RankingEntry[]
  @@unique([groupId, version])
  @@index([userId, seasonYear])
}

model RankingEntry {
  id              String  @id @default(cuid())
  rankingSetId    String
  set             RankingSet @relation(fields: [rankingSetId], references: [id], onDelete: Cascade)
  playerId        String?                        // null = unlinked
  rawName         String
  team            String?
  pos             Pos?
  rank            Int?
  adp             Float?
  projPoints      Float?
  stats           Json?                          // StatLine
  matchMethod     String                         // ALIAS|EXACT_FULL|EXACT_POS|EXACT_TEAM|EXACT_NAME|FUZZY|MANUAL|UNLINKED
  matchConfidence Float?
  sourceRow       Int
  @@unique([rankingSetId, playerId])             // null-exempt per Postgres semantics
  @@index([rankingSetId])
}

model MappingProfile {
  id                String   @id @default(cuid())
  userId            String
  headerFingerprint String
  mapping           Json
  lastUsedAt        DateTime @updatedAt
  @@unique([userId, headerFingerprint])
}

model DraftSession {
  id               String      @id @default(cuid())
  userId           String
  user             User        @relation(fields: [userId], references: [id])
  leagueId         String
  league           League      @relation(fields: [leagueId], references: [id])
  mode             DraftMode
  status           DraftStatus @default(IN_PROGRESS)
  config           Json        // FROZEN snapshot: teams/order/mySlot/rosterSpec/scoring/byeMap
                               // + fully resolved ValuedPlayer[] (values, valueRanks, tiers, ADP)
                               // + rngSeed. Mid-draft league/ranking edits can never shift a live board.
  queuedPlayerIds  Json        @default("[]")
  recPositions     Json        @default("[\"QB\",\"RB\",\"WR\",\"TE\",\"DEF\",\"K\"]")
  providerDraftId  String?     @unique            // Sleeper draft_id
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt
  picks            Pick[]
  sync             DraftSync?
  @@index([userId, status])
}

model Pick {
  id        String       @id @default(cuid())
  sessionId String
  session   DraftSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  overall   Int
  teamSlot  Int          // 1..numTeams seat; round/pickInRound derived from overall + config (no drift)
  playerId  String       // ValuedPlayer id — usually Player.id; session-local 'custom:<hash>' for unlinked
                         // CSV players. Deliberately NO FK: a live pick must never fail referential integrity.
  source    PickSource
  createdAt DateTime     @default(now())
  @@unique([sessionId, overall])                  // the idempotency key for batched sync + provider re-polls
  @@index([sessionId])
}

model DraftSync {                    // per live draft: pull-through cache state (§8)
  sessionId      String   @id
  session        DraftSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  providerStatus String
  syncedAt       DateTime
  ttlSec         Int
  etagPicks      String?
  etagDraft      String?
  claimedUntil   DateTime?           // single-flight lease (pooler-safe; see §8)
  nextAllowedAt  DateTime?           // 429/5xx backoff
}

model AdpSnapshot {                  // live ADP service (§8a); latest per source+format+teams
  id           String   @id @default(cuid())
  source       String                 // 'ffc'
  format       String                 // 'STANDARD' | 'HALF_PPR' | 'PPR' | 'SF'
  teams        Int
  fetchedAt    DateTime
  totalDrafts  Int
  entries      Json                   // [{playerId (canonical, matched), rawName, adp, stdev, high, low, bye}]
  @@unique([source, format, teams])
}

model PlayerSyncRun {                 // cron observability (players + ADP runs)
  id      String   @id @default(cuid())
  kind    String   @default("players") // 'players' | 'adp'
  ranAt   DateTime @default(now())
  etag    String?
  changed Int
  total   Int
  ok      Boolean
}
```

**Key rationale (condensed):**
- **Picks relational** — append-heavy bursts become idempotent `createMany(skipDuplicates)` against `(sessionId, overall)`; undo is a tail `deleteMany`; Sleeper re-polls dedupe naturally. A JSONB array would need read-modify-write (lost-update hazard with two tabs) and has no idempotency key.
- **`DraftSession.config` frozen snapshot including resolved `ValuedPlayer[]`** (~55 KB) — resume is one row + picks; a mid-draft edit or deletion of the league/ranking set can never shift an in-progress board.
- **`Pick.playerId` has no FK** — unmatched CSV players get stable session-local ids inside the snapshot; a draft must never be blocked mid-pick by referential integrity. Validated at the app layer against the snapshot.
- **Ranking entries relational** (vs JSONB) — per-row `matchMethod` audit, the unmatched-resolution workflow updates individual rows, and the null-exempt unique constraint prevents duplicate player rows per set.

---

## 8. Sleeper provider layer + live draft sync

### Verified API surface (docs.sleeper.com + live calls, 2026-08-12)

Base `https://api.sleeper.app/v1`, read-only, **no auth**, CORS-open, ETags honored (`If-None-Match` → 304 confirmed). Documented limit: stay under 1,000 calls/min/IP. Endpoints: user by username, user's leagues (`/user/{id}/leagues/nfl/{season}`), league (`/league/{id}` → `scoring_settings`, `roster_positions`, `status`, `draft_id`), league users/rosters, drafts (`/league/{id}/drafts`, `/draft/{id}`, `/draft/{id}/picks`, `/draft/{id}/traded_picks`), players dump (`/players/nfl` — **14 MB, 12,218 entries, ≤1 call/day per docs**), NFL state (`/state/nfl` — confirmed `season: "2026"`). **Neither ADP nor bye weeks is exposed anywhere** → byes stay a first-party seasonal table; ADP comes from uploads/presets. `roster_positions` slot vocabulary: `QB RB WR TE K DEF BN FLEX SUPER_FLEX WRRB_FLEX REC_FLEX` + IDP slots (ignored with a visible banner). Draft object carries `type` (snake/linear/auction), `status`, `settings` (incl. `reversal_round`, `pick_timer`), `draft_order` (user→slot), `slot_to_roster_id`. Picks carry `pick_no`, `round`, `draft_slot`, `player_id`, `picked_by` (`""` = autopick), `metadata` (name/pos/team — the render fallback for unresolved players).

### Provider abstraction (`src/server/providers/`)

Every method takes a `ProviderContext` with **optional encrypted credentials** and each provider declares an auth spec (`'none' | 'cookie' | 'oauth2'`) — Sleeper is `none`; ESPN needs `espn_s2`/`SWID` cookies and Yahoo needs OAuth2, so the interface never bakes in "no auth", and credentials never reach the browser. Core methods: `parseLeagueRef`, `listLeaguesForUser`, `getLeague` + **pure** `normalizeLeagueConfig` (fixture-tested), `listDrafts`, `getDraft → ProviderDraftState`, `getPicks → NormalizedPick[]` (ETag-aware), `resolvePlayers` (batch lookup on `Player.sleeperId`).

**The key convergence point:** the provider emits a precomputed **`pickOwnerByOverall: number[]`** (overall → seat), honoring snake/linear, `reversal_round` (3rd-round reversal — the legacy engine is pure-snake; this is where 3RR support lives), and traded picks. Manual/mock mode builds the same array from plain snake math. `myNextPickOverall`, `picksBeforeMyNextTurn`, the survival horizon, and the board all consume this one representation, so the engine is source-agnostic. Auction drafts are capability-gated out with a clear message at import.

Scoring/roster normalization: `scoring_settings` → `ScoringConfig` (pass-through + `bonus_rec_te` → `posWeights.TE.rec`, 4-dp rounding, zod `.passthrough()` with unknown-key logging); `roster_positions` → ordered `SlotDef[]` feeding the existing per-slot flex machinery unchanged; IDP slots → `ignoredSlots` with a UI disclosure. Import flow: paste league URL/ID/username → confirmation screen (mapped scoring, roster, superflex flag, ignored slots, auto-detected seat via the user's linked Sleeper username) → user can override → saved as `League` + `DraftSession(mode: SLEEPER_SYNC)`.

### Live sync: server pull-through cache

Clients poll **our** `GET /api/drafts/{id}/live?sinceOverall=N` every 5s (±1s jitter, visible tab only). The server is the only thing that talks to Sleeper:

1. Read `DraftSync`; if fresh (`now − syncedAt < ttlSec`), serve from DB.
2. Stale → claim a short single-flight lease with one atomic statement: `UPDATE "DraftSync" SET "claimedUntil" = now() + interval '10 seconds' WHERE "sessionId" = $1 AND ("claimedUntil" IS NULL OR "claimedUntil" < now()) RETURNING 1`. Losers (no row returned) serve the DB copy immediately; the winner fetches picks with `If-None-Match` (304 = cheap no-op) and the draft object every ≥30s or on pick changes. (Deliberately **not** session-level `pg_try_advisory_lock`: through Neon's PgBouncer transaction pooling, session-scoped locks can bind to a different pooled backend than the unlock — the lease row is pooler-safe.)
3. Winner ingests in one transaction: upsert on `(sessionId, overall)`; **reconcile commissioner undos** by truncate-and-reinsert from the first divergent overall (with an explicit "picks were corrected" UI state); update `DraftSync`.
4. Response is delta-shaped (`picks where overall > sinceOverall`, status, on-clock seat) with our own ETag.

**Why server-side rather than the CORS-open client-direct alternative:** entitlement enforcement on the hot path (a revoked user's open tab stops syncing), one normalization pipeline shared with future authenticated providers (ESPN/Yahoo credentials can never ship to a browser), server persistence so resume never replays provider history, immunity to Sleeper CORS-posture changes, and N viewers of one draft cost one upstream call per interval. Cost: ~12 function invocations/min per active viewer — trivial. No background poller exists; polling is viewer-driven, which is exactly right on serverless (no viewers → no upstream traffic).

**Adaptive cadence** (stored in `DraftSync.ttlSec`): pre-draft 60s → 10s inside 5 min of start; in-progress 4s; stalled >3×pick_timer → 15s → 60s (snaps back on any pick); paused 45s; complete → final reconciliation, stop. 429/5xx → exponential backoff in `nextAllowedAt` (8s→…→120s), serve stale, "live sync degraded" indicator past 60s staleness. Worst case ≈17 upstream calls/min per watched draft → ~55 concurrent drafts inside the IP cap before a global TTL stretch kicks in (guard rail: count active `DraftSync` rows).

A "mark pick manually" escape hatch exists for feed lag; such picks are flagged provisional and overwritten by provider truth on the next sync.

### §8a — ADP service (live ADP from online sources; decision 2026-08-13)

Sleeper's API exposes no ADP, so ADP is pulled from **Fantasy Football Calculator's free public ADP API** — verified live 2026-08-13: `GET https://fantasyfootballcalculator.com/api/v1/adp/{format}?teams={n}&year=2026` for formats `standard | half-ppr | ppr | 2qb`, returning `{status, meta: {type, teams, rounds, total_drafts, start_date, end_date}, players: [{player_id, name, position, team, adp, adp_formatted, times_drafted, high, low, stdev, bye}]}`. Confirmed: PPR 12-team returned 280 players from 6,160 real drafts in the trailing week; the `2qb` format returned a properly QB-inflated board (Josh Allen ADP 1.01) — its snapshots are tagged `adpContext: SF`, all others `1QB`, so the generalized `effectiveAdp` rule (§5) works with zero additional configuration.

- **`AdpProvider` abstraction** mirroring the draft-provider pattern (`src/server/adp/`): FFC is the first implementation; more sources can be added and blended later. Responses are zod-validated with `.passthrough()`.
- **Refresh:** the same daily cron run as the players sync (4 formats × 1 call — negligible), upserting one `AdpSnapshot` row per `(source, format, teams)`. ADP shifts daily in August; daily is sufficient, and a manual admin re-trigger exists for draft-day.
- **Identity:** FFC names resolve through the same canonical matcher (normalizer + staged pipeline); unmatched entries land in the admin resolution queue with `PlayerAlias` memory. FFC's ~280–300 players per format are the most-drafted pool — exactly the ADP that matters.
- **Attachment precedence at draft-session snapshot time:** ranking set's own uploaded ADP column → live `AdpSnapshot` matching the league's format (superflex league → `2qb` snapshot; else nearest PPR variant). The chosen source is recorded in the frozen session config; the UI shows "ADP: FFC PPR, updated {date}" and lets the user switch or disable.
- **Bonus — bye weeks:** FFC entries include `bye`, giving a second automated source alongside the first-party `TeamBye` table; the cron cross-checks and flags disagreements for review rather than silently overwriting.
- **Caveat:** FFC's API has been free and openly documented for years, but confirm current terms/attribution requirements at implementation and show a "ADP data: FantasyFootballCalculator.com" credit line in the UI.

### Player table seeding/refresh

Daily Vercel Cron (06:00 ET, `CRON_SECRET`-gated) fetches the dump with stored ETag (304 → exit early), filters to fantasy-relevant positions (~4,300 of 12,218; keep anything referenced by picks/rankings — deactivate, never delete), ingests the 32 D/ST pseudo-players (`player_id` = team code, `isTeamDefense`), diffs by content hash, bulk-upserts in batches. Node function `maxDuration: 300` (**requires Vercel Pro — verify plan tier early**). `PlayerSyncRun` rows + alert if no success in 48h; manual admin re-trigger for draft-day emergencies. First deploy seeds via the same job.

---

## 9. Auth (Clerk) + payments (Stripe one-time seasonal unlock)

### Clerk (verified against current docs)

`@clerk/nextjs` v6+: async `auth()`/`auth.protect()` everywhere; `clerkMiddleware` lives in `proxy.ts` on Next 16 (renamed from `middleware.ts` — scaffolding templates that still write `middleware.ts` silently don't run; verify at scaffold time). Public routes: `/`, `/pricing`, sign-in/up, `/api/webhooks/*` (webhooks **must** stay in the public matcher — a middleware change that protects them silently drops entitlements). Every mutating server action re-checks `auth()` — middleware alone is insufficient for actions.

**Users mirror into Postgres** (minimal row: id = Clerk ID, email, name) via the Clerk webhook (`verifyWebhook` from `@clerk/nextjs/webhooks`) **plus lazy upsert on first authenticated write** — the webhook is an optimization, never a dependency (local dev needs no tunnel; a missed webhook can't 500 a brand-new user on draft night). Rationale for mirroring at all: FK integrity for Entitlement/League/RankingSet, one-query joins, one GDPR deletion path via `user.deleted`.

### Stripe

- Hosted Checkout, `mode: 'payment'`. `client_reference_id` + metadata carry the Clerk user ID. No idempotency key on session creation (abandon-and-retry should mint a fresh session); idempotency lives in fulfillment.
- **Entitlement granted only by the `checkout.session.completed` webhook** (`payment_status === 'paid'`), never the success page; the success page polls entitlement state (webhook races the redirect by seconds).
- Do **not** pass `apiVersion` to stripe-node — the SDK pins its tested version (current major: `2026-07-29.dahlia`); pin the webhook endpoint's version at creation; treat SDK major bumps as reviewed changes with a `stripe trigger` re-test.
- Webhook route: Node runtime, raw body via `req.text()`, signature verification, then **two idempotency layers**: `WebhookEvent` insert-unique on event id + unique `Entitlement.stripeCheckoutSessionId`. Return 2xx fast. Fulfillment is an **upsert keyed on `[userId, product]`** (updating the Stripe ids and clearing `revokedAt`) — so a user who was refunded and later re-buys doesn't hit the unique constraint.
- Refunds: full `charge.refunded` → revoke; partial → log for manual review; `charge.dispute.created` → revoke immediately.
- Vercel note: point webhooks only at production (Deployment Protection 401s previews); local dev via `stripe listen` (different signing secret).
- Boot-time env validation (zod `lib/env.ts`) so a missing webhook secret fails the deploy, not the first draft-night event. A `livemode`-mismatch guard logs and skips events whose mode disagrees with the key in use.

**Season definition (proposal — owner decision):** purchases Mar 1 2026 – Feb 28 2027 → `product: 'season-2026'`, expiring Mar 1 2027, encoded as a pure tested `currentSeason(now)` function. Alternative: flat 365 days. Late-Feb buyers rolling into the next season's product is worth considering.

### Free vs paid (proposal — owner decision)

| Capability | Free | Paid (season unlock) |
|---|---|---|
| Mock draft room (full engine, autopick, undo) | ✅ | ✅ |
| Shipped presets (incl. the FULL_STATS projections demo) | ✅ | ✅ |
| Leagues configured | 1 | Unlimited |
| Custom CSV rankings upload + mapper | — | ✅ |
| Sleeper import (settings auto-config) | ✅ (into the free league) | ✅ |
| Sleeper **live draft sync** | — | ✅ |
| Full custom scoring / VBD knobs | Presets only | ✅ |

Rationale: free users must *feel* the recommendation engine (mocks convert); the three differentiating draft-night features carry the purchase. Enforcement is server-side only (`requireEntitlement()` throwing `PaywallError` → 402) at: create-league (count check), CSV upload, live-sync start, **and the `/live` poll route itself**, custom-scoring save. UI gating is cosmetic.

---

## 10. Draft room UI port (mobile parity)

Component map mirrors the original's regions, all inside the one client subtree, reading store selectors:

- **Topbar** — overall/round/pick, on-clock (highlight when me), "your next pick: #N (M away) / NOW", Undo / Export CSV / Reset (modal).
- **RecPanel** — up to 5 chips (pos badge, name, #valueRank, bye tag with clash highlight, reason tooltip + inline why), click-to-draft on my clock only.
- **ScarcityBar** — picks-until-turn, tier-left per needed position (warn ≤4 / crit ≤2), "Suggest" position toggle chips (persisted).
- **PlayerList** — search, Available/Drafted tabs, position tabs (FLEX = eligibility union), sortable columns (rank/name/team/pos/bye/ADP; nulls last), star-to-queue, recommended-row highlight, drafted status (`Rd R.PP — Team`), ADP cell coloring incl. the `{adp}*` superflex-QB grey.
- **RightPanel tabs** — Board (round × seat grid, sticky headers/first column, on-clock cell, my-column tint), Rosters (per-team slots, EXTRA overflow rows, bye-summary with ≥3 stacked-bye flags), Queue (rank-sorted, drafted entries struck, click-to-draft).
- New for live mode: sync status ("last synced Xs ago", degraded banner, "picks were corrected" toast) and disabled manual controls.

**Mobile parity contract** (from source CSS ~151–192, rebuilt with container queries at the same effective breakpoints): <900px stacks the right panel **below** the player list, page scrolls normally (no inner-viewport trap), player list capped ~55vh, sticky topbar, full-width action buttons, ADP column and footer note hidden, rec-chip "why" hidden; <560px also hides the team column and caps the list at 48vh. Tap targets ≥44px on rows/chips/stars. The 5s poll pauses on hidden tabs (with an on-screen staleness indicator, since mobile Safari throttles timers).

---

## 11. Testing (Vitest)

Tooling verified current: **Vitest 4.1.x** + `@vitest/coverage-v8`, **`@fast-check/vitest`** for properties, Node **24 pinned** in CI and `engines` (float reproducibility for goldens). Projects: `unit` (fast, every push) and `golden`. Coverage gate: `src/engine/**` ≥ 95% lines/branches.

**Table-driven suites** (the user-required five in bold):

- **`snake.test.ts`** — grid over n ∈ {4,8,10,12,14,20} with shuffled orders: overalls 1, n, n+1 (snake reflection: same team), 2n, 2n+1, mid-round, final pick; `myNextPickOverall`/`picksBeforeMyNextTurn` on-clock vs not, last-pick → null. Plus `pickOwnerByOverall` parity between snake math and the provider path, incl. `reversal_round` cases.
- **`tiers.test.ts`** — exact tier arrays: gap-1 run of 9 (cap split 8+1 RB / 6+3 QB), uniform gap-2 run (no break), gap-2 inside gap-1 (break), `g >= thr` inclusive boundary, window truncation at head/tail, singleton/two-player positions, non-contiguous ranks (real positional-list shape).
- **`vbd.test.ts`** — hand-computed baselines: 12-team 1QB (the §5 worked example as a pinned snapshot), 10-team superflex (QB baseline ≈ QB20, not QB10), 2QB league, `REC_FLEX`+`WRRB_FLEX` combos, restrictive-first ordering, exhausted-pool clamping; TE premium lifts TE values; PPR vs half-PPR reorders a known WR/RB pair; `pointsFor` vectors incl. Sleeper import round-trip (float rounding, `bonus_rec_te` relocation); greedy flex sim fuzz-checked against a brute-force matcher on small pools.
- **`roster.test.ts`** — slot label spellings (`FLEX`, `FLEX2`, `DEF`, `BN1`), template order, greedy tables (dedicated-first, flex spill, QB into QB-eligible flex, DEF never flexed, overflow EXTRA), the pinned order-dependence fixture, needs expansion / bench-only → empty set, bye counts (starters only; ≥2 clash vs ≥3 flag asymmetry).
- **`recommend.test.ts`** — three ~20-player hand-computable fixture leagues (1QB tier-cliff, superflex ADP-nulled, bye-clash) asserting exact shortlist ids, per-term `scoreBreakdown`, and verbatim reason strings; the 45-cap; max-2-per-pos/top-5 walk; need-fallback chain; all-positions-off → `[]`; unreachable "Best available overall" when #1's position is toggled off; stable-sort ties; every reason boundary (drop 12/25, tier 2/4, surv 0.25/0.75, adp−rank 25) and the first-2-reasons truncation.
- `adp.test.ts` — golden survival numbers at 1e-6 (σ floor boundary at ADP 33/34; 0.5 at pick==ADP), null contract, `adpSignal` at d = ±20, the generalized adpContext rule truth table.
- `outlook.test.ts` — ≥0.5 threshold inclusive; null-survival exclusion (K/DEF, superflex QBs) → rank-order fallback; `slice(gone)` arithmetic; drop 80 default; final-pick edge (drop 0, surv null).
- `autopick.test.ts` — stubbed-RNG branch boundaries (len 9 → always idx 8; band 8–28; `r <= acc` inclusive; pool-of-2 renormalization; empty → null) **and** a 200k-draw seeded distribution test (±1% absolute on {0.506, 0.2208, 0.1196, 0.0736}; sleeper band 0.08 ± 0.5%).
- `draft.test.ts` — applyPick fields/completion no-op/duplicate rejection; undo manual + mock pop-through + the zero-user-picks edge (legacy stall pinned, v2 fix asserted); reset preserves queue/recPos; queue drafted-retention; resume defaulting.
- `export.test.ts`, `scoring/normalize/matcher` suites — CSV export goldens; normalizer fixtures (suffixes, apostrophes, `Keenan  Allen`, DST aliases); header-heuristic fixtures (FantasyPros ECR combined POS, FP duplicate-header projections, FTN-style codes, BOM/UTF-16/1252 files); match-pipeline determinism + fuzzy-gate cases; data-tier feature-activation matrix (POINTS invariant under scoring changes, FULL_STATS moves).

**Property-based:** every overall maps to exactly one team and each team gets exactly `rounds` picks; roster assignment never drops a player (slots + overflow ≡ picks); tier numbers start at 1, increment by 1, respect caps; `survivalProb` ∈ (0,1), strictly decreasing in pick; shortlists ≤5/≤2-per-pos/from-the-pool with non-increasing scores; seeded full mock drafts always terminate with exactly `totalPicks` unique picks (pool-exhaustion halt pinned separately).

**Golden masters** as per §4 — the parity harness for the port, retained afterward as rank-mode regression tests.

**CI:** GitHub Actions, single <3-min job (typecheck, lint, `vitest run --coverage`), required check alongside Vercel's build/preview check. Tests do not run inside the Vercel build. Prisma-dependent integration tests come later as a second job with a Postgres service container.

---

## 12. Deployment & ops

- **Vercel:** Node runtime everywhere; Fluid Compute default; cron for the players sync; `maxDuration: 300` on the cron route (Pro plan — confirm early). Preview deployments get Neon branch databases via the marketplace integration.
- **Env inventory** (all zod-validated at boot): Clerk pk/sk + webhook secret, Stripe sk + webhook secret + `STRIPE_PRICE_SEASON`, `DATABASE_URL`/`DIRECT_DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`, `ADMIN_USER_IDS`.
- **Local dev:** Clerk dev instance (no tunnel needed thanks to lazy upsert); `stripe listen --forward-to localhost:3000/api/webhooks/stripe`; `pnpm dev:stripe` script; seeded Neon branch or local Postgres.
- **Observability:** `PlayerSyncRun` + 48h alert; raw Sleeper payloads recorded for the first live drafts; log-based alert on webhook signature failures; "live sync degraded" surfaced to users past 60s staleness.
- **Pre-launch checklist:** live-mode $1 test purchase through real Checkout; a real Sleeper mock-draft sync run (measures the CDN-staleness risk on in-progress picks); Lighthouse pass on the mobile draft room.

---

## 13. Phased delivery (draft season: ~3 weeks out)

**Phase 0 — Scaffold (days 1–2).** Repo, Next 16 + TS strict, Clerk (proxy.ts), Neon + Prisma 7 baseline migration, CI skeleton, env validation, deploy pipeline green.

**Phase 1 — Engine port + golden masters (week 1).** Fixture extraction, legacy reference module, Playwright transcription audit, golden generation, module-by-module port with goldens green, VBD modules (scoring/baseline/value) added with rank-mode parity intact, full unit + property suites. **Exit gate: golden suite green in CI.** Everything downstream depends on `engine/types.ts`, so UI and provider work can begin in parallel once contracts freeze (~day 3).

**Phase 2 — Draft room + rankings (week 2).** **Prerequisite: Player table seeded** — run the players-dump sync job manually at the start of this phase (the cron *automation* stays in Phase 3, but CSV identity resolution and preset seeding both need the canonical table now). Draft-room UI to mobile parity (mock + manual modes, resume, sync route), league setup/editor (roster shape, per-slot flex, scoring controls), CSV pipeline end-to-end (mapper → resolution → READY), presets seeded, dashboard. **Exit gate: a stranger can run a full mock draft on a phone against a preset, close the tab, and resume.**

> **Owner task, not dev task:** authoring the two preset boards (1QB + Superflex) and reviewing the script-generated projections preset is your labor. It must happen during weeks 1–2 so Phase 2's exit gate isn't blocked on content.

**Phase 3 — Sleeper + Stripe + ADP (week 3).** Players-dump cron automation, **ADP service** (§8a — small: one provider + cron formats + snapshot attach), Sleeper import + confirmation screen, live sync (pull-through cache, adaptive TTL, undo reconciliation), billing (Checkout, webhook, entitlement gating wired to the §9 matrix), pre-launch checklist. **Exit gate: a real Sleeper mock draft syncs live on production; a live-mode test purchase unlocks; a preset draft shows live FFC ADP with working survival features.**

**Phase 4 — Post-launch.** Positional value curves for rank-only uploads (§5), SSE upgrade if 5s polling chafes, PPG-scaled scoring experiment (engineMode flag), admin preset refresh UI, alias-promotion screen, ESPN/Yahoo groundwork (crosswalk IDs are already in place).

**If the timeline compresses (priority order, decided 2026-08-13):** billing does **not** slip — the purchase peak is draft week, and the seasonal unlock is the point of the launch. The cut line is Sleeper **live sync** (manual-tracking mode already covers draft night — the user types picks as they happen; import/auto-config can still ship). The engine port and the mobile draft room cannot slip. ADP service is small enough that it should survive any squeeze; if forced, survival features degrade gracefully (the tool works without ADP exactly as it does for K/DEF today).

---

## 14. Decision log (resolved with owner, 2026-08-13)

1. **ADP:** owner does *not* hand-maintain ADP. The tool pulls live market ADP automatically — see §8a (FFC public ADP API, verified live; per-format snapshots incl. superflex; daily cron; upload-column precedence; UI attribution). Preset boards themselves are still owner-authored (FTN-credited legacy data remains test-fixtures-only).
2. **Price: $8.99** one-time seasonal unlock — agreed; it's an impulse-buy price that suits a no-brand launch, with room to raise next season once there's social proof. Free/paid split stands as the §9 table. **Billing does not slip** — if week 3 compresses, Sleeper live sync is the cut, not Stripe (§13).
3. **Season window:** league year (purchases Mar 1 → end Feb map to that NFL season's product, expiring Mar 1). ✅
4. **Mock-undo stall fix:** approved — undo before the user's first pick re-runs autopicks. ✅
5. **Rank-only uploads (recommendation, adopted):** v1 default is **strict legacy mode** (`value = −sourceRank`) — zero behavioral risk, zero extra work, identical to the current tool; the FULL_STATS preset demos real VBD. Curve-estimated points ship post-launch (Phase 4) and only become the default after side-by-side validation.
6. **3rd-round reversal:** provider-path only (manual/mock stays pure snake). ✅
7. **Sleeper seat detection:** link Sleeper username once + manual seat-picker fallback. ✅
8. **Old localStorage drafts:** the old single-file tool saves in-progress drafts inside the browser (localStorage). The new app will not import those — a draft started in the old tool can't be resumed in the new one. Since drafts last an evening, this costs nothing in practice; the old HTML file keeps working as-is for anything mid-flight. Accepted (no migration).
9. **Recommendation constants (recommendation, adopted): keep them fixed.** They're tuned, they're what "the logic is sound" means, exposing them breaks the golden-test determinism story and invites support burden. Revisit as advanced settings only if users ask post-season.

---

## 15. Top risks

| Risk | Mitigation |
|---|---|
| **Behavior drift in the port** — constants were tuned in rank units; any deviation silently changes recommendations | Golden masters land *before* refactoring; valueRank keeps all math ordinal; rank mode stays green permanently |
| **CSV player matching** (rookies missing from the dump, name variants, DST naming) is the top product risk | Staged deterministic matcher, never-guess uniqueness gates, resolution UI with alias memory, unlinked entries first-class |
| **Sleeper API is undocumented-contract** — shapes can shift mid-season; CDN staleness on in-progress picks unmeasured; per-IP rate limits vs Vercel's shared egress IPs untested | zod `.passthrough()` + unknown-key logs, pick-metadata render fallback, ETag+backoff+serve-stale path exercised in a real August mock draft before launch |
| **Timeline** — 3 weeks to draft season | Phasing front-loads engine + room; billing does not slip (decided); Sleeper live sync is the cut line, with manual-tracking as the fallback |
| **FFC ADP dependency** — free public API with no SLA; shapes or terms could change | Provider abstraction isolates it; zod `.passthrough()`; survival features degrade gracefully to the no-ADP behavior; verify terms + attribution at implementation |
| **Stripe webhook misconfiguration** = silent revenue failure | Boot-time env validation, webhooks pinned in the public matcher with a comment, live $1 test purchase pre-launch |
| **Unit-scale drift if/when scaled-value scoring ships** | Deferred behind engineMode flag with side-by-side comparison; not a launch bet |
| **Prisma 7 / Neon / Next 16 / Clerk v6 are all recent** | Pin minors, no preview features, verify `proxy.ts` middleware rename and Vercel Pro `maxDuration` at scaffold time |
