# Mac output helper

A menu bar app that turns a Mac into several Stage Utility screens at once. Each
of the Mac's displays is its own device, set up on the server like any other. It
is a beta feature.

The helper is a client. The server can be on another machine or on the same Mac.
It renders each screen's own URL in a `WKWebView`, so every view, widget and
layout works as it does in Safari.

## Build and run

Needs macOS 14 or later and Swift 5.9 or later. The Command Line Tools are enough;
Xcode is not required.

```sh
cd helper/macos
swift build                 # a debug build, .build/debug/StageUtilityOutput
./test.sh                   # the core library's tests
./build-app.sh              # StageUtilityOutput.app, signed ad hoc
```

`test.sh` runs `swift test`. With only the Command Line Tools it names the
`Testing` framework's location itself, which `swift test` does not find on its own.

`build-app.sh` writes the bundle next to itself (or into `$OUT`). Its version is
the repository's `package.json` version, its bundle id is
`com.stageutility.output`, and it is an agent app (`LSUIElement`): a menu bar icon,
no Dock icon.

To try it without touching the real settings, point both state directories at a
scratch folder and open the window:

```sh
mkdir /tmp/suo
STAGE_UTILITY_OUTPUT_STATE_DIR=/tmp/suo \
  .build/debug/StageUtilityOutput --show-window --log-stderr
```

## Flags

| Flag | What it does |
|---|---|
| `--show-window` | Open the window at launch. Without it the window opens only on a first run (no `outputs.json` yet) or from the menu bar icon. |
| `--dump-frames <dir>` | Every 5 s, write a PNG of what each output is showing (`<output key>-NNNN.png`) and of the helper's own window (`window-NNNN.png`). It is how to check rendering on a Mac nobody is looking at: it uses `WKWebView.takeSnapshot`, which needs no Screen Recording permission. |
| `--list-outputs` | Print each display's output key, device id and default, and exit. |
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

`outputs.json` holds each output's secret token, so it is readable only by its owner.
An unreadable one is moved aside as `outputs.json.unreadable-<time>`, never deleted.
To turn an output on without the window, set `"enabled": true` on its record.

## How outputs map to devices

Each output is its own device with id `<mac device id>.<output key>`, so a screen on
the server binds to a port on a Mac, not to the Mac. The id stays under the server's
128-character limit: a part too long is shortened to a prefix plus a hash of the
whole part, so it is stable and two Macs never collide.

For a display the output key is its `CGDisplayCreateUUIDFromDisplayID` UUID,
lower-cased. It survives reboots and re-plugging. The name is `<connector> · <screen
name>`, where the connector is "Built-in" for the Mac's own panel and "Display N"
for everything else, because macOS does not say which port a display is on.

The display with the menu bar is **off** until it is switched on, so the Mac keeps
its desktop. Every other display starts on. The default is decided once, when the
display is first seen, and stored.

A display that is unplugged closes its window; when it returns it reopens with the
same binding.

## Discovery, and what the server hears

Unless a `server` file names the server, each enabled output sends the existing UDP
probe, with an `output` object added, to the broadcast address of every interface:

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

A page that fails to load is retried after 2, 4, 8, 16 and then 30 s. After three
failures in a row, or three failed health posts, discovery runs again, because the
server may have moved.

## Health

Every 10 s, an output that is showing a set-up screen posts
`{ at, dropped, fps, repeated }` to `/api/devices/<id>/health` with its token in the
`x-device-token` header. A display's fps is its display link's tick rate; `repeated`
and `dropped` are 0. A 404 means the server has no health route, and posting stops
until the helper is restarted.

## Keeping a display painting

WebKit stops painting a window it thinks is hidden: a locked screen, an asleep
display. The helper turns that off with four private WebKit switches:

- `-[WKWebView _setWindowOcclusionDetectionEnabled:]`
- `-[WKPreferences _setHiddenPageDOMTimerThrottlingEnabled:]`
- `-[WKPreferences _setHiddenPageDOMTimerThrottlingAutoIncreases:]`
- `-[WKPreferences _setPageVisibilityBasedProcessSuppressionEnabled:]`

Each is checked at launch, set with a real `BOOL`, and read back. One that is missing
or does not take is logged and shown in the window. They are not public API and can
change in any macOS release.

## Local Network permission

Since macOS Sequoia an app that sends broadcasts or connects to machines on the LAN
asks once: "Allow Stage Utility Output to find devices on local networks?" Someone at
the Mac has to answer it. When it is refused, every probe fails with "no route to
host"; the helper logs that and says in its window that Local Network access may be
off, with where to turn it on (System Settings > Privacy & Security > Local Network).

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
retried, health posts refused, a missing WebKit switch, a state file that could not be
saved. Healthy frames are not logged. Tokens never are.

## Layout

| Path | What |
|---|---|
| `Sources/StageUtilityOutputCore/` | Everything decidable without a window: the probe, reply, ids, URLs, state files, timing, wording. Foundation only. |
| `Sources/StageUtilityOutput/` | The app: displays, windows, sockets, the menu bar, the window. |
| `Tests/StageUtilityOutputCoreTests/` | swift-testing tests of the core. |

An output is an `OutputSink` (`Sources/StageUtilityOutputCore/OutputModel.swift`); a
display is one implementation, and a DeckLink port will be another.
