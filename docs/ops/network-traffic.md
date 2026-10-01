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
| `stage:state-changed` | ~35 KB | only when something structural changes |
| `pco:live` | ~1.2 KB | on change, else a 15s keepalive |
| `spl:metrics` | under 1 KB | up to 4 Hz while Smaart is connected |
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
  the transcript. A layout — Home, a custom view, a console — reads and subscribes
  only to the sources its placed widgets draw, so a wall showing a clock asks for
  nothing else. A hidden widget and one inside an embedded view still count. A
  Home tile set to show only during a service, or only the rest of the week,
  does not count until it shows. The layout editor is the exception: it
  subscribes to everything, so every widget's preview has data.
- **Nothing is produced for nobody.** An integration with no subscribers stops
  resolving and serialising.
- **Images are content-addressed and immutable.** Logos and layout images are
  named by a hash of their bytes, and a person's photo by Planning Center's URL,
  which changes when the photo does; all are cached for a year, except a
  full-size photo standing in for a smaller copy Planning Center has not sent. A slots DISPLAY
  has its photos cropped to the column shape they are drawn at, which is a tall
  sliver — that is the saving. An inline mic-slots object on a custom layout is
  whatever size it was dragged to, so nothing server-side knows its shape: it
  receives the whole image and the browser crops it.
- **Photos come at the size they are drawn.** Each slot asks for the device
  pixels its photo covers, so a Screens-page preview, drawn at under half size,
  downloads a fraction of what the screen itself does: for an 11-slot and a
  9-slot mic board, 330 KB of photos on a 2x laptop screen and 100 KB at 1x,
  against 837 KB on the full-size screens. See
  [Photos](../integrations/planning-center.md#photos).

Idle, the stream is silent: measured at 0 bytes over 12 seconds on a server with
nothing happening.

A screen on the [polling transport](../display-urls.md#polling-transport)
(`?transport=poll`) is the exception: it costs one request every two seconds
whether or not anything changed — about 43,000 a day, mostly empty answers. Use
it only on a browser that cannot hold the stream.

## Between services

Integrations back off toward a dormant ceiling (see [reliability](reliability.md))
and the Planning Center poll stretches from 4 seconds to 5 minutes. With nothing
changing, nothing is pushed. A screen left on overnight costs a keepalive.

## Leaving your network

Only Planning Center. Every other integration is LAN-only, and video never passes
through the app — NDI is discovered and received peer-to-peer by the client.
