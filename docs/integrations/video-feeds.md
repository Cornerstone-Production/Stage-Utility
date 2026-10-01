# Video feeds

Shows camera and program video in layouts and on Home — the **Video** widget's
source. Feeds themselves are set up once on the **Video feeds** page, under
**Screens** in the sidebar.

## What a feed is

A feed is a name and a source, `{id, name, source}`. The `id` is a slug of the
name it was given when created and never changes, even across a rename — so
renaming a feed on the Video feeds page does not break any layout or Home card
already pointed at it.

## Kinds

| Kind | What it is |
|---|---|
| YouTube or Resi player | The platform's own embed, muted |
| Another WebRTC or HLS address | Something already serving WHEP or HLS, played as given |
| Pull from a device (RTSP, SRT, HLS) | Not available in this version |
| The device pushes to Stage Utility (SRT, RTMP, WHIP) | Not available in this version |

Only the first two kinds can be added right now. Pulling a feed from a camera
or encoder on the network, and letting a device push to Stage Utility, are not
available in this version.

### YouTube or Resi

Choosing **YouTube or Resi player** adds a **Player** field, then a field that
follows it:

| Player | Paste |
|---|---|
| YouTube, the channel's current live stream | The channel ID, which starts with `UC` — YouTube Studio, Settings, Channel, Advanced settings |
| YouTube, one video or stream | A YouTube watch/`youtu.be` URL, or a bare video id |
| Resi embed | Resi's embed code, or its player address (`https://control.resi.io/webplayer/…`) |

Either way the feed plays in the platform's own player, muted, and only while
the stream is public or unlisted — a private one has no embed to load. YouTube
runs 5 to 15 seconds behind live. This is a lobby feed, not a stage one: there
is no way to reduce that delay from inside Stage Utility. The feed list's pill
for it reads **Live on YouTube** or **Live on Resi**, which names the player the
feed uses. Stage Utility cannot see whether the platform's stream is actually
live.

### External WHEP or HLS address

For something that already serves WebRTC (WHEP) or HLS on its own — a switcher
or another box's relay. An address ending in `.m3u8` plays over HLS, anything
else over WebRTC. Stage Utility plays the address exactly as given and cannot
see whether it is up, so this kind carries no live/offline status and no pill:
it plays, or it retries. A failed attempt retries the same way after a delay
that starts at 1 second and doubles to 30, and never gives up; playback that
holds for 10 seconds starts the delay over.

The address may not carry a username or password (`https://user:pass@…`):
browsers refuse to play one, so it is refused when the feed is saved.

## The Video feeds page

One card: the list of feeds on the left, the selected feed's editor on the
right. Each row shows the feed's name, its status pill, a source line (the
kind, then the address or embed reference) and a line on how it plays. **Add
feed** sits under the last row.

The editor shows the feed's live picture, its **Name** and **Source**, and the
fields for that source, each with its label above it. Under **Save**,
**Cancel** and **Delete feed** it says which layouts use the feed. Delete asks
before it removes anything, naming those layouts again; the widgets in them
then show their offline state.

## The Video widget

Place a Video widget on a layout or a Home card and point it at a feed with
**Feed**. It is always muted, with no controls, and opens a connection only
while it is actually on screen and the browser tab is visible — scrolled past
or a hidden tab tears the session down after a few seconds, so it is never
holding a connection nobody is watching.

Settings, states and the "N s behind" badge are covered in the widget
reference: see [Video](../reference/widgets.md#video).

## Logging

Each screen writes `[video]` lines to [`/log`](../ops/updates-and-logs.md) from
the browser:

- A feed failing on a screen, once per failing streak: its first failure and
  the reason, a reminder at most every 5 minutes while it goes on failing
  (with how many attempts and for how long), and a line when it is playing
  again after holding for 10 seconds. Individual retries are not logged; the
  browser console shows each one, with its delay, at the Verbose level.
- A Video widget crashing, with the error. The rest of the layout keeps
  drawing.

## Screens previews

A layout's preview on the Screens page never opens a live connection to a
feed: a Video widget there shows **Video paused in preview** with a **Play**
button, so browsing layouts does not quietly connect to every feed on the
list. Press Play to watch it inside the preview.
