# What this puts on your network

Short version: during a service with every integration running and six screens
connected, Stage Utility uses **roughly 1.4 Mbit/s across the whole LAN** — about
0.25 Mbit/s per screen. Idle, between services, it is close to zero.

The figures below are computed from payloads measured on a real install and the
cadences in the code, not captured from a packet trace. Where a number depends on
an assumption, the assumption is stated.

## Where the traffic goes

Everything a screen receives arrives on one SSE stream (`/api/events`), plus a few
one-off HTTP fetches when the page first loads.

| Channel | Size | Cadence | Notes |
|---|---|---|---|
| `stage:state` | ~35 KB | only when something structural changes | plan, slots, views, routing |
| `slots:devices` | **4.5 KB** | up to ~6.7/s during a service | RF, battery, audio level — see below |
| `pco:live` | ~1.2 KB | on change, else a 15s keepalive | the countdown ticks client-side |
| `spl:metrics` | <1 KB | 1 Hz while Smaart is connected | |
| photos | ~1.3 MB total | **once**, then cached forever | content-addressed URLs |
| app bundle | ~900 KB | **once per deploy** | fingerprinted, `immutable` |

## Why the telemetry channel exists

Wireless receivers report RF and audio level about once per second per channel.
A 150 ms trailing debounce collapses sixteen channels' worth of chatter into at
most **~6.7 pushes a second** (`DEVICE_STATUS_FLUSH_MS` in `stage-controller.ts`).

Those readings used to live on the slots inside `stage:state`, so every one of
those pushes re-sent the whole document — and **88% of it was views, slot
configuration, layouts and routing that had not changed**. There is no HTTP cache
to lean on here: SSE is a push stream, so the only way to stop re-sending
something is to stop putting it in the message. Telemetry now travels on its own
channel and the client merges it back onto the slots.

Three changes, compounding, on the same 6.7/s cadence:

| | payload | 6 screens |
|---|---|---|
| originally | 217.9 KB | **~70 Mbit/s** |
| after moving logos out and dropping duplicate slot copies | 36.6 KB | ~11.8 Mbit/s |
| after splitting telemetry onto its own channel | **4.5 KB** | **~1.4 Mbit/s** |

The logos were 168 KB of base64 re-sent on every push; two deprecated fields
carried second and third copies of the slot list. None of it changed between
pushes. Gigabit copper never cared. Wi-Fi screens did.

## What keeps it small

- **Volatile data is separated from static data.** What changes every tick travels
  on `slots:devices`; what changes when someone edits something travels on
  `stage:state`. Both are deduped by a signature of their own contents, so a
  setter called with the value it already had sends nothing. Idle, the SSE stream is genuinely silent — measured at **0 bytes over
  12 seconds** on a server with nothing happening.
- **Channel filtering.** A client subscribes to the channels it renders; a screen
  showing slots is not sent the transcript.
- **Nothing is pushed to nobody.** Producers check `channelHasSubscribers()` before
  doing the work, so an unwatched integration stops re-resolving and re-serialising.
- **Images are content-addressed and immutable.** Logos, layout images and people's
  photos are named by a hash of their bytes and served `max-age=31536000, immutable`,
  so a screen fetches each one once, ever. A changed image is a new URL.
- **Photos are cropped to the shape they are drawn at.** Slots are tall and narrow;
  asking Planning Center for a square avatar meant most of every download was
  cropped away and thrown out.

## Between services

Outside a service window there is almost nothing. Integrations back off toward a
dormant ceiling (see [reliability](reliability.md)), the Planning Center poll
stretches to five minutes, and with no state changing the SSE stream sends nothing
at all. A screen left on overnight costs a keepalive and little else.

## Outbound

The only traffic that leaves your network is Planning Center. Every integration —
ProPresenter, OBS, REAPER, Smaart, wireless, OSC, RossTalk, ProdCom, SenSource — is
LAN-only, and video never passes through this app: NDI is discovered and received
peer-to-peer by the client.
