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

The module requires **Companion 4.3.0 or newer**, which is where Companion added
the v2 connection API the module is built against. On anything older it installs
and shows up in the module list, but the connection never starts — Companion
reports "Connection not found or not running" and loads no config, which looks
like a broken download rather than a version mismatch.

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
people attendance and occupancy (with per-zone variables), last sync time. Plus
one pair per automation signal — see below.

## Signals

An automation rule can publish a named value that a **Companion Trigger** acts on.
Stage Utility never presses a button and never contacts the device: it says what is
true, and Companion decides what to do. That keeps device actions — a Dante
crosspoint, say — inside the module that owns them.

Each signal becomes two variables:

| | |
|---|---|
| `$(stage:signal_<name>)` | the published value |
| `$(stage:signal_<name>_error)` | why the last evaluation failed; blank when healthy |

with feedbacks **Automation signal equals** and **Automation signal failed to
resolve**. `stage` is whatever you named the connection in Companion.

**Use letters, digits and underscores in a signal name.** The name becomes part of
a Companion variable id, and anything else may not resolve.

### Worked example: routing talkback

Production marks the talkback vocalist in Planning Center by adding a marker to
their note for that event, alongside the slot number they already use: `4 TB`.

In Stage Utility, under **Settings -> Automation**:

```
When:  Before a rehearsal or service      60 minutes, rehearsal + service
Then:  Set a Companion signal from the roster
         Signal name:      dante_tb
         Marker in notes:  TB
         Only this position: Vocals
         Send for each slot:  1 -> Vox 1
                              2 -> Vox 2
                              4 -> 31.Vox 4
```

In Companion:

```
Trigger
  When:  variable $(stage:signal_dante_tb) changes
  Then:  audinate-dantecontroller: Make Crosspoint
           Source Channel Name:  $(stage:signal_dante_tb)
           Destination Channel:  Lead TB
```

One trigger covers every slot, because the Dante module accepts variables in
every field. Adding a fifth slot is one row in the rule and nothing in Companion.

### What it does on failure

**Nothing, and it holds the previous value.** If nobody is marked, or two people
are, or the matched slot has no row in the table, the rule refuses and records why.
The last good route stays in place — an unrelated scheduling mistake must not take
talkback off mid-service.

Every outcome is in the automation Activity log, and the failure also lights the
**signal failed to resolve** feedback, so a button on the wall can go red. That is
the only way anyone learns about it in the moment.

### Two things to know

**The value you type is sent verbatim, and nothing validates it.** Dante channel
names may carry numeric prefixes (`31.Vox 4`) or be renamed at will, so the table
takes exactly what you see in Dante Controller. A typo produces a perfectly valid
signal that fails silently at the crosspoint — **test each row once after setting
it up.**

**A restart re-asserts the routing.** Variables are re-sent when the module
reconnects, so Companion re-runs the trigger. That is deliberate and self-healing,
but it does mean a crosspoint someone changed by hand will be put back.

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

The module reports those channels to the server. It sends a `cid` on the event
stream and posts its channel list to `POST /api/events/subscribe` when the stream
opens, so the fan-out skips everything else — notably the 4 Hz `spl:metrics`
stream, which the module has no use for. See
[network traffic](../ops/network-traffic.md) for how the filter works.
