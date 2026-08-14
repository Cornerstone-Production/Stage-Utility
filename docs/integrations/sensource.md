# SenSource Vea integration

Polls the SenSource Vea people-counter API for live attendance and occupancy and
surfaces them on stage displays via the **people-counter**, **people-graph**, and
**people-panel** custom-layout objects.

## How it works

SenSource has no real-time endpoint, so the poller
(`main/services/sensource-service.ts`) queries the Vea REST API on an interval
(default 45s; counts lag a few minutes server-side, so lower values add API calls
without fresher data).

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

The poll interval you set is the rate while a display is showing the count. With
nothing watching, it polls more slowly — never faster than the interval you set,
so raising it to stay inside an API quota does what you expect.

A failing endpoint backs off instead of retrying at full rate, and logs the first
failure rather than one line per attempt. Outside the service window it goes
dormant with the other integrations.
