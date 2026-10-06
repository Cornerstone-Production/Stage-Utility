# Video feeds

Shows camera and program video in layouts and on Home — the **Video** widget's
source. Feeds themselves are set up once on the **Video feeds** page, under
**Screens** in the sidebar.

## The relay and its switch

A pull or push feed (below) plays through Stage Utility's own video relay —
MediaMTX, behind an adapter, run as a child of this server. It appears as its
own **Video feeds** card under Integrations, with a link back to this page
rather than a settings form: the switch, every feed and the relay's ports all
live here and in Advanced instead.

The switch runs the relay only while it is on AND at least one pull or push
feed exists — an embed or external feed plays either way, since neither one
needs it. The status line at the top of this page reflects exactly that:

| Switch | Relay feed | Binary on disk | Status line |
|---|---|---|---|
| Off | — | Not yet | Names the pinned MediaMTX release's download size (about 27 MB, 55 MB once extracted) |
| Off | — | Archive placed by hand, not yet extracted | Says it sets up MediaMTX from the archive already in place |
| Off | — | Already downloaded | Nothing — a switched-off relay that has run before needs no warning |
| On | None yet | — | Says the relay starts once a feed pulls from a device or a device pushes to it |
| On | At least one | — | Downloading: a progress bar. Starting: says so. Running: the version and its ports (RTMP and SRT inbound, UDP for video to screens) |

The first time it is needed, the switch downloads that pinned MediaMTX
release, checks it against a fixed SHA-256 checksum, and extracts it with the
system's own `tar` into the data folder's `video-relay` directory. None of it
is backed up; it is runtime data, rebuilt the same way on a fresh machine:

| In `video-relay` | What it is |
|---|---|
| `downloads/` | The verified archive |
| `v1.21.1/` | The extracted binary, in a folder named for the version. Extracted beside it and renamed into place, so it is whole or absent; one without a runnable binary is removed and extracted again |
| `mediamtx.yml` | The relay's config, written fresh at every start and before every restart. Readable by this server's user only (0600): it holds every push feed's publish password and the password for the relay's own API |
| `relay.pid` | The running relay's process id, so the next start can find a relay left behind by a server that was killed |

Once extracted it is reused on every later start, with no re-download and no
re-check. A machine with no internet access can skip the download entirely:
place the exact archive the failing status line names in
`video-relay/downloads` in the data folder by hand, and it is checked against
the same checksum before it is ever run — a wrong or corrupted file is
refused, not extracted.

| Install | Data folder |
|---|---|
| Linux (one-line installer) | `/var/lib/stage-utility` |
| macOS (one-line installer) | `/usr/local/var/stage-utility` |
| Windows | `%ProgramData%\stage-utility` |
| Homebrew | `$(brew --prefix)/var/stage-utility` |
| Checkout, or no installer | `~/.stage-utility` |

The status line, like everything else a browser on the network can read,
names folders relative to the data folder and a busy port's holder by
program name only. The server log has the full path and the holder's
process id.

Once running, the relay is a child process of this server. If it exits for
any reason it is restarted automatically, backing off from 1 second up to 60
between attempts, and it never gives up.

A relay can outlive a server that was killed outright (a crash, `kill -9`, a
power cut) and keep holding its ports. The next start finds it by the
`relay.pid` it left in `video-relay` and stops it before checking the ports;
one that will not stop is reported as the reason the relay cannot start.
Windows has no `ps` to confirm what that pid is, so there a leftover relay is
not stopped: end `mediamtx.exe` in Task Manager.

If it cannot start — a busy port, a failed download, a config write that
failed, an unsupported platform — the line says why, and names where to
place a downloaded archive by hand if the download itself is what failed.
Every reason but an unsupported platform also says when it retries; an
unsupported platform never will, so the line never invites waiting for one.
The integration's test, `POST /api/integrations/video/test`, answers from
the relay itself: `MediaMTX v1.21.1` while it is running, otherwise the same
reason the status line gives (starting, downloading, why it is failing, or
that it is not running). The Video feeds dialog under Integrations has no
Test button of its own, having no settings to test.

The relay's ports live on their own card in **Advanced**, reachable from
this line's "Change ports in Advanced" while running, or failing on a busy
port specifically — the one failure that page can actually fix — saving
them restarts the relay if it is running, unless the six values did not
actually change.

## Ports and the firewall

The relay listens on six ports, all editable on that same card in
**Advanced**:

| Port | Default | Protocol | Reaches | Carries |
|---|---|---|---|---|
| RTMP | 1935 | TCP | The LAN | A push feed set to RTMP |
| SRT | 8890 | UDP | The LAN | A push feed set to SRT |
| Video to screens | 8189 | UDP | The LAN | WebRTC media for every relay feed a screen plays, however it was ingested |
| WebRTC signalling | 8889 | TCP | 127.0.0.1 only | Proxied by Stage Utility's own server; never reached directly |
| HLS | 8888 | TCP | 127.0.0.1 only | Proxied by Stage Utility's own server; never reached directly |
| Relay API | 9997 | TCP | 127.0.0.1 only | Only this server ever calls it, with a password made fresh at every relay start; nothing else on the machine can read or change the relay's paths, a pull feed's address among them |

If the server sits behind a firewall, or the gear it talks to is on another
VLAN, two directions matter — the loopback-only three never need a rule,
since nothing outside this machine ever reaches them:

- **UDP 8189 must reach the server from the screens' network.** Every screen
  playing a relay feed over WebRTC opens a direct UDP connection here for the
  video itself — the one leg that cannot go through Stage Utility's own HTTP
  server. Block it and a feed sits on Connecting until the player gives up
  and falls back to HLS.
- **UDP 8890 and TCP 1935 must reach the server from the encoders' network.**
  A push feed's device connects to these directly to send SRT or RTMP.

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
**Address**, then **Username and password** if the device needs them. SRT
has no username, only a passphrase: leave Username empty and put the
passphrase in Password. It is 10 to 80 characters of plain ASCII — letters,
digits, spaces and punctuation, as an encoder's own settings page takes. A
username, or a passphrase that breaks either rule, is refused when the feed
is saved; the relay itself refuses one outside that length on every attempt.
The relay only dials the address while something is actually showing the feed
(a Video widget on screen, or the editor's own preview); nothing else keeps
it connected. Once a password is stored, the field says "A password is
saved. Type to replace it, or clear it." with a **Clear** button that
removes it at once; typing a new one and saving replaces it, and leaving
the field untouched on an edit leaves whatever is already stored.

A Magewell Ultra Stream can serve one feed to Stage Utility this way while
its first output keeps streaming to Resi: turn on the Ultra Stream's RTSP
server as its second output.

### The device pushes to Stage Utility

For a device that connects outward — OBS, a hardware encoder, or an NDI
source through a converter box. Choose **How it connects**: SRT, RTMP, or
WHIP (OBS) — switching it before saving previews that protocol's own address
below, with the same password, so there is no need to save just to see what
each one looks like. Saving the feed mints a random password, shown once the
feed exists under **Paste this into the device** — the exact address to
paste, with **Copy** (its label reads "Copied" for a moment after) — and
**Password**.

The password is part of the SRT and RTMP addresses already (a device pushing
without it is refused); for WHIP it is OBS's Bearer Token, entered separately
under Settings, Stream, Service WHIP. **New password** replaces it and drops
whatever is currently connected, so the old password stops working
immediately rather than at the device's next reconnect. If the relay cannot
be reached to apply it, or cannot drop the current connection, the editor
says so rather than claiming it worked.

A Panasonic AW-UE160 pushes SRT or RTMP itself, straight to the addresses
above; the older AW-UE150 pushes RTMP only. ProPresenter and ProVideoPlayer
output only NDI, which has no SRT, RTMP or WHIP of its own — a small
converter box on the network (a Kiloview N60, or a Magewell Ultra Encode)
turns an NDI source into one, and its output sets up as an ordinary push feed
the same way.

A B-frame is a picture the encoder built by referencing both an earlier AND a
later frame, which needs frames held back and sent out of order — cheaper to
encode, but not something any browser's WebRTC decoder accepts for H.264. If
the source sends them, WebRTC cannot carry the picture and Stage Utility
falls back to HLS for that feed — a few seconds behind instead of under
one — whether it pulls from a device or a device pushes to it. The editor
says so, and so does the feed's own row on this page. For a feed set to WHIP
this names OBS specifically, with its own fix (Settings, Output, Streaming:
Profile baseline, or Keyframe interval 1 s with B-frames 0); a pulled camera
or an SRT/RTMP push feed is not necessarily OBS, so the same message names
"the device" instead.

That fallback needs a screen willing to play HLS. A screen's own **Use HLS on
this screen** switch (its overflow menu on the Screens page) can turn it off —
a Pi 4 can freeze decoding HLS, so this keeps a struggling screen on WebRTC
only. With it off, a feed that needs HLS shows **This screen can't play
video** there instead, while it keeps playing normally on every other screen.

## Feed states

A pull or push feed's status pill reflects what the relay currently knows, and
for a pull feed with the Video feeds page open, what its camera answered to a
[check](#checking-pulled-feeds):

| Pill | Meaning |
|---|---|
| Live | Playing over WebRTC, under a second behind |
| Live, delayed | Playing, but only over HLS — a few seconds behind, from B-frames (above) or an unsupported codec |
| Ready | A pull feed whose camera answered a check and described its stream, with nothing pulling it right now. Its line reads "Camera answers · H.264 1920 × 1080 · checked 4 s ago", leaving out what the camera did not say. See [Checking pulled feeds](#checking-pulled-feeds) |
| Not answering | A pull feed whose camera failed the check, with the reason in red under it: no answer within 5 seconds, a refused connection, a missing path or a refused login. Logged once per outage |
| Checking | A pull feed whose first check since the page opened has not come back yet |
| Standby | Nothing to report yet: video is off, the relay is still starting, a pull feed that cannot be checked (SRT, which says so on its line), or — before a check has answered — a pull feed nothing is currently watching. A pull feed connects to its source only while a widget or the editor's preview has it open, so the relay cannot tell an idle feed from a down one until something looks. A pull feed that came up and was then closed because nothing watches it any more — a browser tab hidden, a widget scrolled away — is back on Standby, not Offline |
| Waiting for source | A push feed nothing has ever sent to |
| Offline | Was live and is not any more — shows how long ago. Also a pull feed something asked the running relay for that did not come up within its 10-second dial, until 25 seconds after the last request for it (a request to a relay that has since restarted does not count), and any pull or push feed the running relay has no path for (it could not be set up on the relay — see `could not reconcile` under Logging) |

An embed feed shows **Live on YouTube** or **Live on Resi** instead, naming the
platform it plays through; Stage Utility cannot see whether that platform's
own stream is actually live. An external feed shows no pill at all — Stage
Utility cannot see whether its source is live.

## Checking pulled feeds

The relay pulls a camera only while something shows it, so without a check every
pulled feed would read Standby until clicked, and a wrong address would look the
same as a camera that is simply idle. While the Video feeds page is open, the
server asks each pulled camera to describe its stream, without streaming it:

- Once when the page opens and every 15 seconds after, only while a Video feeds
  page is open. The server starts only for a client that names `video:probe`
  (this page); another page, a display connecting, or a client with no channel
  filter at all (curl, Home Assistant) starts nothing. With the page closed,
  nothing is asked. The relay's own **Live** and **Live,
  delayed** win: a feed the relay already has playing is not checked.
- An RTSP or RTSPS address gets a `DESCRIBE`; an HTTP or HTTPS (HLS) address gets
  a GET of its playlist. Neither starts a stream. Each has 5 seconds to answer.
  An RTSPS or HTTPS camera's certificate must be one this machine trusts, as
  the relay requires: a self-signed one reads as not trusted, and nothing,
  login included, is sent to it.
- The feed's **Username** and **Password** are used when the camera asks for a
  login (Basic or Digest). A camera that wants one with none saved says so; one
  that refuses the saved one says that.
- SRT cannot be asked without streaming it, so an SRT feed stays on Standby, and
  its line says it shows **Live** once something plays it.
- With the Video feeds switch off nothing is asked.
- A camera that answers `406 Not Acceptable` is busy answering someone else
  (some encoders take one `DESCRIBE` at a time, so two servers checking the same
  camera, or a check while the relay connects, can collide). It is asked twice
  more a moment apart; if it is still busy, the row keeps what it showed and
  nothing is logged. A feed that has never answered reads **Checking** with
  "The camera is busy answering another request · trying again". A feed the
  relay was asked for in the last 25 seconds is not checked, so the check does
  not collide with the relay's own dial.

The reason under **Not answering** names the camera's host. The answers it can
give are:

- no answer for this path (the camera connected and said nothing, which is how
  many encoders answer a path they do not have);
- a refused connection on a port, or not reachable;
- no stream at this path;
- a login wanted, or refused;
- "The camera asks for a login method this check can't use": Digest with
  another algorithm than MD5 (SHA-256, MD5-sess) or only `auth-int`, with no
  Basic offered as well;
- "answered, but not with RTSP" or "not with a playlist": something else is
  listening at that address;
- "answered with more than a camera should": a reply past 64 KB, read no
  further;
- "The address could not be checked": the address does not parse;
- the camera's own status for anything else. A redirect (3xx) is shown that
  way, as the camera's own status, and is not followed.

"checked 4 s ago" is the server's own age of the answer plus how long the page
has held it, so a display whose clock is wrong still reads right.

## The Video feeds page

One card: the list of feeds on the left, the selected feed's editor on the
right. Each row shows the feed's name, its status pill, a source line (the
kind, then the address or embed reference) and a line on how it plays. **Add
feed** sits under the last row. Pressing it adds a highlighted draft row at
the end of the list, marked "Not saved", that follows the name and address as
they are typed; it goes away on **Cancel** or when another feed is selected,
and **Save** replaces it with the real feed.

The editor shows the feed's live picture, its **Name** and **Source**, and the
fields for that source, each with its label above it. A new feed's **Name**
and **Address** start empty, with "New feed" and "rtsp://" as placeholders;
saving without a name is refused. Under **Save**,
**Cancel** and **Delete feed** it says which layouts use the feed. Delete asks
before it removes anything, naming those layouts again; the widgets in them
then show their offline state.

The header also holds **Export** and **Import**, covered under
[Moving feeds between servers](#moving-feeds-between-servers).

## Moving feeds between servers

**Export** and **Import** in the page's header move feeds to or from another
Stage Utility, in either direction, without the rest of a configuration. Each
opens in place of the editor; selecting a feed or **Add feed** brings the
editor back.

**What the file carries.** `stage-utility-video-feeds-<date>.json` holds the
feeds you tick: each one's id, name and source. Feeds keep their ids, so a view
moved with them (see [Moving a view](../moving-a-view.md)) finds its Video
widgets' feeds on the other server. Two things are opt-in:

- **Relay ports**: the six ports, as saved.
- **Passwords**: a pull feed's camera password and a push feed's publish
  password. The file holds them in plain text, and anyone with it can publish
  to those feeds and log in to those cameras; the panel says so when the box is
  ticked. Keep the file off shared drives.

The full config snapshot (**Settings → Advanced → Data**) carries the
feeds and the ports too, but never any password.

**What an import does.** Choosing a file shows every feed in it against what is
on this server, each tagged:

- **New**: not here; it is added under the file's id.
- **Same as here**: nothing to do.
- **Differs**: the changed fields are listed (`address old → new`; a password
  only reads "password differs", never the values), with a choice per feed:
  **Use the file's** (the default) or **Keep this server's**.
- **Can't import**: this build cannot take the feed (a source kind it does not
  offer, an address with a login inside it); the reason is shown and the feed is
  skipped.

An import never removes a feed: the ones the file does not have are named and
left alone. It never touches the **Video feeds** on/off switch, and it works
with the switch off. A file that carries ports shows a **Use the file's relay
ports** box, off by default; ticking it saves them, which restarts a running
relay. A file with no passwords leaves this server's passwords alone on a feed
it replaces, unless the feed's kind changes. A new push feed from a file
without a password gets a new publish password made here, and the result names
it: its device needs the new password pasted in.

The review is what gets applied: if a feed is edited, added, deleted or given
a new password on this server between the review and **Import**, that feed is
skipped with
"Changed on this server since the review. Review the file again." and the
rest still land.

A file that is not a video feeds export, is the wrong version, lists a feed id
twice or carries an id this server cannot use is refused whole, with the
reason.

## The Video widget

Place a Video widget on a layout or a Home card and point it at a feed with
**Feed**. It is always muted, with no controls, and opens a connection only
while it is actually on screen and the browser tab is visible — scrolled past
or a hidden tab tears the session down after a few seconds, so it is never
holding a connection nobody is watching.

Settings, states and the "N s behind" badge are covered in the widget
reference: see [Video](../reference/widgets.md#video).

A Raspberry Pi decodes WebRTC in software. Plan on one 720p feed per Pi 4
screen; a Pi 5 or a computer handles 1080p.

## Health from the screens

Every Video widget reports its own playback on the same presence heartbeat
that keeps its screen's Connected/Offline dot current — every 10 seconds
while at least one widget on that screen is actually showing a relay or
external feed's picture, faster than the heartbeat's normal 20-second (near a
service) or 60-second cadence otherwise. Each report is that widget
instance's own numbers since its last report: frames decoded (never counting
the dropped ones, over either method), frames dropped and stalls as deltas,
and the frame's current width, height and whether it is playing over WebRTC
or HLS. A stall is the picture going into `waiting` on HLS; on WebRTC, where
a `<video>` playing a live stream never fires `waiting` when the stream
starves, it is instead Chrome's own receiver-side freeze counter, falling
back to `waiting` on a browser that does not report one. On WebRTC a stall is
therefore a receiver-side freeze, a gap between frames of roughly 180 ms or
more at 30 fps; on HLS it is the buffer running dry. An embed's platform
player, and a probe merely testing whether WebRTC works, report nothing —
only a widget actually showing a picture does.

A widget whose stats take longer than 1.5 seconds to read is left out of that
heartbeat and counts as a failed read (see Logging below). If the widgets
have not all answered within 2 seconds, the heartbeat goes without any
reports rather than wait, so the Connected dot never waits on a stats read.

The server keeps a rolling one-minute window per screen and feed — two
widgets on one screen playing the same feed are one pair — and marks the pair
**struggling** the moment its window crosses either threshold: more than 5%
of decoded frames dropped, or 3 or more stalls. Once struggling, it stays
that way for 60 seconds after the last sample that kept it bad, even through
cleaner reports arriving in between, so one bad spike cannot flap the warning
on and off as the window's own totals dilute it.

While a pair holds struggling, the server also holds its **episode**: the
worst window since it started struggling, not the live one — the live
window's own totals dilute as an old bad sample ages out from under a sticky
flag that is still holding, so a card built off the live numbers alone could
end up describing a cause (a stall count, say) that has already faded out of
what it is currently showing. A struggling screen's card on the Screens page
reads from the episode instead: **Struggling with \<feed\>.** followed by how
many frames it dropped in that worst minute. Above 720p it adds the feed's
resolution and the fix — a Pi 4 decodes WebRTC in software and cannot keep up
much past that: **The feed is W × H; a Pi 4 plays 1280 × 720 smoothly. Lower
the encoder's output to 720p.** At 3 or more stalls it adds **It stalled N
times; check this screen's network.** — unless stalls alone crossed the
threshold (the dropped fraction never did), in which case the card leads with
**This screen stalled N times in the last minute; check its network.** and
leaves out the dropped-frames and resolution sentences, since those are
decode advice and a stall-only episode says nothing about decode load. The
`[video]` struggling log line below reads from the same episode.

The Video feeds list's own meta line reads **On N screens** for any feed
currently playing anywhere, struggling or not — every distinct screen a
heartbeat has reported that feed's playback for in the last minute.

Each transition into or out of struggling is a `[video]` line on the
server's own log; see Logging below.

## Logging

Exporting and importing feeds writes one line each, tagged `[video-export]`
and `[video-import]`: the count of feeds, and whether passwords or relay ports
were included or applied. The import line also names each skipped feed and
why. An import that fails writes `import failed, nothing was changed:` and the
reason, or `import failed and could not restore:` when putting things back
failed too. A password is never in any of them.

The relay itself writes `[video]` lines to [`/log`](../ops/updates-and-logs.md)
from the server:

- `relay started: MediaMTX v1.21.1, RTMP 1935, SRT 8890, video to screens
  UDP 8189`, once for each relay process, once its API has answered — so a
  restart after a crash is announced too, and a process that dies before it
  ever answers is not.
- An exit — `relay exited with code 1: <its last error>` or `relay killed by
  SIGKILL` — and when it restarts; a failing streak's start and its recovery,
  each once, not on every retry. `relay could not rewrite its config` when a
  restart cannot write `mediamtx.yml`, retried the same way.
- `relay stopped`, and why: video switched off, or no pull or push feed left.
- Downloading the pinned MediaMTX release, and a checksum that does not
  match — from a fresh download or a hand-placed archive — refused rather
  than run, with where to place the archive by hand.
- A busy port, naming the program holding it and its process id.
- `stopped a relay left over from the last run (pid N)`, or that it would
  not stop, which also stops this start.
- The relay's own bookkeeping failing, each once per outage and once more
  when it works again: `could not stop the relay` and `stopping the relay is
  working again`; a start or stop step that could not run while the relay
  was up (reading the feed list, say) and `the relay's start and stop steps
  are working again`; `could not read`, `write` or `remove relay.pid` and
  `relay.pid can be read`, `written` or `removed again`.
- `the relay is not answering`: a running relay whose API has not answered a
  status read for 10 seconds, and `the relay is answering again`.
- `could not reconcile the relay`: its paths or publish users could not be
  set, once the relay's API had answered at least once (never for the first
  moment of a start, before it has opened), and `reconciling the relay is
  working again` on the next success.
- `proxy to relay failed for <feed>`: a screen's or OBS's request the relay
  did not answer, once per outage per feed, and `is answering again`.
- Each feed going live or delayed, and `went offline` once per outage, only
  for a feed that was showing a picture.
- `<feed>: nothing from <address> within 10 s of the relay asking`: a pull
  feed's device did not answer the relay's dial, once per outage however often
  screens retry, and `the device is answering again` once it has. The usual
  cause is a wrong address or path — some encoders answer a path they do not
  have with silence rather than an error, which looks the same as a device
  that is off.
- `<feed>: <reason> (<address>)`: a pulled camera did not pass a check made
  while the Video feeds page was open — see [Checking pulled feeds](#checking-pulled-feeds).
  It shares the dial line's one-per-outage rule and its recovery, so a camera
  that is down writes one line whether the relay's dial or a check found it
  first, and `the device is answering again` once. The address is logged
  without any username or password. `could not check the pulled feeds` when a
  round cannot read the feed list.
- B-frames detected on a feed, with which setting to change.
- A push feed's password rotating, and whether it dropped the device that
  was connected; `made a new publish password (none was stored)` for a push
  feed that had lost its password, which its device then needs.
- A screen struggling with a feed — dropped frames and stalls, in the last
  minute — the moment its window crosses the threshold above, and playing it
  smoothly again the moment it clears; each once, not repeated while it stays
  true. `could not record <screen>'s playback report` when a screen's
  numbers cannot be saved, once per outage for each screen, and `recording
  <screen>'s playback reports is working again` once they have saved again
  for two minutes. The heartbeat itself still counts either way.

The relay's own error text can echo a feed's address back, so before any of
it reaches `/log`, the status line or an API error, a username and password
in the address, an SRT `passphrase`, a `pass` or `pwd` query value, and the
password in an SRT `streamid` are all stripped.

Each screen writes its own `[video]` lines from the browser:

- A feed failing on a screen, once per failing streak: its first failure and
  the reason, a reminder at most every 5 minutes while it goes on failing
  (with how many attempts and for how long), and a line when it is playing
  again after holding for 10 seconds. Individual retries are not logged; the
  browser console shows each one, with its delay, at the Verbose level.
- A relay feed falling back to HLS on a screen because WebRTC did not carry
  it there, once per outage, and a line when WebRTC is carrying it again.
  Its retries every 5 minutes are not logged.
- A feed that needs HLS refused by a screen's own **Use HLS on this screen**
  switch, once per outage, and a line once it can play again — the screen
  allows HLS again, or the feed stops needing it. Nothing repeats while the
  switch stays off.
- A playing widget's own stats failing to read (for the health report
  above), or taking longer than 1.5 seconds, once per outage, and a line once
  they read again.
- A Video widget crashing, with the error. The rest of the layout keeps
  drawing.

## Screens previews

A layout's preview on the Screens page never opens a live connection to a
feed: a Video widget there shows **Video paused in preview** with a **Play**
button, so browsing layouts does not quietly connect to every feed on the
list. Press Play to watch it inside the preview.
