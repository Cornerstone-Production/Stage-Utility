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
- If the site also has **SafeSpace**, the occupancy — and only the occupancy —
  comes from there instead, on its own faster interval. See
  [SafeSpace live occupancy](#safespace-live-occupancy).
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

## SafeSpace live occupancy

SafeSpace is SenSource's other product. Where Vea reports a day's worth of
counting — attendance, per-zone traffic, peak, mean, capacity — SafeSpace
publishes one number per space: how many people are in it right now, updated far
more often than Vea's ~78-second refresh.

It is part of this integration rather than a second one, because it is the same
vendor and the same payload. When a space ID is set, **the occupancy comes from
SafeSpace and everything else still comes from Vea**. Attendance, the zone
breakdown, today's peak / lowest / mean and the capacity are unchanged. Nothing
about SafeSpace is required: leave the field blank and Vea answers everything, as
it did before.

**Where the space ID comes from.** In SafeSpace, open the space and take the
live-occupancy value's embed address — the ID is the last path segment of
`app.safespace.io/api/raw-data/live-occupancy/<space ID>` (their UI may show the
`display.safespace.io/value/live/<space ID>` form of the same thing, which ends in
the same ID). Paste that ID into **SafeSpace space ID** on the SenSource card, and
set **SafeSpace interval** if 10 seconds is not what you want.

**Treat the space ID as a credential.** The endpoint has no key, no token and no
account check — the ID is the whole of its authority, so anyone who has it can
read your occupancy from anywhere.

Stage keeps it out of every log line: the one place that builds a message
containing the URL redacts it first, so a failure on `/log` reads `<space id>`
rather than the value.

It is not stored with the Vea client secret. It is ordinary non-encrypted
integration config, which means it rides along in a **config snapshot** (Settings → Advanced → Data → Config snapshots, and in the automatic
backups) — a bundle otherwise presented as safe to keep on a drive or hand to
somebody. Handle a snapshot taken from a site with SafeSpace configured the way
you would handle the ID itself.

**What the reading does when it goes wrong.**

- **An empty response is unknown, never zero.** About one reading in six comes
  back with no number at all. Parsing that as 0 would report an empty building and
  fire every occupancy threshold in the app, so the last good value stands
  instead. Nothing is logged for a single empty response — it is the normal case.
- **A stale reading loses to Vea.** Once the newest SafeSpace value is a minute
  old, Vea's number is at least as current and the occupancy goes back to it.
- **A SafeSpace failure falls back to Vea rather than going blank**, and says so
  once per outage on the terms in [Logging an outage](#logging-an-outage) — not
  once per reading, which at a 10-second interval would be 360 lines an hour.
- **Rate limiting is read from the response, not assumed.** SafeSpace reports
  `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; Stage
  measures what a request costs from consecutive `Remaining` values and stops
  asking until the reset the server named, rather than trusting an observed quota.
  An `HTTP 429` honours `Retry-After`, capped at five minutes.

The published count says which product it came from: the `people:count` payload
carries `total.occupancySource` (`"vea"` or `"safespace"`), and the integration's
connection line on the Integrations panel names the source it used on the last
poll.

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

A failing endpoint backs off instead of retrying at full rate. Outside the service
window it goes dormant with the other integrations. See
[Logging an outage](#logging-an-outage) for what a failure writes to `/log`.

## Logging an outage

Each part of the poll that can fail on its own — the day aggregates, the live
minute series, the `/space` listing, the zone→location join, the token exchange,
each rejected path — is its own **outage**, logged once when it starts and once
when it ends, never once per poll.

A run does not end on the first success. It ends on a success that **holds** for
four poll intervals (at least two minutes). Vea fails by alternating: a request
is rejected, the next succeeds, the one after is rejected again. Under a
once-per-transition rule the intervening success clears the state and every
rejection is a fresh first failure, which is how this integration once wrote
3,527 warning and error lines in five days — 2,837 of them in one day — against
under 200 for everything else in the app combined. An alternating outage is one
run and one line.

- **A different kind of failure is always news.** A 503 arriving during a 401
  storm is a different problem and gets its own line, so a credentials error
  cannot mask the network error that replaced it.
- **A run that lasts reminds you every 15 minutes**, with how many attempts it
  has cost and how long it has been going, so a broken endpoint is never silent.
- **Every part that can open an outage also closes one.** A 401 storm on one
  endpoint, an unreadable `/space` listing, a broken zone join: each writes a line
  when it clears, naming what the run cost. An outage that opens with a line and
  ends in silence leaves an operator watching `/log` with no way to know.
- **The recovery line accounts for the run** it ended — nothing suppressed is
  dropped without being counted somewhere.
- **A response whose text changes every time** (a timestamp, a request id) cannot
  turn that into a line per poll.

The window is four *polls* rather than a fixed two minutes because the interval
has no ceiling. At the 300s an operator might set to stay inside an API quota, a
fixed window shorter than one poll would be outlasted by every success and the
rule would collapse back to once-per-transition.

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
request — so the reason is on `/log` once, on the terms in
[Logging an outage](#logging-an-outage).

The SafeSpace reading has its own interval and its own timer, and neither one
affects the other — a live number is only worth having if it is read often, and
tying it to a Vea interval raised to save API calls would throw that away. It is
on the same idle gate: with nothing consuming the count it drops to once a minute,
and a consumer arriving mid-wait pre-empts it.

The trend buffer behind the people-graph samples on its own 45s clock rather than
once per poll, so its ~3h span does not shrink when the interval drops.
