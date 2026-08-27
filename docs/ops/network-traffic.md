# Network traffic

During a service with every integration running and six screens connected, Stage
Utility uses about **1.4 Mbit/s across the whole LAN** — roughly 0.25 Mbit/s per
screen. Between services it is close to zero.

Figures are calculated from measured payloads and the cadences in the code, not
captured from a packet trace.

## What a screen receives

Everything arrives on one event stream (`/api/events`), plus a few fetches when the
page first loads.

| Channel | Size | Cadence |
|---|---|---|
| `slots:devices` | 4.5 KB | up to 6.7/s during a service — RF, battery, audio level |
| `stage:state` | ~35 KB | only when something structural changes |
| `pco:live` | ~1.2 KB | on change, else a 15s keepalive |
| `spl:metrics` | under 1 KB | 1 Hz while Smaart is connected |
| People's photos | ~1.3 MB total | once, then cached |
| App bundle | ~900 KB | once per deploy |

Wireless receivers report about once per second per channel, which is what sets the
6.7/s ceiling — a 150 ms debounce collapses sixteen channels into at most that many
pushes. Those readings travel on their own channel so a meter moving does not
re-send the plan, slot configuration and layouts along with it.

## What keeps it small

- **Volatile and static data are on separate channels**, both deduplicated against
  their own last value. A setter called with the value it already had sends nothing.
- **Clients subscribe to what they render.** A screen showing mic slots is not sent
  the transcript.
- **Nothing is produced for nobody.** An integration with no subscribers stops
  resolving and serialising.
- **Images are content-addressed and immutable.** Logos, layout images and people's
  photos are named by a hash of their bytes and cached for a year — a changed image
  is a new URL. Photos are also cropped to the shape they are drawn at — for a
  display column, which is a tall sliver. An inline mic-slots object on a custom
  layout draws a much squarer cell, so it asks for a crop wide enough to keep a
  whole face (about 2x the bytes of a display's crop, for the slots on that
  layout only).

Idle, the stream is silent: measured at 0 bytes over 12 seconds on a server with
nothing happening.

## Between services

Integrations back off toward a dormant ceiling (see [reliability](reliability.md))
and the Planning Center poll stretches from 4 seconds to 5 minutes. With nothing
changing, nothing is pushed. A screen left on overnight costs a keepalive.

## Leaving your network

Only Planning Center. Every other integration is LAN-only, and video never passes
through the app — NDI is discovered and received peer-to-peer by the client.
