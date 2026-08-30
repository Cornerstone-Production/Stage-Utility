# Live Scores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow chosen teams' live scores from ESPN's public API and surface them in four places — a capsule in the operator context bar that expands into an Apple-Live-Activities-style panel, a custom layout object, and a Home card.

**Architecture:** One polling integration (`StatusIntegration`, the REAPER shape) fetches each followed league's scoreboard, folds it with a pure `parseScoreboard`, and detects scoring with a pure `diffScores` keyed on `${eventId}:${teamId}`. It broadcasts on `scores:status` only when something changed. The renderer shares one presentation core — team colour + ink, the per-sport centre, the score strip — across all four surfaces, so a capsule and a wall widget are different sizes of the same thing, never two implementations.

**Tech Stack:** TypeScript, React, node:test, existing `StatusIntegration` / `DataStore` / SSE plumbing. **No new npm dependencies.**

**Visual reference:** <https://claude.ai/code/artifact/bbb96b3f-8fa4-4ff6-a3d8-e95837ede38f> — the interactive mockup this plan implements. Every animation timing, gradient stop and layout number below is taken from it. Read it before Task 5.

**Research:** `docs/superpowers/research/2026-08-29-espn-scores.md` — every endpoint, field name and response size was fetched live on 2026-08-29. Its "Unverified" section is binding: do not design around a field it says it could not observe.

**Branch:** `feat/scores`, off `beta`.

---

## What the mockup settled, and why it is not the research doc's design

The research doc (§3.5) identified the toast as the single biggest UI risk: `ToastEntry.message` is a `string` across 142 call sites, so a rich score card is not expressible, and widening it is a wide, awkward change.

**The toast is gone from this design.** Henry's call: *"I would want this to be included as a context bar object that we built earlier that is at the top of every page."* The score lives in the context bar as a capsule, and the Live Activity grows out of that capsule. That removes the toast problem entirely — `renderer/components/ui/toast.tsx` is **not touched by this plan** — and it removes the redundancy Henry flagged (*"I wouldn't want getting a toast and the live activity object too on the same view/page etc."*), because there is now one score surface per operator page, not two.

It also removes the dependency on `renderer/main/expand-overlay.tsx`, which research §4.2 correctly flagged as unmerged (still true: it is on `feat/multiview`, PR #346, open). The Live Activity expands in place under the bar. It is not a FLIP to full screen, so it needs nothing from that branch.

**The context bar is operator-only.** `renderer/app/context-bar.tsx` has exactly one call site, `renderer/app/shell.tsx:98`. Wall displays render `KioskTopBar` from `renderer/main/stage-view.tsx`, a different component with fixed props. Henry: *"wall displays not designated as a console have a default, non configurable context bar so should be no changes needed."* Correct. **No task in this plan modifies `KioskTopBar`.** Wall displays get scores only if the operator places the layout object on them.

---

## Global Constraints

- **No emojis anywhere** — UI, code, comments, commit messages, PR body. No Claude attribution footer.
- **Public repo.** No church name, no real service-type ids, no LAN addresses, no credentials, no customer ids in code, tests, fixtures or docs. ESPN fixtures are public data and are fine.
- **No new npm dependencies.** The gradients, masks, springs and the search popover are all hand-written with what is already here.
- **Every new `catch` rethrows or returns the failure to its caller.** A `catch` that only logs is forbidden. A poll failure reaches the operator through `this.report("error", …)` and through `ScoresStatusDTO.error`.
- **Every persisted store declares its classification** in its constructor. `scores-favourites.json` is `"config"` — the operator chose those teams — and must be added to `EXPECTED_CONFIG` in `main/services/config-snapshot.test.ts` **in the same commit**.
- **Time goes through `main/services/app-timezone.ts`**, never the host clock. Game start times, the daily schedule refresh, "is it today" — all of it.
- **Numeric fields in settings use the themed `NumberInput`**, never a raw `<input type="number">`.
- **Zero purple. Dark surfaces are strictly R=G=B.** A team colour may fill its own side of a card; it may never tint a neutral dark surface, and no `saturate()` over dark.
- **`prefers-reduced-motion` is checked in JS, explicitly**, wherever a transform is driven from JS. The global CSS override at `renderer/styles.css:367` cannot reach a JS-set inline `transform`. The idiom is `window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false`.
- **Broadcast on change only.** A 25-second poll must not be a 25-second SSE frame. Use `emitIfChanged`. Do **not** override it to tick a game clock — let the client count down locally.
- **Gate on `inDemand`, not `hasSubscribers`.** `integration-base.ts` records a real bug where gating on browser subscribers alone silently disabled every automation rule reading the channel.
- **Every guard ships with proof.** Delete the guard or reintroduce the bug, watch it go red in-session, and say so in the commit.
- **Exact counts, not floors.** Adding two layout object types moves five separate exact-count assertions. Grep for every one before committing.
- **PR-only.** Branch off `beta`, three review passes (correctness, simplification, whole-PR) before opening. Never push to `beta`/`main`. Henry merges.

### The exact-count assertions this plan moves

Two new layout object types (`scores`, `home-scores`) mean, verified on `beta`:

| File | Assertion | From | To |
|---|---|---|---|
| `renderer/main/object-catalog.test.ts:19` | `TYPES.length` | 54 | 56 |
| `main/types/object-capabilities.test.ts:19` | `Object.keys(CAPABILITIES).length` | 54 | 56 |
| `renderer/main/object-fit.test.ts:34` | `Object.keys(CAPABILITIES).length` | 54 | 56 |
| `renderer/main/object-look.test.ts:60` | `all.length` | 54 | 56 |
| `renderer/main/object-look.test.ts:61` | `all.filter(hasCard).length` | 29 | 30 |
| `renderer/app/home/home-card-routing.test.ts:25` | `HOME_TYPES.length` | 12 | 13 |

`scores` is carded; `home-scores` is bare (it goes in `HOST_FRAMED_TYPES`, and `object-look.test.ts`'s `BARE` list is asserted equal to it, so both move together). `renderer/main/layout-objects.test.ts:328` `ADDED_SINCE` takes two appended entries.

`renderer/main/object-fit.test.ts:26` comments that a browser overflow sweep should be run against a new type before bumping. Do it — Task 6 has the step.

---

## File Structure

**Server**

| File | Responsibility |
|---|---|
| `main/types/scores.ts` (new) | Every DTO. Leagues table. No logic. |
| `main/services/espn-client.ts` (new) | HTTP only: fetch a league scoreboard, fetch a league's teams. Knows nothing about favourites. |
| `main/services/scores-parse.ts` (new) | Pure. `parseScoreboard`, `diffScores`, `sortGames`. No I/O, no clock. |
| `main/services/scores-schedule.ts` (new) | Pure. Given today's games and now, when should the next poll be, and should we be polling at all. |
| `main/services/scores-service.ts` (new) | `StatusIntegration<ScoresStatusDTO>`. Owns the timer, the baseline, the broadcast. |
| `main/services/scores-store.ts` (new) | `DataStore<ScoresConfig>`, `"config"`. Favourites and cached team display fields. |

Split this way because `scores-parse.ts` is where the two bugs that matter live (the diff key, and degrading when a sport-specific field is absent) and it must be testable against a saved fixture with no network and no clock. `scores-schedule.ts` is separated for the same reason: "should we be polling at 3am" is a pure function of a list of games and a timestamp.

**Renderer, shared presentation**

| File | Responsibility |
|---|---|
| `renderer/main/score-ink.ts` (new) | `inkFor(hex)`, `contrastRatio(a,b)`. Pure, WCAG relative luminance. |
| `renderer/main/score-center.tsx` (new) | The per-sport centre. One component, a switch over `situation.kind`. |
| `renderer/main/score-strip.tsx` (new) | Away side / centre / home side. The one strip every surface renders. |
| `renderer/main/use-scores-state.ts` (new) | Mirrors `use-reaper-state.ts`. |

**Renderer, surfaces**

| File | Responsibility |
|---|---|
| `renderer/app/score-activity-store.ts` (new) | Module-level open/focus state, `useSyncExternalStore`. Why: `renderBarItem` is a pure `(id, ctx) => ReactNode` and the guard at `context-bar.test.tsx:149` asserts it never returns null. Threading open state through `BarItemContext` would put UI state in a data object every item reads. A module store is the same shape `toast.tsx` already uses. |
| `renderer/app/score-activity.tsx` (new) | The Live Activity panel and the wallet stack. |
| `renderer/main/scores-object.tsx` (new) | The custom layout object body. |
| `renderer/settings/panels/scores-teams-panel.tsx` (new) | The bespoke Integrations panel, with its own popover, query state and filter. See the decision below. |

### One decision, settled

Research §3.6 found **four** hand-rolled search-filter popovers already in the repo (`position-picker.tsx`, `icon-grid.tsx`, `home-editor.tsx`'s `AddWidgetSheet`, plus `multi-select.tsx` which has no search at all). CLAUDE.md says: *"If the same shape exists in three places, prefer removing the duplication over fixing it three times."*

This plan originally recommended extracting `renderer/components/ui/searchable-list.tsx` with the scores picker as its first consumer. **Henry overruled that: the picker is bespoke and no new primitive ships.**

The reasoning that survives either way is that a primitive extracted for exactly one consumer is speculative generality — you cannot tell which parts of the shape are general until a second caller disagrees with one — while migrating the existing four means touching slot matching and every icon field in a PR about sports scores. Neither half of that trade was worth taking here, so the fifth copy is written knowingly, is confined to one file, and the deduplication stays available as its own change when someone has three callers to design against.

What does **not** change with the decision: the picker is built on Radix `Popover`, never on `select.tsx` (which renders a native `<select>`, so the OS draws the list and its first-letter typeahead fights any text field inside it — `position-picker.tsx` records exactly this lesson); the query matches display name **and** abbreviation; an empty result shows an explicit empty state; and the query resets on close.

---

## Task 1: The ESPN client and the pure folds

**Files:**
- Create: `main/types/scores.ts`
- Create: `main/services/espn-client.ts`
- Create: `main/services/scores-parse.ts`
- Create: `main/services/scores-parse.test.ts`
- Create: `main/services/fixtures/espn-mlb-doubleheader.json`
- Create: `main/services/fixtures/espn-nfl-scoreboard.json`
- Create: `main/services/fixtures/espn-football-in-play.json`

**Interfaces:**
- Produces: `ScoresConfig`, `ScoreFavourite`, `ScoreGameDTO`, `ScoreTeamDTO`, `ScoreSituation`, `ScoresStatusDTO`, `ScoreEvent`, `LEAGUES`, `LeagueId`; `fetchScoreboard(league, dates?)`, `fetchTeams(league)`; `parseScoreboard(league, json, favourites)`, `diffScores(prev, next)`, `sortGames(games)`.
- Consumes: nothing.

- [ ] **Step 1: Write `main/types/scores.ts`**

```ts
// scores.ts — the shapes the scores integration speaks.
//
// Every field here was observed in a real ESPN response on 2026-08-29; see
// docs/superpowers/research/2026-08-29-espn-scores.md. Fields the research could
// not observe live are NOT in this file — a DTO field nothing ever fills is a
// renderer branch that is never exercised.

/** The leagues the picker offers. Adding one is a row here plus a fixture. */
export const LEAGUES = [
  { id: "mlb", path: "baseball/mlb", label: "MLB", kind: "baseball" },
  { id: "nfl", path: "football/nfl", label: "NFL", kind: "football" },
  { id: "nba", path: "basketball/nba", label: "NBA", kind: "basketball" },
  { id: "nhl", path: "hockey/nhl", label: "NHL", kind: "hockey" },
] as const;

export type LeagueId = (typeof LEAGUES)[number]["id"];
export type SportKind = (typeof LEAGUES)[number]["kind"];

export function leagueById(id: string): (typeof LEAGUES)[number] | null {
  return LEAGUES.find((l) => l.id === id) ?? null;
}

/**
 * A followed team.
 *
 * Keyed on ESPN's numeric `id`, NOT the abbreviation or the display name.
 * Abbreviations are unique only within a league and both names move on a
 * relocation or rebrand — exactly the season rollover this has to survive. The
 * display fields are a CACHE for rendering the settings row before the first
 * successful fetch; they are re-resolved from /teams, and the id is the thing
 * that is authoritative.
 */
export interface ScoreFavourite {
  league: LeagueId;
  teamId: string;
  /** Cached for the settings row. Refreshed on every successful /teams read. */
  displayName: string;
  abbreviation: string;
  /** Cached at selection time so no display ever fetches a.espncdn.com itself. */
  logo: string | null;
  /** "#0E3386", already prefixed. null when ESPN sent nothing usable. */
  color: string | null;
}

export interface ScoresConfig {
  favourites: ScoreFavourite[];
}

/** ESPN's three-way game state. `status.type.state`. */
export type ScoreState = "pre" | "in" | "post";

export interface ScoreTeamDTO {
  id: string;
  abbreviation: string;
  /** "Cubs" — shortDisplayName. What a card shows. */
  name: string;
  /** "Chicago Cubs" — for the settings row and the accessible label. */
  displayName: string;
  /** "#0E3386", already prefixed. null means "no colour" — render neutral. */
  color: string | null;
  logo: string | null;
  /** "78-56", or null. */
  record: string | null;
  /**
   * null means NO READING, and is not the same as 0.
   *
   * The per-team endpoint returns null scores for a game that is demonstrably in
   * progress, and a null-to-0 transition read as a score would fire a phantom
   * event on every followed team the first time one of those was ever parsed.
   */
  score: number | null;
}

/**
 * Sport-shaped garnish over the common core.
 *
 * ESPN's `situation` object is NOT uniform — baseball has bases and a count,
 * football has down and distance, and the two share only `lastPlay`. So this is
 * a discriminated union rather than a wide optional-everything record, and every
 * renderer switches on `kind` with a default that draws the status detail alone.
 *
 * Football possession IS carried, on evidence gathered after the research doc
 * was written: `situation.possession` is a bare team id string, cross-checked
 * against `drives.current.team.id` on the summary endpoint. It is OMITTED
 * (absent, not null) in some states — an official timeout, and between a kickoff
 * and the receiving team's first snap — and was present at the end of a quarter,
 * so "absent at dead ball" is too broad a rule. Read it independently of
 * `shortDownDistanceText`, which is present on that first snap when possession
 * is not.
 */
export type ScoreSituation =
  | {
      kind: "baseball";
      onFirst: boolean;
      onSecond: boolean;
      onThird: boolean;
      balls: number;
      strikes: number;
      outs: number;
    }
  | {
      kind: "football";
      down: number | null;
      distance: number | null;
      redZone: boolean;
      /** The team id with the ball, or null. NOT possessionText (that is the
       *  ball's field position) and NOT lastPlay.start.team.id (after a kickoff
       *  that is the team who just kicked it away). */
      possession: string | null;
      /** "3rd & 10" — ESPN's short form. Independent of possession. */
      downDistance: string | null;
    }
  | { kind: "basketball" }
  | { kind: "hockey" };

export interface ScoreGameDTO {
  /** ESPN event id. Half of the diff key — see diffScores. */
  eventId: string;
  league: LeagueId;
  sport: SportKind;
  state: ScoreState;
  /**
   * A rain delay reports state "in". Anything keying only on `state` shows a
   * delayed game as live, so the delay is called out separately.
   */
  delayed: boolean;
  /** ESPN's own pre-formatted, already-sport-appropriate string: "Top 3rd". */
  detail: string;
  shortDetail: string;
  /** ESPN's clock string, e.g. "3:22". Empty for sports without one. */
  clock: string;
  /** ISO-8601. Render through app-timezone, never the host clock. */
  startsAt: string;
  venue: string | null;
  away: ScoreTeamDTO;
  home: ScoreTeamDTO;
  situation: ScoreSituation | null;
}

/** One team's score moving between two polls. */
export interface ScoreEvent {
  eventId: string;
  teamId: string;
  from: number;
  to: number;
}

export interface ScoresStatusDTO {
  connected: boolean;
  /** Followed games for today, sorted by start time then eventId — see sortGames. */
  games: ScoreGameDTO[];
  /**
   * Bumped only when a score actually moved.
   *
   * A client uses it to tell "news arrived" from "React re-rendered", which is
   * what drives the auto-open. Same idiom as the presence work: a monotonic
   * counter, because comparing DTOs in the client is a second place for the
   * change rule to live and drift.
   */
  rev: number;
  /** The scoring changes carried by the poll that last bumped `rev`. */
  lastEvents: ScoreEvent[];
  /** ISO-8601 of the last successful poll, or null. */
  fetchedAt: string | null;
  /**
   * Non-null when the last poll failed.
   *
   * Carried in the DTO as well as reported to the Integrations panel, so a
   * display shows a stale-data notice rather than silently freezing on numbers
   * that stopped being true an hour ago.
   */
  error: string | null;
}

export const SCORES_OFFLINE: ScoresStatusDTO = {
  connected: false,
  games: [],
  rev: 0,
  lastEvents: [],
  fetchedAt: null,
  error: null,
};
```

- [ ] **Step 2: Write the two fixtures**

Fetch them live and trim to what the parser reads. Both are public data.

```bash
mkdir -p main/services/fixtures
curl -s 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20260829' \
  > main/services/fixtures/espn-mlb-doubleheader.json
curl -s 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' \
  > main/services/fixtures/espn-nfl-scoreboard.json
# A football slate captured WHILE a game is in play, so it carries a real
# situation.possession. College football, because the NFL regular season had not
# started — same sport path, same situation keys.
curl -s 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard' \
  > main/services/fixtures/espn-football-in-play.json
```

Each is then trimmed to the fields the parser reads (dropping `lastPlay`, which
carries headshots and win-probability blocks nothing here touches). That takes the
three from 321 KB / 292 KB / 306 KB to roughly 70 KB / 41 KB / 73 KB, which is the
difference between a fixture a reviewer can read and one they cannot.

Verify the in-play fixture actually caught a possession before committing:

```bash
node -e "const j=require('./main/services/fixtures/espn-football-in-play.json');
const e=j.events.find(e=>e.competitions[0].situation?.possession);
if(!e) throw new Error('fixture caught no in-play possession — recapture');
console.log('possession:', e.shortName, e.competitions[0].situation.possession);"
```

The MLB fixture **must** contain the BOS @ NYY doubleheader (events `401874913` and `401816717`). Verify before committing:

```bash
node -e "const j=require('./main/services/fixtures/espn-mlb-doubleheader.json');
const ids=j.events.filter(e=>e.shortName.includes('BOS')&&e.shortName.includes('NYY')).map(e=>e.id);
console.log('BOS@NYY events:', ids); if(ids.length<2) throw new Error('fixture lacks the doubleheader');"
```

If that date's payload is no longer served, use any date with a doubleheader and update the ids in the test. **Do not fabricate a fixture** — the point of this one is that it is a real payload that a team-keyed diff gets wrong.

- [ ] **Step 3: Write `main/services/espn-client.ts`**

```ts
// espn-client.ts — HTTP against ESPN's public, undocumented scoreboard API.
//
// No authentication, no rate-limit headers, and no contract. The community
// reference is explicit that "excessive requests may be blocked", and a block
// would be by source IP — which on a church LAN is the whole building, with no
// warning and no support channel. Nothing is gained by polling fast and a silent
// unappealable block is what there is to lose. Cadence lives in
// scores-schedule.ts; this file only knows how to ask once.
//
// Every response is returned as parsed JSON and NOT interpreted here: the fold
// lives in scores-parse.ts so it can be tested against a fixture with no network.

const BASE = "https://site.api.espn.com/apis/site/v2/sports";

/** ESPN's own cache-control on the scoreboard is max-age=10; four seconds is a
 *  network timeout, not a cadence. */
const REQUEST_TIMEOUT_MS = 6000;

/** A league path, e.g. "baseball/mlb". */
export type LeaguePath = string;

async function getJson(url: string): Promise<unknown> {
  // AbortSignal.timeout rather than a hand-rolled controller-plus-clearTimeout:
  // the timer cannot be leaked because there is no timer to forget. This is the
  // codebase-wide convention (see reaper-service.ts).
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ESPN returned HTTP ${res.status} for ${url}`);
  return await res.json();
}

/**
 * One league's scoreboard.
 *
 * `dates` is YYYYMMDD in the LEAGUE's own reckoning, which is why the caller
 * computes it through app-timezone rather than this file reaching for a clock.
 */
export function fetchScoreboard(league: LeaguePath, dates?: string): Promise<unknown> {
  const q = dates ? `?dates=${encodeURIComponent(dates)}` : "";
  return getJson(`${BASE}/${league}/scoreboard${q}`);
}

/** One league's teams — for the picker, and to re-resolve cached display fields. */
export function fetchTeams(league: LeaguePath): Promise<unknown> {
  return getJson(`${BASE}/${league}/teams`);
}
```

- [ ] **Step 4: Write the failing tests in `main/services/scores-parse.test.ts`**

```ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { parseScoreboard, diffScores, sortGames, baselineOf } from "./scores-parse.js";
import type { ScoreGameDTO } from "../types/scores.js";

const MLB = JSON.parse(readFileSync(new URL("./fixtures/espn-mlb-doubleheader.json", import.meta.url), "utf8"));
const NFL = JSON.parse(readFileSync(new URL("./fixtures/espn-nfl-timeout.json", import.meta.url), "utf8"));

/** Every followed team in the MLB fixture, so parseScoreboard returns everything. */
const ALL_MLB = { league: "mlb" as const, teamIds: new Set<string>() };

describe("parseScoreboard", () => {
  test("keeps only games a followed team is in", () => {
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    assert.ok(games.length > 0, "the fixture must contain a game for team 10");
    for (const g of games) {
      assert.ok(g.away.id === "10" || g.home.id === "10", `${g.eventId} has no followed team`);
    }
  });

  test("score is a NUMBER, never the string ESPN sends", () => {
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    for (const g of games) {
      for (const t of [g.away, g.home]) {
        assert.ok(t.score === null || typeof t.score === "number", `${t.abbreviation} score is ${typeof t.score}`);
      }
    }
  });

  test("an absent score is null, not 0", () => {
    // Strip the scores off one competitor and confirm the fold says "no reading"
    // rather than inventing a nil-nil game.
    const doctored = structuredClone(MLB);
    delete doctored.events[0].competitions[0].competitors[0].score;
    const id = doctored.events[0].competitions[0].competitors[0].id;
    const g = parseScoreboard("mlb", doctored, new Set([id]))[0];
    const side = g.away.id === id ? g.away : g.home;
    assert.equal(side.score, null);
  });

  test("colours arrive prefixed with #", () => {
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    for (const t of [games[0].away, games[0].home]) {
      if (t.color !== null) assert.match(t.color, /^#[0-9a-f]{6}$/i, `${t.abbreviation}: ${t.color}`);
    }
  });

  test("a football payload with no baseball fields still folds", () => {
    // The situation object is sport-shaped. This is the degradation guard: a
    // sport whose situation lacks everything the renderer might want must yield
    // a game with a null or football situation, never throw.
    const ids = new Set<string>(
      NFL.events.flatMap((e: never) =>
        (e as { competitions: { competitors: { id: string }[] }[] }).competitions[0].competitors.map((c) => c.id),
      ),
    );
    const games = parseScoreboard("nfl", NFL, ids);
    assert.ok(games.length > 0);
    for (const g of games) {
      assert.ok(g.situation === null || g.situation.kind === "football");
    }
  });

  test("a payload missing competitions entirely is skipped, not thrown on", () => {
    const doctored = { events: [{ id: "x", date: "2026-08-29T17:05Z", status: {}, competitions: [] }] };
    assert.deepEqual(parseScoreboard("mlb", doctored, new Set(["10"])), []);
  });

  test("a delayed game reports delayed, even though its state is in", () => {
    const doctored = structuredClone(MLB);
    const ev = doctored.events[0];
    ev.status.type = { ...ev.status.type, state: "in", name: "STATUS_DELAYED" };
    const id = ev.competitions[0].competitors[0].id;
    const g = parseScoreboard("mlb", doctored, new Set([id]))[0];
    assert.equal(g.state, "in");
    assert.equal(g.delayed, true);
  });
});

describe("diffScores", () => {
  test("THE DOUBLEHEADER: two games between the same two teams do not smear", () => {
    // This is the guard the whole file exists for. BOS @ NYY is played twice on
    // this date. A diff keyed on the TEAM sees NYY at 3 in game one and NYY at 0
    // in game two and reports a score change that never happened — in both
    // directions, every poll, forever.
    const ids = new Set<string>(
      MLB.events.flatMap((e: never) =>
        (e as { competitions: { competitors: { id: string }[] }[] }).competitions[0].competitors.map((c) => c.id),
      ),
    );
    const games = parseScoreboard("mlb", MLB, ids);
    const pairs = new Map<string, ScoreGameDTO[]>();
    for (const g of games) {
      const key = [g.away.id, g.home.id].sort().join("~");
      pairs.set(key, [...(pairs.get(key) ?? []), g]);
    }
    const doubled = [...pairs.values()].find((gs) => gs.length > 1);
    assert.ok(doubled, "the fixture must contain a doubleheader — see Task 1 Step 2");
    assert.notEqual(doubled[0].eventId, doubled[1].eventId);

    // Same list, twice. Nothing changed, so nothing is reported.
    const base = baselineOf(games);
    assert.deepEqual(diffScores(base, games), []);
  });

  test("a real score reports exactly one event, with from and to", () => {
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    const g = games.find((x) => x.away.score !== null && x.home.score !== null);
    assert.ok(g, "the fixture must contain a game with both scores present");
    const base = baselineOf(games);
    const after = structuredClone(games);
    const target = after.find((x) => x.eventId === g.eventId)!;
    const before = target.home.score!;
    target.home.score = before + 1;

    const events = diffScores(base, after);
    assert.deepEqual(events, [
      { eventId: g.eventId, teamId: g.home.id, from: before, to: before + 1 },
    ]);
  });

  test("null to a number is NOT a score", () => {
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    const after = structuredClone(games);
    after[0].home.score = 0;
    const base = new Map(baselineOf(games));
    base.set(`${after[0].eventId}:${after[0].home.id}`, null);
    assert.deepEqual(diffScores(base, after), []);
  });

  test("an unseen game does not report every team as having scored", () => {
    // The first successful poll seeds the baseline and emits nothing. Without
    // this, every followed team "scores" the moment the server starts.
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    assert.deepEqual(diffScores(new Map(), games), []);
  });

  test("a score going DOWN is reported, so a reversal is not silently swallowed", () => {
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    const g = games.find((x) => (x.home.score ?? 0) > 0);
    assert.ok(g, "the fixture must contain a game with a non-zero home score");
    const base = baselineOf(games);
    const after = structuredClone(games);
    const target = after.find((x) => x.eventId === g.eventId)!;
    target.home.score = target.home.score! - 1;
    assert.equal(diffScores(base, after).length, 1);
  });
});

describe("sortGames", () => {
  test("is stable by start time then eventId, so cards never reshuffle", () => {
    // ESPN does not guarantee events[] order between polls.
    const games = parseScoreboard("mlb", MLB, new Set(["10"]));
    const a = sortGames([...games].reverse());
    const b = sortGames([...games]);
    assert.deepEqual(a.map((g) => g.eventId), b.map((g) => g.eventId));
  });
});
```

- [ ] **Step 5: Run the tests and watch them fail for the right reason**

```bash
npm test -- --test-name-pattern="parseScoreboard|diffScores|sortGames" 2>&1 | tail -30
```

Expected: every test fails with `Cannot find module './scores-parse.js'`.

- [ ] **Step 6: Write `main/services/scores-parse.ts`**

```ts
// scores-parse.ts — folding an ESPN scoreboard into our DTOs, and spotting a score.
//
// Pure, no I/O, no clock. Everything here is testable against a saved fixture,
// which is the point: the two bugs that matter in this feature both live in this
// file, and both are only visible against a real payload.
//
// ESPN's payload is an undocumented third-party shape that can change without
// notice, and its `situation` object differs by sport. So every read is
// defensive and every failure degrades to "score and status" rather than
// throwing — but a payload that yields NOTHING is reported by the caller, never
// swallowed.

import type {
  LeagueId,
  ScoreEvent,
  ScoreGameDTO,
  ScoreSituation,
  ScoreState,
  ScoreTeamDTO,
  SportKind,
} from "../types/scores.js";
import { leagueById } from "../types/scores.js";

/** A JSON object we have not proved anything about yet. */
type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function bool(v: unknown): boolean {
  return v === true;
}

/** ESPN sends whole numbers as strings on some endpoints and numbers on others. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ESPN sends colours as bare six-digit hex with no leading #. */
function colour(v: unknown): string | null {
  const s = str(v);
  return s && /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
}

function parseTeam(competitor: Obj): ScoreTeamDTO | null {
  const team = obj(competitor.team);
  const id = str(competitor.id) ?? (team ? str(team.id) : null);
  if (!team || !id) return null;
  const records = arr(competitor.records).map(obj);
  const overall = records.find((r) => r && str(r.type) === "total") ?? records[0];
  return {
    id,
    abbreviation: str(team.abbreviation) ?? id,
    name: str(team.shortDisplayName) ?? str(team.name) ?? str(team.displayName) ?? id,
    displayName: str(team.displayName) ?? str(team.name) ?? id,
    color: colour(team.color),
    logo: str(team.logo),
    record: overall ? str(overall.summary) : null,
    // NOT `?? 0`. A missing score is no reading; see ScoreTeamDTO.score.
    score: num(competitor.score),
  };
}

/**
 * The sport-specific garnish, or null.
 *
 * Returns null rather than a half-filled object whenever the sport's own fields
 * are absent — a renderer that draws an empty bases diamond over a football game
 * is worse than one that draws the status detail alone.
 */
function parseSituation(kind: SportKind, situation: Obj | null): ScoreSituation | null {
  if (!situation) return null;
  switch (kind) {
    case "baseball": {
      const outs = num(situation.outs);
      // The count and the bases are what make a baseball centre worth drawing.
      // Without outs there is nothing sport-specific to say.
      if (outs === null) return null;
      return {
        kind: "baseball",
        onFirst: bool(situation.onFirst),
        onSecond: bool(situation.onSecond),
        onThird: bool(situation.onThird),
        balls: num(situation.balls) ?? 0,
        strikes: num(situation.strikes) ?? 0,
        outs,
      };
    }
    case "football": {
      const down = num(situation.down);
      return {
        kind: "football",
        // ESPN uses -1 for "no down", e.g. during a timeout.
        down: down !== null && down > 0 ? down : null,
        distance: num(situation.distance),
        redZone: bool(situation.isRedZone),
      };
    }
    case "basketball":
      return { kind: "basketball" };
    case "hockey":
      return { kind: "hockey" };
  }
}

function parseState(v: unknown): ScoreState {
  return v === "in" || v === "post" ? v : "pre";
}

/**
 * Followed games from one league's scoreboard.
 *
 * `followed` is a set of ESPN team ids. An empty set matches nothing — "follow
 * everything" is not a state this feature has, and defaulting an empty
 * favourites list to every game in a league would poll and render 15 games
 * nobody asked for.
 */
export function parseScoreboard(
  league: LeagueId,
  payload: unknown,
  followed: ReadonlySet<string>,
): ScoreGameDTO[] {
  const meta = leagueById(league);
  if (!meta) return [];
  const root = obj(payload);
  if (!root) return [];

  const out: ScoreGameDTO[] = [];
  for (const raw of arr(root.events)) {
    const ev = obj(raw);
    if (!ev) continue;
    const eventId = str(ev.id);
    const comp = obj(arr(ev.competitions)[0]);
    if (!eventId || !comp) continue;

    const competitors = arr(comp.competitors).map(obj);
    const away = competitors.find((c) => c && str(c.homeAway) === "away");
    const home = competitors.find((c) => c && str(c.homeAway) === "home");
    if (!away || !home) continue;

    const a = parseTeam(away);
    const h = parseTeam(home);
    if (!a || !h) continue;
    if (!followed.has(a.id) && !followed.has(h.id)) continue;

    const status = obj(ev.status) ?? obj(comp.status);
    const type = status ? obj(status.type) : null;
    const venue = obj(comp.venue);

    out.push({
      eventId,
      league,
      sport: meta.kind,
      state: parseState(type?.state),
      // A rain delay reports state "in". Keying only on state shows a delayed
      // game as live, so this is called out rather than inferred by every caller.
      delayed: str(type?.name) === "STATUS_DELAYED",
      detail: (type ? str(type.detail) : null) ?? "",
      shortDetail: (type ? str(type.shortDetail) : null) ?? (type ? str(type.detail) : null) ?? "",
      clock: (status ? str(status.displayClock) : null) ?? "",
      startsAt: str(ev.date) ?? "",
      venue: venue ? str(venue.fullName) : null,
      away: a,
      home: h,
      situation: parseSituation(meta.kind, obj(comp.situation)),
    });
  }
  return sortGames(out);
}

/**
 * Stable order.
 *
 * ESPN does not promise events[] comes back the same way twice, and a stack of
 * cards that reshuffles under the operator between polls is unreadable. Start
 * time first because that is the order a person expects; eventId as the
 * tiebreak because a doubleheader's two games can share a listed start.
 */
export function sortGames(games: readonly ScoreGameDTO[]): ScoreGameDTO[] {
  return [...games].sort(
    (x, y) => x.startsAt.localeCompare(y.startsAt) || x.eventId.localeCompare(y.eventId),
  );
}

/**
 * The diff key: ONE GAME'S ONE TEAM.
 *
 * Both halves are load-bearing.
 *
 *  - `teamId`, not `homeAway`, because home/away is a ROLE. Keying on it means a
 *    swap between two polls reads as both teams scoring.
 *  - `eventId`, not the team alone, because two teams can play each other twice
 *    in a day. A real BOS @ NYY doubleheader is in the test fixture, and a
 *    team-keyed diff reports phantom scores in both directions on every poll of
 *    it, forever.
 */
function keyOf(eventId: string, teamId: string): string {
  return `${eventId}:${teamId}`;
}

/** The score each followed side was last seen at. `null` means "no reading". */
export type ScoreBaseline = Map<string, number | null>;

export function baselineOf(games: readonly ScoreGameDTO[]): ScoreBaseline {
  const m: ScoreBaseline = new Map();
  for (const g of games) {
    m.set(keyOf(g.eventId, g.away.id), g.away.score);
    m.set(keyOf(g.eventId, g.home.id), g.home.score);
  }
  return m;
}

/**
 * What scored between two polls.
 *
 * Three cases deliberately produce NOTHING:
 *
 *  - A side that was not in the baseline at all. The first successful poll seeds
 *    and emits nothing; otherwise every followed team "scores" the moment the
 *    server starts.
 *  - A move out of `null`. The per-team endpoint returns null scores for games
 *    that are demonstrably in progress, so null-to-0 is a reading arriving, not
 *    a run scoring.
 *  - A move INTO `null`, which is a reading going away.
 *
 * A score going DOWN is reported. A review reversing a touchdown is news, and a
 * silent correction would leave the card and the baseline disagreeing.
 */
export function diffScores(
  baseline: ScoreBaseline,
  games: readonly ScoreGameDTO[],
): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  for (const g of games) {
    for (const side of [g.away, g.home]) {
      const key = keyOf(g.eventId, side.id);
      if (!baseline.has(key)) continue;
      const from = baseline.get(key) ?? null;
      const to = side.score;
      if (from === null || to === null || from === to) continue;
      events.push({ eventId: g.eventId, teamId: side.id, from, to });
    }
  }
  return events;
}
```

- [ ] **Step 7: Run the tests and watch them pass**

```bash
npm test -- --test-name-pattern="parseScoreboard|diffScores|sortGames" 2>&1 | tail -20
```

- [ ] **Step 8: PROVE the doubleheader guard fails on the bug it guards**

Temporarily change `keyOf` to drop the event:

```ts
function keyOf(eventId: string, teamId: string): string {
  return teamId; // DELIBERATE BUG — revert after observing red
}
```

Run the diff tests. **Paste the failing output into the commit message.** Then revert.

Expected: the doubleheader test goes red because the second game's baseline overwrites the first's, so the two BOS @ NYY games report a score change against each other.

- [ ] **Step 9: PROVE the null guard fails on the bug it guards**

Temporarily change `parseTeam` to `score: num(competitor.score) ?? 0`. Run. Expected: "an absent score is null, not 0" and "null to a number is NOT a score" both go red. Revert, and say so in the commit.

- [ ] **Step 10: Full suite, then commit**

```bash
npm test 2>&1 | tail -5
npx tsc --noEmit
```

```bash
git add main/types/scores.ts main/services/espn-client.ts main/services/scores-parse.ts \
        main/services/scores-parse.test.ts main/services/fixtures/
git commit -m "feat(scores): fold an ESPN scoreboard, and spot a score without smearing a doubleheader"
```

---

## Task 2: The integration, the schedule, and the registration chain

**Files:**
- Create: `main/services/scores-store.ts`
- Create: `main/services/scores-schedule.ts`
- Create: `main/services/scores-schedule.test.ts`
- Create: `main/services/scores-service.ts`
- Create: `renderer/main/use-scores-state.ts`
- Modify: `main/services/integration-ids.ts`
- Modify: `main/services/automation-triggers.ts`
- Modify: `main/services/integration-manager.ts`
- Modify: `main/services/remote-server.ts`
- Modify: `main/services/stores.ts`
- Modify: `renderer/lib/sse-channels.ts`
- Modify: `main/services/automation-coverage.test.ts`
- Modify: `main/services/config-snapshot.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseScoreboard`, `diffScores`, `baselineOf`, `fetchScoreboard`, `fetchTeams`, all DTOs.
- Produces: `scoresService` (with `getLatest()`, `configure(favourites)`, `listTeams(league)`), `scoresStore`, `nextPoll()`, the `scores:status` channel, `useScoresState()`.

- [ ] **Step 1: Write `main/services/scores-store.ts`**

```ts
// scores-store.ts — which teams the operator follows.
//
// "config": these are the operator's choices, and losing them to a reinstall is
// losing their setup. Being config is also what puts the file in every backup —
// the allowlist is derived from this classification, so a store misfiled as
// "runtime" is silently missing from every snapshot with the suite green.
//
// GLOBAL, not per-device, like bar-config: two operators on two machines should
// be following the same teams.

import { DataStore } from "./data-store.js";
import type { ScoreFavourite, ScoresConfig } from "../types/scores.js";

const DEFAULT: ScoresConfig = { favourites: [] };

const store = new DataStore<ScoresConfig>("scores-favourites.json", DEFAULT, "config");

let cache: ScoresConfig = DEFAULT;

export const scoresStore = {
  async init(): Promise<void> {
    cache = await store.load();
  },
  get(): ScoresConfig {
    return cache;
  },
  async setFavourites(favourites: ScoreFavourite[]): Promise<ScoresConfig> {
    cache = await store.update((c) => ({ ...c, favourites }));
    return cache;
  },
};
```

Register it wherever `bar-config-store` is registered in `main/services/stores.ts` — find that line and add the import beside it. `config-snapshot.test.ts` asserts the registered store count against the number of stores declared under `main/`, so a new store that is never imported fails the suite.

- [ ] **Step 2: Write the failing schedule tests in `main/services/scores-schedule.test.ts`**

```ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { nextPoll } from "./scores-schedule.js";
import type { ScoreGameDTO } from "../types/scores.js";

function game(over: Partial<ScoreGameDTO>): ScoreGameDTO {
  return {
    eventId: "e1", league: "mlb", sport: "baseball", state: "pre", delayed: false,
    detail: "", shortDetail: "", clock: "", startsAt: "2026-08-29T18:00:00.000Z",
    venue: null, situation: null,
    away: { id: "1", abbreviation: "AAA", name: "A", displayName: "A", color: null, logo: null, record: null, score: null },
    home: { id: "2", abbreviation: "BBB", name: "B", displayName: "B", color: null, logo: null, record: null, score: null },
    ...over,
  };
}

const NOON = Date.parse("2026-08-29T17:00:00.000Z");

describe("nextPoll", () => {
  test("a live game with something watching polls at the active cadence", () => {
    const d = nextPoll([game({ state: "in" })], NOON, true);
    assert.equal(d.poll, true);
    assert.equal(d.delayMs, 25_000);
  });

  test("a live game with NOTHING watching still polls, just slowly", () => {
    // Not zero. integration-base.ts records a real bug where gating on browser
    // subscribers alone silently disabled every automation rule reading the
    // channel — an unattended appliance is exactly where "nobody is watching"
    // is permanent.
    const d = nextPoll([game({ state: "in" })], NOON, false);
    assert.equal(d.poll, true);
    assert.equal(d.delayMs, 300_000);
  });

  test("a game starting within the hour polls every two minutes", () => {
    const soon = new Date(NOON + 30 * 60_000).toISOString();
    const d = nextPoll([game({ state: "pre", startsAt: soon })], NOON, true);
    assert.equal(d.poll, true);
    assert.equal(d.delayMs, 120_000);
  });

  test("every followed game finished: STOP, and say when to look again", () => {
    const d = nextPoll([game({ state: "post" })], NOON, true);
    assert.equal(d.poll, false);
    assert.ok(d.delayMs >= 30 * 60_000, "a stopped poller still wakes to re-read the schedule");
  });

  test("no games at all: stop, do not spin", () => {
    const d = nextPoll([], NOON, true);
    assert.equal(d.poll, false);
  });

  test("a game far in the future does not hold the fast cadence open", () => {
    const later = new Date(NOON + 6 * 3_600_000).toISOString();
    const d = nextPoll([game({ state: "pre", startsAt: later })], NOON, true);
    assert.equal(d.poll, false);
    // It must wake in time to catch the pre-game ramp, never sleep past it.
    assert.ok(NOON + d.delayMs <= Date.parse(later) - 60 * 60_000 + 1000);
  });

  test("live beats finished: one live game keeps the fast cadence", () => {
    const d = nextPoll([game({ state: "post" }), game({ eventId: "e2", state: "in" })], NOON, true);
    assert.equal(d.poll, true);
    assert.equal(d.delayMs, 25_000);
  });

  test("an unparseable start time never yields NaN", () => {
    const d = nextPoll([game({ state: "pre", startsAt: "" })], NOON, true);
    assert.equal(d.poll, false);
    assert.ok(Number.isFinite(d.delayMs), `delayMs was ${d.delayMs}`);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npm test -- --test-name-pattern="nextPoll" 2>&1 | tail -20
```

Expected: `Cannot find module './scores-schedule.js'`.

- [ ] **Step 4: Write `main/services/scores-schedule.ts`**

```ts
// scores-schedule.ts — when to ask ESPN again, and when to stop asking.
//
// Pure, and takes `now` rather than reading a clock, so every tier is testable.
//
// The argument for this file is the one service-window.ts already makes about
// the PCO live poll: a naive 25-second poll is ~3,500 requests per league per
// day for the handful of hours a followed game is actually being played. This is
// an undocumented free endpoint whose community reference warns that excessive
// requests may be blocked, by IP, with no notice — so the schedule is not
// politeness, it is the thing that keeps the feature working.

import type { ScoreGameDTO } from "../types/scores.js";

/** A followed game is live and somebody (or some rule) is consuming the channel. */
const ACTIVE_MS = 25_000;
/** Live, but nothing is reading. Slow, never stopped — automation still runs. */
const UNWATCHED_MS = 300_000;
/** A followed game starts within the hour. Cheap way to catch first pitch. */
const RAMP_MS = 120_000;
/** How long before a game we start ramping. */
const RAMP_WINDOW_MS = 3_600_000;
/** Nothing to watch today. Wake up occasionally and re-read the schedule. */
const DORMANT_MS = 1_800_000;

export interface PollDecision {
  /** Whether to fetch on this wake-up at all. */
  poll: boolean;
  /** How long until the next wake-up. Always finite and positive. */
  delayMs: number;
}

/**
 * The next wake-up.
 *
 * Fails OPEN in the same sense service-window.pollDelayMs does: a game whose
 * start time will not parse produces a dormant wake-up rather than NaN, and a
 * NaN delay passed to setTimeout fires immediately and forever.
 */
export function nextPoll(
  games: readonly ScoreGameDTO[],
  now: number,
  inDemand: boolean,
): PollDecision {
  if (games.some((g) => g.state === "in")) {
    return { poll: true, delayMs: inDemand ? ACTIVE_MS : UNWATCHED_MS };
  }

  const starts = games
    .filter((g) => g.state === "pre")
    .map((g) => Date.parse(g.startsAt))
    .filter((t) => Number.isFinite(t) && t > now)
    .sort((a, b) => a - b);

  const next = starts[0];
  if (next === undefined) return { poll: false, delayMs: DORMANT_MS };

  const until = next - now;
  if (until <= RAMP_WINDOW_MS) return { poll: true, delayMs: RAMP_MS };

  // Never sleep past the moment the ramp window opens — the same clamp
  // service-window.ts uses so a long dormant delay cannot swallow the next
  // window's start.
  return { poll: false, delayMs: Math.max(60_000, Math.min(DORMANT_MS, until - RAMP_WINDOW_MS)) };
}
```

- [ ] **Step 5: Run the schedule tests and watch them pass**

- [ ] **Step 6: PROVE the NaN guard fails on the bug it guards**

Temporarily drop the `Number.isFinite(t)` filter. Expected: "an unparseable start time never yields NaN" goes red with `delayMs was NaN`. Revert; record in the commit.

- [ ] **Step 7: Write `main/services/scores-service.ts`**

```ts
// scores-service.ts — follows chosen teams' live scores from ESPN.
//
// The HTTP-polling shape, modelled on reaper-service.ts: ONE timer carries both
// the steady cadence and the back-off, through scheduleIn(). Two timers would
// double the poll rate after a reconnect.
//
// What is different from the LAN integrations: there is no box to connect to and
// no session to hold. "connected" means the last poll reached ESPN and parsed.
// A failure is reported to the Integrations panel AND carried in the DTO, so a
// display shows a stale-data notice instead of silently freezing on numbers that
// stopped being true an hour ago.

import { appTimezone } from "./app-timezone.js";
import { errorMessage } from "./errors.js";
import { fetchScoreboard, fetchTeams } from "./espn-client.js";
import { StatusIntegration } from "./integration-base.js";
import { baselineOf, diffScores, parseScoreboard, sortGames, type ScoreBaseline } from "./scores-parse.js";
import { scoresStore } from "./scores-store.js";
import {
  LEAGUES,
  SCORES_OFFLINE,
  leagueById,
  type LeagueId,
  type ScoreFavourite,
  type ScoreGameDTO,
  type ScoresStatusDTO,
} from "../types/scores.js";
import { nextPoll } from "./scores-schedule.js";

/** ESPN wants YYYYMMDD in the league's own reckoning. Servers run UTC, so this
 *  goes through the app time zone — a UTC box rolls its date at 19:00 in
 *  Chicago, which would ask for tomorrow's scoreboard all evening. */
function todayStamp(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: appTimezone.get(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts.replaceAll("-", "");
}

class ScoresService extends StatusIntegration<ScoresStatusDTO> {
  private favourites: ScoreFavourite[] = [];
  private baseline: ScoreBaseline = new Map();
  private seeded = false;
  private rev = 0;
  /** One league's team list, cached for the picker. Teams change about once a
   *  decade; re-opening a dropdown must not re-fetch 30 rows. */
  private teamCache = new Map<LeagueId, { at: number; teams: ScoreFavourite[] }>();

  constructor() {
    super("scores", "scores:status", SCORES_OFFLINE);
  }

  protected get configured(): boolean {
    return this.favourites.length > 0;
  }

  configure(favourites: ScoreFavourite[]): void {
    this.favourites = favourites;
    // The baseline is keyed by game and team, so a favourites change invalidates
    // it: a team added mid-game must not immediately report its whole score as
    // having just happened.
    this.baseline = new Map();
    this.seeded = false;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[scores] following ${this.favourites.length} team(s)`);
    super.start();
  }

  /** Which leagues have at least one followed team. Never poll an empty league. */
  private activeLeagues(): LeagueId[] {
    return [...new Set(this.favourites.map((f) => f.league))];
  }

  private followedIn(league: LeagueId): Set<string> {
    return new Set(this.favourites.filter((f) => f.league === league).map((f) => f.teamId));
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.configured) return;
    const stamp = todayStamp();
    const games: ScoreGameDTO[] = [];
    const failures: string[] = [];

    for (const id of this.activeLeagues()) {
      const meta = leagueById(id);
      if (!meta) continue;
      try {
        const payload = await fetchScoreboard(meta.path, stamp);
        games.push(...parseScoreboard(id, payload, this.followedIn(id)));
      } catch (err) {
        // Collected, not swallowed. A function that can partially fail returns
        // what failed; the operator decides what it means that MLB is reachable
        // and the NHL is not.
        failures.push(`${meta.label}: ${errorMessage(err)}`);
      }
    }
    if (!this.running) return;

    // EVERY league failed. That is a connection failure, not a partial result.
    if (failures.length > 0 && games.length === 0) {
      this.fail(failures.join("; "));
      return;
    }

    const sorted = sortGames(games);
    const events = this.seeded ? diffScores(this.baseline, sorted) : [];
    this.baseline = baselineOf(sorted);
    this.seeded = true;

    if (events.length > 0) this.rev++;
    if (!this.last.connected) {
      this.resetBackoff();
      this.report("connected", `Following ${this.favourites.length} team(s)`);
    }
    // A partial failure is reported but does not stop the feature: the leagues
    // that answered still show.
    if (failures.length > 0) this.report("error", failures.join("; "));

    this.emitIfChanged({
      connected: true,
      games: sorted,
      rev: this.rev,
      // Carried only on the poll that produced them. A client reads them when
      // `rev` moves and ignores them otherwise.
      lastEvents: events,
      fetchedAt: new Date().toISOString(),
      error: failures.length > 0 ? failures.join("; ") : null,
    });

    const decision = nextPoll(sorted, Date.now(), this.inDemand);
    this.scheduleIn(decision.delayMs);
  }

  private fail(message: string): void {
    if (this.attempt === 0) console.warn(`[scores] ESPN unreachable (${message}) — backing off quietly`);
    this.report("error", message);
    // The scores we last had are kept and marked stale rather than blanked:
    // a display going empty reads as "no games", which is a different and wrong
    // statement from "we could not ask".
    this.emitIfChanged({ ...this.last, connected: false, error: message });
    this.scheduleReconnect();
  }

  /** One-shot check for the panel's Test button. */
  async test(): Promise<{ ok: boolean; message?: string }> {
    const league = this.activeLeagues()[0] ?? "mlb";
    const meta = leagueById(league);
    if (!meta) return { ok: false, message: "No league selected" };
    try {
      const payload = await fetchScoreboard(meta.path, todayStamp());
      const games = parseScoreboard(league, payload, this.followedIn(league));
      return {
        ok: true,
        message:
          games.length > 0
            ? `Reached ESPN — ${games.length} followed ${meta.label} game(s) today`
            : `Reached ESPN — no followed ${meta.label} games today`,
      };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  }

  /**
   * One league's teams, for the picker.
   *
   * Cached for a day. The picker opens often and a team list changes about once
   * a decade; re-fetching 30 rows to render a dropdown is the sort of traffic
   * this whole integration is built to avoid.
   */
  async listTeams(league: LeagueId): Promise<ScoreFavourite[]> {
    const hit = this.teamCache.get(league);
    if (hit && Date.now() - hit.at < 86_400_000) return hit.teams;

    const meta = leagueById(league);
    if (!meta) throw new Error(`Unknown league ${league}`);
    const payload = (await fetchTeams(meta.path)) as {
      sports?: { leagues?: { teams?: { team?: Record<string, unknown> }[] }[] }[];
    };
    const raw = payload.sports?.[0]?.leagues?.[0]?.teams ?? [];
    const teams: ScoreFavourite[] = [];
    for (const entry of raw) {
      const t = entry?.team;
      if (!t || typeof t.id !== "string") continue;
      const colour = typeof t.color === "string" && /^[0-9a-f]{6}$/i.test(t.color) ? `#${t.color.toLowerCase()}` : null;
      const logos = Array.isArray(t.logos) ? (t.logos as { href?: unknown }[]) : [];
      teams.push({
        league,
        teamId: t.id,
        displayName: typeof t.displayName === "string" ? t.displayName : t.id,
        abbreviation: typeof t.abbreviation === "string" ? t.abbreviation : t.id,
        // Cached at selection time so no wall display ever reaches a.espncdn.com
        // itself — some church networks will not allow it, and the logo's own
        // cache-control is 103 seconds, so a display left running would re-fetch
        // it all week.
        logo: typeof logos[0]?.href === "string" ? logos[0].href : null,
        color: colour,
      });
    }
    if (teams.length === 0) throw new Error(`${meta.label} returned no teams`);
    teams.sort((a, b) => a.displayName.localeCompare(b.displayName));
    this.teamCache.set(league, { at: Date.now(), teams });
    return teams;
  }

  /** Every league the picker offers, for the settings panel. */
  leagues(): typeof LEAGUES {
    return LEAGUES;
  }

  async init(): Promise<void> {
    await scoresStore.init();
    this.configure(scoresStore.get().favourites);
  }
}

export const scoresService = new ScoresService();
```

- [ ] **Step 8: Wire the registration chain**

Eight edits. Do them together — this is the "fix every instance" rule applied forward: a half-registered integration is the failure mode this chain's guards exist to catch.

1. `main/services/integration-ids.ts` — add `"scores"` to `INTEGRATION_IDS` (alphabetical, after `"rosstalk"`) and to `CONNECTION_MANAGED_IDS` (config changes must re-apply the connection).
2. `main/services/automation-triggers.ts:59` — add `{ id: "scores", label: "Live scores" }` to `INTEGRATIONS`. That alone gives it connection triggers and, via `automation-conditions.ts`, an `is-connected` condition, which satisfies `automation-coverage.test.ts`.
3. `main/services/integration-manager.ts` — an `IntegrationDescriptor` with `id: "scores"`, `kind` matching the bespoke-panel branch (see Task 3), label `"Live scores"`, an empty `configSchema: []` (the panel is bespoke), an entry in the applier map calling `scoresService.configure(scoresStore.get().favourites)`, no secret fields, and a branch in the test handler calling `scoresService.test()`.
4. `main/services/remote-server.ts` — beside the `reaper:status` line in the hello burst, add `sseWrite(res, "scores:status", scoresService.getLatest())`.
5. `renderer/lib/sse-channels.ts` — add `"scores:status"` to `HYDRATED_CHANNELS`. Scores are **state**, not events: a display opened mid-game must not sit blank until the next score.
6. `main/services/automation-coverage.test.ts` — add `"scores:status"` to `BROADCAST_CHANNELS`. Channels passed to the base constructor cannot be found by grepping for `broadcast("…")`, which is why that list is hand-maintained.
7. `main/services/config-snapshot.test.ts:97` — add `"scores-favourites.json"` to `EXPECTED_CONFIG`, in sorted position.
8. `main/services/stores.ts` — import `scores-store.js` beside the other store imports.

Also add the IPC handlers wherever `reaper:getStatus` is registered: `scores:getStatus` → `scoresService.getLatest()`, `scores:listTeams` → `scoresService.listTeams(league)`, `scores:setFavourites` → `scoresStore.setFavourites(f)` then `scoresService.configure(f)`, `scores:getFavourites` → `scoresStore.get()`.

- [ ] **Step 9: Write `renderer/main/use-scores-state.ts`**

Mirror `use-reaper-state.ts` exactly — same shape, same comment structure, `"scores:getStatus"` / `"scores:status"`, returning `ScoresStatusDTO | null`.

- [ ] **Step 10: Verify the chain, then commit**

```bash
npx tsc --noEmit
npm test 2>&1 | tail -5
```

The exact-count guards in `config-snapshot.test.ts` and `automation-coverage.test.ts` are the proof this task's registration is complete — they fail on a half-registered integration. Confirm they were red before step 8 and green after, and say so in the commit.

Then drive it for real:

```bash
STAGE_UTILITY_DATA=/tmp/stage-scores-test npm run server &
# wait for it, then in another shell:
curl -s localhost:8799/api/events --max-time 3 | grep -c "scores:status"
lsof -ti tcp:8799 | xargs -r kill -9
```

Kill by **port**. Never `pkill -f` on the env-var prefix — the prefix is not in the process command line, so the old server survives and the next run tests stale code.

```bash
git commit -m "feat(scores): poll ESPN on a schedule, and register the integration everywhere it must be"
```

---

## Task 3: The team picker

**Files:**
- Create: `renderer/settings/panels/scores-teams-panel.tsx`
- Create: `renderer/settings/panels/scores-teams-panel.test.tsx`
- Modify: `renderer/components/integrations-panel.tsx`
- Modify: `renderer/lib/api.ts`

**Interfaces:**
- Consumes: `scores:listTeams`, `scores:getFavourites`, `scores:setFavourites`.
- Produces: `ScoresTeamsPanel`, `TeamPicker`, `filterTeams`.

- [ ] **Step 1: Write `renderer/settings/panels/scores-teams-panel.tsx`**

Bespoke, with its own popover, query state and filter — see the decision in File Structure. Built on Radix `Popover`, **not** on `select.tsx`: `select.tsx` renders a native `<select>`, so the OS draws the open list and its first-letter typeahead fights a text field placed inside it. Read `renderer/settings/sections/position-picker.tsx`'s header comment first and follow its structure.

A list of followed teams — logo, display name, league — each with a remove button, plus one "Add a team" popover grouped by league, its options loaded from `scores:listTeams` on first open. Saving calls `scores:setFavourites`.

Four rules this panel must honour:

- The query matches the full display name **and** the abbreviation. An operator who thinks of the team as "CHC" should not have to know it is filed under "Chicago Cubs".
- An empty result shows an explicit **empty state**, never a bare list.
- The **query resets on close**, so re-opening never shows a filtered list whose filter has scrolled out of view.
- The **whole favourite is saved, not just the id.** `displayName`, `abbreviation`, `logo` and `color` are cached at selection time so no display ever fetches `a.espncdn.com` and the settings row renders before the first poll.
- A failed `listTeams` **shows the operator the error**. It does not silently render an empty dropdown. `catch` sets an error message in state and the panel says which league could not be loaded.

- [ ] **Step 2: Write `renderer/settings/panels/scores-teams-panel.test.tsx`**

Cover the filter rule (display name, abbreviation, case-insensitive, empty query, no match) and the picker itself. The query-resets-on-close behaviour is the one worth a guard with proof: remove the `setQuery("")` and confirm the test goes red.

Render the REAL popover rather than testing a helper in isolation, or the guard cannot see the component it guards. Two jsdom notes that cost time: `cleanup()` between renders (two mounted pickers means two "Add a team" buttons and the query fails on ambiguity), and let Radix's async focus work settle before teardown removes `window`, or every test passes while the FILE fails on an unhandledRejection.

- [ ] **Step 3: Register the panel**

`renderer/components/integrations-panel.tsx:1226` already has the bespoke-panel escape hatch:

```tsx
if (descriptor.kind === "wireless") return <WirelessConnectionsPanel />;
if (descriptor.id === "osc") return <OscTargetsPanel />;
```

Add `if (descriptor.id === "scores") return <ScoresTeamsPanel />;` beside them, and add `"scores"` to the appropriate group in the group table at `:986`. It belongs in whichever group reads as "things that display information", not "control & output" — check the table and choose deliberately.

- [ ] **Step 4: Drive it in a browser**

```bash
STAGE_UTILITY_DATA=/tmp/stage-scores-test npm run server &
npm run dev
```

Open Settings → Integrations → Live scores. Add two MLB teams and one NFL team. Confirm:
- the search filters as you type, on both full name and abbreviation
- a followed team shows "Following" and clicking it again removes it
- the row survives a page reload (it is in the store)
- `/tmp/stage-scores-test/scores-favourites.json` contains the cached logo URL

A control that renders is not a control that does anything. Drive it.

```bash
lsof -ti tcp:8799 | xargs -r kill -9
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(scores): choose which teams to follow"
```

---

## Task 4: The shared presentation core

**Files:**
- Create: `renderer/main/score-ink.ts`
- Create: `renderer/main/score-ink.test.ts`
- Create: `renderer/main/score-center.tsx`
- Create: `renderer/main/score-strip.tsx`
- Modify: `renderer/styles.css`

**Interfaces:**
- Consumes: `ScoreGameDTO`, `ScoreSituation`.
- Produces: `inkFor(hex)`, `contrastRatio(a,b)`, `ScoreCenter`, `ScoreStrip`.

This task builds the pieces every surface shares. Tasks 5, 6 and 7 compose them at three sizes. Building it once is the whole reason the mockup uses the same `.side` / `.mid` markup in the single-game panel and in the stack cards — Henry, on a scaled-down variant: *"dont do that."*

- [ ] **Step 1: Write `renderer/main/score-ink.ts` and its test**

```ts
// score-ink.ts — readable text over a team's own colour.
//
// ESPN's colours are brand colours picked for contrast against ESPN's chrome,
// not ours. A near-white alternateColor ("ffffff" was observed on an NFL team)
// with white text on it is unreadable, so the ink is CHOSEN per colour by
// relative luminance rather than fixed.
//
// WCAG 2.1 relative luminance and contrast ratio, which is the only definition
// of "readable" that is not a guess.

/** sRGB relative luminance, WCAG 2.1 §relative-luminance. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Near-black rather than pure black: pure black on a mid brand colour reads as
 *  a hole, and the app's own dark ink is this value. */
export const INK_DARK = "#0a0a0a";
export const INK_LIGHT = "#ffffff";

/** Whichever of the two inks contrasts better against this team's colour. */
export function inkFor(hex: string | null): string {
  if (!hex) return INK_LIGHT;
  return contrastRatio(hex, INK_LIGHT) >= contrastRatio(hex, INK_DARK) ? INK_LIGHT : INK_DARK;
}

/** The ink at reduced strength, for a logo chip's fill behind the team colour. */
export function inkSoft(ink: string): string {
  return ink === INK_LIGHT ? "rgba(255,255,255,.93)" : "rgba(10,10,10,.9)";
}
```

The test must assert, with the real colours from the mockup:

```ts
test("a near-white team colour gets dark ink", () => {
  assert.equal(inkFor("#ffffff"), INK_DARK);
  assert.equal(inkFor("#b4975a"), INK_DARK); // Vegas gold
});
test("a dark team colour gets light ink", () => {
  assert.equal(inkFor("#0e3386"), INK_LIGHT); // Cubs blue
  assert.equal(inkFor("#0b162a"), INK_LIGHT); // Bears navy
});
test("every ink choice clears 4.5:1", () => {
  for (const c of ["#c6011f", "#0e3386", "#ffb612", "#0b162a", "#fdb927", "#007a33", "#6f263d", "#b4975a", "#003087", "#bd3039", "#ffffff", "#000000"]) {
    assert.ok(contrastRatio(c, inkFor(c)) >= 4.5, `${c} → ${inkFor(c)} is ${contrastRatio(c, inkFor(c)).toFixed(2)}:1`);
  }
});
test("no colour is a colour, and gets light ink over the neutral surface", () => {
  assert.equal(inkFor(null), INK_LIGHT);
});
```

**Prove it:** temporarily make `inkFor` return `INK_LIGHT` unconditionally and watch the 4.5:1 test go red naming Vegas gold. Record in the commit.

- [ ] **Step 2: Add the colour feather to `renderer/styles.css`**

```css
/* Live scores — a team's colour fading toward the centre of a card.
 *
 * A MASK, not a gradient in the background. Fading a colour to `transparent`
 * interpolates toward transparent BLACK, which leaves a faint dark shoulder just
 * before it disappears — visible as a hard-ish edge at the very end however many
 * stops you add. A mask interpolates ALPHA only, so the hue never shifts and the
 * tail actually reaches nothing.
 *
 * The stops approximate an ease-out: most of the fade happens early and the last
 * stretch is nearly flat, which is what removes the visible "start of the fade".
 * Solid across the left 42% — where the logo and the number sit — so the ink
 * contrast score-ink.ts computes is against the real brand colour.
 *
 * The mask goes on a BACKGROUND LAYER, never on the element: masking the element
 * fades its CONTENT too, which made the scores near the seam hard to read. The
 * colour is a pseudo-element; the text rides above it on z-index 1.
 *
 * These are strictly per-side fills. A team colour never tints a neutral dark
 * surface — see the R=G=B rule.
 */
:root {
  --score-feather-r: linear-gradient(to right, #000 0%, #000 42%, rgba(0,0,0,.92) 55%, rgba(0,0,0,.74) 66%, rgba(0,0,0,.5) 76%, rgba(0,0,0,.28) 85%, rgba(0,0,0,.12) 92%, rgba(0,0,0,.04) 97%, transparent 100%);
  --score-feather-l: linear-gradient(to left,  #000 0%, #000 42%, rgba(0,0,0,.92) 55%, rgba(0,0,0,.74) 66%, rgba(0,0,0,.5) 76%, rgba(0,0,0,.28) 85%, rgba(0,0,0,.12) 92%, rgba(0,0,0,.04) 97%, transparent 100%);
  /* Restrained overshoot, only where the motion means "something just happened". */
  --score-spring: cubic-bezier(.22, 1.06, .36, 1);
}

.score-side { position: relative; isolation: isolate; }
.score-side::before { content: ""; position: absolute; inset: 0; z-index: 0; background: var(--score-team); }
.score-side > * { position: relative; z-index: 1; }
.score-side-away::before { -webkit-mask-image: var(--score-feather-r); mask-image: var(--score-feather-r); }
.score-side-home::before { -webkit-mask-image: var(--score-feather-l); mask-image: var(--score-feather-l); }
```

- [ ] **Step 3: Write `renderer/main/score-center.tsx`**

The per-sport centre. Henry: *"obviously the center section would need to change based on sport (baseball, football, basketball, etc) and the metrics shown."*

```tsx
// score-center.tsx — what is happening right now, in this sport's own terms.
//
// A bases diamond in a basketball game is nonsense and a down-and-distance line
// means nothing in the ninth inning, so this is a switch over the situation's
// discriminant rather than one shape wearing different labels.
//
// The DEFAULT arm is not a fallback nobody hits — it is the normal case for any
// sport whose situation ESPN did not send, and for every sport this app has not
// specialised. It draws status.shortDetail, which ESPN has already formatted
// per sport, so an unspecialised sport still reads correctly.
```

Four arms plus a default:

- **baseball** — period label, a bases diamond, an outs row, a balls-strikes count. The diamond is a **2x2 grid rotated 45deg**, not a three-cell row: a row rotated 45deg puts third base on a diagonal. Rotating a 2x2 puts top-left at the top and bottom-left at the left, so the cells read 2nd, 1st, 3rd, and the fourth (home) is `visibility: hidden`.
- **football** — period label, clock, down and distance composed as `${ordinal(down)} & ${distance}`.
- **basketball** — period label, clock.
- **hockey** — period label, clock.
- **default** — `shortDetail` alone.

Fixed frame, **not** a clamped centre. From the mockup: clamping the centre is what clipped the count and the bonus label. The strip's minimum height is set by the tallest centre any sport produces — baseball's four rows — with real padding, and the centre composes inside it. `min-height: 80px` on the strip, no `max-height` on the centre.

- [ ] **Step 4: Write `renderer/main/score-strip.tsx`**

Away side, centre, home side, at one size.

```tsx
export function ScoreStrip({ game, size }: { game: ScoreGameDTO; size: "compact" | "full" }) { … }
```

Rules from the mockup, each of which was a fix:

- The home side is `flex-direction: row-reverse`, so the two sides mirror.
- **Full team names**, not abbreviations. Henry: *"I think we have enough room to have full team names instead of just GB or CHC or LAL."* `team.name` ("Cubs") is what a card shows; `abbreviation` survives only in the logo chip and in the context-bar capsule, where width is genuinely scarce.
- The record sits under the name in mono at reduced opacity.
- The score is mono, tabular-nums, and scales with the container on a wall display via the existing `ctx.H` fraction idiom — a fixed pixel size is unreadable at 20 feet and enormous at desk distance.
- The logo is an `<img>` with the team's abbreviation as its `alt`, so a blocked CDN degrades to readable text rather than a hole.

- [ ] **Step 5: Verify in a browser at both sizes, then commit**

Render the strip standalone at 320px and at 1280px wide. Confirm nothing clips at either, that the baseball diamond reads as a diamond with third base on the left, and that a team with a near-white colour has dark ink.

```bash
git commit -m "feat(scores): one score strip, at every size, with the centre each sport actually needs"
```

---

## Task 5: The context bar capsule and the Live Activity

**Files:**
- Create: `renderer/app/score-activity-store.ts`
- Create: `renderer/app/score-activity.tsx`
- Create: `renderer/app/score-activity.test.tsx`
- Modify: `renderer/app/bar-items.tsx`
- Modify: `renderer/app/context-bar.tsx`
- Modify: `renderer/styles.css`

**Interfaces:**
- Consumes: Task 4's `ScoreStrip`, `ScoreCenter`, `inkFor`; Task 2's `useScoresState`.
- Produces: the `"scores"` `BarItemId`, `ScoreActivityHost`, the activity store.

This is the surface Henry chose over a toast. Read the mockup before starting.

- [ ] **Step 1: Add the bar item**

`renderer/app/bar-items.tsx`:

```ts
export type BarItemId =
  | "clock"
  | "plan"
  | "live-timer"
  | "current-item"
  | "integration-health"
  | "recording"
  | "streaming"
  | "scores";
```

and in `BAR_ITEMS`:

```ts
  scores: {
    id: "scores",
    label: "Live scores",
    icon: TrophyIcon,
    hint: "A followed team's score. Click it for the full card.",
  },
```

`BarItemId` is a union and `BAR_ITEMS` is a `Record` keyed by it, so the entry is compiler-enforced. It appears in the right-click configurator's palette automatically — Henry: *"it also needs to be added to the operator context bar editor that you get to by a right click that allows me to put it anywhere."* No configurator edit is needed; verify that in step 7 rather than assuming it.

Do **not** add it to `DEFAULT_BAR_ORDER`. Like integration health and recording, it is opt-in rather than added to everyone's bar without asking.

- [ ] **Step 2: Write `renderer/app/score-activity-store.ts`**

```ts
// score-activity-store.ts — whether the activity is open, and which card has focus.
//
// A module-level store rather than state threaded through BarItemContext.
//
// renderBarItem is a pure (id, ctx) => ReactNode and context-bar.test.tsx asserts
// it never returns null for any id. Putting open/focus state into the context
// object every item reads would put UI state in a data structure whose whole job
// is to carry readings. This is the same shape toast.tsx already uses, and it is
// why toast.x() works from non-React modules.

import { useSyncExternalStore } from "react";

interface ActivityState {
  open: boolean;
  /** Index into the stack. 0 when only one game is live. */
  focus: number;
  /** The rev the panel last auto-opened for, so one score opens it once. */
  seenRev: number;
}

let state: ActivityState = { open: false, focus: 0, seenRev: 0 };
const subscribers = new Set<() => void>();

function publish(next: ActivityState): void {
  state = next;
  // Iterate a copy: a subscriber that unsubscribes during publish would
  // otherwise mutate the set being walked.
  for (const fn of [...subscribers]) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function useScoreActivity(): ActivityState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

let holdTimer: ReturnType<typeof setTimeout> | null = null;

/** How long an auto-opened activity stays up before folding away by itself. */
const HOLD_MS = 6500;

function clearHold(): void {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
}

export const scoreActivity = {
  /**
   * Open or close by hand.
   *
   * A hand-driven open OWNS the panel from that moment: it cancels any hold left
   * over from a score, so a tap to dismiss is never undone two seconds later by
   * a timer the operator cannot see.
   */
  toggle(): void {
    clearHold();
    publish({ ...state, open: !state.open });
  },
  close(): void {
    clearHold();
    publish({ ...state, open: false });
  },
  focus(i: number): void {
    clearHold();
    publish({ ...state, focus: i, open: true });
  },
  /**
   * A score arrived. Opens, and folds away on its own.
   *
   * Guarded on `rev` so one score opens it once: the DTO is re-delivered to every
   * late SSE subscriber from the hello burst, and without this a page opened five
   * minutes after a touchdown would pop the panel as if it had just happened.
   */
  scored(rev: number, focus: number): void {
    if (rev === state.seenRev) return;
    clearHold();
    publish({ open: true, focus, seenRev: rev });
    holdTimer = setTimeout(() => publish({ ...state, open: false }), HOLD_MS);
  },
  /** Seed `seenRev` without opening — used on first mount so a page loaded long
   *  after a score does not animate a stale one. */
  seed(rev: number): void {
    if (state.seenRev === 0) publish({ ...state, seenRev: rev });
  },
};
```

- [ ] **Step 3: Render the capsule in `renderBarItem`**

Add a `case "scores"` to the switch in `renderer/app/context-bar.tsx`. It must **never return null** — `context-bar.test.tsx:149` iterates `Object.keys(BAR_ITEMS)` and asserts every id renders something in three different states, so this guard is free the moment the id exists.

Idle states, in order:
- no favourites configured → `<Idle>No teams</Idle>`
- favourites but no game today → `<Idle>No games</Idle>`
- a game today, not started → `<Idle>{shortDetail || "Scheduled"}</Idle>`
- a live game → the capsule

The capsule, from the mockup: a real `<button>` (it is one — Henry: *"obviously i would also want it to expand/close on pointer click"*), `aria-expanded` bound to the open state, containing away logo + score, the centre's short label, home score + home logo, with the feathered team colour on each side.

**Logos only, no city names.** Henry: *"the context bar doesn't need the team city name, I think we can just rely on logos so that it gets a little smaller."*

- [ ] **Step 4: Write `renderer/app/score-activity.tsx`**

The panel and the stack. This is where the mockup's timings are law.

```tsx
// score-activity.tsx — the score card that grows out of the context-bar capsule.
//
// THE COLOUR IS NOT ANIMATED. It is painted at full strength from the first
// frame and scales with the shell.
//
// Three earlier passes gave the coloured sides their own opacity and transform,
// and every one of them read as the box "clipping" on the way open: an outline
// that had already landed with colour still travelling inside it. It was never a
// race on opacity — it was a second, slower animation running inside a shell that
// had already arrived. There is now ONE moving object. The shell's own scale IS
// the expansion.
//
// The one exception is the centre, and it is deliberately neutral-coloured:
// staggering grey text reads as detail settling, not as the panel filling in.
```

Structure and CSS, taken from the mockup:

```css
/* The host clips; the shell scales. Height leads on the way in and trails on the
   way out, so the panel is never clipped mid-flight in either direction. */
.score-host { display: grid; grid-template-rows: 0fr; transition: grid-template-rows 620ms var(--ease) 60ms; }
.score-host.is-open { grid-template-rows: 1fr; transition: grid-template-rows 560ms var(--score-spring); }
.score-clip { overflow: hidden; }

/* Origin is the top, so growth pushes downward from where the capsule sits.
   Closing is the same sequence reversed — an exit that behaves differently from
   the entrance reads as two unrelated animations. */
.score-shell {
  transform-origin: top center;
  opacity: 0; transform: translateY(-10px) scaleY(.68) scaleX(.86);
  transition: opacity 260ms var(--ease), transform 300ms var(--ease);
}
.score-host.is-open .score-shell {
  opacity: 1; transform: none;
  transition: opacity 300ms var(--ease), transform 620ms var(--score-spring);
}
.score-host .score-mid { opacity: 0; transition: opacity 150ms var(--ease); }
.score-host.is-open .score-mid { opacity: 1; transition-delay: 170ms; }
```

The **wallet stack**, for several games at once. Henry: *"if i expand the live activity maybe have it show a stack of all of the current games? … Could maaaybe even do an apple wallet style where they are stacked like that and if i click (focus) one it animates to the top of the stack?"*

Cards are absolutely positioned and moved by `transform` only, so focusing one animates on the compositor rather than reflowing the page under it. Only the container's height animates in layout, driven from the same numbers, so the two cannot disagree.

```ts
// Measured, never assumed. And measured on the card's BODY CONTENT, never on the
// grid item being animated: the body is the item of a row going 0fr -> 1fr, so
// reading it at the instant focus changes returns the height it is LEAVING, not
// the one it is going to. That placed every later card as though the focused one
// had no body, and let the open panel paint over the card beneath it — which is
// a card the operator then cannot click.
//
// The strips are normalised first: a four-row baseball centre and a two-row
// hockey centre would otherwise sit at visibly different heights in one stack.
// Read every height, then write every height — reading back inside the loop that
// is also writing would thrash layout once per card.
function layoutStack(cards: HTMLElement[], focus: number): number {
  const tops = cards.map((c) => c.querySelector<HTMLElement>("[data-score-strip]")!);
  for (const t of tops) t.style.height = "";
  const tallest = tops.reduce((m, t) => Math.max(m, t.offsetHeight), 0);
  for (const t of tops) t.style.height = `${tallest}px`;

  let y = 0;
  cards.forEach((c, i) => {
    const body = i === focus ? c.querySelector<HTMLElement>("[data-score-body]")!.offsetHeight : 0;
    c.style.transform = `translateY(${y}px)`;
    c.style.zIndex = String(i === focus ? 5 : 1);
    y += tallest + body + GAP;
  });
  return y - GAP;
}
```

**Cards are full size in the stack, never scaled down.** Henry: *"it looks like you scaled it down. dont do that."* The stack reuses `ScoreStrip` at the same size as the single-game panel — a shrunken variant would be a second set of dimensions to keep in step, and the scores are the thing you are reading.

Dismissal, all four routes, each cancelling the hold timer:
- tapping the capsule toggles
- a `pointerdown` anywhere outside the capsule and the panel closes. Bound on the **document**, not on a scrim — Henry: *"tapping anywhere else on the page should also close the activity too"* — because a transparent full-bleed scrim is hit-tested above the page and would swallow the first press on whatever is underneath, and on a console that press is usually the thing the operator actually reached for. (This is the exact mistake the multiview expand overlay made and corrected; see that ledger.)
- Escape, with focus returned to the capsule
- the 6.5s hold, on an auto-open only

**Reduced motion:** check `window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false` explicitly and skip the JS-driven `transform` entirely, placing cards at their final offsets. The global CSS override at `styles.css:367` collapses `transition-duration` but cannot reach an inline `transform` set from JS. A score arriving is **involuntary** motion the viewer did not initiate, which is the category this setting exists for most strongly.

- [ ] **Step 5: Mount the host in `ContextBar`**

`ContextBar` returns a fragment today. Add the activity host after the `<header>`, rendered only when `rows` includes `"scores"` — the panel belongs to the item, so a bar without the item has no panel.

- [ ] **Step 6: Write `renderer/app/score-activity.test.tsx`**

Guards, each with proof:

1. **One score opens the panel once.** Call `scored(5, 0)` twice; assert the second is a no-op. Proof: delete the `rev === state.seenRev` guard and watch it go red.
2. **A hand-driven toggle cancels the hold.** `scored(...)` then `toggle()`; advance fake timers past 6500ms; assert the panel is still in the state the operator left it. Proof: remove `clearHold()` from `toggle` and watch the panel close under the test.
3. **`seed` does not open.** Proof: make `seed` publish `open: true` and watch it go red.
4. **Every `BarItemId` still renders.** Already covered free by `context-bar.test.tsx:149` — confirm it now iterates 8 ids, not 7, and say so.

Note honestly in the test file what is **not** guarded here: the CSS mask living on the pseudo-element rather than the element, and the stack's measured heights, are both invisible to jsdom — it loads no stylesheet, so `getComputedStyle` sees Tailwind defaults, and `offsetHeight` is always 0. A test asserting them would pass on the bug. Step 7 is the verification for those, and the file says so rather than shipping a guard that cannot fail.

- [ ] **Step 7: Drive the real thing**

```bash
STAGE_UTILITY_DATA=/tmp/stage-scores-test npm run server &
npm run dev
```

Right-click the context bar → Configure bar → drag "Live scores" in. Then, against a live game (or a doctored fixture served by a temporary route):

- [ ] the capsule shows two logos and two scores and no city names
- [ ] clicking it opens the panel; clicking again closes it
- [ ] the colour and the outline arrive **together** — no stage where an empty outline is at full size with colour still moving
- [ ] closing is the entrance reversed, not a different animation
- [ ] with several live games, expanding one **pushes the ones below it down**; every card underneath stays clickable
- [ ] all four cards in a stack are the same height whatever mix of sports
- [ ] nothing in a centre is clipped or touching its boundary — check a baseball card specifically, it has the tallest centre
- [ ] a press anywhere else on the page closes it, and the thing you pressed still receives that press
- [ ] Escape closes it and focus returns to the capsule
- [ ] with `prefers-reduced-motion: reduce` set in the OS, the panel appears in its final state and does not travel

```bash
lsof -ti tcp:8799 | xargs -r kill -9
```

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(bar): a score capsule that grows into a live activity, and folds back the same way"
```

---

## Task 6: The custom layout object

**Files:**
- Modify: `main/types/views.ts`
- Modify: `main/types/object-capabilities.ts`
- Modify: `main/types/readout-types.ts`
- Modify: `renderer/main/layout-objects.ts`
- Modify: `renderer/main/layout-renderer.tsx`
- Create: `renderer/main/scores-object.tsx`
- Modify: `renderer/editor/palette.tsx`
- Modify: `renderer/editor/inspector.tsx`
- Modify: the five exact-count test files listed in Global Constraints
- Modify: `docs/reference/widgets.md`

- [ ] **Step 1: Add `scores` to the config union in `main/types/views.ts`**

```ts
  | {
      type: "scores";
      /** Which followed game this object shows. `"auto"` follows whichever
       *  followed game is live, preferring the one that scored most recently —
       *  which is what a wall display wants, since nobody is there to pick. */
      game: "auto" | string;
      /** Show the sport-specific centre, or just the score and the status. */
      detail?: boolean;
    }
```

Adding the member breaks five or more files until they follow. That is the design: `LayoutObjectType` is derived from this union and `CAPABILITIES`, the palette `ICONS` map and `LAYOUT_OBJECTS` are all `Record<LayoutObjectType, …>`, with a `const _never: never` at the end of the render switch.

- [ ] **Step 2: Follow the compiler**

`npx tsc --noEmit` and fix each error in turn: a `CAPABILITIES` entry (`readout`, and `drilldown` only if a `DRILLDOWN` route is added — a test asserts both directions, so do not declare one without the other), `IDIOM_TYPES` if it uses the shared caption/value/sub idiom (it does not — it has its own layout), the `LayoutObjectSpec`, the render `case`, the palette icon.

The `blurb` is asserted: non-empty, at most 60 characters, sentence case, no trailing period, and different from the label. `"Live score for a team you follow"` is 32.

The spec carries `integration: { id: "scores", label: "Live scores" }` so the palette card is dimmed until the integration is set up.

- [ ] **Step 3: Gate the data hook**

In `useLayoutData` in `renderer/main/layout-renderer.tsx`, gate `useScoresState` behind `want(["scores"])` so the hook does not run for layouts that do not use it. This is the existing efficiency idiom and it is the thing that makes an unused integration free on a nine-tile wall.

Verify the gate actually works: put a scores object inside an embedded view and confirm the hook still runs. `collectLayoutTypes` descends into embedded layouts (that was fixed on `feat/multiview`); if this branch is off `beta` and that fix is not in it, the gate must be checked against a **direct** placement and the embedded case noted as covered once #346 merges.

- [ ] **Step 4: Write `renderer/main/scores-object.tsx`**

Its own file, like `osc-button.tsx` — this is non-trivial and it composes Task 4's pieces at wall scale.

Selection when several games are live, from the mockup's rotate behaviour: `game: "auto"` picks the game whose `rev`-bearing event is most recent, falling back to the earliest start. Pinning a specific `eventId` is not offered, because an event id is a per-day value that means nothing next week; the inspector offers **the team**, and the object resolves that team's live game.

- [ ] **Step 5: Add the inspector block**

A flat `{c.type === "scores" && (…)}` block in `renderer/editor/inspector.tsx` using the existing `Row` / `RowSelect` / `RowSwitch` helpers: a team select populated from the configured favourites (plus an "Any followed team" option for `"auto"`), and a "Show sport detail" switch.

The select lists **only configured favourites**, with an inline link to Settings when there are none. An object offering all 122 teams while the integration follows three would be a control that silently does nothing.

- [ ] **Step 6: Move every exact count**

The five assertions in the Global Constraints table, `ADDED_SINCE` in `layout-objects.test.ts`, and a `| **Live scores** | … |` row in `docs/reference/widgets.md` (`widget-docs.test.ts` matches bolded labels exactly, in both directions).

- [ ] **Step 7: Run the browser overflow sweep**

`renderer/main/object-fit.test.ts:26`'s comment asks for it before bumping the count. Place the object on a canvas at its default `0.3 x 0.16` and at a full-width tile, on a 1920x1080 display, and confirm nothing overflows its box at either.

- [ ] **Step 8: Full suite, then commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git commit -m "feat(layout): a live score object for a wall, at wall distance"
```

---

## Task 7: The Home card

**Files:**
- Modify: `main/types/views.ts`
- Modify: `renderer/main/layout-objects.ts`
- Modify: `renderer/app/home/cards.tsx`
- Modify: `renderer/main/object-look.test.ts`
- Modify: `renderer/app/home/home-card-routing.test.ts`
- Modify: `docs/reference/widgets.md`

There is no separate Home card registry — a Home card is an ordinary layout object whose type begins `home-` (`renderer/app/home/cards.tsx:36`). Most of the work is shared with Task 6.

- [ ] **Step 1: Add `home-scores` to the union**

```ts
  | { type: "home-scores"; size?: HomeCardSize; when?: HomeVisibility }
```

- [ ] **Step 2: The spec, and `HOST_FRAMED_TYPES`**

`homeSize: "m"`. Add `home-scores` to `HOST_FRAMED_TYPES` in `renderer/main/layout-objects.ts` so it is frameless on Home and framed on a wall, and add it to `BARE` in `object-look.test.ts` in the same edit — that list is asserted equal to `HOST_FRAMED_TYPES`, so they move together or the suite fails.

- [ ] **Step 3: `homeWhen`, and the decision behind it**

Research §4.1 asked whether scores should be suppressed during a service, and noted `HomeVisibility` already answers it declaratively.

**The default is `"always"`**, and here is why rather than the safer-sounding alternative: Sunday afternoon NFL overlaps the second service in most US churches, so `"idle"` as a default would mean the feature never fires on the day it exists for — the silent-uselessness failure `integration-base.ts`'s `inDemand` comment is a cautionary tale about. The operator's own Home page is not stage-facing, and the operator chose to add the card.

The setting stays available: `when` is on the config, so an operator who wants it gone mid-service sets it to `"idle"` in the card's own settings. The **wall display** case is different and is handled the other way round — a scores object only appears on a wall if someone deliberately placed it there.

- [ ] **Step 4: The component and the two registration points**

The card body in `renderer/app/home/cards.tsx`, the key in `HOME_CARD_TYPES` (`:59`), and the `case` in the `HomeCard` switch (`:642`). Both fail to compile if skipped. `layout-renderer.tsx` needs no edit — `isHomeCard(c)` at `:689` intercepts before the switch.

Show up to three followed games, each as a compact `ScoreStrip`; a footer line carrying the leading game's `detail`. Trailing teams render at reduced opacity, matching the mockup.

- [ ] **Step 5: Move the counts, drive it, commit**

`HOME_TYPES.length` 12 → 13; `object-look`'s `all` 54 → 56 and `BARE` grown by one (both moved in Task 6's step 6 if the two tasks are committed together — check, do not assume).

Drive it: add the card on Home, confirm it renders with real followed teams, confirm it survives a reload, and confirm setting `when: "idle"` hides it while a plan item is live.

```bash
git commit -m "feat(home): followed scores on the operator's own page"
```

---

## Task 8: Docs

**Files:**
- Create: `docs/integrations/scores.md`
- Modify: `docs/integrations/README.md`
- Modify: `docs/reference/widgets.md`
- Modify: `docs/reference/api.md`

- [ ] **Step 1: Write `docs/integrations/scores.md`**

Match the voice of `docs/integrations/reaper.md`: concise reference for a stranger on GitHub, not a narrative of how this was built and not a changelog. Cover what it connects to, what it needs (nothing — no key, no account), how to choose teams, which surfaces show it, and the polling behaviour.

Say plainly, because an operator deserves to know: this uses an **undocumented public API with no contract**. ESPN can change or withdraw it without notice, there is no support channel, and heavy polling may get an IP blocked. The app polls on a schedule for exactly that reason.

- [ ] **Step 2: The index row and the API reference**

A row in `docs/integrations/README.md`, and the four IPC methods in `docs/reference/api.md` beside the other integration status endpoints.

- [ ] **Step 3: Check nothing else went stale**

```bash
grep -rn "integration" docs/ | grep -i "seven\|eight\|nine\|fourteen\|fifteen" | head
```

A doc that counts the integrations is now wrong. Fix any it finds.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: live scores"
```

---

## Before the PR

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` — full suite green, and the count moved by the number of tests this branch added
- [ ] `npm run lint` clean
- [ ] Three review passes: correctness, simplification, whole-PR. Fix what they find before opening; if you disagree with a finding, say why — do not silently skip it.
- [ ] Every guard in this branch proven red in-session against the bug it guards, and each proof named in its commit
- [ ] `grep -rn "scores" main/services/*.ts renderer/**/*.ts* | grep -i "todo\|fixme"` returns nothing
- [ ] No emojis anywhere in the diff: `git diff origin/beta... | grep -P "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]"` returns nothing
- [ ] No Claude attribution in any commit message or in the PR body

---

## Self-Review

**Spec coverage.** Every element of the mockup maps to a task: the capsule and its logos-only treatment (5.3), the feathered colour with the mask on the pseudo-element (4.2), WCAG ink selection (4.1), the per-sport centre with the correctly-oriented bases diamond (4.3), full team names (4.4), the single-object expand animation with no second animation inside it (5.4), the wallet stack with measured, normalised heights (5.4), all four dismissal routes (5.4), reduced motion (5.4), placement via the existing bar configurator (5.1), the layout object (6), the Home card (7). The research doc's registration chain is Task 2 step 8, item by item.

**Deliberately not built, each with a reason stated where it matters:**

- *The toast.* Replaced by the context-bar capsule at Henry's direction. `toast.tsx` is untouched.
- *The composed pitch-by-pitch sentence* from the original screenshot ("Kevin Gausman throws 80 mph slider outside…"). Research §1.4 established it is not a field in any endpoint — ESPN composes it client-side. Reconstructing it costs a 752 KB per-game request. The scoreboard's own `situation.lastPlay.text` is free but terse ("Pitch 3 : Ball 2"). **Neither ships here.** The activity shows score, status and the sport centre; the play line is a follow-up worth costing separately, and building it on a guess about phrasing would be our prose presented as ESPN's.
- *NFL possession.* **Now built, not omitted.** A live football payload probed after the research doc was written confirms `situation.possession` is a bare team id string ("23"), agreeing with `drives.current.team.id` on the summary endpoint. `shortDownDistanceText` ("3rd & 10") is preferred over `downDistanceText` ("3rd & 9 at SJSU 28"), whose field position the centre has no room for. Two traps are guarded by tests: `possessionText` is the ball's FIELD POSITION and matches no team id, and `lastPlay.start.team.id` names the kicking team between a kickoff and the first snap. Possession is absent (not null) in some states and is rendered as nothing when null. **Caveat carried into `docs/integrations/scores.md`:** every football observation is from `football/college-football`, because no NFL game was live on the capture date — the NFL shares the sport shape and situation keys, so this is strong evidence, not proof, and wants a spot-check against a live regular-season NFL game.
- *Soccer, college.* The leagues table takes a row plus a fixture. Four leagues ship; the shape is built for more.
- *Any shared search-popover primitive.* The plan proposed extracting one; Henry overruled it and the picker is bespoke. The four existing copies are untouched, and this is knowingly the fifth. See the decision in File Structure.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries the code. The three places that say "find that line" (`stores.ts`, the IPC handler registration, the integrations group table) name the file and the neighbouring symbol, because the line number will have drifted.

**Type consistency.** `ScoreFavourite` is used identically by the store, the service's `listTeams` and the picker. `ScoreGameDTO` flows unchanged from `parseScoreboard` through `ScoresStatusDTO` to all four surfaces. `inkFor` takes `string | null` because `ScoreTeamDTO.color` is nullable. `nextPoll` takes `readonly ScoreGameDTO[]` matching what `sortGames` returns.

**One risk this plan does not remove.** ESPN's endpoints have no contract. The parser degrades rather than throws, a failure reaches the operator instead of being logged, and the last known scores are kept and marked stale rather than blanked. But if ESPN withdraws the endpoint, the feature stops, and no amount of care here prevents that. That is worth Henry knowing before the first commit, not after.
