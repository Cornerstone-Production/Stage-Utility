# Mac output helper

**Goal.** A Mac running a small helper app becomes several screens at once.
Each of its own displays and each output port on a Blackmagic DeckLink or
UltraStudio is a separate device that the server sets up like any other. Screens
can therefore go out over SDI from a Mac mini, and the outputs are not capped by
the Mac's display limit. The helper is a client: the server may run on another
machine or on the same Mac.

**Mockup.** https://claude.ai/artifact/PcSoitwz96ukgthxauMSvH (v1). It covers a
Mac's outputs arriving on Screens, the Device section of an SDI screen's
settings, and the helper's own window. The mockup is the UI spec; where this text
and the mockup disagree, the mockup wins.

**Decided with Henry, 9 Oct 2026:**
- The helper is Swift, rendering with macOS's own WebKit, not Electron or
  embedded Chromium. It is lighter, and operators already run Stage Utility in
  Safari.
- It drives as many outputs as the hardware allows.
- The format is nearly always 1080p59.94.
- Outputs are plain. Splitting one output into slices for a hardware splitter
  is out of scope.
- It is a beta feature, and bugs found in use are expected.

## Why the Mac's display limit does not apply to SDI

A Mac's HDMI and Thunderbolt display outputs are driven by the chip's display
engine, and the limit is hardware: three external displays on an M4 Mac mini,
whatever hub is used. A DeckLink port is not a display. macOS never sees it as
one; the app writes frames to the card through Blackmagic's Desktop Video SDK.
ProPresenter calls these video outputs rather than graphics outputs, and that
distinction is how it exceeds the cap. The helper does the same: the Mac's own
displays are capped at three, and DeckLink ports are limited only by the cards.

## Pieces

| Piece | What it is | Where |
|---|---|---|
| Output helper | A menu bar app. It finds the server, announces one device per output, and draws each output's screen | `helper/macos/`, Swift package |
| Display output | A borderless full-screen window on one of the Mac's displays, holding a web view of the screen's URL | Helper |
| DeckLink output | An off-screen web view whose frames are sent to one DeckLink port on the card's clock | Helper, plus a C++ shim over the vendored SDK headers |
| Output devices on Screens | A Mac's outputs, grouped under the Mac in *Not set up yet*, each set up on its own | Screens page |
| Device section | For a helper output: which port, the format, rotation, and health | Screen settings panel |

## One Mac, many devices

- **Identity.** Each output is its own device, with id `<mac device id>.<output key>`.
  - The Mac's device id is the one the macOS installer already writes to
    `/Library/Application Support/StageUtility/device-id`.
  - The output key is stable across reboots and re-plugging:
    - for a display, its `CGDisplayCreateUUIDFromDisplayID` UUID;
    - for a DeckLink port, the card's persistent id plus the sub-device index.
  - A binding is to an output, so moving a cable to another port moves which
    screen goes out where. That matches how the router thinks about it.
- **The probe** gains an `output` object:
  `{ kind: "display" | "decklink", name, port, modes?: string[] }`.
  It is otherwise the same UDP probe, sent once per enabled output. `macs` and
  `hostname` are the Mac's.
- **Grouping.** The server groups devices with the same MAC under one machine on
  Screens. Outputs of one Mac are not flagged as "looks like" each other. The
  same-MAC hint stays for devices with no `output`.
- **Same machine.** The responder drops probes carrying one of the server's own
  MACs (`kiosk-responder.ts`), because a kiosk agent on the server's own machine
  was never a wall screen. A probe with an `output` is let through: the helper
  on the server's Mac is the supported case.
- **Releasing.** Releasing a helper output returns it to *Not set up yet*.
  Turning an output off in the helper stops its probes, and the bound screen goes
  offline like any unplugged device.

## Rendering

Every output renders the screen's own URL (`/enroll?device=<id>&token=…`, which
redirects once claimed) in a `WKWebView`. Every view kind, widget and layout
therefore works as it does in Safari, with no second renderer to keep in step.

**Display outputs.**
- A borderless window at `mainMenu + 1` level, covering the display.
- It follows hot-plug: a display that goes away closes its window, and a display
  that comes back reopens it with the same binding.
- The Mac's main display (the one with the menu bar) is off by default, so the
  booth Mac keeps its desktop. A headless Mac can turn it on.

**DeckLink outputs.**
- The web view lives in a window placed off every display.
- On each frame of the card's clock, the helper takes `WKWebView.takeSnapshot`
  (`afterScreenUpdates = false`) and copies its pixels out.
- Metal converts BGRA to 8-bit YUV 4:2:2 and applies rotation.
- The frame is written into the DeckLink frame the card has just finished with.

The capture choices come from measurement, not preference:

- **No ScreenCaptureKit.** It needs the Screen Recording permission, and since
  macOS Sequoia a monthly "Continue to allow" prompt. An unattended output box
  must not raise a dialog. `takeSnapshot` needs no permission.
- **WebKit stops painting a window it considers hidden.** That means a locked
  screen, an asleep display, or a window off every display, and a DeckLink web
  view is always off every display. The helper turns that off through WebKit SPI:
  - `-[WKWebView _setWindowOcclusionDetectionEnabled:NO]`;
  - on `WKPreferences`: `_setHiddenPageDOMTimerThrottlingEnabled:NO`,
    `_setHiddenPageDOMTimerThrottlingAutoIncreases:NO` and
    `_setPageVisibilityBasedProcessSuppressionEnabled:NO`.

  Each is checked with `respondsToSelector:` at launch. A missing one is logged
  and shown in the helper, because it would freeze DeckLink outputs. SPI can
  change in any macOS release, which is the main maintenance risk here.
- **Measured on an M4 Mac mini (16 GB), 1080p, 59.94 Hz sampling:**
  - Snapshot plus pixel copy takes 2–4 ms per frame.
  - Four outputs at once cost about one CPU core and about 630 MB in total.
  - With the display awake, 599 of 600 frames were new.
  - With the screen locked and the display asleep, an off-screen web view
    without the switches produced 1 new frame in 600. With them (each read back
    as off) it produced 587 of 600, and an on-screen one 533: WebKit falls back
    to a timer when no display is driving it.
  - The switches take a real `BOOL`. `perform(_:with: false)` passes an object
    pointer, which reads as YES, so the helper calls each setter's
    implementation directly and reads the value back.
  - A Mac with at least one awake display, a used built-in output or a dummy
    HDMI plug, gets the clean cadence. The test page was simple, and real
    displays will cost more.

**Timing.** The card's clock drives output, not the renderer:
- Scheduled playback. In `ScheduledFrameCompleted`, the latest finished
  picture is copied into the frame just returned and scheduled two frames ahead.
- A late page repeats the previous picture rather than letting the card run dry.
- If the schedule falls behind the card's own stream time, it resyncs forward
  instead of building delay.

This is the approach MxU Slides takes. MxU's code is licensed PolyForm Shield,
which is source-available, not open source, so this project takes the idea and
none of the code.

**Bandwidth.** Eight 1080p59.94 BGRA streams are about 4 GB/s, more than a
Thunderbolt PCIe enclosure carries. 8-bit 4:2:2 halves that. Whether a DeckLink
Quad 2 in an enclosure sustains all eight is unmeasured until real hardware is
on the bench.

## The DeckLink layer

- **Headers.** Blackmagic's DeckLink SDK headers are vendored under
  `helper/macos/Vendor/DeckLink/` with their license notice. Their license
  permits redistribution, and OBS vendors them in a GPL project. The Desktop
  Video driver is the user's install, and without it the helper offers display
  outputs only and says why.
- **Shim.** A small C++ shim (`decklink_shim.cpp`) exposes a C API to Swift:
  - enumerate ports and their output modes;
  - open a port in a mode;
  - hand over the latest frame;
  - read counters for frames scheduled, repeated and dropped (late, from the
    completion result);
  - close.
- **Isolation.** It runs in the helper process for the first release. A crash in
  the driver takes the helper down, and launchd restarts it. Moving it to its own
  XPC process, as MxU does, is a follow-up if that proves real.
- **Unplugged.** A card unplugged or a driver error closes that port's output,
  logs it, and keeps announcing the output as unavailable. Plugging it back in
  reopens it.

## Server changes

- **Probe.** `kiosk-discovery.ts` decodes the `output` object. Unknown kinds are
  ignored, and a probe without `output` behaves exactly as today.
- **Responder.** The same-machine filter lets through probes with an `output`.
- **Output fields**, both config:
  - `rotation?: 0 | 90 | 180 | 270`, absent meaning 0;
  - `videoMode?: string`, absent meaning 1080p59.94, and only meaningful on a
    DeckLink output.

  Both are written through the existing `PATCH /api/outputs/:id`. The helper
  reads them from the state it already receives for its screen.
- **Health.** `POST /api/devices/:id/health { fps, repeated, dropped, at }`,
  sent every ten seconds by each helper output. It is held in memory as runtime
  and shown in the Device section. A screen whose dropped count rises gets the
  same struggle box the video feeds use.
- **Screens.** Unclaimed devices are grouped by machine, with each output's
  name, kind and mode.
- **Screen settings → Device:** the port, Format (DeckLink only, from the
  modes the port reported), Rotation, health, and Release.

## Installing

- `install-macos.sh` installs the helper instead of today's Chrome kiosk when
  it finds Apple silicon or Intel macOS 14 or later:
  - it downloads `StageUtilityOutput.zip` from the GitHub release matching the
    server's version;
  - unpacks it into `/Applications`;
  - registers a LaunchAgent so the app starts at login.
- The helper reads the existing device id, `server` file and token. A Mac
  already set up as a kiosk keeps its identity: its single display becomes an
  output with the same binding.
- The Chrome kiosk path remains for a Mac where the helper cannot run, behind
  `--browser`.
- **Packaging.** A macOS runner in the release workflow builds the app with
  `swift build`, assembles the bundle and signs it ad hoc. A file fetched with
  `curl` carries no quarantine flag, so Gatekeeper does not block it.
  Notarisation with a Developer ID is a follow-up if Henry wants it.
- **Local Network permission.** Since macOS Sequoia, an app that finds or
  talks to other machines on the LAN asks once:
  - "Allow Stage Utility Output to find devices on local networks?"
  - Someone at the Mac answers it during setup. The helper also shows, in its
    own window, when it is missing.
  - The answer is tied to the app's code signature. An ad hoc signature changes
    with every build, so after an update macOS may ask again.
  - A Developer ID signature (Apple Developer Program) keeps the identity
    stable across updates. It is the reason to get one before the helper is on
    several Macs. It also lets a copy downloaded in a browser open without the
    Gatekeeper warning.
  - The app must run from `/Applications` for the permission to hold.
- **Updates.** The helper follows the server. On launch, and when the server's
  version changes, it compares its own version with `/api/version`. If they
  differ, it downloads the matching release, replaces itself in
  `/Applications` and relaunches. A failed update keeps the running version and
  says so.
- Auto-login, never-sleep and no screen lock are still required on an output
  Mac, and the installer still prints them.

## Logging

- **Helper.** It logs to the unified log under subsystem
  `com.stageutility.output`, and to the server through the health post.
- **Server.** It logs the decisions and failures tagged `[output-helper]`:
  - an output seen, claimed or released;
  - a port opened in a mode, or refused one;
  - a card unplugged;
  - a missing WebKit SPI;
  - a sustained drop in fps or rise in dropped frames.

  Every few seconds of healthy frames is not logged.

## Build order

1. **Server.** The probe `output` object, the same-machine allowance, grouping
   on Screens, `rotation` and `videoMode`, the health route, and the Device
   section. All TypeScript, and testable now with probes sent by hand.
2. **Helper core.** The menu bar app, discovery per output, display outputs
   with hot-plug, the WebKit keep-painting switches, health posts and the
   LaunchAgent. Testable on the dev Mac mini today.
3. **DeckLink.** Vendored headers, the shim, scheduled output, Metal YUV and
   rotation, and a null sink that runs the same scheduler on a software clock so
   the timing is testable without a card. Proven on real hardware once a
   DeckLink is connected.
4. **Installer and release packaging.**

## Not in this

- Slices and edge blending for hardware splitters.
- Audio out of a DeckLink port.
- Key and fill output.
- NDI output from the helper. The same frames could feed an NDI sender later;
  NDI receive in widgets is a separate thread.
- Windows and Linux helpers. A Pi stays a single-screen kiosk.
