# ProPresenter integration

Reads live slide, item, section, and timer status from ProPresenter over its
local network API and surfaces it on the dashboard and on custom-layout slide
objects (current/next slide text, notes, section, progress, thumbnail).

## How it works

ProPresenter 7.9+ exposes an official local HTTP API on the LAN (no auth).
`propresenter-service.ts` holds **one server-sent-event stream per configured
instance** and makes no periodic requests at all while it is up. Connecting is
two requests — `GET /version` as the reachability probe, then:

```
POST /v1/status/updates?sse
["status/slide","presentation/slide_index","presentation/active",
 "playlist/active","timers/current","timer/system_time"]
```

A snapshot frame arrives per endpoint immediately, then a frame whenever one of
them changes, so a slide advance reaches a display as fast as the network
carries it. `timer/system_time` ticks once a second and is the heartbeat: TCP
keepalive plus a 15-second silence watchdog notice a stream that has died
without closing, which a half-open socket does. The stream stays open for as
long as the instance is configured, watched or not — an idle stream is cheaper
than any keepalive poll.

`/v1/playlist/<uuid>` is the one request made after connecting, and only when
the active playlist changes. It supplies the "next service item" name. A
playlist the API refuses — it answers 404 for a Planning Center linked playlist
— is retried on a back-off (30 s, doubling to 10 minutes) rather than on every
frame, and everything else on the panel is unaffected.

If a ProPresenter refuses `status/updates`, the service falls back to polling
the same endpoints as REST reads, at the configured poll interval, and says so
in the log.

Fields are read defensively (each degrades to null) and assembled into a
`ProPresenterStatusDTO` broadcast on the `propresenter:status` channel. Every
field is verified against ProPresenter 21.3 / API v1. Slide thumbnails are
proxied through Stage at a fixed width. Multiple auditoriums are supported: the
primary instance keeps `propresenter:status`, extra instances get
`propresenter:status:<id>`, and a combined snapshot of all instances is
broadcast on `propresenter:instances` so a layout object can pick which one it
reads. Each instance holds its own stream with its own reconnect back-off, so
one auditorium being switched off does not affect the other.

### What the log says

```
[propresenter] streaming 6 endpoints from 192.168.0.123:1025
[propresenter] stream ended (closed by ProPresenter) — reconnecting in 5s
[propresenter] status/updates unsupported (HTTP 404) — falling back to polling
[propresenter] playlist unreadable on 192.168.0.123:1025 (HTTP 404) — no next-item name, retrying in 30s
[propresenter] 192.168.0.123:1025 unreachable (connect ECONNREFUSED) — backing off, will keep retrying quietly
```

## Setup

**In ProPresenter:** Preferences → Network → turn the **Network API** on and note
the **port** (default 1025). The machine must be on the same network as Stage.

**In Stage:** Settings → Integrations → **ProPresenter** → enter a **Name**,
**Host** (IP), **API Port**, and optionally a **Poll interval**, enable it, and
**Test connection**. Add more auditoriums via extra instances.

**Poll interval** applies only to the fallback: on a ProPresenter that supports
`status/updates`, updates are pushed and there is no interval. Left blank the
fallback polls at **1000 ms**, dropping to a 5 s keepalive when no display is
watching; anything under 200 ms is ignored.

**On a layout:** add slide objects — current/next slide text, current/next slide
notes, current/next section, slide progress, slide thumbnail. Each can target a
specific ProPresenter instance.

## Triggering a macro from a rule

The **Trigger a ProPresenter macro** [automation](../automation.md) action runs
one of your own macros — whatever that macro does in ProPresenter, it does here.
Pick the instance and the macro; nothing else is configured. Leaving the
instance blank means the primary one.

It uses the same Network API the status stream reads, so an instance that is set
up needs nothing extra. The request is `GET /v1/macro/<name>/trigger`, which is
ProPresenter's own design for a command.

The macro is identified by its **name**, not by its uuid. A name means the same
thing on every machine and survives re-importing a library, where a uuid is
per-machine and does not — so one rule works in both auditoriums. The trade is
that renaming a macro in ProPresenter stops the rule finding it; the action then
fails with `no macro called "SONG INTRO" on MA`, which is also what the log says:

```
[propresenter] macro "SONG INTRO" triggered on MA
[propresenter] macro "SONG INTRO" failed: no such macro on MA (404)
```

The macro dropdown lists the names every configured instance reports, read fresh
at most every 30 seconds. An instance that is switched off contributes nothing
and never blocks the editor from opening; when more than one is configured, a
name only some of them have is marked `DOORS (MA only)`. A macro already chosen
on a rule is shown whether or not the machine holding it is reachable.

With **Simulate mode** on, the action reports what it would trigger and contacts
nothing — a rule can be written and tested with the booth machine off.
