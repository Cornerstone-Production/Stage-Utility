# Video feeds

**Goal.** Live video in layouts and on Home: the program feed on a stage
confidence display under a second behind, cameras on operator screens, the
public stream on a lobby screen, and later the ProPresenter output. Feeds are
defined once on their own page and a Video widget picks one by name. Stage
Utility runs the relay that turns encoder and camera streams into something a
browser can play, and says how every feed and every screen is doing.

**Mockup.** https://claude.ai/artifact/XWy5PQBhojfMC6uh4z7NJf (v2) — driveable:
pick a feed, switch its source, preview each widget state. The mockup is the UI
spec; where this text and the mockup disagree, the mockup wins.

**Decided with Henry, 27 Sep 2026.** Feeds are a list Stage Utility manages;
Stage Utility runs the relay itself; one relay (MediaMTX) behind an adapter, not
two; video only, no audio; no snapshots; Video feeds is its own page under
Screens; Source is a dropdown. Displays are a mix of Pi 4, Pi 5, Mac and
Windows.

## What this is for

| Use | Where it shows | Latency it needs | Path |
|---|---|---|---|
| Program/IMAG as a confidence monitor | Stage displays (Pi) | under 1 s | relay, WebRTC |
| A stage camera or PTZ | Home, consoles, custom layouts | a few seconds is fine | relay, WebRTC or HLS |
| The public stream | Lobby screen, a Home card | any | YouTube or Resi player |
| ProPresenter or ProVideoPlayer output | Custom layouts | a few seconds | relay, once a converter box exists |

## What this rests on

Researched 27 Sep 2026. Sources are the vendors' own pages unless noted.

- **No browser plays RTMP, RTSP, SRT or NDI.** Browsers play WebRTC, HLS, MSE
  and MJPEG. So an encoder's stream needs a relay that repackages it, or the
  platform's own embed player.
- **Repackaging is cheap; re-encoding is not.** RTMP, SRT and RTSP from an
  encoder are already H.264, so a relay only remuxes them. NDI arrives nearly
  uncompressed and would need an always-on box re-encoding every frame, which is
  why NDI-to-browser was ruled out in June and still is.
- **MediaMTX** (bluenviron, MIT, one Go binary, v1.21.1 Sept 2026, very active)
  ingests RTSP, RTMP, SRT and WHIP, serves WebRTC (WHEP) and HLS/LL-HLS, remuxes
  only, and has a REST API on its own port. go2rtc (MIT) is the runner-up: it
  adds snapshots and MSE playback but has no HLS and no SRT ingest. SRS is
  heavier to run; OvenMediaEngine is AGPL; nginx-rtmp is unmaintained.
- **WebRTC playback works over plain HTTP.** `RTCPeerConnection` is not
  restricted to secure contexts (only `getUserMedia` is), so WHEP playback works
  on `http://<lan-ip>` in Chromium, Firefox and Safari. MSE is not restricted
  either. WebCodecs is secure-context-only, so nothing here may use it.
- **WebRTC cannot carry H.264 B-frames**, by design, in every browser
  ([MediaMTX](https://mediamtx.org/docs/features/webrtc-specific-features),
  [#1317](https://github.com/bluenviron/mediamtx/issues/1317)). OBS's default
  x264 settings send them. HLS plays B-frames fine, 2 to 6 s behind.
- **H.264 only.** HEVC over WebRTC needs a hardware decoder with no software
  fallback, and is missing from Firefox; the Pis have no HEVC path for it.
- **Muted autoplay always works; sound needs a gesture** per tab. Video only
  sidesteps it.
- **Raspberry Pi.** Chromium decodes WebRTC in software on both Pi 4 and Pi 5.
  Plan on one 720p30 feed per Pi 4 screen; a Pi 5 or a computer handles 1080p.
  Current Raspberry Pi OS Chromium has an open bug where tearing down the Pi 4's
  hardware H.264 decoder (the `<video>`/HLS path) freezes the display
  ([trixie-feedback #101](https://github.com/raspberrypi/trixie-feedback/issues/101)).
- **Ross Ultritouch.** DashBoard's browser is JxBrowser (real Chromium) where the
  panel can run it; the fallback browser the panels here use buffers SSE and
  almost certainly plays no video. Out of scope, per Henry.
- **The gear here**, from the church's Companion connections: several Magewell
  Ultra Stream encoders, a Magewell Pro Convert decoder, an SW-P-08 video router
  (Ross Ultrix), RED cinema cameras, Panasonic PTZs, OBS, ProPresenter, PVP,
  HyperDecks, SmartView monitors, Vizio TVs driven by Pis.
  - An **Ultra Stream** runs two outputs at once (up to ~4 Mbps combined when
    both are on), one of them an RTSP server. It can keep pushing RTMP to Resi and
    serve RTSP to the relay: no new hardware.
  - The **Ultrix** routes any SDI source to an Ultra Stream's input, and
    Companion already drives it, so any camera can become a feed.
  - **Panasonic AW-UE160** pushes SRT or RTMP itself; the AW-UE150 pushes RTMP.
  - **RED** has no network video on the bodies likely here (RED Connect is
    V-RAPTOR only).
  - **ProPresenter and PVP** output only NDI. Showing them needs a converter box
    (Kiloview N60, or a Magewell Ultra Encode) that turns NDI into SRT or RTSP.
- **YouTube's embed player** works on a plain-HTTP page (the player itself is
  served over HTTPS), for public and unlisted streams: 15 to 60 s normal, 5 to
  15 s low latency, 2 to 5 s ultra-low.

## Three PRs, in order

Each is usable on its own and goes to `beta`. Nothing reaches `main` until all
three are done and have run on a Sunday.

1. **The page, the widget and the player**, with the `embed` and `external`
   source kinds. On its own this puts the public stream on a lobby screen or a
   Home card, and plays anything that already serves WHEP or HLS.
2. **The relay.** Acquisition, supervision, configuration, the playback proxy,
   the `pull` and `push` kinds, and each feed's live status.
3. **Health from the screens.** Playback stats, the Screens warning, the
   per-screen HLS switch, and the docs pass.

## Feeds

A feed is `{ id, name, source }`, stored in a new `DataStore` classified
`"config"`, so it is backed up with the rest of the operator's work. The `id` is
a slug of the first name and never changes; renaming changes only `name`, so
every layout pointing at the feed keeps working.

Source kinds, chosen from the **Source** dropdown:

| Kind | Dropdown label | What it holds | Who connects |
|---|---|---|---|
| `pull` | Pull from a device (RTSP, SRT, HLS) | an address, optional username and password | the relay fetches, only while watched |
| `push` | The device pushes to Stage Utility (SRT, RTMP, WHIP) | a protocol and a generated password | the device connects to the relay |
| `embed` | YouTube or Resi player | YouTube channel, YouTube video, or a Resi embed | the screen loads the platform's player |
| `external` | Another WebRTC or HLS address | a WHEP or HLS URL | the screen plays it as given |

- Passwords (a `pull` source's credentials, a `push` feed's publish password)
  live in `secretsStore`, never in the feed store. A config snapshot leaves them
  out like every other secret, and restoring one asks for them again.
- The server answers the feed list with each `push` feed's paste-ready address
  (SRT `streamid`, RTMP URL, or WHIP URL plus bearer token) built from the
  server's LAN address, so the page shows exactly what goes into the device.
- Routes and IPC channels follow the existing shape: list, create, update,
  delete, and regenerate a push password. The plan fixes the names.
- Deleting a feed a layout uses is allowed; the page says which layouts use it
  before you confirm, and those widgets then show their offline state.

## The relay

### One adapter, one relay

Everything outside `main/services/video/` talks to a `VideoRelay` interface,
never to MediaMTX:

- `reconcile(feeds)` — make the relay's paths match the feed list exactly.
- `status()` — relay up/down, and per path: ready, source connected, codec,
  resolution and profile (MediaMTX reports them per track), whether WebRTC can
  carry it, reader count.
- `playback(feedId)` — how a browser plays it: a WHEP URL and an HLS URL, both
  on Stage Utility's own origin.

MediaMTX is the one implementation. A second (go2rtc) would be a new adapter and
a setting, and is not built now. Triggers for building it: snapshots wanted, a
camera only go2rtc can talk to (ONVIF, HomeKit), or MSE's faster fallback needed
on a Pi 5 or a computer.

### Getting the binary

- The repo pins one MediaMTX version with the SHA-256 of each platform's release
  asset (linux amd64/arm64, darwin amd64/arm64, windows amd64).
- It is downloaded the first time video is turned on, never at install, into the
  data folder under a versioned directory, verified against the pinned checksum,
  and only then extracted (with the system `tar`, which Linux, macOS and Windows
  10+ all ship) and made executable. A mismatch deletes the file and refuses to
  run. v1.21.1 is a 27 MB download and 55 MB on disk; the page says so before
  the first download.
- A newer MediaMTX ships as an ordinary Stage Utility release that bumps the pin.
  The app never follows MediaMTX's releases on its own.
- Offline machines: the page names the exact path and filename to place the
  binary by hand; it is checksum-verified the same way.
- The binary directory is runtime data, not backed up.

### Running it

- **A child process of the server**, started when video is turned on and at
  least one feed exists, stopped when video is turned off or the server stops.
  No systemd unit, no launchd job, no Windows service.
- The config file is generated fresh on every start into the data folder
  (runtime, not backed up); nobody edits it.
- An exit restarts it with backoff from 1 s to 60 s. It never gives up; the
  status says it is failing and why.
- After every start the adapter reconciles paths from the feed list. Paths are
  created through the API, so the config file holds only listeners and auth.
- A Stage Utility restart drops video for a few seconds. The update lock already
  keeps updates out of services.

### Configuration

- **The API listens on 127.0.0.1 only.** Nothing on the network can reconfigure
  the relay. Metrics, pprof, the playback server, the RTSP server, RTSPS, RTMPS
  and **MoQ** stay off. MoQ matters: v1.21.1 turns it on by default and binds
  `:8892` and `:8893` on every interface, so the generated config must say
  `moq: false` explicitly. Every listener the app does not use is switched off by
  name, not left to the default. RTSPS and RTMPS are `rtspEncryption: "no"` and
  `rtmpEncryption: "no"`; there is no `rtsps` key, and an unknown key stops
  MediaMTX at startup.
- **HTTP listeners (WebRTC signalling, HLS) listen on 127.0.0.1 only**; browsers
  and OBS's WHIP reach them through Stage Utility (below).
- **Inputs listen on the LAN:** RTMP 1935, SRT 8890 (UDP), WebRTC media UDP 8189.
  No push kind uses RTSP, and pulling RTSP uses the relay's RTSP client, so the
  RTSP server is off. The relay advertises the server's LAN address for ICE.
  Ports are editable in a new Video relay card in Advanced (Advanced has no port
  settings today); a taken port is reported with the program holding it, through
  the existing `port-holder.ts`.
- **`pull` paths fetch on demand** (`sourceOnDemand`), closing a few seconds
  after the last viewer leaves. An unwatched feed costs no traffic.
- **Publishing needs the feed's password.** Every `push` path accepts a publisher
  only with its own credentials, and `overridePublisher` is false (MediaMTX
  defaults it to true), so a second device cannot kick the first off a feed.
  Reading is allowed only from 127.0.0.1, which is the proxy. How each protocol
  carries the credentials: SRT in the `streamid`
  (`publish:<path>:<user>:<pass>`), RTMP as `?user=&pass=`, and OBS's WHIP
  "Bearer Token" field as `user:pass`, which MediaMTX accepts for exactly this.
  Every push feed's user is `video`; the password is per feed (probed: several
  users may share a name, each allowed one path).
- **A new password applies at once.** Changing the publish users through the API
  keeps every live session (probed), so New password also kicks the device
  currently sending; its next connection needs the new password.

### Playback goes through Stage Utility

Browsers talk only to Stage Utility's own origin, on 8788 and on port 80:

- `/video/<feedId>/whep` — WHEP signalling (POST the offer, PATCH, DELETE the
  session), proxied to the relay. The WebRTC media itself then flows from the
  relay to the screen over UDP 8189; that part cannot go through a web server.
- `/video/<feedId>/index.m3u8` and its segments — HLS, proxied and streamed.
- `/video/<feedId>/whip` — WHIP signalling for a `push` feed set to WHIP, with
  OBS's Authorization header passed through. The relay's HTTP listener is
  loopback-only, so OBS publishes through Stage Utility too.
- Only existing feeds of the `pull` and `push` kinds are served; any other id is
  404.
- **B-frames are detected from the relay's own log, not the WHEP answer.**
  Probed against the real v1.21.1 binary: MediaMTX answers a B-frame stream's
  offer with `201`, the peer connection comes up, and it then closes the session
  with `closed: WebRTC doesn't support H264 streams with B-frames`. The browser
  sees "connected" and no frames. The supervisor already reads the child's
  output; it pairs `[session X] is reading from path 'P'` with that close line
  and marks feed P "WebRTC unavailable: B-frames". The status then sends every
  screen straight to HLS, and the page says what to change on the device. The
  mark clears when the path's source changes (a new publisher, or a re-pulled
  source), since that may be the encoder with its settings fixed. The lines are
  pinned by a test built from the real output; a MediaMTX bump that changes the
  wording fails it.
- **The player backs this up.** A WebRTC session that is connected but has
  decoded no frame within 5 s falls back to HLS as well. That also covers a
  blocked UDP port, and anything the log does not name.

### Status

- While anything watches (a widget playing, or the Video feeds page open), the
  server reads the relay's path list every few seconds and publishes the result
  on a new hydrated SSE channel. Nothing polls otherwise.
- Feed states: `live`, `delayed` (plays over HLS only, with the reason),
  `standby` (a pull feed nothing is watching: it connects only when watched, so
  the relay cannot know the source is up until something looks), `waiting` (a
  push feed nothing has sent to yet), `offline` (was live, source gone; shows
  when last seen), and `embed` (a player the relay does not see).
  An `external` feed has no state: Stage Utility cannot see it, and the page
  says so.
- Relay states: running (with version), starting, failing (with the reason and
  the next retry), off.
- The relay is also registered with the integration manager, so the context
  bar's integration health counts a failing relay like any other integration.

## The Video feeds page

Built as the mockup shows:

- **Its own sidebar entry, under Screens, below Screens.** It owns the on/off
  switch, the relay's status line and every feed.
- **Integrations gets a small Video feeds card** that links to the page, so
  anyone looking where the other devices live finds it. Ports are set in a Video
  relay card in Advanced, which the page's status line links to.
- **The feed list** shows each feed's name, source line, status pill, how it
  plays and on how many screens, and a one-line fix when it plays delayed.
- **The editor** shows the feed's live picture, the name, the **Source**
  dropdown, and the fields for that kind: address and credentials for `pull`;
  protocol, paste-ready address with Copy, and the password with New password
  for `push`; player and channel for `embed`; the address for `external`.
  Device hints sit beside the fields (the Ultra Stream's second output, OBS's
  WHIP settings and B-frames).
- Delete says which layouts use the feed.

## The Video widget

A new layout object `video` in `main/types/views.ts` and the palette:
`{ feedId, fit: "contain" | "cover", showLabel, whenOffline: "message" | "logo" | "nothing" }`.
The same object is a Home card, in Home's card frame.

### Which way a screen plays it

1. **WebRTC** through the WHEP proxy. A small client in the renderer, no
   library: a receive-only peer connection, POST the offer, apply the answer,
   DELETE the session on stop.
2. **HLS** as the fallback, when WebRTC is refused for B-frames, the browser
   has no WebRTC, or WebRTC does not connect within 10 s (a blocked UDP port) —
   unless the screen's "Use HLS on this screen" switch is off, in which case it
   goes to step 4. hls.js (a new dependency, checked against the
   maintained-dependencies rule in the plan) wherever the browser has Media
   Source Extensions, including Safari and iPadOS 17.1+ through
   `ManagedMediaSource`; the browser's own HLS only where it has neither.
   Chrome 153 reports native HLS support, but its player fails on MediaMTX's
   low-latency HLS where hls.js plays it (driven 28 Sep 2026).
   A relay feed that fell back to HLS tries WebRTC again after 5 minutes, so one
   blip does not leave a stage screen delayed for the rest of the service. An
   `external` WHEP feed has no HLS to fall back to, so any failure retries.
3. **The platform's player** for `embed` feeds: YouTube's or Resi's iframe,
   muted, autoplay, no controls.
4. **"This screen can't play video"**, naming the feed, when none of those can
   run.

Always muted, never controls, never audio tracks requested.

### When it plays

- Only while on screen (IntersectionObserver) and while the page is visible. A
  widget hidden for more than a few seconds tears its session down, and the
  relay's reader count proves it.
- **Screens previews show "Video paused in preview" with a Play button**, so a
  page of nine previews does not decode nine streams. The layout editor's canvas
  plays live.
- A dropped connection retries with backoff (1 s doubling to 30 s) and shows the
  offline state while it waits. The backoff resets only after 10 s of continuous
  playback, not on the first frame: a player that shows one frame and then fails
  would otherwise retry every second forever. When the feed's status goes live
  again, the widget reconnects at once instead of waiting out the backoff. A
  failing feed writes one log line per outage, not one per retry.

### What it shows

Live; Connecting (a quiet pulse and the feed name); Delayed, with an "N s
behind" badge on the picture, so a performer never watches old video unaware;
Offline, per `whenOffline`; Waiting for the source; and Can't play here. The
feed-name label is optional. A widget that throws never takes the layout down
with it.

## Health from the screens

- While playing, each widget measures its own playback, over WebRTC from the
  peer connection's stats and over HLS from the video element's playback
  quality: frames decoded, frames dropped, stalls, the picture's resolution,
  and which path it is on.
- Each screen sends these with the display-presence heartbeat it already sends,
  which runs every 10 s while a Video widget plays (otherwise 20 s near a
  service and 60 s away from one, as now; at 60 s the window would hold one
  sample). No new connection.
- The server keeps a 60 s rolling window per screen and feed, and marks the
  pair **struggling** when more than 5% of decoded frames were dropped or there
  were 3 or more stalls in the window; it clears after 60 s under both. These
  are named constants, tuned on the Pi 4 in the on-site checklist.
- The Screens card shows the warning as the mockup does, with the feed's
  resolution and what to change ("Lower the Ultra Stream's second output to
  720p").
- **"Use HLS on this screen"**, a per-screen switch on the Screens card, on by
  default, stored with the screen's other settings. Off, the screen never plays
  HLS: a B-frame feed says it can't play there instead. A Pi 4 that freezes on
  HLS teardown can be kept to WebRTC-only feeds until Raspberry Pi fixes the bug.

## Docs

Each PR ships its docs, in the reference voice:

- A new `docs/integrations/video-feeds.md`: what a feed is and the four kinds;
  device setup for the Ultra Stream's second output, OBS over WHIP with B-frames
  off, a Panasonic PTZ pushing SRT, YouTube and Resi, and NDI sources through a
  converter; the ports and the firewall (UDP 8189 must be open on the server);
  Pi guidance (720p for Pi 4 screens); what B-frames are and why they delay a
  feed.
- `docs/reference/api.md`: the feed routes, the playback proxy routes, and the
  status channel.
- The widget reference: the Video widget, its settings and states.
- `docs/ops/network-traffic.md`: what video costs on the network (about 6 Mbps
  per screen per feed) and that pull feeds fetch only while watched.
- The operator-app docs: the Video feeds page in the sidebar.

## Logging

A `[video]` tag, on `/log`, for decisions and failures, not successes:

- The relay starting (with version and ports), exiting and restarting, and a
  failing streak's start and recovery, logged once per streak, as SenSource does.
- Binary download, checksum mismatch, and a hand-placed binary that fails
  verification.
- A port conflict, naming the holder.
- A feed going live or offline, on the transition only.
- B-frames detected on a feed.
- A screen starting and stopping struggling with a feed.

## Tests, each proven red

Every guard below fails with its fix removed, in the session that writes it, and
the commit says so.

- The feed store is classified `"config"` and appears in the config-snapshot
  exact list; feed passwords never appear in a snapshot.
- Reconcile against a fake MediaMTX API: adds, updates and removes paths to match
  the feed list exactly, including after a relay restart.
- Supervision against a fake child process: restart with backoff, never give up,
  status reports failing with the reason.
- A download whose checksum does not match is deleted and never run.
- The WHEP proxy: a B-frame refusal sets the feed's status and returns the
  fallback signal; a disabled or unknown feed is 404.
- Player selection: WebRTC, then HLS on a B-frame refusal, then can't-play; the
  per-screen switch keeps a screen off HLS.
- Visibility: no WHEP request while the widget is off screen or the page hidden;
  a hidden widget tears its session down.
- A Screens preview renders the paused placeholder and plays only on Play.
- Struggling: the rolling window marks and clears a screen and feed at the
  thresholds.

**Driven for real, in each PR's verification.** A sandbox server with an empty
data folder runs the pinned MediaMTX; FFmpeg stands in for the encoders, with a
Baseline test stream and a B-frame one, over SRT, RTMP and RTSP. A real browser
plays both: WebRTC under a second, the B-frame feed falling back to HLS with its
badge, going offline and recovering when the test stream is killed and
restarted, and the reader count dropping when the widget is hidden.

## On-site checklist

Only the church's LAN can prove these; this Mac cannot reach LAN devices from a
sandbox. Run on the beta server after PR 2:

1. An Ultra Stream's second output as an RTSP server, pulled as a feed, while its
   first output keeps streaming to Resi.
2. The feed on one Pi 4 screen and one Pi 5 screen, over WebRTC; note dropped
   frames at 1080p and at 720p.
3. An iPad playing a feed over WebRTC on plain HTTP.
4. UDP 8189 reaching the VM from the screens' network (and across VLANs, if the
   displays sit on another one).
5. OBS pushing over WHIP, first with its default settings (expect delayed and the
   B-frame hint), then with B-frames off (expect under a second).
6. The church's YouTube channel as a channel embed during a live stream, and a
   Resi embed, each autoplaying muted on a lobby screen. Neither player's
   autoplay parameters have been run here.

## Risks

- **The Pi 4 HLS freeze.** Mitigated by WebRTC-first and the per-screen switch;
  watch the Raspberry Pi bug.
- **Encoder settings.** A feed is only as good as its encoder's profile. The page
  says what to change when it sees B-frames; the docs cover each device here.
- **The UDP port.** A blocked 8189 looks like a feed stuck on Connecting. The
  player times out to HLS and the page names the port.
- **Safari WebRTC over plain HTTP** is documented behavior, not something anyone
  here has run; it is item 3 on the checklist.
- **Bandwidth.** Each screen pulls its own copy from the relay: about 6 Mbps per
  screen per feed. Fine on this LAN; the docs say it.

## Open, deliberately

- **The NDI converter** for ProPresenter and PVP (Kiloview N60 or Magewell Ultra
  Encode) is a purchase decision. Once one exists it is an ordinary `push` feed.
- **Audio.** Needs AAC-to-Opus conversion per feed for WebRTC, and a gesture per
  screen. A later per-feed option.
- **Snapshots**, for the Ultritouch and for real pictures in Screens previews.
  Needs FFmpeg decoding one frame a second per feed; a trigger for the go2rtc
  adapter.
- **Choosing the router source from the widget** (switching which camera feeds an
  encoder through the Ultrix). Companion already does it; a Stage Utility control
  would be its own spec.
- **A relay on another machine.** The adapter makes it possible; nothing asks for
  it yet.
