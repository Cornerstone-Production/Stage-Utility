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
  pasted long-lived static token is also accepted and skips the exchange.
- Per-zone breakdown comes from `/data/traffic` (`entityType=zone`), summed per
  zone. The Vea traffic endpoint has no working server-side location/zone filter,
  so Stage always requests every zone and narrows to the selected zones
  client-side. `attendance = Σ ins`, per-zone `occupancy = ins − outs` (clamped ≥0).
- The building total is overridden from the authoritative `/data/occupancy`
  (`entityType=space`) endpoint when a space exists — matching the Vea dashboard's
  live "Most Recent Occupancy" — with peak/min/avg/capacity. It falls back to the
  zone-derived net when a site has no spaces.
- The zone-traffic and day-occupancy requests are issued together rather than one
  after the other; the per-minute occupancy request follows only when the day
  response reports at least one space. Both parallel requests ask for a Bearer
  token, so the client-credentials exchange is de-duplicated behind a single
  in-flight promise.
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
dormant with the other integrations.

The trend buffer behind the people-graph samples on its own 45s clock rather than
once per poll, so its ~3h span does not shrink when the interval drops.
