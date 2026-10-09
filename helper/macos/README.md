# Mac output helper

A menu bar app that turns a Mac into several Stage Utility screens at once. Each
of the Mac's displays is its own device, set up on the server like any other. It
is a beta feature.

The helper is a client. The server can be on another machine or on the same Mac.
It renders each screen's own URL in a `WKWebView`, so every view, widget and
layout works as it does in Safari.

## Build and run

Needs macOS 14 or later and a Swift 6 toolchain: the tests use swift-testing, which
ships with Swift 6 (`swift build` alone only needs 5.9). The Command Line Tools are
enough; Xcode is not required.

```sh
cd helper/macos
swift build                 # a debug build, .build/debug/StageUtilityOutput
./test.sh                   # the core library's tests
./build-app.sh              # StageUtilityOutput.app, signed ad hoc
```

`test.sh` runs `swift test`. With only the Command Line Tools it names the
`Testing` framework's location itself, which `swift test` does not find on its own.

`build-app.sh` writes the bundle next to itself (or into `$OUT`). It is universal
(arm64 and x86_64, joined with `lipo`: `swift build --arch` needs Xcode's xcbuild, so
each is built with `--triple`). Its version is the repository's `package.json`
version, kept whole in `CFBundleShortVersionString`; `CFBundleVersion` has to be
dotted integers, so it is the part before any `-` (`1.26.0` for `1.26.0-beta.4`). Its
bundle id is `com.stageutility.output`, and it is an agent app (`LSUIElement`): a menu
bar icon, no Dock icon.

### The CEF download

The helper renders with Chromium through the Chromium Embedded Framework (CEF). The
CEF version is pinned in `cef.json`, with the download URL, size, SHA-1 (from CEF's
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
  .build/debug/StageUtilityOutput --show-window --log-stderr
```

## Opening the window

The menu bar icon toggles the window. If the icon is out of reach, launching the app
again (or `open -a "Stage Utility Output"`) brings the window back; a second copy
started from a terminal hands over to the first and exits. The window has a
**Quit Stage Utility Output** button, because an agent app has no menu.

An output window sits above the menu bar, so one over the Mac's main display covers
the icon. The window therefore opens by itself at launch whenever an output covers the
main display, and again when a change in the displays newly covers it.

## Flags

| Flag | What it does |
|---|---|
| `--show-window` | Open the window at launch. Without it the window opens only on a first run (no `outputs.json` yet) or from the menu bar icon. |
| `--dump-frames <dir>` | Every 5 s, write a PNG of what each output is showing (`<output key>-NNNN.png`) and of the helper's own window (`window-NNNN.png`). It is how to check rendering on a Mac nobody is looking at: it uses `WKWebView.takeSnapshot`, which needs no Screen Recording permission. |
| `--list-outputs` | Print the stored state and exit: each display's output key, device id, and whether it is on (stored) or what it would default to. It only reads; a Mac with no device id yet is told so, not given one. |
| `--discovery-port <n>` | The UDP port to probe. Default 8789, or `STAGE_KIOSK_PORT`. |
| `--log-stderr` | Also print the log to the terminal. |

## State

| What | Where |
|---|---|
| The Mac's device id, the optional `server` file, the installer's token | `/Library/Application Support/StageUtility/`, written by `install-macos.sh`. Read only. |
| Per-output state: `outputs.json` (enabled, token, the server it is bound to) | `~/Library/Application Support/StageUtilityOutput/` |
| A device id, when the installer never wrote one | `generated-device-id` in the same user folder. The window says so. |

`STAGE_UTILITY_OUTPUT_STATE_DIR` replaces both folders, for tests and development.
Nothing then reads or writes the real ones.

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

The display with the menu bar is **off** until it is switched on, so the Mac keeps
its desktop. Every other display starts on. The default is decided once, when the
display is first seen, and stored.

A display that is unplugged closes its window; when it returns it reopens with the
same binding. The outputs follow a change in the displays only after it has held for
one second, so a display that vanishes for a moment on wake does not tear down every
web view.

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
and `dropped` are 0.

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
or 270) and turns the view about its centre, so the screen is laid out for its real shape
and not squeezed. `--dump-frames` PNGs are turned to match what the window shows. The page
shows upright for a moment at launch, before the first read. `videoMode` is a DeckLink
port's setting and is not read.

## Keeping a display painting

WebKit stops painting a window it thinks is hidden: a locked screen, an asleep
display. The helper turns that off with four private WebKit switches:

- `-[WKWebView _setWindowOcclusionDetectionEnabled:]`
- `-[WKPreferences _setHiddenPageDOMTimerThrottlingEnabled:]`
- `-[WKPreferences _setHiddenPageDOMTimerThrottlingAutoIncreases:]`
- `-[WKPreferences _setPageVisibilityBasedProcessSuppressionEnabled:]`

Each is checked every time an output is switched on (each output has its own web view),
set with a real `BOOL`, and read back. One that is missing or does not take is logged and
shown in the window. They are not public API and can change in any macOS release.

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
ignored, a missing WebKit switch, a state file that could not be read or saved. Trouble
that continues (a probe socket that will not open, every probe failing to send) is
logged when it starts and when it ends, not on every try. Healthy frames are not logged. Tokens never are.

## Layout

| Path | What |
|---|---|
| `Sources/StageUtilityOutputCore/` | Everything decidable without a window: the probe, reply, ids, URLs, state files, timing, wording. Foundation only. |
| `Sources/StageUtilityOutput/` | The app: displays, windows, sockets, the menu bar, the window. |
| `Tests/StageUtilityOutputCoreTests/` | swift-testing tests of the core. |

An output is a `WebSurface` placed by a destination. `WebSurface` is a protocol with no
engine in it (load, reload, a committed-address callback, a load-result callback, a
snapshot); `SurfaceLoader` is the part every engine shares (the retry, the backoff, what a
5xx means), and `WKWebSurface` is the WebKit surface (with `KeepPainting`, the only code that names WebKit
or its keep-painting switches). A display output puts the surface's view in a borderless window
over a whole display (`WindowDestination`, which takes a placement, so it can later take a
tile of a canvas display, and which turns the view for a rotation without knowing what draws
in it); a DeckLink port will be another destination.
