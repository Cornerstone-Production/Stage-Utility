# SenSource Vea integration

Polls the SenSource Vea people-counter API for live attendance and occupancy and
surfaces them on stage displays via the **people-counter**, **people-graph**, and
**people-panel** custom-layout objects.

## How it works

SenSource has no push, webhook or streaming endpoint, so the poller
(`main/services/sensource-service.ts`) queries the Vea REST API on an interval
(default 15s — see [Polling](#polling) for what that number is doing).

- Auth is transparent to the operator: they enter an API client **id + secret**
  (created in the Vea app) and Stage exchanges those for a short-lived Bearer
  token via the client-credentials call, refreshing before expiry. A directly
  pasted long-lived static token is also accepted and skips the exchange. See
  [Auth](#auth) for what happens when a token is rejected.
- Per-zone breakdown comes from `/data/traffic` (`entityType=zone`), summed per
  zone. The Vea traffic endpoint has no working server-side location/zone filter,
  so Stage always requests every zone and narrows to the selected zones
  client-side. `attendance = Σ ins`, per-zone `occupancy = ins − outs` (clamped ≥0).
- The building total is overridden from the authoritative `/data/occupancy`
  (`entityType=space`) endpoint when a space exists — matching the Vea dashboard's
  live "Most Recent Occupancy" — with peak/min/avg/capacity. It falls back to the
  zone-derived net when a site has no spaces.
- When the day request fails, today's peak, lowest, mean and capacity are
  carried forward from the last good response for up to ten minutes, and live
  occupancy stays this poll's. Attendance stays on the same source throughout:
  the last space-derived count advanced by what the zone traffic has counted
  since, never swapped for the raw zone total, which counts doors the space total
  does not and would otherwise step up and down on alternate polls in the field
  service history is recorded from. Past ten minutes — or once the date rolls
  over in the app time zone, whichever comes first — the carried values go back
  to unknown, the objects showing them read "—", and attendance falls back to the
  zone total.
- The zone-traffic and day-occupancy requests are issued together rather than one
  after the other; the per-minute occupancy request follows when the day response
  **or** the `/space` listing reports a space, so it still runs on a poll whose
  day request was rejected. Both parallel requests ask for a Bearer
  token, so the client-credentials exchange is de-duplicated behind a single
  in-flight promise.
- A poll whose configuration is replaced while it is in flight publishes nothing
  and carries nothing forward: its answers describe a scope the operator has
  already changed.
- Counts broadcast on the SSE channel **`people:count`** (skipping re-broadcasts
  when the substantive counts are unchanged); `GET /api/people/count` hydrates a
  freshly loaded display. A rolling trend buffer backs the people-graph.

## Setup

**In Vea:** Settings → API clients → create a client. It gives you a Client ID
and Secret — you enter both.

**In Stage:** Settings → Integrations → **SenSource Vea** → enter the **API Client
ID** and **API Client Secret** (leave the static token blank in the normal case),
set the **Poll interval**, enable it, and **Test connection** (authenticates and
reports how many locations are visible). Optionally pick a **location** and/or
specific **zones** to scope the count — zones are the reliable scoping mechanism.
The location/zone selection is saved as non-secret config; the client secret and
static token are stored encrypted.

**On a layout:** add object → **SenSource → people-counter / people-graph /
people-panel**.

## Service history

`attendance-recorder.ts` folds the live counts into a per-service record: it samples
every 30 s, keeps running peak/min/last, and broadcasts the open record on
**`attendance:history`** every 5 s so the History tab updates during a service rather
than only after it.

On the History **Overview**, the attendance trend chart includes the service that is
recording — its point is drawn hollow and its tooltip reads "recording", because that
weekend total is a partial that keeps climbing. Every computed stat (average, peak,
trend direction) is taken over finished services only; folding a partial peak into a
cross-service mean would understate it all morning and "recover" by noon. The two
scopes live in `renderer/settings/sections/overview-scope.ts`.

## Polling

**Vea's own numbers advance about every 78 seconds.** Measured against the live
API during a Sunday arrival ramp with roughly 31 people per minute entering — so
the true count was moving continuously, and any poll that saw no change was
seeing stale data. At a 45s interval the count changed on 60% of polls, and the
gap between changes was exactly one poll (30% of the time) or two (70%): the
signature of sampling a ~78s source.

That 78s belongs to SenSource and nothing here can shorten it. What the interval
controls is the delay Stage adds on top, which falls uniformly between zero and
one interval after each upstream tick:

| Interval | Delay Stage adds | Requests per minute |
| --- | --- | --- |
| 45s | 23s average, 46s worst | 4 |
| 15s (default) | 7.5s average, 15s worst | 12 |
| 10s (minimum) | 5s average, 10s worst | 18 |

An interval comparable to the upstream refresh is what puts a Stage display
behind the Vea web dashboard — not fresher data on Vea's side. Below 10s there is
nothing left to win, since the source has not moved, so the field will not go
lower.

Finer buckets do not help either: attendance comes from a day-grouped request and
live occupancy from a per-minute one, and across three hours of production
samples the two moved together on 92% of polls. The coarser grouping is not the
slower one.

The interval you set is the rate while something is consuming the count — a
display showing it, the attendance recorder during a service, a scoreboard feed,
or an automation rule, not just an open browser. With nothing consuming it, the
poll drops to once a minute, and a consumer arriving mid-wait pre-empts it rather
than sitting out the rest. It never polls *faster* than the interval you set, so
raising it to stay inside an API quota does what you expect.

A failing endpoint backs off instead of retrying at full rate, and logs the first
failure rather than one line per attempt. Outside the service window it goes
dormant with the other integrations. A partial failure — the day aggregates, or
the live minute series — is logged when it starts and when it clears, never once
per poll.

## Auth

**Give every Stage instance its own Vea API client.** Vea keeps one live token
per API client: minting a token invalidates the client's previous one. Two
instances sharing a client therefore knock each other offline in turn, and a
spare box left running is enough to do it to production.

Stage will not make that worse, and says so on the log when it sees it:

- A rejected request is retried once on the same token. Whether the token itself
  is at fault is decided **per poll**, once, from every request in that poll
  together — never from a single response, whose arrival order says nothing.
- One endpoint's 401 beside another endpoint's success is that endpoint failing.
  The request fails alone and the token is left in place.
- Every request in a poll rejected means the token is dead. A token more than a
  minute old is replaced immediately and the poll re-run once on the new one, so
  an ordinary token rollover costs a display nothing.
- A token rejected **within a minute of being issued** is not replaced — that is
  the loop two instances get into. It is dropped, a probable shared API client is
  reported with the fix named, and the poll backs off. The line is written at
  most once an hour, because the condition lasts until somebody changes the
  configuration.
- No token is minted more often than once every 30 seconds. That floor holds for
  the poller and for the **Test connection** button alike; a Test pressed inside
  the window reports how long is left rather than minting a second token. Saving
  the integration's settings resets the floor, so a corrected client id takes
  effect at once.
- Because a dead token is replaced and the poll re-run, a genuinely shared API
  client is usually recognised on the poll AFTER the one that first hit it: the
  re-run mints, the next poll's rejection is the one that arrives on a
  seconds-old token.
- `HTTP 429` on the token exchange honours `Retry-After`, capped at 15 minutes,
  or waits a minute when the response does not carry one.

The first rejected response of an outage is logged with what Vea said, per
request — so the reason is on `/log` once, whatever the body says. A response
whose text changes every time (a timestamp, a request id) does not turn that into
a line per poll.

The trend buffer behind the people-graph samples on its own 45s clock rather than
once per poll, so its ~3h span does not shrink when the interval drops.
