# Network traffic

During a service with every integration running and six screens connected, Stage
Utility uses about **1.4 Mbit/s across the whole LAN** for its own state and
control traffic — roughly 0.25 Mbit/s per screen. Video is separate and far
larger (see below): a feed playing on one screen costs about 6 Mbit/s for that
screen alone, on top of the figure above. Between services it is close to
zero.

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
| `messages:state` | see below | when a message is sent, an alert is cleared or runs out, a group changes, or the thread clears at midnight |
| `spl:metrics` | under 1 KB | up to 4 Hz while Smaart is connected |
| People's photos | ~1.3 MB total | once, then cached |
| App bundle | ~900 KB | once per deploy |

Wireless receivers report about once per second per channel, which is what sets the
6.7/s ceiling — a 150 ms debounce collapses sixteen channels into at most that many
pushes. Those readings travel on their own channel so a meter moving does not
re-send the plan, slot configuration and layouts along with it.

### Stage messages

`messages:state` carries the day's [stage messages](../features/stage-messages.md)
and the groups: `{ rev, groups, messages, alert }`. The groups are a few hundred
bytes; a short message adds about 0.2 KB and a 280-character alert about 0.45 KB,
so a day with twenty messages is under 4 KB. The 200-message cap is the ceiling:
about 36 KB of short messages, 90 KB if every one were a full-length alert. The
whole state is sent on every change, not just the new message.

It changes only when somebody acts: one frame per send, per cleared alert, per
group edit, once when an alert runs out, and once at midnight when the thread
clears. Between those it is silent, and with no messages sent it is a single small
frame when a client connects. It is part of the connect-time snapshot, so a
screen that connects while an alert is running shows it. A client that has named
the channels it renders and left this one out is not sent the changes.

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

## Video

A pull or push feed's own picture never travels over the event stream above:
each screen pulls its own copy straight from the relay, at about **6 Mbit/s
per screen per feed** (typical 1080p30 H.264, over WebRTC or HLS). Two screens
playing the same feed cost two copies of that traffic, not one shared between
them.

- **A pull feed's source is fetched only while something is watching it** — a
  Video widget on screen, or the editor's own preview. With nobody watching,
  there is no connection to the source at all, whatever the switch says.
- **The relay's own status poll runs only while something watches**
  `video:state` — the Video feeds page open, or a Video widget on screen
  anywhere. With nobody watching, the server asks the relay nothing.
- **Pulled cameras are checked only while the Video feeds page is open** — one
  RTSP `DESCRIBE` or HLS playlist GET per pulled camera every 15 seconds, never
  a stream. A client that names `video:probe` in its channel filter is what
  starts it; a display connecting, another page, or a client with no filter
  (curl, Home Assistant) does not. With the page closed the server sends the
  cameras nothing. A camera that wants a login takes two connections per check
  (the first is refused, the second carries the login), and a busy one
  (`406`) is asked up to two more times a moment apart, so up to three asks
  per check.

## Leaving your network

Planning Center, and whatever an embed or external feed points at — a YouTube
or Resi player reaches its own platform, and an external feed reaches whatever
address it names. Once, the first time video is switched on with a pull or
push feed, the server downloads the pinned MediaMTX release from GitHub
(about 27 MB), unless the archive was placed by hand; see
[Video feeds](../integrations/video-feeds.md#the-relay-and-its-switch). Every other integration is LAN-only, and so is a pull or
push feed: its picture passes through Stage Utility's own relay, but never any
further than the network the encoders and screens are already on. NDI is the
one path that skips the app entirely — discovered and received peer-to-peer by
the client.
