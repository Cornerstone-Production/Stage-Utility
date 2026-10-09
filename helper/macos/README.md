# Mac output helper

A menu bar app that turns a Mac into several Stage Utility screens at once. Each
of the Mac's displays, and each output port of a Blackmagic DeckLink or UltraStudio
card, is its own device, set up on the server like any other. It is a beta feature.

The helper is a client. The server can be on another machine or on the same Mac.
It renders each screen's own URL in Chromium, embedded through the Chromium Embedded
Framework (CEF), so every view, widget and layout works as it does on the Raspberry
Pi kiosks, which run Chromium too.

## Build and run

Needs macOS 14 or later and a Swift 6 toolchain: the tests use swift-testing, which
ships with Swift 6. The Command Line Tools are enough; Xcode is not required. Python 3
(in the Command Line Tools) is used to make a venv with CMake and Ninja for the
browser host; nothing is installed system-wide.

```sh
cd helper/macos
./test.sh                        # core and DeckLink tests; needs no CEF and no card
./build-app.sh --arch arm64      # dist/arm64/StageUtilityOutput.app, signed ad hoc
./build-app.sh --arch x86_64     # dist/x86_64/StageUtilityOutput.app
```

`test.sh` runs `swift test`. With only the Command Line Tools it names the
`Testing` framework's location itself, which `swift test` does not find on its own.
`swift build` builds the Swift app alone; it starts, but says in its window that
Chromium is missing, because the browser host is only ever inside the app bundle.

`build-app.sh --arch <arm64|x86_64>` writes `$OUT/StageUtilityOutput.app`, `OUT`
defaulting to `dist/<arch>` (gitignored); without `--arch` it builds for the Mac it runs
on. It fetches CEF (below), builds the browser host with CMake (`build-cef-host.sh`,
into `.cef-build/<arch>`, with CMake and Ninja from a venv in `.tools/`), builds the
Swift app with `swift build --triple`, and assembles CEF's bundle layout:

| In `Contents/` | What |
|---|---|
| `MacOS/StageUtilityOutput` | The Swift app |
| `Frameworks/libStageUtilityCEFHost.dylib` | The browser host (`CEFHost/`): CEF behind a small C API |
| `Frameworks/Chromium Embedded Framework.framework` | Chromium, in CEF's versioned framework layout |
| `Frameworks/StageUtilityOutput Helper.app`, `Helper (Alerts)`, `(GPU)`, `(Plugin)`, `(Renderer)` | CEF's helper apps, one executable under five names; Chromium starts its other processes from them |

It is signed ad hoc from the inside out: the framework's libraries, the framework,
the host, each helper, then the app. The app is about 325 MB for arm64 and 340 MB for
x86_64, almost all of it the framework.

There is one app per architecture, not a universal one: CEF ships a separate
framework for each, and a universal app would carry both, about 650 MB, to every Mac.
The installer is to pick by `uname -m` (`arm64` or `x86_64`); the release job calls
`build-app.sh --arch` once for each.

The version is the repository's `package.json` version, kept whole in
`CFBundleShortVersionString`; `CFBundleVersion` has to be dotted integers, so it is the
part before any `-` (`1.26.0` for `1.26.0-beta.4`). The bundle id is
`com.stageutility.output` (the helpers' are `com.stageutility.output.helper` and
`.helper.gpu` and so on), and it is an agent app (`LSUIElement`): a menu bar icon, no
Dock icon. `NSAppSleepDisabled` and an activity held while any card output runs keep
App Nap from slowing a card's clock.

### The CEF download

The CEF version is pinned in `cef.json`, with the download URL, size, SHA-1 (from CEF's
index) and SHA-256 for each architecture. `./fetch-cef.sh [arm64|x86_64]` downloads the
"minimal" distribution (about 135 MB) into `.cef/downloads/`, checks both checksums,
and unpacks it beside them (about 800 MB). A mismatch deletes the download and fails;
an archive already in the cache is checked again before it is unpacked. `.cef/` is
gitignored, and no CEF binary is ever committed.

To try it without touching the real settings, point both state directories at a
scratch folder and open the window:

```sh
mkdir /tmp/suo
STAGE_UTILITY_OUTPUT_STATE_DIR=/tmp/suo \
  dist/arm64/StageUtilityOutput.app/Contents/MacOS/StageUtilityOutput --show-window --log-stderr
```

## Opening the window

The menu bar icon toggles the window. If the icon is out of reach, launching the app
again (or `open -a "Stage Utility Output"`) brings the window back; a second copy
started from a terminal hands over to the first and exits. The window has a
**Quit Stage Utility Output** button, because an agent app has no menu.

An output window sits above the menu bar, so one over the Mac's main display covers
the icon. The window therefore opens by itself at launch whenever an output covers the
main display, and again when a change in the displays newly covers it.

**Starting at login.** `install-macos.sh` starts the helper at every login with a
system-wide LaunchAgent, `/Library/LaunchAgents/com.stageutility.output.plist`. Where
that file exists, the window's footer reads **Starts at login (installed)** and has no
switch, since a per-user login item beside it would start a second copy; one made
before the installer ran is removed at launch, and the log says so. A copy run by hand
on a Mac the installer never ran on has the **Open at login** switch instead, a
per-user login item (`SMAppService`). A copy run with `STAGE_UTILITY_OUTPUT_STATE_DIR`
never touches the login item, neither reading nor changing it, and its footer says
Open at login is not available: the item belongs to the user and the app, not the
state folder, so one a test made would outlive the test and start the helper at the
next login with the real state.

## Flags

| Flag | What it does |
|---|---|
| `--show-window` | Open the window at launch. Without it the window opens only on a first run (no `outputs.json` yet) or from the menu bar icon. |
| `--dump-frames <dir>` | Every 5 s, write a PNG of what each output is showing (`<output key>-NNNN.png`) and of the helper's own window (`window-NNNN.png`). It is how to check rendering on a Mac nobody is looking at, with the screen locked; nothing needs Screen Recording permission. A display output's picture comes from Chromium's DevTools (`Page.captureScreenshot`), turned as the window turns it. A card output's is the next new frame exactly as the card is sent it, 8-bit UYVY decoded back to RGB, so it shows the Metal conversion, the turn and the scaling. The copy is taken as the page hands the picture over; decoding, encoding and writing are off the main thread. A card output whose page draws nothing new has no dump that round. Leave it off when measuring. |
| `--list-outputs` | Print the stored state and exit: each display's and DeckLink port's output key, device id, and whether it is on (stored) or what it would default to. It only reads; a Mac with no device id yet is told so, not given one. |
| `--discovery-port <n>` | The UDP port to probe. Default 8789, or `STAGE_KIOSK_PORT`. |
| `--log-stderr` | Also print the log to the terminal. |
| `--virtual-sdi <n>` | For development: add n card outputs, 1 to 16, with no card behind them (below). Without it, none are shown. |
| `--test-pattern latency` | For development: every output that is on shows a latency test page instead of its server's screen: a large clock to photograph side by side with another output, and a stamp in its corner from which a card output times each picture exactly ([DECKLINK.md](DECKLINK.md#latency)). |
| `--frame-timings <file>` | For development: write every card output's slots to a CSV file, one line each with the times of its picture on the way to the card. |
| `--head-start <ms>`, `--fill-lead <ms>` | For development: when each card output's slot is asked for and filled, before it goes to air. Without them, the measured defaults (20 and 5 ms). |

## State

| What | Where |
|---|---|
| The Mac's device id, the optional `server` file, the installer's token, the `migrated-from-kiosk` marker | `/Library/Application Support/StageUtility/`, written by `install-macos.sh`. Read only. |
| Per-output state: `outputs.json` (enabled, token, the server it is bound to, whether it holds the kiosk's identity) | `~/Library/Application Support/StageUtilityOutput/` |
| Chromium's profile (cookies, local storage, cache) and its own log, `chromium.log` | `Chromium/` and `chromium.log` in the same user folder |
| A device id, when the installer never wrote one | `generated-device-id` in the same user folder. The window says so. |

`STAGE_UTILITY_OUTPUT_STATE_DIR` replaces both folders, for tests and development, and the installer's LaunchAgent is then looked for in its `LaunchAgents/`.
Nothing then reads or writes the real ones, nor the per-user login item.

`outputs.json` holds each output's secret token. The folder is created `0700` and the
files `0600` from the first byte, not narrowed afterwards.

A file that is missing is a first run and is made. One that exists but cannot be read,
or is not what the helper wrote, is left exactly as it is: the helper says so in its
window and the log and **saves nothing** until it is fixed or removed and the helper
restarted, because tokens saved over it would lock every claimed output out. The same
goes for an unreadable `generated-device-id`: the run uses a temporary id and does not
save it.

To turn an output on without the window, set `"enabled": true` on its record. This
works only while the helper is not running: it writes the file from memory whenever
anything changes, and overwrites an edit made behind its back.

## How outputs map to devices

Each output is its own device with id `<mac device id>.<output key>`, so a screen on
the server binds to a port on a Mac, not to the Mac. The id stays under the server's
128-character limit: a part too long is shortened to a prefix plus a hash of the
whole part, so it is stable and two Macs never collide.

Lengths are counted the way the server counts them, in UTF-16 code units (JavaScript's
string length), not characters or bytes. A probe is always under the server's 2048-byte
limit: if names in other scripts push it over, the long name falls back to the port,
then the modes go, then the extra MAC addresses, so the output still appears.

For a display the output key is its `CGDisplayCreateUUIDFromDisplayID` UUID,
lower-cased. It survives reboots and re-plugging. The name is `<connector> · <screen
name>`, where the connector is "Built-in" for the Mac's own panel and "Display N"
for everything else, because macOS does not say which port a display is on.

A DeckLink port's key is `decklink-<persistent id, hex>-<sub-device>`: the card's own
identity plus the connector, so a card unplugged and plugged back keeps its binding,
and moving a cable moves which screen goes out where. A card with no persistent id is
`decklink-t<topological id>-<sub-device>`, which holds while it stays in the same slot.
Its name is the driver's ("DeckLink Quad 2 (3)"), and it announces the modes the port
plays in 8-bit YUV that the server lists. A virtual one (`--virtual-sdi`) is
`virtual-sdi-<n>`.

The display with the menu bar is **off** until it is switched on, so the Mac keeps
its desktop. Every other display starts on. The default is decided once, when the
display is first seen, and stored.

A display that is unplugged closes its window; when it returns it reopens with the
same binding. A DeckLink port found once stays an output until the helper quits: a card
unplugged is logged, its line in the window says the port is unavailable, and it
reopens when the card is back. The outputs follow a change in the displays only after it has held for
one second, so a display that vanishes for a moment on wake does not tear down every
page.

## A Mac that was a Chrome kiosk

A Mac set up as a kiosk before the helper is bound on the server under its bare device
id, with the installer's `token` as its secret. When `install-macos.sh` replaces that
kiosk with the helper it writes `/Library/Application Support/StageUtility/migrated-from-kiosk`.
With the marker there, the main display's output takes the kiosk's identity: it goes by
the bare `<mac device id>` with the installer's token, and starts **on**, so the screen
the kiosk showed stays bound and keeps showing. Every other output is new, as usual.

This is decided once, when the main display's record is first made in `outputs.json`
(`"kioskIdentity": true`), and never moved: a restart with the menu bar on another
display, or the holder unplugged, does not give it to a second output. It is given
only with the marker, the installer's own device id and its token; an output that
already has a record is never converted, because its own id may be what a screen is
bound to. `--list-outputs` shows the id each output really goes by.

## Discovery, and what the server hears

Each enabled output sends the existing UDP probe, with an `output` object added. With
no `server` file it goes to the broadcast address of every interface:

```json
{"boundTo":"…","hostname":"booth-mini","id":"<mac>.<key>","macs":["…"],"os":"macOS",
 "output":{"kind":"display","name":"Display 2 · LG 27UL","port":"Display 2"},
 "stageUtility":"discover","v":1}
```

It probes every 2 s until the server answers, every 30 s after ten unanswered probes,
and every 30 s after an answer so the server goes on listing the output until it is
set up. The reply gives the server's id (kept as `boundTo`) and address. The output
then loads `<server>/enroll?device=<id>&token=<token>`, which shows a holding screen
until the output is set up on the server and redirects to its screen after.

**A `server` file** (`/Library/Application Support/StageUtility/server`, for a network
where broadcast does not cross) names the server, and the page loads from it at once.
The probes are still sent, by unicast to that server's host on the discovery port, so
the output still appears under *Not set up yet* in a multi-output Mac. If the host does
not resolve to an IPv4 address the helper says so once in the log. The address has to
be the root of the server (`192.0.2.10:8788`): the server's redirects and assets start
with `/`, so one with a path is refused, in the window and the log, with the address to
use, and discovery runs as if there were no file.

A page that fails to load is retried after 2, 4, 8, 16 and then 30 s. After three
failures in a row, or three failed health posts, discovery runs again, because the
server may have moved. Whether an output shows the holding screen or a set-up screen
is read from the page that has **committed**, not the one being loaded, so a retry
that fails against a server that is down changes nothing.

**Only the server it is bound to.** Once an output has heard a server it keeps that
server's id as `boundTo` and ignores answers from any other: anything on the network
can answer a broadcast, and the answer names the address the output sends its token
to. The first such answer is logged once. After 30 unanswered probes to its server (the
Linux agent's threshold) the probe also carries `unreachable: true`, so another server
can list the output as *bound elsewhere*.

*If the server is gone for good and an output must move to another:* quit the helper,
remove that output's `"boundTo"` line from `outputs.json` (and nothing else; its token
stays), and start it. It announces itself unbound and appears under *Not set up yet* on
whichever server is scanning. Until then it will not follow another server.

## Health

Every 10 s, an output that is showing a set-up screen posts
`{ at, dropped, fps, repeated }` to `/api/devices/<id>/health` with its token in the
`x-device-token` header. A display's fps is its display link's tick rate; `repeated`
and `dropped` are 0. A card output's come from the shim's scheduler (`CardCounters`),
the same for a DeckLink port and a virtual one: fps is frames sent per second, repeats
included; `repeated` the percent of them that carried the previous picture again because
the page's was late; and `dropped` the slots missed since the output was made, a total
(so a lower number than last time means the output was made again). A slot is missed
when the card reports its frame late or dropped, or when the schedule fell behind the
card and moved forward past it (a resync), so nothing of ours went out in it.

A **401 or 404** means the server does not recognise this output with this token (it
was released in Screens, or never set up; the server answers 401 for both so ids cannot
be listed). That is the output's own problem: **only its** posts pause, retried after 30,
60, 120 and then 300 s, or at once when its page becomes a set-up screen again. Its status
line in the window says "not recognised by the server, health paused". Other outputs keep
posting. Only the first pause is logged. Any other refusal or silence is logged once and
posting carries on; three silent posts in a row make the output look for the server again.

## Rotation

A screen's `rotation` (0, 90, 180 or 270, clockwise; absent is 0), set in the server's
Screens panel, is applied to a display output. The helper reads it from the screen's
record in `/api/outputs` when a page becomes a screen and every 10 s after, together with
the screen's name. The window lays the page out at the turned size (a portrait page for 90
or 270) and turns the view Chromium draws in about its centre (`frameCenterRotation` on the
view that holds it), so the screen is laid out for its real shape and not squeezed. AppKit
does the hit-testing in the turned view's coordinates, so a click or a touch lands where it
looks: driven with a 90° turn on a 1920 x 1080 display, clicks at window points (100, 200)
and (1800, 900) reached the page at (200, 1820) and (900, 120). A card output lays its
page out at the turned size too (1080 x 1920 for a quarter turn of a 1080p port), and
the Metal conversion turns each frame back as it writes it for the card
(`SurfaceFrameSource.rotation`), so the card is always sent a landscape frame. The page
shows upright for a moment at launch, before the first read.

A card output also reads the screen's `videoMode` there (absent is 1080p59.94). A
change reopens its port in that mode, and the page lays out at the mode's size; a mode
the port does not have is refused, said in the log and on the output's line in the
window, and the port stays off until the mode changes.

## DeckLink outputs

Each output port of a Blackmagic DeckLink or UltraStudio card is an output, as a
display is, and its own device on the server. A port is not a display: macOS never
sees it, the helper sends frames to it through Blackmagic's Desktop Video SDK, and so
DeckLink outputs are not limited by the Mac's display count. They render with no
window, so nothing on the Mac can cover them and they keep going with the screen
locked.

- **Desktop Video 12.0 or later** is needed, Blackmagic's driver, installed by the
  user. The helper ships only the SDK's headers. Without it there are no DeckLink
  outputs; the window and the log say so once ("Desktop Video is not installed, so
  there are no DeckLink outputs; install it and restart the helper"), and the
  displays work as before. A driver older than 12.0, or one that will not load, is
  said the same way.
- **Installing or updating Desktop Video takes a restart of the helper**: the SDK
  looks for the driver once per process.
- **What appears.** One output per port that can play out, named as the driver names
  it ("DeckLink Quad 2 (3)"), keyed `decklink-<persistent id>-<sub-device>` (see [How
  outputs map to devices](#how-outputs-map-to-devices)), with the modes it can play.
  The helper scans at launch and whenever the driver reports a device arriving or
  going. A port found once stays an output until the helper quits.
- **Format.** The screen's `videoMode` (Screen settings > Device > Format on the
  server), 1080p59.94 when it has none, opens the port in that mode, at its frame
  size; a change reopens it. The helper sends 8-bit YUV 4:2:2, Rec. 709. A mode the
  port does not have is refused: the output's line in the window says "Cannot play
  1080p25: the port has no 1080p25 (it offers ...)", the log says the same, and the
  port stays off until the format changes.
- **Unplugged or failed.** The port's output closes, its line reads "Port unavailable
  (...). Retrying", it tries again every 2 s and at once when a device arrives, and
  it reopens with the same binding and counts.
- **No picture.** A port that is sending but whose page has never handed over a
  picture, 10 s after it started, reads "No picture from the page. Sending black" in
  place of its frame rate, and the log says so; health reports every frame repeated.
  A page that drew and then stopped for 5 s reads "No new picture from the page.
  Reloading it" while it is reloaded. Both clear, with a log line, at the next picture.
- **Health** is the scheduler's own count, as for every card output (see
  [Health](#health)); falling behind is logged at the server's line.

[DECKLINK.md](DECKLINK.md) covers the rest: the SDK and its vendored headers, the
scheduler's timing, the helper's and the card's frames, bandwidth, the log lines, the
bench tool (`swift run DeckLinkProbe list`), and what only a real card can prove.

## Chromium

**The host.** `CEFHost/` is a small C++ and Objective-C++ layer over CEF with a C API
(`Sources/StageUtilityCEFHostAPI/include/stage_cef_host.h`): start and stop CEF, make a
windowed browser in a view or a windowless one of a given size, load, reload, resize, ask
a windowless browser for a frame, call a DevTools method, and report back a committed
page, a failed load with Chromium's net error, a renderer that ended, and each windowless
frame as an IOSurface. The Swift app does not link it: it opens the dylib at run time and
checks its API version, so `swift build` and the tests need no CEF, and an app whose host
is missing or damaged starts, finds the server and lists its outputs, and says in its
window that Chromium did not start.

**The event loop** is CEF's own (`CefRunMessageLoop`). On macOS that is AppKit's
`-[NSApplication run]` with Chromium's work on the same run loop, so the menu bar, the
window, the timers and every browser share one loop. CEF's alternative, an external pump
that calls `CefDoMessageLoopWork` from a timer, exists for apps that cannot hand over
their loop, and CEF documents it as slower; this app can. The app object is
`StageUtilityCEFApplication`, an `NSApplication` subclass in the host that conforms to
`CefAppProtocol`, as CEF requires; it is the bundle's `NSPrincipalClass`, and the app
makes it before anything else touches `NSApplication`. Quitting closes every page and
stops every clock, then ends the loop and shuts CEF down, so Chromium's processes go with
the app.

**The sandbox is on.** Chromium's renderer, GPU and utility processes run in its macOS
sandbox (seatbelt; each is started with `--seatbelt-client`). It needs no entitlement and
works with the ad hoc signature. It matters here because the pages are the server's own,
but a layout can embed outside content: a web page, a video.

**Display outputs** are windowed browsers, a child of a view in the output's borderless
window, so Chromium takes clicks, touches, scrolling and typing itself and a display
output can be a control surface. They keep drawing when macOS thinks their window is
hidden (a locked screen, an asleep display) through three public Chromium switches:
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and
`--disable-background-timer-throttling`. `--use-mock-keychain` keeps Chromium from ever
asking for the login keychain. Popups (`window.open`), JavaScript dialogs and the context
menu are refused: an output has nobody to answer them.

**Card outputs** are windowless browsers at their port's frame size, with shared
textures and external begin frames: they draw a frame only when asked, and hand it over
as an IOSurface that is valid only inside the callback. Each one feeds a
`DeckLinkOutputPort` (see [DECKLINK.md](DECKLINK.md)), whose scheduler, in the C++ shim,
runs on the card's clock, on a real-time thread of its own:

1. 20 ms before a slot goes to air, the scheduler asks the output's
   `SurfaceFrameSource` to begin it, which sends the browser a begin frame
   (`source.onBeginFrame` calls the host's `begin_frame`, which CEF runs on its UI
   thread). Each request first asks Chromium's capture for a picture, so a page that
   has not changed still hands one over, and a repeat always means late, never idle.
2. The picture arrives in `OnAcceleratedPaint`, on the main thread, and
   `source.present` converts it to UYVY on the GPU, turned for the screen's rotation,
   at the card's frame size, before the callback returns.
3. 5 ms before the slot goes to air, the scheduler has the source copy the newest
   converted picture into one of the card's frames and schedules it; if no new
   picture came, the frame carries the previous one again and counts as repeated.

How those times were chosen, and where the 20 ms goes, is in
[DECKLINK.md](DECKLINK.md#latency).

The scheduler is the one count of what went out (`CardCounters`: scheduled, repeated,
dropped, resyncs, skipped). Health is taken from it, and once a second it decides
whether the output is falling behind (`CardWatch` and `LagWatch`, core, tested). A page
that has drawn no new picture for 5 s is reloaded.

**`--virtual-sdi <n>`** adds n card outputs named "SDI n (virtual)", keyed
`virtual-sdi-n` (so each keeps its device id and binding between runs), kind `decklink`,
offering every mode the server lists. Each is a `DeckLinkOutputPort` with no card
(`.virtual`): the same scheduler on a software clock that ticks by itself at the rate
and size of the mode it is opened in, and sends the frames nowhere. They are listed,
claimed, rotated, set to a format and report health like a real port. Without the flag
they do not exist.

**Measured** on an M4 Mac mini, a display output and four virtual card outputs (one
turned a quarter, one in 720p59.94), all claimed and showing a static screen, over 2
minutes, without `--dump-frames`: health 59.9 to 60.0 fps (a 10 s window of a 59.94
clock holds 599 or 600 frames), 0% repeated, 0 dropped; the app and all its Chromium
processes used 0.30 of a core and 710 MB (phys footprint, 764 at most), against 0.003
core and 124 MB with no output on. That includes each card frame's copy and Metal
conversion to UYVY. A static screen is a floor; animated layouts cost more GPU and
renderer time.

**Updating Chromium is part of every release.** CEF follows Chrome's release train, about
every four weeks, and a browser's security fixes matter. To move to a new CEF: find the
newest `stable` entry for `macosarm64` and `macosx64` in
`https://cef-builds.spotifycdn.com/index.json`, put its version, file names, URLs, sizes
and SHA-1s in `cef.json`, download each and add its SHA-256 (after checking the SHA-1),
then build both architectures and drive the app.

Ad hoc signing makes Chromium log `Unable to derive validation category for current
process ... -67030` at launch; it has no effect seen so far. A Developer ID signature
should be checked for it before the helper is on many Macs.

## Local Network permission

Since macOS Sequoia an app that sends broadcasts or connects to machines on the LAN
asks once: "Allow Stage Utility Output to find devices on local networks?" Someone at
the Mac has to answer it. When it is refused, every broadcast probe fails with "no
route to host"; the helper logs that and says in its window that Local Network access
may be off, with where to turn it on (System Settings > Privacy & Security > Local
Network). Only that, a broadcast that failed on every interface, raises the warning. A
page that cannot load or a health post that gets "no route to host" does not: a server
that is switched off on the same subnet gives the same error.

The answer is tied to the app's code signature, and the app has to run from
`/Applications` for it to hold. An ad hoc signature is different on every build, so
after an update macOS may ask again. A Developer ID signature keeps the identity
stable across updates.

## Logging

The unified log, subsystem `com.stageutility.output`:

```sh
log stream --level info --predicate 'subsystem == "com.stageutility.output"'
```

It logs decisions and failures: an output appearing, going or switching, an answer from
a server, a probe that could not be sent, a page that did not load and when it will be
retried, health posts refused or paused, a rotation applied, a foreign server's answer
ignored, a state file that could not be read or saved. Chromium's own (category `cef`):
whether it started, with its version and whether the sandbox is on, or why not; a page's
renderer process ending, and the reload; the GPU process ending (Chromium starts
another). The DeckLink layer's (category `decklink`): a port opened in a mode, refused
one, lost or reopened, and a card output falling behind (a second with 5% or more of
its frames repeated, the server's own line, or any dropped) and keeping up again after
5 good seconds, on the change only. A page that drew nothing new for 5 s being reloaded
is under `output`. Trouble that
continues (a probe socket that will not open, every probe failing to send) is logged
when it starts and when it ends, not on every try. Healthy frames are not logged.
Tokens never are: every line has the query and fragment cut from any address in it
(`Redact`), so a page that did not load is logged as loading
`http://<server>/enroll`, without the device id and token the address carries.

Chromium did not start, and an output's page that has crashed (with how many times since
launch), are also said in the helper's window. Chromium writes its own warnings to
`chromium.log` in the helper's state folder, beside its profile (`Chromium/`).

## Layout

| Path | What |
|---|---|
| `Sources/StageUtilityOutputCore/` | Everything decidable without a window: the probe, reply, ids, URLs, state files, timing, health units and when a card output is falling behind, video modes, wording. Foundation only. |
| `Sources/StageUtilityOutput/` | The app: displays, windows, sockets, the menu bar, the window, the Chromium surfaces, and card outputs wired to their ports. |
| `Sources/StageUtilityCEFHostAPI/` | The browser host's C API, and the few lines that open the host at run time. |
| `CEFHost/` | The browser host, over CEF, built with CMake. |
| `Tests/StageUtilityOutputCoreTests/` | swift-testing tests of the core. Nothing that needs Chromium running is unit-tested; that is driven end to end. |
| `Vendor/DeckLink/`, `Sources/DeckLinkShim/`, `Sources/DeckLinkKit/`, `Sources/DeckLinkProbe/` | The DeckLink layer: the vendored SDK headers, the C++ shim and its scheduler, the Swift ports and Metal conversion, and a bench tool. See [DECKLINK.md](DECKLINK.md). |
| `Tests/DeckLinkKitTests/` | The scheduler on a software clock, the driver with none installed, and the Metal conversion on this Mac's GPU. |

An output is a `WebSurface` and somewhere for its pictures to go (`OutputSink`).
`WebSurface` is a protocol with no engine in it (load, reload, a committed-address
callback, a load-result callback, a renderer-gone callback, a snapshot); `SurfaceLoader`
is the part every engine shares (the retry, the backoff, what a 5xx means). A display
output (`DisplaySink`) is a `CEFWindowedSurface` in a borderless window over a whole
display (`WindowDestination`, which takes a placement and turns the view for a rotation
without knowing what draws in it). A card output (`CardOutput`) is a
`CEFWindowlessSurface` feeding a `SurfaceFrameSource` and a `DeckLinkOutputPort`.
