# PCO freshness: roster cadence, in-window cache TTL, API version pin

2026-08-29 · branch `fix/pco-freshness` (off `origin/beta`)

Three changes to the Planning Center client, all in service of the same goal:
fresher data during a service, without more requests the rest of the week.

---

## 1. The roster re-pulls once a minute inside a service window

`main/services/stage-controller.ts`

The roster was the stalest thing the app showed. It moved only on the plan
refresh, whose configured interval goes up to two hours — so a last-minute
substitution could take two hours to reach a stage display, which is the whole
reason the name is on the display. Everything else the app reads from PCO is
cached in minutes, or (the live timer) not cached at all.

A new `rosterRefreshTimer` ticks every `ROSTER_WINDOW_INTERVAL_MS` and calls
`rosterRefreshTick`, which returns immediately unless `serviceWindow.isActive()`.
Outside a window it makes no request at all: the cost away from a service is one
no-op timer callback a minute and zero PCO traffic. It is armed and disarmed
alongside the existing auto-refresh timer, so `pauseBackgroundWork` (used by
config restore) already covers it.

### Why 60 seconds

A roster change is a human editing a plan in Planning Center — a substitution
typed in minutes before doors, at worst. One minute is already under the
granularity at which those edits actually happen. It turns "up to two hours
behind" into "about a minute behind", and going tighter buys no freshness a person
could produce.

The cost side: one request per tick, against an API that allows roughly 100 per 20
seconds per app. About 240 requests across a default four-hour window (120 min
lead + service + 60 min tail), a few hundred a week, and none outside a window.
Well inside PCO's budget and far below the live timer's own traffic.

The cadence is independent of the cache TTL in both directions. The tick passes
`{ fresh: true }` to `fetchTeamMembers`, which drops the plan's roster cache entry
first (`pcoService.clearTeamMembersCache`, narrower than `clearPlanCache` so the
plan's items, notes, attachments and times are not re-pulled alongside it). So the
cadence is exactly this number, and does not become an accident of whatever TTL a
later release picks.

### Racing the plan itself

Inside a window the tick fires every minute, and auto plan-mode can roll from the
9am plan to the 11am one at any point — so the two overlap by design. Two guards:

- `fetchTeamMembers` re-checks, **after** the await, that the state still points at
  the plan it fetched for. A roster that resolves late is discarded rather than
  applied; without this it would put the previous service's names on every stage
  display until the next tick. This also covers the manual `refresh()` path, which
  never set the in-flight flag at all.
- The tick has its own reentrancy flag. `listTeamMembers` paginates and backs off
  on a 429, so a slow window can outlast the 60s cadence; the pre-existing
  `isRefreshing` was set only by `autoRefreshTick` and so guarded one direction of
  one path.

Both are tested, and both go red on removal.

### Reusing the existing window, and no host clock

Gated on `serviceWindow` (`main/services/service-window.ts`) — the app's one
definition of "near a service": PCO's rehearsal and service times widened by the
operator's configured lead and tail, recomputed by
`stageController.refreshServiceWindows`. No second definition was invented, and no
wall clock is consulted: the window is built from plan-time instants, so there is
no host-vs-app-time-zone question to get wrong.

`isActive()` fails **closed** when no windows are known — no credentials, or a
failed schedule fetch. The roster then moves on the operator's configured interval,
exactly as it did before this existed. That is the deliberate direction: failing
towards *more* requests would hit every install that has never had a window
computed. (Note this differs from `pollDelayMs`, which fails open; that one is
protecting a live poller from going quiet, a different risk.)

`pollDelayMs` was considered for this and rejected: it fails open with no windows
(60s roster requests forever on an unconfigured box) and, with a window ahead, it
returns `min(untilOpen, ceiling)`, which would refresh *more* often than today
outside a window.

### Efficiency

The tick recomputes and broadcasts only when the roster actually changed.
`broadcast()` already drops an identical state, so the saving is
`recomputeResolved()` — which re-resolves every view, every inline slots grid and
every view-sourced grid, once a minute for hours, on minutes where nothing moved.

### One thing this does NOT gate on

`serviceWindow.isActive()` ignores `reconnectSchedule.enabled`, unlike
`capDelayMs` and `pollDelayMs` which both short-circuit on it. That switch governs
integration reconnect back-off, not how fresh PCO data is, so turning it off does
not stale the roster back out — the lead and tail under it still shape the window.
Worth knowing because an operator looking for a way to stop this traffic would
reach for that switch and it would do nothing. Called out in the code and in
`docs/integrations/planning-center.md` rather than wired up, because coupling
roster freshness to a reconnect setting would be the more surprising behaviour.

---

## 2. MEDIUM cache TTL: 45s inside a window, 3 min outside

`main/services/pco-service.ts`

Three minutes is right for the ~95% of the week that is not a service. It is wrong
for the hours either side of one, which is exactly when someone is editing the plan
and a display is showing the result. `TTL_MEDIUM_WINDOW_MS = 45_000` applies
inside a `serviceWindow`; `TTL_MEDIUM_MS = 3 * 60_000` is unchanged outside.

45s is short enough that an edit lands before the next thing happens on stage, and
long enough that the live timer's ~1 Hz reads of `listPlanItems` still coalesce
onto one request rather than one per tick.

### Read time, not write time — and why

The switch lives in the **cache entry's TTL, resolved on read**. `CacheEntry`
changed from `{ value, expiresAt }` to `{ value, writtenAt, ttl }` where `ttl` may
be `number | (() => number)`; `cacheGet` resolves it on every read. The six MEDIUM
call sites pass the function `mediumTtlMs`; every other tier still passes a number
and behaves exactly as before.

Write-time evaluation was the simpler diff — one helper call per site, no change to
the entry shape — but it freezes the decision at the moment of the write. An entry
written three minutes before a window opens would live out its full three minutes
*inside* the window, so the tightening would not take effect until the entry it was
meant to shorten had already expired on its own. Read-time makes the boundary exact
in both directions: a window opening shortens entries already in the cache, and a
window closing relaxes them back to three minutes. Both directions are tested.

The expiry comparison is arithmetically identical to before
(`now > writtenAt + ttl` became `now - writtenAt > ttl`), so no other tier's
semantics moved.

### The live timer is untouched

Confirmed: `getLive()` calls `this.request(.../live?include=...)` directly with no
`cacheGet`/`cacheSet` around it, and this change touched only the cache internals,
the six MEDIUM call sites, and the request headers. `getLive` remains uncached and
real-time. A test pins the LONG tier at 15 minutes inside a window too, so the
change is provably scoped to MEDIUM.

---

## 3. `X-PCO-API-Version: 2018-11-01`, pinned

`main/services/pco-service.ts`

### What the documentation actually says

From PCO's own versioning page
(<https://api.planningcenteronline.com/docs/overview/versioning>): each product is
versioned by date, a request selects one with `X-PCO-API-Version: YYYY-MM-DD`, and
PCO resolves it with an **equal-or-earlier** match — ask for a date that does not
exist and you silently get the nearest earlier version, with no warning.

One correction to the premise this work started from. When the header is omitted,
PCO does not serve "the oldest version" as a rule; it serves **whatever is
configured as the app's default version in PCO's developer console**. That is
arguably worse than the premise: the version served was a property of one
organisation's console settings, invisible from this repository and different
between installs. Pinning makes it a property of the code.

### The version string

Services publishes exactly **two** versions, per the version selector on
<https://api.planningcenteronline.com/docs/apps/services> (confirmed on a second
page, the `plan_time` vertex doc):

| Version | Status |
|---|---|
| `2018-08-01` | withdrawn 2 April 2024 |
| `2018-11-01` | current, and the only one still served |

Pinned: **`2018-11-01`**. Deliberately an exact date, never a floating "newest"
sentinel — a floating request would let a PCO release change field names, defaults
or pagination under a running install with no code change here. The constant
`PCO_API_VERSION` carries when it was chosen and how to bump it.

### Products called

Only Services. A grep for `planningcenteronline` across `main/` finds the
`services/v2` base and nothing else — no People, Groups, Calendar or Publishing
endpoint. The two other PCO-adjacent fetches are not API calls and correctly carry
no version header: `photo-cache.ts` fetches an avatar image from
`avatars.planningcenteronline.com`, and `pco-attachment-cache.ts` downloads a
pre-signed file URL.

### Migration risk between 2018-08-01 and 2018-11-01

The only change PCO documents between the two is in the changelog entry for ending
support for `2018-08-01`: `2018-11-01` makes the **`/people` endpoint** respect the
"Can view people not on My Teams" permission. This client calls no `/people`
endpoint. Every URL it builds is under `/services/v2/service_types/...`:
`service_types`, `plans`, `plan_times`, `items`, `notes`, `note_categories`,
`teams`, `team_positions`, `team_members`, `all_attachments`, `live`, and the
`/services/v2` root for the org time zone.

Practically, `2018-08-01` was withdrawn in April 2024, so any install running today
is **already** being served `2018-11-01` whatever its console default says. This
change does not move an install onto a new version; it stops the version being
decided somewhere this repository cannot see.

### What could NOT be verified without credentials — flag for a human

- **The header round-trips.** Unauthenticated probes of
  `https://api.planningcenteronline.com/services/v2` return `401` before any
  version validation, identically with no header, with `2018-11-01`, with
  `2010-01-01` and with `2026-01-01`. So the probes prove nothing about how PCO
  treats the header. A credentialed request is needed to confirm PCO accepts it and
  echoes the expected version.
- **The `include=person` path.** The documented `2018-11-01` behaviour change is on
  the `/people` endpoint, which this client does not call — but it reads person
  records through `team_members?include=person,team`. Whether the same permission
  filter applies to *included* person records is not documented either way. With a
  Personal Access Token (organisation-scoped) it should not filter anything, but
  that is reasoning, not evidence.
- **Field-level parity.** Nothing was diffed field-by-field between the two version
  schemas against live data.

**Recommended credentialed check before this reaches production:** connect a real
organisation, then confirm the roster (names, positions, photos), the plan item
list, plan notes, plan times and the live countdown all still render, and that
`/api/log` shows no new `PCO API error` lines.

---

## Guards, and the proof each one goes red

Every guard drives the real code path (real client, real controller, real cache)
with a stubbed `fetch` and, where needed, a stubbed clock. None of them reads
source text — a source scan is satisfied by the constant existing, and the bug in
each case is a call site that does not use it.

Each window-dependent guard tests **both** sides. A test that only pinned the fast
path would stay green if the window check were deleted outright.

| Change | File | Red-proof performed | Failing test |
|---|---|---|---|
| Version header | `main/services/pco-api-version.test.ts` | deleted the `"X-PCO-API-Version"` line from `pcoHeaders` | **`a GET carries the pinned version`** (4 of 5 red) |
| In-window TTL | `main/services/pco-window-ttl.test.ts` | (a) made `mediumTtlMs` return `TTL_MEDIUM_MS` unconditionally | **`inside a window a MEDIUM entry expires by 60s`** (2 red) |
| In-window TTL | same | (b) resolved the TTL at write time instead of read time | **`a window opening AFTER the write shortens an entry already cached`** (2 red) |
| Roster cadence | `main/services/roster-window-refresh.test.ts` | deleted the `serviceWindow.isActive()` guard | **`a tick outside every window makes no request at all`** (3 red) |
| Roster cadence | same | removed the `setInterval` that arms the roster timer | **`startAutoRefresh arms the roster timer and stopAutoRefresh clears it`** |
| Roster cadence | same | dropped `{ fresh: true }` from the tick's `fetchTeamMembers` call | **`back-to-back ticks each reach PCO rather than being served from cache`** |
| Stale-plan write | same | removed the post-await plan-identity check | **`a roster that resolves after the plan moved on is discarded`** |
| Tick reentrancy | same | removed the `rosterRefreshing` flag | **`a slow tick does not overlap the next one`** |
| Fourth fetch site | `main/services/pco-api-version.test.ts` | added a rogue `fetch(url)` method to `PcoService` | **`a new endpoint cannot reach the network without the version header`** |

Each reversion was applied, the suite watched go red in this session, and the file
restored and re-run green before moving on.

Two of those deserve a note:

- The reentrancy guard originally failed as a **hang** rather than an assertion,
  because the second tick blocked on the same held promise the test was awaiting.
  A guard that hangs reads as a stuck suite, not as a caught bug, so the test was
  restructured to start the second tick without awaiting it, assert, and only then
  release. It now fails in under a millisecond.
- The fourth-fetch-site guard was also checked in the *other* direction: adding
  `fetch(` inside both a line comment and a block comment leaves it green. A scan
  that a comment can satisfy is the exact trap CLAUDE.md names, so this was proven
  rather than assumed.

The three new files add 26 tests. Suite total: **2588 passing, 0 failing**
(539 suites).

`npx tsc --noEmit`, `npx eslint main/ renderer/`, `npm test` and `npm run build`
all clean.

### Real server

The server was booted on port 8799 against a scratch data directory and left
running past several roster ticks. It came up clean, `/api/version` kept
answering, and the log carried no `roster refresh failed` line and no unhandled
rejection — the tick returning early with no windows known, as designed. (The one
error in that log is a pre-existing OSC `EADDRINUSE` on port 9000 on this dev
machine, unrelated to this change.) Killed by port, never by process-name match.

This exercises the timer wiring and the no-window path on a real server. The
in-window path could not be driven there without live PCO credentials, which is
why the roster tick is tested against the real controller instead.

---

### Review passes

Correctness and simplification passes were run over the diff. They found one real
bug and four wrong or misleading comments, all fixed before this was committed:

1. **Stale-roster write (real bug).** `rosterRefreshTick` read an `isRefreshing`
   flag that only `autoRefreshTick` ever set, so the guard was one-directional and
   missed the manual `refresh()` path entirely. With auto plan-mode rolling plans
   mid-window, an in-flight roster could resolve after the plan changed and put the
   previous service's names on every stage display for up to a minute. Fixed with a
   post-await plan-identity check plus a reentrancy flag; both guarded.
2. **The version guard could not catch a fourth fetch site.** It covered the three
   sites that exist, which would all stay green if a new endpoint were added with
   its own hand-written `fetch` — the "fixed in one of three copies" failure this
   repo keeps repeating. Fixed structurally: all three now go through one private
   `pcoFetch`, which is the only thing in the file that calls `fetch`, so the
   headers are unskippable by construction. An exact-count guard pins that.
3. **A comment claimed 45s was "set just under" the 60s cadence so every tick is a
   real read.** False — `fresh: true` means the tick never consults the TTL. The
   comment invented a constraint a maintainer would have honoured needlessly.
4. **A comment justified the change-check by "must not wake every display".**
   `broadcast()` already dedupes on state. The real saving is `recomputeResolved()`.
5. **Two overstatements about clocks and boundaries** — "exact in both directions"
   (an entry written in-window and read after it closes correctly gets 3 minutes)
   and "needs no wall clock of its own" (`isActive()` does call `Date.now()`; what
   it avoids is the *time-zone* question). Both corrected, given how specific
   CLAUDE.md is about clocks.

Updating `pcoFetch` also broke a pre-existing guard in `pco-link-safety.test.ts`
that pinned an exact count of three `fetch(` sites. That guard was updated to the
new shape — one raw sink plus three `pcoFetch(url` callers, each still taking the
origin-checked `url` — rather than loosened.

What the passes checked and cleared:

- `getLive()` has no `cacheGet`/`cacheSet` in its body — still uncached.
- Expiry arithmetic is unchanged for every non-MEDIUM tier; 13 `cacheSet` sites,
  6 MEDIUM (all converted), 7 untouched.
- `pauseBackgroundWork` stays correct: both timers are armed and cleared strictly
  together, so its single `autoRefreshTimer` check is a valid proxy for both.
- The roster tick can interleave with a manual `refresh(true)`, but both write a
  valid roster for the same plan, so there is nothing to corrupt.
- No PCO **API** fetch site lacks the version header. The two remaining fetches
  under `main/` that touch a PCO domain — `photo-cache.ts` (avatar image) and
  `pco-attachment-cache.ts` (pre-signed file URL) — are asset downloads that send
  no `Authorization` header either, and are correctly outside this contract.
- No credentials, real service-type ids, LAN addresses or church names in the
  code, tests, comments or this report.

## Notes on the shape of the change

- `makeAuthHeader` (a string) became `pcoHeaders` (the whole header record). The
  three fetch sites — the GET in `requestInner`, the Live-control POST in
  `postAction`, and the attachment-open POST in `postJson` — had drifted into three
  hand-written copies of the same header literal. Fixing the version pin in one of
  three is the failure mode this repository keeps repeating, so the duplication was
  removed rather than patched three times. A guard exercises all three.
- `teamMembersCacheKey` exists so the roster reader and the targeted invalidator
  cannot drift apart.
- The one new `catch` is at the timer boundary in `startAutoRefresh`, where
  `autoRefreshTick` and `updateCheckTick` already report and continue. There is no
  caller to hand a failure back to, and an unhandled rejection out of a timer would
  take the server down mid-service. `fetchTeamMembers` still reports its own failure
  and keeps the last-known roster on screen rather than blanking it.
