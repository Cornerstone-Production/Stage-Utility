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
| Pull from a device (RTSP, SRT, HLS) | Stage Utility's relay fetches it |
| The device pushes to Stage Utility (SRT, RTMP, WHIP) | The device connects to Stage Utility's relay |

The last two kinds go through Stage Utility's own video relay (MediaMTX,
behind an adapter — see the relay status line at the top of the Video feeds
page). A push feed always has a password; a pull feed's is optional, set
only if the device asks for one. Either way it is never shown back to the
browser once saved, and never carried in the feed list, `video:state`, or
any broadcast — only a push feed's own address and password (below) are
ever returned, and only for that one feed. The pull editor says "A password
is saved" once one is stored, without showing it, and offers Clear.

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

### Pull from a device

For an RTSP, SRT or HLS address on the LAN — a camera or encoder's own output.
**Address**, then **Username and password** if the device needs them. The
relay only dials the address while something is actually showing the feed
(a Video widget on screen, or the editor's own preview); nothing else keeps
it connected. Once a password is stored, the field says "A password is
saved. Type to replace it, or clear it." with a **Clear** button that
removes it at once; typing a new one and saving replaces it, and leaving
the field untouched on an edit leaves whatever is already stored.

A Magewell Ultra Stream can serve one feed to Stage Utility this way while
its first output keeps streaming to Resi: turn on the Ultra Stream's RTSP
server as its second output.

### The device pushes to Stage Utility

For a device that connects outward — OBS, a hardware encoder, ProPresenter's
own output. Choose **How it connects**: SRT, RTMP, or WHIP (OBS) — switching
it before saving previews that protocol's own address below, with the same
password, so there is no need to save just to see what each one looks like.
Saving the feed mints a random password, shown once the feed exists under
**Paste this into the device** — the exact address to paste, with **Copy**
(its label reads "Copied" for a moment after) — and **Password**.

The password is part of the SRT and RTMP addresses already (a device pushing
without it is refused); for WHIP it is OBS's Bearer Token, entered separately
under Settings, Stream, Service WHIP. **New password** replaces it and drops
whatever is currently connected, so the old password stops working
immediately rather than at the device's next reconnect. If the relay cannot
be reached to apply it, or cannot drop the current connection, the editor
says so rather than claiming it worked.

If the device sends B-frames, WebRTC cannot carry the picture and Stage
Utility falls back to HLS — a few seconds behind instead of under one. The
editor says so. For a feed set to WHIP this names OBS specifically, with its
own fix (Settings, Output, Streaming: Profile baseline, or Keyframe interval
1 s with B-frames 0); a pull camera or an SRT/RTMP push feed is not
necessarily OBS, so the same message names "the device" instead.

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
