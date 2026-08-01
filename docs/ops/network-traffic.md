# What this puts on your network

Short version: during a service with every integration running and six screens
connected, Stage Utility uses **roughly 11 Mbit/s across the whole LAN** — about
2 Mbit/s per screen. Idle, between services, it is close to zero.

The figures below are computed from payloads measured on a real install and the
cadences in the code, not captured from a packet trace. Where a number depends on
an assumption, the assumption is stated.

## Where the traffic goes

Everything a screen receives arrives on one SSE stream (`/api/events`), plus a few
one-off HTTP fetches when the page first loads.

| Channel | Size | Cadence | Notes |
|---|---|---|---|
| `stage:state` | **34.6 KB** | up to ~6.7/s during a service | the big one — see below |
| `pco:live` | ~1.2 KB | on change, else a 15s keepalive | the countdown ticks client-side |
| `spl:metrics` | <1 KB | 1 Hz while Smaart is connected | |
| photos | ~1.3 MB total | **once**, then cached forever | content-addressed URLs |
| app bundle | ~900 KB | **once per deploy** | fingerprinted, `immutable` |

## Why `stage:state` dominates

Wireless receivers report RF and audio level about once per second per channel.
Those values live on the slots inside `stage:state`, so each batch of updates
means the state genuinely changed and has to go out. A 150 ms trailing debounce
collapses sixteen channels' worth of chatter into at most **~6.7 pushes a second**
(`DEVICE_STATUS_FLUSH_MS` in `stage-controller.ts`).

That cadence is what makes the payload size matter so much:

| | payload | per screen | 6 screens |
|---|---|---|---|
| before the 2026-08 efficiency pass | 217.9 KB | ~1.4 MB/s | **~70 Mbit/s** |
| now | 34.6 KB | ~230 KB/s | **~11 Mbit/s** |

Most of that came from two things that had no business being in a broadcast: the
branding logos, which were 168 KB of base64 re-sent on every push, and two
deprecated fields that carried duplicate copies of the slot list. Neither changed
between pushes; both are now fetched once (logos) or derived client-side (slots).

Gigabit copper never cared either way. Wi-Fi screens did.

## What keeps it small

- **Broadcast on change, not on a timer.** `stage:state` is deduped by a signature
  of its own contents, so a setter called with the value it already had sends
  nothing. Idle, the SSE stream is genuinely silent — measured at **0 bytes over
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
