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
- The helper is a Swift app that renders with Chromium, embedded through the
  Chromium Embedded Framework (CEF).
  - SDI outputs render with no window at all, so the Mac stays free for other
    work, nothing can cover or freeze them, and they keep running with the
    screen locked.
  - Henry chose this over macOS's WebKit, which only paints reliably in a
    visible window, after measuring both (see Rendering).
  - The cost is a larger app and a Chromium update every release cycle.
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
| Display output | A borderless full-screen window on one of the Mac's displays, holding a CEF browser of the screen's URL | Helper |
| DeckLink output | A windowless CEF browser, rendered on command once for every frame the card is about to send, whose frames go to one DeckLink port | Helper, plus a C++ shim over the vendored SDK headers |
| Browser host | The CEF runtime and a small C++ layer Swift calls, the same shape as the DeckLink shim | Helper |
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
redirects once claimed) in a Chromium browser through CEF. Every view kind,
widget and layout therefore renders as it does on the Raspberry Pi kiosks, which
run Chromium, with no second renderer to keep in step.

**Display outputs.**
- A borderless window at `mainMenu + 1` level, covering the display, holding a
  windowed CEF browser. Chromium handles touch, scrolling and text input
  natively, which a control surface on a Mac-driven display needs.
- It follows hot-plug: a display that goes away closes its window, and a display
  that comes back reopens it with the same binding.
- The Mac's main display (the one with the menu bar) is off by default, so the
  booth Mac keeps its desktop. A headless Mac can turn it on.
- Rotation is applied inside the window: the browser lays out at the turned size
  and is rotated to fit.

**DeckLink outputs.** These have no window and no display:
- **Setup:** a windowless CEF browser per port, 1920×1080, with
  `windowless_rendering_enabled`, `shared_texture_enabled` and
  `external_begin_frame_enabled`.
- **On the card's clock:** when the card asks for frame n of its schedule, the
  helper calls `CefBrowserHost::SendExternalBeginFrame()`. Chromium runs the
  page's animation frame for that moment, composites it on the GPU, and hands
  back the picture as an IOSurface in `OnAcceleratedPaint`.
- **Copy:** the surface is valid only inside that callback, so it is blitted
  there. Metal converts it to 8-bit YUV 4:2:2 and applies rotation, into the
  DeckLink frame for slot n.
- **One render per output frame.** Page animation steps exactly at the output
  rate. There is no capture clock to reconcile with the card's, and no frame to
  pick.

**Measured on an M4 Mac mini (16 GB), CEF 154 (Chromium 154.0.8037.98), with the
screen locked for every run.** The test page was a bar moved by
`requestAnimationFrame`, and begin frames came from a 59.94 Hz timer standing in
for the card:

| Outputs (1920×1080) | New frames | Repeats / skips | Begin frame → frame (p50 / p95) | CPU, all processes | GPU | Memory |
|---|---|---|---|---|---|---|
| 1 | 1200 of 1200 | 0 / 0 | 3.6–4.0 / 4.2–6.1 ms | 0.1–0.17 core | under 10% | 290 MB |
| 4 | 4800 of 4800 | 0 / 0 | 3.7–4.3 / 4.2–7.2 ms | 0.4–0.75 core | 13–18% | 600 MB |
| 8 | 9600 of 9600 | 0 / 0 | 3.3–3.7 / 4.4–6.2 ms | 0.7–1.0 core | 27% | 1.0 GB |
| 8, plus a full frame copy each | 9600 of 9600 | 0 / 0 | 5.1 / 8.0 ms | 1.1 core | 24% | 1.06 GB |
| 16 | 19200 of 19200 | 0 / 0 | 4.7 / 8.7 ms | 1.6 cores | 50% | 1.7 GB |

- **What the numbers mean.** Every begin frame produced exactly one new picture,
  at every count. The animation stepped evenly. A full 1080p copy cost about
  0.7 ms.
- **The test page is a floor.** Real pages cost more, and Chromium's single GPU
  process (35–50% of one core at eight outputs) is the first thing to watch.
- **What it costs.** No permission prompt, no private API, and no Chromium
  switch was needed for any of this. The app bundle is about 320 MB, almost all
  of it the Chromium framework.

**Why not WebKit, which was measured first.**
- `WKWebView` needs no bundled engine, but WebKit stops painting any window it
  considers hidden: covered, off every display, or on a locked screen.
- Getting clean frames from it took either a visible, uncovered window on an
  awake display (a dummy HDMI plug as a canvas, one display slot per four
  outputs), or private WebKit switches plus pages hidden behind the desktop.
- Either way the screen had to stay unlocked, and the output had to pick
  captured frames against the card's schedule rather than render on command.
- It reached 1200 of 1200 only with all of that in place. CEF does it with none.

**Timing.**
- **Who drives.** The card's clock drives output, through scheduled playback.
  `ScheduledFrameCompleted` asks for the frame two slots ahead, and the helper
  sends that browser its begin frame.
- **When the page is late.** If its picture has not arrived in time, the
  previous picture repeats rather than letting the card run dry.
- **When the schedule slips.** If it falls behind the card's own stream time, it
  resyncs forward instead of building delay.
- **Where the idea comes from.** Clocking scheduled playback from the card's
  completion callback is the approach MxU Slides takes. MxU's code is licensed
  PolyForm Shield, which is source-available, not open source, so this project
  takes the idea and none of the code.

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
- **Packaging.**
  - A macOS runner in the release workflow downloads the pinned CEF binary
    distribution and checks its checksum.
  - It builds `libcef_dll_wrapper` and the C++ host with CMake and Ninja, and the
    Swift app with `swift build`.
  - It assembles CEF's bundle layout: the framework, plus the Helper, Helper
    (GPU), (Renderer), (Plugin) and (Alerts) sub-apps.
  - It signs the bundle from the inside out, ad hoc.
  - The app is about 320 MB, so the server also serves the download, for a Mac
    on a network with no internet. A file fetched with
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
- **Chromium updates.** CEF follows Chrome's release train, about every four
  weeks, and a browser's security fixes matter. Bumping the pinned CEF version
  is part of each release.
- **Updates.** The helper follows the server. On launch, and when the server's
  version changes, it compares its own version with `/api/version`. If they
  differ, it downloads the matching release, replaces itself in
  `/Applications` and relaunches. A failed update keeps the running version and
  says so.
- **Auto-login.** An output Mac still needs automatic login: Chromium's GPU
  process needs a logged-in session. A locked screen and an asleep display do
  not matter to SDI outputs; display outputs still need their displays awake.

## Logging

- **Helper.** It logs to the unified log under subsystem
  `com.stageutility.output`, and to the server through the health post.
- **Server.** It logs the decisions and failures tagged `[output-helper]`:
  - an output seen, claimed or released;
  - a port opened in a mode, or refused one;
  - a card unplugged;
  - a Chromium renderer or GPU process crashing, and the browser being reloaded;
  - a sustained drop in fps or rise in dropped frames.

  Every few seconds of healthy frames is not logged.

## Build order

1. **Server.** The probe `output` object, the same-machine allowance, grouping
   on Screens, `rotation` and `videoMode`, the health route, and the Device
   section. All TypeScript, and testable now with probes sent by hand.
2. **Helper core.** The menu bar app, discovery per output, display outputs
   with hot-plug, health posts and the LaunchAgent. It was built first on
   WebKit, behind an engine-neutral web surface.
3. **CEF.**
   - The browser host and the CEF bundle layout.
   - Windowed browsers for display outputs, replacing WebKit.
   - Windowless browsers with external begin frames, which DeckLink outputs
     will use.
   - Packaging in the release workflow.
4. **DeckLink.** Vendored headers, the shim, scheduled output, Metal YUV and
   rotation, and a null sink that runs the same scheduler on a software clock so
   the timing is testable without a card. Proven on real hardware once a
   DeckLink is connected.
5. **Installer.**

## Not in this

- Slices and edge blending for hardware splitters.
- Audio out of a DeckLink port.
- Key and fill output.
- NDI output from the helper. The same frames could feed an NDI sender later;
  NDI receive in widgets is a separate thread.
- Windows and Linux helpers. A Pi stays a single-screen kiosk.
