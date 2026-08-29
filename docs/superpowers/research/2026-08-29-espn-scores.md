# Live sports scores via ESPN's public API — research

Date: 2026-08-29
Status: research only. Nothing implemented, no decisions made.
Scope: a scores feature appearing three ways — a custom-layout object, a Home
card, and a toggleable "something scored" toast styled after Apple Live
Activities — with team/sport selection via a searchable dropdown.

Every ESPN endpoint, field name and size in this document was fetched live on
2026-08-29 and is quoted from the real response. Where I could not verify
something I say so under [Unverified](#unverified) rather than guessing.

Community reference used, as instructed: <https://github.com/pseudo-r/Public-ESPN-API>.
It was accurate about base URLs and about there being no published rate limit. It
does **not** document the multi-sport header endpoint or the scoring-event fields
below — those I established by fetching.

---

## 1. What the API actually gives you

### 1.1 The scoreboard endpoint

```
GET https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
```

Verified: `baseball/mlb`, `football/nfl`, `hockey/nhl`, `soccer/eng.1`.
Optional params: `dates=YYYYMMDD` (or a range), `seasontype`, `limit`, `groups`.

Response envelope:

```
{ day, events[], leagues[], provider, season }
```

`events[]` → each event:

```
{ id, uid, date, name, shortName, status, competitions[], links, weather, season }
```

`events[].competitions[0]` carries the substance:

```
{ id, uid, date, startDate, status, competitors[], situation, venue,
  broadcasts[], outsText, playByPlayAvailable, leaders[], notes[], type, ... }
```

No authentication. `access-control-allow-origin: *` on the JSON.

### 1.2 One request per league, or one for several?

**For a chosen set of favourites: one request per league.** There is no parameter
on the scoreboard endpoint that takes a league list.

There *is* a multi-sport endpoint, which I found by probing rather than from the
community docs:

```
GET https://site.api.espn.com/apis/v2/scoreboard/header
```

Called bare it returned, in a single response, everything ESPN chose to feature
that day:

| Sport | Leagues returned |
|---|---|
| Football | NCAAF, NFL |
| Golf | PGA, LPGA |
| Baseball | MLB, Little League Baseball World Series |
| Basketball | WNBA |
| Soccer | Premier League, LALIGA, Bundesliga, MLS, NWSL, Serie A |

The catch that disqualifies it as a general solution: **you cannot choose the
leagues.** It is ESPN's editorial/seasonal featured set. NBA and NHL were absent
from the bare call on 2026-08-29 because they are out of season, yet both were
reachable individually. It accepts `?sport=&league=` to narrow to exactly one
league (`?sport=hockey&league=nhl` → NHL only, 7 events), but a list form does
not work — `?leagues=nfl,mlb` returned nothing parseable.

So the header endpoint is a *sometimes* optimisation, not an architecture. If the
operator's favourites happen to fall inside ESPN's featured set it is one request
instead of N; the moment he follows an out-of-season or unfeatured league it
silently returns nothing for that league. **Recommendation for a plan: treat it
as one request per followed league, and only consider the header endpoint as a
later optimisation with an explicit fallback.**

Wire cost, measured with gzip (Node's `fetch` sends `Accept-Encoding: gzip` and
decompresses automatically):

| Endpoint | Uncompressed | On the wire (gzip) |
|---|---|---|
| MLB scoreboard | 330,490 B | **26,622 B** |
| NFL scoreboard | 283,159 B | **24,012 B** |
| header (all featured sports) | 789,069 B | **64,340 B** |

26 KB per league per poll is comfortable for a Pi on a church LAN. The
uncompressed figure is the misleading one; do not plan against it.

### 1.3 Identifying a team stably

The scoreboard's `competitors[].team` gives:

```json
{
  "id": "10",
  "uid": "s:1~l:10~t:10",
  "location": "New York",
  "name": "Yankees",
  "abbreviation": "NYY",
  "displayName": "New York Yankees",
  "shortDisplayName": "Yankees",
  "color": "132448",
  "alternateColor": "c4ced4",
  "isActive": true,
  "logo": "https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/nyy.png"
}
```

The `/teams` endpoint adds a `slug`:

```
GET https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams
→ .sports[0].leagues[0].teams[] (30 for MLB)
  { id: "29", uid: "s:1~l:10~t:29", slug: "arizona-diamondbacks",
    abbreviation: "ARI", displayName: "Arizona Diamondbacks",
    location: "Arizona", color: "aa182c", logos: [16 entries] }
```

**Store the favourite as `{ league, teamId }`** — `id` is ESPN's numeric primary
key and is what every other payload cross-references (`situation.pitcher.athlete.team.id`,
`lastPlay.team.id` are all bare ids). `uid` (`s:1~l:10~t:10`) encodes
sport/league/team and is equally stable but is a compound string you would have
to parse.

Do **not** key on `abbreviation` or `displayName`: abbreviations are only unique
within a league, and both change on relocation/rebrand — exactly the season
rollover the operator is worried about. `slug` is human-readable but is derived
from the display name, so it moves when the name does.

A saved favourite should therefore be `{ league: "mlb", teamId: "10" }` plus a
cached `displayName`/`abbreviation` for rendering the settings row before the
first successful fetch. Re-resolve the display fields from `/teams` on each
season start; the id is the thing that survives.

### 1.4 A single game's payload

Taken from a live game (id `401874913`, BOS @ NYY, "Top 7th") on the MLB
scoreboard.

**Status** — `events[].status`:

```json
{
  "clock": 0.0,
  "displayClock": "0:00",
  "period": 7,
  "type": {
    "id": "2", "name": "STATUS_IN_PROGRESS", "state": "in",
    "completed": false, "description": "In Progress",
    "detail": "Top 7th", "shortDetail": "Top 7th"
  }
}
```

`status.type.state` is the three-way the UI should switch on: `"pre"`, `"in"`,
`"post"`. `status.type.name` is the finer enum. States observed live in one MLB
payload: `STATUS_SCHEDULED` (`pre`), `STATUS_IN_PROGRESS` (`in`), **and
`STATUS_DELAYED`, which also reports `state: "in"`** — a rain delay is not a
separate state, so a display keying only on `state` will show a delayed game as
live. `detail`/`shortDetail` are the pre-formatted human strings ("Top 7th",
"4:47 - 3rd Quarter", "4:47 - 3rd") and are the cheapest correct thing to render
— they are already sport-appropriate, so you do not need per-sport period logic
to show *something*.

**Score, home/away, colours, logos** — `competitions[0].competitors[]`:

```json
{
  "id": "10", "homeAway": "home", "order": 0,
  "team": { ...as §1.3... },
  "score": "0",
  "linescores": [ { "value": 0.0, "displayValue": "0", "period": 1 }, ... ],
  "statistics": [ {"name":"hits","abbreviation":"H","displayValue":"3"}, ... ],
  "hits": 3, "errors": 1,
  "records": [ {"name":"overall","type":"total","summary":"76-58"}, ... ],
  "leaders": [...], "probables": [...]
}
```

**`score` is a string, not a number** — `"0"`, `"2"` — on both the site scoreboard
and the header endpoint. Coerce once at the edge; comparing `"10" > "9"`
lexicographically is a bug waiting to happen.

**Start time**: `events[].date`, ISO-8601 Zulu (`"2026-08-29T17:05Z"` — note the
minute-precision form, no seconds). Per repo convention this must be rendered
through `main/services/app-timezone.ts`, never the host clock.

**Situation (baseball)** — `competitions[0].situation`:

```json
{
  "lastPlay": {
    "id": "4018749131203040005",
    "type": { "id": "5", "text": "Ball", "abbreviation": "B",
              "alternativeText": "Walk", "type": "ball" },
    "text": "Pitch 3 : Ball 2",
    "scoreValue": 0,
    "team": { "id": "10" },
    "atBatId": "4018749131203",
    "athletesInvolved": [ { "id": "34958", "fullName": "Jahmai Jones",
                            "shortName": "J. Jones", "jersey": "37",
                            "position": "DH", "headshot": "https://..." } ]
  },
  "balls": 2, "strikes": 1, "outs": 2,
  "pitcher": { "playerId": 33735, "athlete": { "fullName": "Ryan Yarbrough", ... },
               "summary": "0.2 IP, 0 ER, 0 H, 0 BB" },
  "batter":  { "playerId": 34958, "athlete": { "fullName": "Jahmai Jones", ... },
               "summary": "0-2, 2 K" },
  "onFirst": false, "onSecond": false, "onThird": false
}
```

`competitions[0].outsText` = `"2 Outs"`.

**Situation (football)** — same key, different fields. From the one live NFL game:

```json
{ "down": -1, "yardLine": 35, "distance": 0, "isRedZone": true,
  "homeTimeouts": 3, "awayTimeouts": 3, "lastPlay": { ... } }
```

`lastPlay` there carries `text: "Official Timeout at 04:47."`, `statYardage`,
a `probability` block (`homeWinPercentage` etc.) and a `drive` block
(`description: "8 plays, 38 yards, 3:34"`, `start`/`end` yard lines).

The situation object is **sport-shaped, not uniform**. Any renderer must treat it
as optional per-sport garnish over a common core of (score, status detail, teams).

#### The pitch-by-pitch line from the operator's screenshot

The operator's screenshot showed:

> "Kevin Gausman throws 80 mph slider outside to Sal Stewart. Ball 1."

**That exact composed sentence is not a field in any endpoint I could find.** I
grepped every payload I fetched — scoreboard, `summary`, core-API `plays`,
`cdn.espn.com/core/mlb/game` — for `throws` and `mph` and found only article
headlines and glossary text. ESPN's Gamecast composes that sentence client-side.

Its *components* are all available, on the core play object:

```
GET https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/{id}/competitions/{id}/plays?limit=100&page=N
```

```json
{ "text": "Pitch 1 : Strike 1 Looking",
  "pitchVelocity": 91,
  "pitchType": { "id": "17", "text": "Four-seam FB", "abbreviation": "FF" },
  "scoringPlay": false, "scoreValue": 0,
  "awayScore": 2, "homeScore": 0 }
```

Plus pitcher and batter names from `situation`. So the line is **reconstructible**
(`{pitcher} throws {pitchVelocity} mph {pitchType.text} to {batter}. {type.text}.`)
but it is our prose, not ESPN's, and it will not match the screenshot word for
word. The scoreboard's own `situation.lastPlay.text` is the terse
`"Pitch 3 : Ball 2"` form.

This is a plan decision, not a research one: ship the terse ESPN string for free,
or compose our own and own the phrasing. Flagging it because the screenshot sets
an expectation the API does not directly meet.

### 1.5 The scoring-event question

**Plainly: both exist, at different costs, and the answer for this feature is diffing.**

A genuine discrete scoring event *does* exist, but only on the per-game
plays/summary endpoints, not on the scoreboard:

```
GET https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=401874913
→ .plays[]
```

```json
{ "id": "4018749130003990057",
  "text": "Abreu homered to right center (387 feet).",
  "scoreValue": 1,
  "scoringPlay": true,
  "awayScore": 1, "homeScore": 0,
  "period": { "type": "Top", "number": 1 },
  "type": { "text": "Play Result" },
  "wallclock": "2026-08-29T...Z" }
```

`scoringPlay: true` is exactly the flag wanted, `scoreValue` is the points added,
`awayScore`/`homeScore` are the running totals *after* the play, and `wallclock`
timestamps it. In that one game, 3 of 388 plays had `scoringPlay: true`. The same
data is on `sports.core.api.espn.com/.../plays` (paginated, 388 items over 78
pages at `limit=5`).

Why it is nonetheless the wrong primary mechanism here:

- **Cost.** The `summary` response was **752 KB** for one game. That is per game,
  per poll. Polling summary for every followed team's live game would dwarf the
  26 KB league scoreboard by an order of magnitude, on a Pi, during a service.
  This directly contradicts the repo's efficiency-first rule.
- **`situation.lastPlay` on the cheap scoreboard is not a substitute.** It carries
  `scoreValue`, so `lastPlay.scoreValue > 0` does flag "the most recent play
  scored" — but it is a *sample*, not a log. At any sane poll cadence multiple
  plays elapse between polls, so scoring plays will be missed outright. Using it
  as the trigger would drop goals silently, which is the worst failure mode for a
  notification feature.

**So: detect the score change by diffing successive scoreboard polls.**

**The smallest reliable diff key is `${event.id}:${competitor.id}` → `score`.**

Both halves are required:

- `competitor.id` (the team id), not `homeAway`, because `homeAway` is a role, and
  keying on it means a home/away swap between two polls reads as both teams
  scoring.
- `event.id`, not the team id alone — **verified against a real doubleheader in
  today's payload**: BOS @ NYY appears twice on 2026-08-29, as event `401874913`
  (17:05Z, "Doubleheader Game 1") and event `401816717` (23:15Z). A team-keyed
  diff would smear the two games' scores together. Soccer two-leg ties are the
  same hazard.

Alongside the score, diff `status.type.state` per event to catch the
scheduled → in → post transitions (kickoff, final), which are the other two
moments a Live-Activities-style card would want to animate.

Practical notes for the diff:

- Coerce `score` to a number once; it arrives as a string (§1.4).
- Seed the baseline on the **first** successful poll and emit nothing from it,
  or every followed team "scores" the moment the server starts.
- Treat a missing/`null` score as "no reading", not as 0 — the per-team endpoint
  returns `null` scores (§1.6) and a `null → 0` transition would fire a false event.
- A score can go *down* (a review reversing a run/touchdown). Decide whether that
  is an event or a silent correction.
- `soccer` competitors also carry `shootoutScore` (null in normal time), which a
  penalty shootout would move without moving `score`.

If the plan wants the *narration* ("Abreu homered to right center") in the
expanded state, the affordable shape is: diff the scoreboard to detect that
something scored, then make **one** `summary`/`plays` request for **that one
game** to fetch the play text. That is an event-driven 752 KB request a handful
of times a game, not a polled one.

### 1.6 A per-team endpoint does not help

```
GET https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams/10
```

59 KB, and `.team.nextEvent[0]` does carry the live status
(`"detail": "Bottom 7th"`) — but **`competitors[].score` is `null`**. Verified on
a game that was demonstrably in progress with a 2–0 score on the scoreboard. So
you cannot use the cheaper per-team endpoint to follow scores; the league
scoreboard is required.

### 1.7 Logos and colours

**Colours** are on `competitors[].team` as `color` and `alternateColor`, as bare
6-digit hex **without a leading `#`** (`"132448"`, `"c4ced4"`). Prefix before use.
Two live cautions for this repo: these are brand colours chosen for contrast
against ESPN's own chrome, not ours, and some are near-white (`"ffffff"` observed
as an NFL `alternateColor`) — so a team colour used as a background needs a
contrast check against the app's dark surfaces, and per the repo's
avoid-purple/`R=G=B` rule it must not be allowed to tint a neutral dark surface.

**Logos** are absolute HTTPS URLs on the payload:

```
https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/nyy.png
```

Fetched directly, the response was:

```
HTTP/2 200
content-type: image/png
content-length: 20024
cache-control: max-age=103
access-control-allow-origin: *
server: AmazonS3
```

**Usable directly from the browser**: `access-control-allow-origin: *`, and an
HTTP page loading an HTTPS image is not mixed-content-blocked (the reverse is),
so the repo's plain-HTTP production context is not a problem here.

Whether to proxy is a judgement call, not a technical necessity:

- *For direct*: no server work, no cache to invalidate, ~20 KB each and the
  browser caches them.
- *For proxying/caching server-side*: `cache-control: max-age=103` is only ~1.7
  minutes, so a wall display left running will re-request logos steadily; and it
  makes every stage display reach out to `a.espncdn.com` individually, which some
  church networks will not allow. The repo already has precedent for exactly this
  — ProPresenter thumbnail caching (see the efficiency-2 work) — so the pattern
  exists if wanted.

A middle path worth putting in the plan: fetch each followed team's logo **once**
at favourite-selection time and store it, since a team's logo changes about once
a decade. That removes per-poll and per-display image traffic entirely.

---

## 2. Polling reality

### 2.1 What I could actually establish about rate limiting

Measured, not assumed:

- **No rate-limit headers of any kind.** I grepped the response headers for
  `ratelimit`, `x-rate`, `retry-after`, `throttle` — none present.
- **12 sequential requests to the MLB scoreboard, no pacing: all HTTP 200**,
  response times 0.084–0.180 s, identical 330,208-byte bodies. No 429, no
  degradation.
- **The server states its own intended cadence.** The scoreboard responds with:

  ```
  cache-control: max-age=10
  ```

  and `apis/v2/scoreboard/header` with `cache-control: max-age=1`. This is the
  only quantitative guidance ESPN gives, and it is a statement about how long the
  data is considered fresh — not a permission to poll at that rate.
- The community repo says exactly: *"No Authentication Required: Most endpoints
  are publicly accessible"* and *"Rate Limiting: Be respectful — no official
  limits published, but excessive requests may be blocked."*

**So the operator is right that there is no enforced rate limit — and that is not
the same as there being no limit.** This is an undocumented, unsupported,
free endpoint with no contract and an explicit community warning that abuse gets
blocked. A block would be by source IP, which on a church LAN means the whole
building, and it would arrive with no warning and no support channel. That
asymmetry — nothing to gain from polling fast, a silent unappealable block to
lose — is the actual argument for restraint, independent of politeness.

### 2.2 Recommended cadence

The repo already has the right mechanism, and it is not a bare `setInterval`.
`main/services/service-window.ts` exposes:

```ts
pollDelayMs(activeMs: number, dormantCeilingMs = 5 * 60_000, now = Date.now()): number
```

described in its own comment as the inverse of `capDelayMs` — it *stretches a
steady cadence when nothing is happening*, and it **fails open** (returns the
active cadence when the schedule is unknown). That is exactly the shape this
integration needs, and it should be used rather than reinvented.

Recommended tiers, to be argued with in the plan rather than accepted:

| Condition | Cadence | Why |
|---|---|---|
| A followed team's game is `state === "in"` **and** something is watching | **20–30 s** | Comfortably above ESPN's own `max-age=10`. At 30 s, one league is ~26 KB × 120/hr ≈ 3 MB/hr — nothing for a LAN, and a scoring toast that lands within half a minute reads as live. |
| A followed game is live but **nothing is watching** (no SSE subscriber, no in-process demand) | **poll paused, or ≥5 min** | The integration base already exposes `inDemand` for this. |
| A followed game starts within the hour | **2–5 min** | Cheap way to catch first pitch without polling all day. |
| No followed game today, or all `post` | **30–60 min**, or stop | One `dates=` request settles the day's schedule. |
| **During a service window** | see §2.3 | The load question and the propriety question are separate; both point the same way. |

Two cadence points specific to this repo's rules:

- **Gate on demand, not just on subscribers.** `integration-base.ts` distinguishes
  `hasSubscribers` (browsers) from `inDemand` (browsers *or* registered in-process
  consumers), and its comment records a real bug where gating on subscribers alone
  silently disabled every automation rule reading the channel. If a scores toast
  or an automation trigger is meant to fire on an unattended appliance, the
  service must register a demand source — otherwise "nobody has a page open" means
  "no toasts ever", which on a kiosk is always.
- **Do not tick the SSE channel on every poll.** `StatusIntegration.emitIfChanged`
  is the house rule: a poll every 30 s must not be an SSE frame every 30 s. The
  scores DTO changes rarely (a score, a period, a status), so broadcast-on-change
  is nearly free. Note the REAPER counter-example — it deliberately overrides
  `emitIfChanged` to tick every poll while recording so a timecode advances. A
  game *clock* would tempt the same override; resist it and let the client count
  down locally from `displayClock` + a server timestamp, as the PCO countdown
  already does, rather than pushing a frame per second to every wall display.

### 2.3 What it should do when no game is live

Not "poll slower" — **stop, and know when to wake**.

The schedule is knowable a day ahead: one `?dates=YYYYMMDD` request per followed
league at, say, 06:00 app-time yields every followed team's start time for the
day. From that, schedule the poller to start ~5 minutes before the earliest
followed game and stop after the last one reaches `state: "post"`. Between those,
zero requests.

That turns a naive 24/7 30-second poll (~2,880 requests/league/day) into roughly
one schedule request plus polling only across actual game windows — the same
argument `service-window.ts` already makes in its own comment about the PCO live
poll ("~151,000 requests a week … for the ~5% of it that is a service").

`pollDelayMs`'s "never sleep past the moment the next window opens" clamp is the
existing idiom for this and should be reused rather than hand-rolled.

---

## 3. How this fits THIS app

Paths below are relative to the repo root
(`/Users/hstreuber/projects/stage-utility`). Read at commit `56f601d` on branch
`fix/pco-freshness` — note the worktree was **not** on the branch named in the
session's opening git status, and other agents are editing concurrently, so line
numbers may drift.

### 3.1 The integration contract

**`main/services/integration-base.ts`** — two layers:

- `ConnectionLifecycle` — connect/retry/report only.
- `StatusIntegration<T extends { connected: boolean }>` — adds the snapshot
  contract. **This is the right base for scores.**

What a new integration must implement:

| Member | Obligation |
|---|---|
| `constructor(log, channel, OFFLINE)` | short log tag, SSE channel name, and an offline DTO |
| `protected abstract connect(): Promise<void>` | one attempt; call `scheduleReconnect()` on failure |
| `protected abstract get configured(): boolean` | true when configured enough to try |
| `protected teardown()` | optional; clear poll timers |
| `protected get reconnectBaseMs()` | optional; default 3000 ms |

What it gets free: `report(state, message)` (de-duplicated, so a retry loop does
not spam the Integrations panel), `resetReport()`, `attempt`, `resetBackoff()`,
`hasSubscribers` / `addDemandSource()` / `inDemand`, `scheduleReconnect()`
(exponential, clamped by `serviceWindow.capDelayMs`), `scheduleIn(ms)`,
`getLatest()`, `emitIfChanged()`, `emit()`, `goOffline()`.

Connection state is `type ConnState = "connected" | "error" | "disconnected"`,
reported via `this.report(...)`, which the manager wires to the Integrations
panel.

**The model to copy is `main/services/reaper-service.ts`** — it is the only
existing *HTTP-polling* integration, which is exactly what ESPN is. It
demonstrates the whole pattern in ~140 lines:

- one timer for both steady cadence and back-off via `scheduleIn()` (its comment
  notes two timers would double the poll rate after a reconnect),
- `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` rather than a hand-rolled controller
  — stated as the codebase-wide convention,
- a pure exported parse function (`parseTransport`) so the fold can be unit-tested
  without a live server. **A scores integration should do the same**: a pure
  `parseScoreboard(json) → GameDTO[]` plus a pure `diffScores(prev, next) → ScoreEvent[]`,
  both testable against a saved fixture. Given the repo's "a guard must fail on
  the bug it guards" rule, the diff function is where the fixture-based test
  earns its keep — including a doubleheader fixture, since that is the case a
  team-keyed diff gets wrong.
- `test(host, port)` for the panel's "Test connection" button.

OBS (`main/services/obs-service.ts`) is the WebSocket model — less relevant here.

### 3.2 Registering the integration

| # | File | What |
|---|---|---|
| 1 | `main/services/integration-ids.ts` | add the id to `INTEGRATION_IDS`. **This alone fails `automation-coverage.test.ts` until the integration has a trigger or condition** — the file says so explicitly. Add to `CONNECTION_MANAGED_IDS` too if config changes should re-apply the connection (typed `Record<ConnectionManagedId, …>`, so omitting an applier is a compile error). |
| 2 | `main/services/automation-triggers.ts` / `automation-conditions.ts` | at least one entry, plus a label in `INTEGRATIONS` (a second test deep-equals that list against `INTEGRATION_IDS`, and a third requires a non-empty label). "A followed team scores" is a natural trigger. |
| 3 | `main/services/integration-manager.ts` | an `IntegrationDescriptor` (id, kind, label, description, `configSchema`), an entry in the applier map, secret-field list, and — if there is a Test button — a branch in the test handler. |
| 4 | `main/services/remote-server.ts` | add a `sseWrite(res, "<channel>", service.getLatest())` line to the hello burst (see `:873` for `reaper:status`). |
| 5 | `renderer/lib/sse-channels.ts` | add the channel to `HYDRATED_CHANNELS`. Scores are **state**, not events, so they belong here — a display opened mid-game must not sit blank until the next score. The file's own comment draws exactly this line and notes `update:notice` is deliberately excluded as an event. |
| 6 | `main/services/automation-coverage.test.ts` | add the channel to `BROADCAST_CHANNELS` (channels passed to the base constructor cannot be found by grepping for `broadcast("…")`). |
| 7 | a `DataStore` for favourites | `export const scoresStore = new DataStore<Fav[]>("scores-favourites.json", [], "config")` — third arg is the classification. **`"config"`**: these are the operator's choices and must be restored. `config-snapshot.test.ts` asserts an **exact** store count and deep-equals the sorted config/runtime file lists (`EXPECTED_CONFIG`, `EXPECTED_RUNTIME`), so the new file must be added there in the same change or the suite fails. |
| 8 | `renderer/main/use-scores-state.ts` | mirror `renderer/main/use-reaper-state.ts` verbatim: an `invoke<T>("scores:getStatus")` hydrate on mount plus `onNotification("<channel>", …)`. 34 lines. |

### 3.3 Adding the layout object

Steps 1–5 are enforced by the type checker (`LayoutObjectType` is derived from the
config union, and `CAPABILITIES`, the palette `ICONS` map and `LAYOUT_OBJECTS` are
all `Record<LayoutObjectType, …>`, with a `const _never: never` at the end of the
render switch). Later steps are silent-failure territory guarded by exact-count
tests.

| # | File | What |
|---|---|---|
| 1 | `main/types/views.ts` | add a member to the `LayoutObjectConfig` union (`reaper-status` at ~:402). Breaks 5+ files until they follow. |
| 2 | `main/types/object-capabilities.ts` | one `CAPABILITIES` entry — `readout` / `control` / `drilldown` / `editable`. `drilldown` also needs a `DRILLDOWN` route (a test asserts both directions). |
| 3 | `main/types/readout-types.ts` | add to `IDIOM_TYPES` if it uses the shared caption/value/sub idiom. |
| 4 | `renderer/main/layout-objects.ts` | the `LayoutObjectSpec`: `label`, `blurb` (**required, ≤60 chars, sentence case, no trailing period, must differ from the label** — asserted), `group`, `config()`, `style()`, optional `integration: { id, label }` (dims the palette card until set up — wanted here), `homeSize`, `homeWhen`. There is **no canvas default-size field**; new objects get `0.3 × 0.16` from `makeObject` in `renderer/editor/layout-editor.tsx:118`. |
| 5 | `renderer/main/layout-renderer.tsx` | a `case` in the `ObjectBody` switch (`reaper-status` at ~:1096), plus gating the data hook in `useLayoutData` (~:2400) with `want(["scores-…"])` so the hook does not run for layouts that do not use it — the existing efficiency idiom. Add to `TABULAR_TYPES` if numeric. |
| 6 | `renderer/main/scores-object.tsx` | own file, since this is non-trivial and animated (precedent: `osc-button.tsx`, `live-controls.tsx`). Simple readouts stay inline. |
| 7 | `renderer/editor/palette.tsx` | one lucide icon in `ICONS` (~:31). |
| 8 | `renderer/editor/inspector.tsx` | per-object settings as flat `{c.type === "…" && (…)}` blocks (~:906 for reaper) using `Row`, `RowText`, `RowSwitch`, `RowSelect`, `RowNumber`. **This is where the per-object team picker goes.** |
| 9 | `docs/reference/widgets.md` | a `| **Label** | What it shows | Source |` row — `widget-docs.test.ts` matches bolded labels **exactly, both directions**. |

Tests that will fail until deliberately updated (all **exact counts**, not floors):

- `renderer/main/object-catalog.test.ts:19` — `TYPES.length === 54`; also validates the blurb rules.
- `main/types/object-capabilities.test.ts:20` — `Object.keys(CAPABILITIES).length === 54`; `controls` must deep-equal an exact sorted list.
- `renderer/main/object-fit.test.ts:34` — `=== 54`; its comment says run the browser overflow sweep against the new type before bumping.
- `renderer/main/object-look.test.ts:60` — three counts: `all === 54`, `carded === 29`, `bare === BARE.length`.
- `renderer/main/layout-objects.test.ts:329` — the golden registry; append `{ type, label, group, after }` to `ADDED_SINCE`.
- Plus `captions.test.ts`, `tabular-readouts.test.ts`, `status-fill-parity.test.ts`, `home-cards.test.ts` as applicable.

Verified as **not** in the chain: there is no zod/schema validation for layout
objects anywhere in `main/` (`views.json` is stored as-is, which is why
`findLayoutObjectSpec` returns `null` for unknown types rather than throwing),
and no migration is needed — `never-chosen-defaults.ts` and `surface-migration.ts`
work generically.

### 3.4 Adding the Home card

There is **no separate Home card registry.** Home cards are ordinary layout-object
types whose `type` begins `home-`:

```ts
// renderer/app/home/cards.tsx:36
export type HomeCardType = Extract<LayoutObjectConfig, { type: `home-${string}` }>["type"];
```

`renderer/app/home/home-cards.ts` is sizes/visibility/array ops, not a registry:

```ts
export type HomeCardSize = "s" | "m" | "l" | "xl" | "tall";   // views.ts:584
export const SIZES = { s:{w:1,h:1}, m:{w:2,h:1}, l:{w:2,h:2},
                       xl:{w:3,h:2}, tall:{w:3,h:4} };        // home-cards.ts:27
export type HomeVisibility = "always" | "live" | "idle";      // views.ts:595
export function visibleCards(objects, mode) { ... }           // home-cards.ts:70
```

Note `HomeVisibility` — **`"idle"` and `"live"` already exist as a first-class
concept**, and `visibleCards` already filters on the current mode. That is
directly relevant to §4.1: "show this card only when a service is *not* running"
is an existing, declarative capability (`homeWhen: "idle"`), not new work.

Files to add one card:

1. `main/types/views.ts` — `| { type: "home-scores"; ... }` in the union.
2. `renderer/main/layout-objects.ts` — the spec (with `homeSize`, `homeWhen`), **and** add to `HOST_FRAMED_TYPES` (~:135) so it is frameless on Home and framed on a wall.
3. `renderer/app/home/cards.tsx` — the component, the key in `HOME_CARD_TYPES` (:59), the `case` in the `HomeCard` switch (:642). Both fail to compile if skipped.
4. `renderer/main/object-look.test.ts` — its `BARE` list (:32) is asserted equal to `HOST_FRAMED_TYPES`; update in lockstep.
5. `renderer/app/home/home-card-routing.test.ts:26` — `HOME_TYPES.length === 12`, exact.
6. `renderer/app/home/card-toggles.ts` — only if the config declares a toggleable key; typed `Record<TypesWith<K>, true>`, fails both ways.

`layout-renderer.tsx` needs no edit — `isHomeCard(c)` (:689) intercepts before the
switch.

### 3.5 The toast: what exists, and what it cannot do

`renderer/components/ui/toast.tsx`, 96 lines, Radix `Toast` over a module-level
store. The **entire** public API:

```ts
export const toast = {
  success: (message: string) => addToast("success", message),
  error:   (message: string) => addToast("error", message),
  info:    (message: string) => addToast("info", message),
};
export function Toaster(): JSX.Element   // takes NO props
```

The entry type (not exported):

```ts
interface ToastEntry {
  id: string;
  type: "success" | "error" | "info";
  message: string;
}
```

**It cannot render rich custom content.** `message` is `string`. There is no
`title`, no `description`, no `action`, no `children`, no `ReactNode` anywhere in
the file. Auto-dismiss is a hard-coded `setTimeout(… , 4000)` with no per-toast
override and no returned handle for early dismissal. The only visual variation is
a leading icon picked from `t.type`.

**So a Live-Activities-styled toast — team logos, colours, two scores, an
animated open/collapse — is not expressible in the current component.** This is
the single biggest UI-side finding.

Scale of the constraint, which is why "just change the signature" is not free:
**142 call sites across 33 files** (heaviest: `renderer/app/use-stage-settings.ts`
30, `renderer/components/integrations-panel.tsx` 13). Hosts are mounted twice,
once per entrypoint: `renderer/app/index.tsx:22` and `renderer/main/index.tsx:43`.
There is no context provider — the store is module-level globals, which is why
`toast.x()` works from non-React modules like `renderer/lib/optimistic.ts`.

Three options for the plan to weigh, not decided here:

1. **Widen `ToastEntry.message` to `string | ReactNode`** and let `addToast` take
   a node. Smallest diff; all 142 existing string call sites keep working
   unchanged. Risk: the store is imported by non-React modules, so putting JSX in
   it blurs a boundary the current design keeps clean; and duration/dismissal are
   still fixed at 4 s, which is likely wrong for a score notification.
2. **A separate `ScoreActivity` overlay host**, independent of `Toaster`. Keeps
   the general-purpose toast untouched, and a score card is genuinely a different
   thing from "Saved" — different dwell time, different dismissal, different
   z-index needs. Costs a second overlay system to own.
3. **Extend `toast` with a fourth variant** carrying a small typed payload
   (`toast.activity({ home, away, … })`) so the store stays data-only and
   `Toaster` owns the rendering. Middle path; keeps JSX out of the store.

### 3.6 Account-level config and the searchable dropdown

`renderer/settings/sections/integrations-section.tsx` is a **9-line shim**:

```tsx
import { IntegrationsPanel } from "../../components/integrations-panel";
// ... <IntegrationsPanel />
```

The real file is **`renderer/components/integrations-panel.tsx`** (53,718 bytes).
It renders each integration from its descriptor's declarative `configSchema`, and
`main/types/integrations.ts` fixes the available field types:

```ts
export interface ConfigField {
  key: string; label: string;
  type: "text" | "password" | "number" | "select" | "ip-list";
  options?: { value: string; label: string }[];
  placeholder?: string; help?: string;
  default?: string | number;
  showIf?: { key: string; equals: string };
}
```

**There is no multi-select and no searchable field type in `ConfigField`.** So a
searchable multi-league, multi-team picker cannot be expressed declaratively.

The established escape hatch is a bespoke panel, and there are two precedents at
`integrations-panel.tsx:1226–1227`:

```tsx
if (descriptor.kind === "wireless") return <WirelessConnectionsPanel />;
if (descriptor.id === "osc") return <OscTargetsPanel />;
```

with the group table at `:986` (`{ title: "Control & output", ids: [...] }`)
deciding where the card appears. A `ScoresTeamsPanel` slots in the same way, and
the operator's instinct that this belongs in the Integrations tab matches how the
app already handles OSC targets and wireless connections.

#### Does a searchable multi-select already exist?

**No.** Two separate negatives:

- **`renderer/components/ui/multi-select.tsx`** (118 lines) — multi-select, but
  **no search**. There is no query state and no `<input>` in the file; options map
  straight through to a scrolling checkable list in a Radix Popover, with only a
  count and All/None buttons in the header.

  ```ts
  export function MultiSelect({ options, selected, onChange,
                                placeholder, summary, className, disabled }: {
    options: { value: string; label: string }[];
    selected: string[];
    onChange: (next: string[]) => void;
    placeholder?: string;   // default "Select…"
    summary?: string;       // override the collapsed trigger text
    className?: string; disabled?: boolean;
  })
  ```

  For ~30 MLB teams a plain list is arguably fine; across several leagues
  (30 + 32 + 30 + 32 + soccer) it is not, which is the operator's point.

- **`renderer/components/ui/select.tsx`** — **no search**, and worth knowing: it
  renders a **native `<select>`** behind a compound marker API
  (`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem` all `return null`
  and are read out of the element tree). The OS draws the open list, so the only
  "search" is the browser's first-letter typeahead. Its lines 65–68 warn that
  arbitrary children of `SelectTrigger` are dropped.

No `Combobox`, `Autocomplete`, `Typeahead`, or `Command` component exists in
`renderer/components/ui/`.

**The closest existing thing, and the one to copy, is
`renderer/settings/sections/position-picker.tsx`** (`PositionRangeEditor`): Radix
Popover + `const [query, setQuery] = useState("")`, an `autoFocus` input at :100
(`placeholder="Search positions…"`), a `.filter()` over name and team, grouped
results, an empty state, and an `ANY` sentinel. Its header comment states the
design rationale directly — built on Popover rather than Select *"so the search
input can live inside the dropdown without the Select's typeahead fighting the
text field."* That is precisely the lesson a team picker needs. It is bound to
`SlotPositionMatch`/`TeamPositionDTO`, so it is not generic.

Two other ad-hoc search UIs exist and are worth reading for consistency:
`renderer/components/icon-grid.tsx` (`IconGrid`, query + `searchIcons()`) and
`renderer/app/home/home-editor.tsx:176` (`AddWidgetSheet`, "Search widgets…"
filtering label/type/blurb).

**A plan decision to surface:** this is the fourth hand-rolled search-filter
popover in the repo. Per the repo's own rule — *"If the same shape exists in three
places, prefer removing the duplication over fixing it three times"* — there is a
real case for extracting a generic `SearchableMultiSelect` into
`renderer/components/ui/` and having the scores picker be its first consumer,
rather than writing a fifth. That is scope the operator should choose knowingly,
because it enlarges the PR.

Team lists for the picker come from `/teams` per league (§1.3) — 30 teams for MLB
— which should be fetched once and cached, not re-fetched to open a dropdown.

---

## 4. Design questions a plan must answer

Surfaced with trade-offs. **Not decided here.**

### 4.1 Should the toast be suppressed during a service?

This is a judgement call about a church production app, and it is the operator's
to make. What matters for the plan is that **the app already knows the answer to
"is a service running", in three places**, so suppression is cheap to implement
whichever way he chooses:

- **`serviceWindow.isActive()`** (`main/services/service-window.ts`) — server-side,
  window-aware (`leadMin: 120`, `tailMin: 60` by default). Broad: it covers
  rehearsal-through-teardown, so it is "we are in a service *window*", not "a
  service is *on air*".
- **`PcoLiveDTO.mode`** (`main/types/live.ts:12`) — `"item" | "preservice" | "none"`,
  broadcast on `pco:live`. `mode === "item"` is the sharp signal: a plan item is
  live *right now*. This is the one that means "on air".
- **`HomeVisibility`** (`views.ts:595`) — `"always" | "live" | "idle"`, already
  filtered by `visibleCards()`. For the *card*, suppression is a one-word
  declarative setting (`homeWhen: "idle"`), no new mechanism at all.

The trade-offs:

- *For suppressing*: a score toast popping over a wall display mid-sermon is a
  distraction visible to volunteers and possibly the congregation. The failure is
  public and not undoable. The repo's stated principle that recording a live
  service is deliberately independent of the clock reflects the same instinct —
  during a service, the service wins.
- *Against blanket suppression*: Sunday afternoon NFL overlaps the second service
  in most US churches, so "suppress during services" may mean "the feature never
  fires", which is the silent-uselessness failure mode the `inDemand` bug in
  `integration-base.ts` is a cautionary tale about.
- *Middle paths worth costing*: suppress on wall/stage displays but allow on the
  operator's own console (the app already distinguishes these — `ctx.interactive`
  is false on wall displays); or queue events during `mode === "item"` and release
  a digest after; or make it a per-surface setting and let the operator own it.

A related question the plan should not skip: **who sees this?** A layout object on
a stage-facing wall display is visible to the platform and possibly the room; the
Home card is the operator's own page. These deserve different defaults.

### 4.2 Animation: is either existing mechanism reusable?

**`renderer/main/expand-overlay.tsx` does not exist on this branch.** Verified:
the file is absent at `56f601d` (`fix/pco-freshness`); it was added in `6bf1024`
and lives on **`feat/multiview`** (and `fix/integration-status-ordering`),
unmerged. **A plan must not assume it is available** — depending on it couples
this feature to an unmerged branch. Findings below are from
`git show origin/feat/multiview:renderer/main/expand-overlay.tsx`.

It is a hook, not a component:

```ts
export function useExpand(enabled: boolean): {
  tileRef: React.RefObject<HTMLDivElement | null>;
  control: (title: string) => ReactNode;
  overlay: (render: (panelH: number) => ReactNode, title: string) => ReactNode;
}
```

Its FLIP is the closer match of the two, because **it scales**:

```js
const dx = from.left - to.left, dy = from.top - to.top;
const sx = from.width / to.width, sy = from.height / to.height;
panel.style.transformOrigin = "top left";
panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
panel.style.transition = "none";
// two nested rAF, then:
panel.style.transition = `transform ${OPEN_MS}ms cubic-bezier(0.2, 0.6, 0.2, 1)`;
panel.style.transform = "none";
```

`OPEN_MS = 260`. Reusable parts: the measure/invert/release with scale; a
module-level `openPanels` stack so Escape closes only the innermost; full a11y
(`role="dialog"`, `aria-modal`, focus into the close button, `trapTab`, focus
restored via `isConnected`); a render-phase gate so a vanishing tile cannot
strand an overlay; a deliberate `z-[90]` (above app chrome at 50, below toasts at 100).

Three caveats that bite this feature specifically:

- **It always goes full-screen** — `fixed inset-0 bg-bg/95 backdrop-blur-sm` with
  a mandatory header bar and X. There is no prop for target geometry, so *"expand
  to a larger card in place"* — which is the actual Live Activities shape — is
  **not expressible**.
- **It is open-only.** There is no reverse FLIP; the panel just unmounts. A Live
  Activities *collapse* is new code either way.
- It is coupled to embeds (imports `useEmbedBoxHeight` from `./embed-box`), which
  a generic object expander would have to reuse or strip.

**`useSlideOnMove` in `renderer/app/home/home-grid.tsx:29–80`** is the weaker
candidate: file-local, not exported, not generic. It queries `[data-card-id]`
inside its own host, keys rects by `dataset.cardId`, and animates **translation
only, never scale** — `transform 180ms cubic-bezier(0.2, 0, 0, 1)`, enabled only
during a drag. It is a grid-reorder slide, not a morph primitive. Not reusable
for open/collapse.

**`prefers-reduced-motion` — the repo's convention, which must be respected:**
the primary mechanism is global CSS at `renderer/styles.css:367–388`, collapsing
`transition-duration`/`animation-duration` to `1ms !important` for
`*, *::before, *::after`, with two deliberate carve-outs — `.animate-spin` (kept
at 1.4 s: *"a spinner that stops spinning reads as a frozen app"*) and `.su-flash`
(steady outline instead of pulsing). `renderer/motion-tokens.test.ts:97` guards
that the block exists.

JS-side the idiom is
`window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false`, used
in exactly two places: `renderer/lib/view-transition.ts:9` and `expand-overlay.tsx`.
Note the asymmetry the plan should not repeat: **`expand-overlay` checks it
explicitly and early-returns; `useSlideOnMove` does not, and is neutralised only
incidentally by the global CSS.** A hand-rolled JS FLIP for scores must check it
explicitly — a JS-driven `transform` that the CSS override cannot reach is
exactly the case the global rule misses.

A further point specific to this feature: a score toast is **involuntary** motion
the viewer did not initiate, which is the category `prefers-reduced-motion` exists
for most strongly. Under reduced motion the card should appear in its final state,
not travel.

### 4.3 Compact vs expanded, at two very different distances

The same object renders on a wall display read from ~20+ feet and on a console at
desk distance. The repo already encodes this split — canvas widgets size fonts as
a fraction of the container (`ctx.H`), and `ctx.interactive` is false on wall
displays.

Questions to settle:

- **What is in the compact state?** Candidates, cheapest first: two abbreviations
  and two scores (`"BOS 2 – 0 NYY"`); plus `status.type.shortDetail`
  (`"Top 7th"`, `"4:47 - 3rd"`, already pre-formatted per sport, §1.4); plus
  logos. At wall distance, logos and score are legible and text is not; at desk
  distance the reverse is affordable.
- **What does the expanded state add?** Full team names, the situation garnish
  (count/outs/bases for baseball, down-and-distance for football), the scoring
  play text (which costs the extra request from §1.5), records, venue.
- **Does the expansion animate on a wall display at all?** `ctx.interactive` is
  false there, so there is no one to tap it — the expansion would have to be
  *automatic and timed* (open on a score, collapse after N seconds), which is
  genuinely the Live Activities behaviour but is also unattended motion on a
  stage-facing screen. On the console, tap-to-expand is the natural interaction
  and `useExpand` is the closest fit — if it lands on this branch.
- **Are they the same component?** Wall (auto, timed, no controls) and console
  (tap, persistent, dismissible) may be different enough to warrant different
  behaviour behind one config.

### 4.4 Several games at once

Genuinely likely: the operator follows multiple sports, and a Sunday afternoon can
have several NFL games plus an MLB doubleheader (one is in today's payload) live
simultaneously. Unresolved:

- **The object**: one game per object (operator places N), or one object showing a
  list? A fixed-height wall widget showing four games at wall-legible type is not
  possible — that is a real constraint, not a preference.
- **Selection when several are live**: most recently scored? Earliest start?
  Closest game? A manual pin?
- **Toast storms.** Two games scoring within seconds is normal. Queue, coalesce
  ("2 updates"), or show only the highest-priority team? The current `Toaster`
  stacks with a fixed 4 s dismissal and no queue, so unbounded stacking is the
  default failure. A minimum interval between activity toasts is probably needed
  regardless.
- **Which team's colour wins** when a card shows two followed teams playing each
  other.
- **Ordering stability**: the scoreboard's `events[]` order is not guaranteed
  stable between polls. Sort explicitly (by start time, then `event.id`) or cards
  will reshuffle under the operator.

---

## 5. Cost

Rough, in this repo's terms. Two independent axes: **the integration is routine;
the UI is not.**

**Server side — low risk, well-trodden.** ~8 files. A new
`main/services/scores-service.ts` extending `StatusIntegration` (REAPER is a
~140-line worked example of the same HTTP-polling shape), a `DataStore` for
favourites, DTOs in `main/types/live.ts`, plus the registration chain in §3.2
(`integration-ids.ts`, `automation-triggers.ts`, `integration-manager.ts`,
`remote-server.ts`, `sse-channels.ts`) and three test files that will fail on
exact counts until updated. Pure `parseScoreboard` and `diffScores` functions with
fixture tests, per the `parseTransport` precedent.

**Layout object** — ~9 files plus ~8 test files with exact-count assertions (§3.3).
Mechanical, but the count bumps (`54 → 55` in four separate files, `carded 29 → 30`)
are easy to half-do, and `object-fit.test.ts`'s comment asks for a browser
overflow sweep before bumping.

**Home card** — ~6 files (§3.4). The smallest piece, because a Home card is just a
`home-`-prefixed layout object and much of the work is shared with the object above.

**Toast** — the real unknown. The current component is string-only across 142 call
sites (§3.5); a Live-Activities toast needs rich content that does not exist.
Whichever of the three options is chosen, this is new UI plus an animation system,
and the FLIP that best matches is on an unmerged branch and is full-screen-only
and open-only.

**Settings picker** — ~2–4 files. A `ScoresTeamsPanel` following
`OscTargetsPanel`, with the search behaviour copied from `position-picker.tsx`.
More if the team is extracted into a shared `SearchableMultiSelect` (§3.6), which
is the better engineering call and the larger PR.

### Where the risk actually is

1. **The toast.** Rich content is not expressible today; 142 call sites make a
   naive signature change wide; and the animation primitive that fits best is
   unmerged, full-screen-only, and has no close transition. This is the piece most
   likely to be underestimated.
2. **Dependence on `expand-overlay.tsx`, which is not on this branch.** Verified
   absent at `56f601d`. Any plan that assumes it must say which branch it is
   building on.
3. **An undocumented third-party API with no contract.** ESPN can change or
   withdraw these endpoints without notice, and the field shapes are
   *sport-specific* (`situation` differs between MLB and NFL; `shootoutScore`
   exists only in soccer). The parser must degrade to "score and status" when
   anything richer is missing, rather than throwing. Per the repo's
   do-not-swallow-a-failure rule, a parse failure must be reported to the operator
   via `report("error", …)`, not logged and dropped.
4. **The exact-count test guards.** At least eight files assert exact counts. This
   is the repo's own most expensive recurring mistake (fixing one instance of a
   repeated pattern); grep for every count before committing.
5. **Getting the diff key wrong.** Keying on team instead of `event.id`+`competitor.id`
   breaks on doubleheaders and two-leg ties — and a real doubleheader is in today's
   payload, so a fixture for it is available. Per "a guard must fail on the bug it
   guards", the test should be shown going red against a team-keyed diff.
6. **Scope creep into a shared search component.** Defensible, arguably correct,
   but it should be an explicit decision up front rather than discovered mid-PR.

---

## Unverified

Stated plainly, so none of it becomes a bug in a plan:

- **NFL `possession`, `downDistanceText`, `shortDownDistanceText`,
  `possessionText`.** Widely referenced elsewhere, but I could **not** observe
  them. Only one NFL game was live (2026-08-29, preseason) and it sat in an
  Official Timeout; its `situation` object's keys were exactly
  `[awayTimeouts, distance, down, homeTimeouts, isRedZone, lastPlay, yardLine]` —
  the possession fields were **absent**, not null. I could not confirm their names
  or types during live play. Verify against a live regular-season NFL game before
  designing a football-specific readout.
- **The composed pitch-by-pitch sentence** from the operator's screenshot is not a
  field in any endpoint I fetched (§1.4). I searched the scoreboard, `summary`,
  core `plays`, and `cdn.espn.com/core/mlb/game`. I cannot rule out an endpoint I
  did not find, but I found no evidence of one.
- **NBA/NHL/college payload shapes.** I fetched NHL (7 events, preseason,
  `season.type 1 / year 2027`) and confirmed the endpoint pattern works, but did
  not examine an in-progress game for either. Basketball and hockey `situation`
  shapes are unverified.
- **Long-run rate limiting.** 12 rapid requests drew no throttling and there are no
  rate-limit headers, but this says nothing about sustained polling from one IP
  over hours or days. Nobody outside ESPN can verify that; treat §2.2 as risk
  management, not measurement.
- **Season-rollover behaviour of team ids.** `id` is ESPN's primary key and is the
  best available choice on the evidence, but I could not observe a rollover or a
  franchise relocation to prove ids survive one. The `/teams` re-resolution in
  §1.3 is the hedge.
- **The `apis/v2/scoreboard/header` endpoint is undocumented** even in the
  community repo — I found it by probing. Higher drift risk than the site
  scoreboard, which the community repo does document.
- **Line numbers throughout §3** were read at `56f601d` on `fix/pco-freshness`
  while other agents were actively editing the repo. Symbol names are reliable;
  line numbers may have moved.
- **`renderer/app/home/home-grid.tsx` FLIP internals** and the toast call-site
  count (142 across 33 files) come from a delegated read. I independently verified
  the toast's string-only `ToastEntry`, the absence of search in `multi-select.tsx`,
  and the absence of `expand-overlay.tsx` on this branch; I did not re-count the
  call sites myself.
