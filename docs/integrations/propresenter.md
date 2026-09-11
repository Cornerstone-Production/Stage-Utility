# ProPresenter integration

Reads live slide, item, section, and timer status from ProPresenter over its
local network API and surfaces it on the dashboard and on custom-layout slide
objects (current/next slide text, notes, section, progress, thumbnail).

## How it works

ProPresenter 7.9+ exposes an official local HTTP API on the LAN (no auth).
`propresenter-service.ts` polls a handful of REST endpoints once per second while
a display is watching, dropping to a ~5 s keepalive when nobody is and backing
off (5 s, doubling) while the machine is unreachable:

- `GET /v1/presentation/active`
- `GET /v1/status/slide`
- `GET /v1/presentation/slide_index`
- `GET /v1/playlist/active` (+ `/v1/playlist/<uuid>`)
- `GET /v1/timers/current`

Fields are read defensively (each degrades to null) and assembled into a
`ProPresenterStatusDTO` broadcast on the `propresenter:status` channel. Every
field is verified against ProPresenter 21.3 / API v1. Slide thumbnails are
proxied through Stage at a fixed width. Multiple auditoriums are supported: the
primary instance keeps `propresenter:status`, extra instances get
`propresenter:status:<id>`, and a combined snapshot of all instances is
broadcast on `propresenter:instances` so a layout object can pick which one it
reads.

## Setup

**In ProPresenter:** Preferences → Network → turn the **Network API** on and note
the **port** (default 1025). The machine must be on the same network as Stage.

**In Stage:** Settings → Integrations → **ProPresenter** → enter a **Name**,
**Host** (IP), **API Port**, and optionally a **Poll interval**, enable it, and
**Test connection**. Add more auditoriums via extra instances.

Left blank, the poll runs at **1000 ms** while a display is watching. Set it
lower — 500 ms feels instant — at the cost of twice the requests; anything under
200 ms is ignored.

**On a layout:** add slide objects — current/next slide text, current/next slide
notes, current/next section, slide progress, slide thumbnail. Each can target a
specific ProPresenter instance.

## Triggering a macro from a rule

The **Trigger a ProPresenter macro** [automation](../automation.md) action runs
one of your own macros — whatever that macro does in ProPresenter, it does here.
Pick the instance and the macro; nothing else is configured. Leaving the
instance blank means the primary one.

It uses the same Network API the poll reads, so an instance that is set up needs
nothing extra. The request is `GET /v1/macro/<name>/trigger`, which is
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
