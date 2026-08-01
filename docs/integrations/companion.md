# Bitfocus Companion

Drives and reads Stage Utility from [Bitfocus Companion](https://bitfocus.io/companion)
— Stream Deck buttons for plan control, view routing and blackout, with feedback
from the live service.

The module is a separate repository:
[companion-module-cornerstone-stageutility](https://github.com/Cornerstone-Production/companion-module-cornerstone-stageutility).

## How it connects

The direction is reversed from every other integration: Stage Utility dials out
to nothing. The Companion module connects **to** this app's existing HTTP/SSE
server on port 8788, so the in-app integration carries no config fields and
stores no secret.

The module marks its event stream with an `X-Companion-Module` header (or
`?client=companion`). The server counts those streams and reports the total to
the integration manager, which is what the settings panel's "N connected" shows.
The in-app integration is therefore presence and guidance only — there is nothing
to enable or test.

## Setup

**In Companion** — add a **Cornerstone Stage Utility** connection and enter this
server's IP and port. No password; the API is LAN-only.

**In Stage Utility** — Settings → Integrations → **Bitfocus Companion** shows the
LAN IP and port split into separate copyable fields, because Companion takes host
and port separately and cannot resolve a DNS name. A live connected-client count
sits alongside them.

## What the module exposes

**Actions** — PCO Live next/previous, refresh lineup, jump to next plan, set plan,
set service type, set plan mode, route a view to an output, blackout an output,
refresh displays, apply a preset, show/hide the QR code.

**Feedbacks** — countdown overtime, mic battery low, mic offline, ProPresenter
disconnected, plan in manual mode, output showing a given view, output blacked
out, occupancy over a threshold, captions idle, and a people-count text feedback
that writes the count onto a button.

**Variables** — plan and series title, service type, plan mode, ProPresenter
current/next item and slide position, PCO countdown label and seconds, mics
online and total, lowest battery and its channel, last caption text and speaker,
people attendance and occupancy (with per-zone variables), last sync time.

## Network cost

**The module is event-driven, not polling.** It holds one SSE connection to
`/api/events` and reacts to pushes. A local one-second timer ticks the countdown
and re-evaluates the two time-relative feedbacks — that runs in the module's own
memory and puts nothing on the network.

It listens to seven channels: `server:hello`, `stage:state-changed`, `pco:live`,
`propresenter:status`, `prodcom:transcript`, `wireless:connections-changed`,
`people:count`.

REST is used for two things: writes (every action is a POST), and a hydrate on
connect that fetches nine endpoints in one burst — state, views, outputs, service
types, presets, wireless channels, PCO live, ProPresenter status and people
count.

**Poll fallback is off by default** (`0` seconds) and should stay that way unless
an SSE connection cannot be kept open. When enabled it re-runs that nine-endpoint
hydrate on every tick, so a five-second fallback is 108 requests a minute, most
of them for configuration that rarely changes.

### Known inefficiency

The module does not call `POST /api/events/subscribe`, so the server has no
channel filter for it and sends **every** channel — including the 4 Hz
`spl:metrics` stream, which the module discards client-side. Reporting its seven
channels would let the fan-out skip the rest. See
[network traffic](../ops/network-traffic.md) for how the filter works.
