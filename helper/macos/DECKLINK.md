# DeckLink outputs

The Mac output helper's DeckLink layer: Blackmagic DeckLink and UltraStudio ports
as outputs, each its own device on the server like a display. A port is not a
display: macOS never sees it, and the helper writes frames to the card through the
Desktop Video SDK, so DeckLink outputs are not limited by the Mac's display count.

It is a library (`DeckLinkKit`) and a bench tool (`DeckLinkProbe`). The helper app
does not use it yet: a port's pictures come from a windowless browser, which the
Chromium (CEF) surface provides. [How it plugs in](#how-it-plugs-in) says how.

## Requirements

- **Desktop Video 12.0 or later**, Blackmagic's driver, installed by the user. It
  provides `/Library/Frameworks/DeckLinkAPI.framework`, which the helper loads at
  run time. The SDK headers the helper builds against are vendored in
  [`Vendor/DeckLink/`](Vendor/DeckLink/README.md) (SDK 12.0); nothing of the driver
  ships with the helper.
- Without the driver there are no DeckLink outputs and the log says so once:
  "Desktop Video is not installed, so there are no DeckLink outputs". A driver older
  than 12.0, or one whose API will not load, is reported the same way with what to
  do. Display outputs are unaffected.

## Ports and devices

Every DeckLink device that can play out is one output. A card with several
connectors (a Duo 2, a Quad 2) is several devices, one per sub-device.

| | |
|---|---|
| Output key | `decklink-<persistent id, hex>-<sub-device index>`, for example `decklink-1a2b3c4d-2`. A card that reports no persistent id gets `decklink-t<topological id>-<sub-device>`, which holds while it stays in the same slot. |
| Device id | `<mac device id>.<output key>`, as for a display. |
| Name and port | The driver's display name, "DeckLink Quad 2 (3)". |
| Modes | The modes the port plays in 8-bit YUV that the server lists, in the server's order: the probe's `modes`. |

The key is the card's own identity plus the connector, so moving a cable moves
which screen goes out where, and a card unplugged and plugged back keeps its
binding.

## Formats

The helper sends **8-bit YUV 4:2:2** (`bmdFormat8BitYUV`, UYVY), Rec. 709, video
range (Y 16-235, Cb and Cr 16-240). Each pair of pixels shares its chroma, the
average of the two.

A screen's `videoMode` names the mode; absent, it is **1080p59.94**. The name is
matched to the port's modes by size, scan and rate, not by the driver's wording:

| `videoMode` | Size | Frame rate (duration / scale) |
|---|---|---|
| `1080p23.98`, `1080p24`, `1080p25`, `1080p29.97`, `1080p30` | 1920 x 1080, progressive | 1001/24000, 1000/24000, 1000/25000, 1001/30000, 1000/30000 |
| `1080p50`, `1080p59.94`, `1080p60` | 1920 x 1080, progressive | 1000/50000, 1001/60000, 1000/60000 |
| `1080i50`, `1080i59.94`, `1080i60` | 1920 x 1080, interlaced | 1000/25000, 1001/30000, 1000/30000 (named by field rate) |
| `720p50`, `720p59.94`, `720p60` | 1280 x 720, progressive | 1000/50000, 1001/60000, 1000/60000 |

The list is the server's `VIDEO_MODES` (`main/types/output-format.ts`), copied in
`VideoModes.all`; a mode added there is added there too. An interlaced mode sends
a progressive picture as two fields. 2K DCI, UHD, SD and PsF modes have no name and
are not offered.

A mode is **refused**, with the reason in the log, when the server's list does not
have it, the port does not have it ("the port has no 1080p59.94 (it offers 1080i50,
1080i59.94)"), or the port has it only in other pixel formats. A refused port stays
off until the screen's mode changes.

## Timing

The card's clock drives each output, through scheduled playback.

- **Frames in flight.** Three frames, all filled and scheduled before playback
  starts. The frames' memory is the helper's own, page-aligned, so Metal writes the
  picture straight into it.
- **Each frame.** When the card finishes showing frame *k* (`ScheduledFrameCompleted`),
  the source is asked for frame *k* + 3, two slots after the one on air, and that
  frame is scheduled.
- **A late source.** If the source has no new picture, the frame carries the previous
  picture again and counts as **repeated**. Nothing waits for the page.
- **The card's own report.** A frame the card reports displayed late
  (`bmdOutputFrameDisplayedLate`) or dropped (`bmdOutputFrameDropped`) counts as
  **dropped**.
- **A schedule that slips.** If the host was held up and the next frame would go out
  at or before the frame on air, the schedule jumps to two frames ahead of the card
  (**resync**) instead of scheduling frames in the past, which would be shown late
  for good or dropped until it caught up.

Health posts report `fps` as frames sent per second (repeats included), with the
repeated and dropped counts since the last post.

## Bandwidth

8-bit 4:2:2 is 2 bytes a pixel: 1080p59.94 is about 249 MB/s per output, and eight
outputs about 2 GB/s across the bus. BGRA would be twice that. A Thunderbolt 3
PCIe enclosure carries roughly 2.7 GB/s of PCIe data, so eight should fit, but
**whether a DeckLink Quad 2 in a Thunderbolt enclosure sustains eight outputs is
unverified** until one is on the bench.

On the Mac's side the conversion costs about 1.3 ms of GPU time per 1080p frame on
an M4 Mac mini, measured with eight outputs at 59.94 (`DeckLinkProbe null 5 8`).

## Unplugged and failed ports

A device removed, a frame the driver refuses, or playback stopping by itself closes
that port's output and logs it. The port tries to open again every 2 s, and at once
on `retry()`, which its owner calls when `DeckLinkDriver.watchDevices` reports a
device arriving. It logs when it is back, and its counts run on across the gap.

## Logging

Under the helper's subsystem, category `decklink`:

```sh
log stream --level info --predicate 'subsystem == "com.stageutility.output" && category == "decklink"'
```

| Line | When |
|---|---|
| `Desktop Video is not installed, so there are no DeckLink outputs` | At the first scan, and again only if that changes. Likewise too old or not loading. |
| `Desktop Video 14.2: 2 output ports: …` | The driver found, or its ports changed. |
| `<port>: opened in 1080p59.94` / `reopened in …` | A port started, or came back. |
| `<port>: refused 1080p59.94: <reason>` | The mode cannot be played on that port. |
| `<port>: could not open (<reason>)` / `lost (<reason>)` | A port that will not open or went away; retried. |
| `<port>: repeating frames (n in the last 1 s)` / `stopped repeating frames (n in all)` | Repeats start, and stop after five quiet seconds. Likewise `dropping frames`. |

Healthy frames are not logged.

## The bench tool

```sh
swift run DeckLinkProbe list                       # the driver, the ports, their modes
swift run DeckLinkProbe bars <output key> [mode] [seconds]
swift run DeckLinkProbe null [seconds] [outputs]   # the software clock, no card
```

`bars` and `null` play 75% colour bars with a moving white line through the whole
path (an IOSurface presented, the Metal conversion, the scheduler) and print the
counts every second. Each picture is drawn when the clock takes the frame before
it, on another thread, as a browser's begin frame would be.

## How it plugs in

| Type | Role |
|---|---|
| `CardFrameSource` | Answers "the picture for frame *n*", on the card's thread. Return false for a repeat. |
| `CardSink` | Pulls from a source on its own clock and counts: `counters` (`scheduled`, `rendered`, `repeated`, `dropped`, `resyncs`) and `takeHealthSample()`. |
| `DeckLinkOutputPort` | The `CardSink` for a port. `.port(DeckLinkPort)` for a card; `.softwareClock(…, ticksByItself: true)` runs the same scheduler on a timer, with no card. |
| `SurfaceFrameSource` | A `CardFrameSource` an engine presents IOSurfaces to, with the `rotation` and the Metal conversion. |
| `DeckLinkInventory`, `DeckLinkDriver.watchDevices` | The ports to announce, and when to look again. |

For a windowless CEF browser per port:

1. Make a `SurfaceFrameSource` and a `DeckLinkOutputPort(.port(port), source:)`, and
   `open(videoMode:)` with the screen's `videoMode`.
2. In `OnAcceleratedPaint`, call `source.present(surface)`. It copies the surface on
   the GPU before returning, since the surface is valid only inside the callback.
3. Set `source.onFrameTaken` (before opening) to send that browser's
   `SendExternalBeginFrame()`, on CEF's UI thread. It is called on the card's thread
   each time a frame is taken, so the page renders once per output frame, ahead of
   the frame that will carry it.
4. Set `source.rotation` from the screen's `rotation`. The browser lays out at the
   turned size (1080 x 1920 for a quarter turn), as a display output's does.
5. Post `port.takeHealthSample()` every ten seconds.

The CEF branch's `NullCardSink` is the same shape: a sink that pulls frame *n*
from a provider on a 59.94 Hz clock and counts rendered, repeated and dropped.
`DeckLinkOutputPort` on a software clock is that sink with the card's scheduling
behind it; the two merge by having the null sink be the software clock, or by
making `NullCardSink` conform to `CardSink`, with its provider a `CardFrameSource`.

The scheduling follows the general approach MxU Slides describes (scheduled playback
clocked by the completion callback, the latest picture copied into the returned
frame). MxU's code is PolyForm Shield, not open source; none of it is used.

## What is proven, and what needs a card

Proven on a Mac with no DeckLink hardware and no driver:

- the shim builds and links against the vendored SDK; with no driver, the driver
  reads as not installed, the port list is empty, and opening a port says why,
  without crashing;
- mode naming and refusal against the SDK's documented mode timings;
- the scheduler, on the software clock: exactly the late frames repeat with the
  previous picture, a stalled host resyncs once with no frames dropped, an unplugged
  port is lost and reopens, health samples and the start/stop log lines;
- the Metal conversion on this Mac's GPU, against exact UYVY bytes for white,
  black, the 75% bars and turned patterns;
- eight 1080p59.94 outputs on the software clock through the whole path.

Only a card can prove:

- that the driver accepts the helper's own frames (an `IDeckLinkVideoFrame` over
  helper memory, which the SDK allows) and DMAs from them;
- port enumeration, persistent ids, sub-devices and the modes a real card reports;
- the card's completion results and stream time under load, and the resync on real
  timing;
- unplug and re-plug notifications, and `E_ACCESSDENIED` when another app holds the
  port;
- the colour on a scope, interlaced output, and the bandwidth of eight ports.

## Layout

| Path | What |
|---|---|
| `Vendor/DeckLink/` | The SDK headers and dispatch, unchanged, with Blackmagic's notice. |
| `Sources/DeckLinkShim/` | The C API (`include/decklink_shim.h`), the scheduler shared by card and software clock (`output.cpp`), the software clock (`fake_card.cpp`), the driver side (`decklink_shim.cpp`). |
| `Sources/DeckLinkKit/` | Swift: the driver and ports, the output port, the Metal conversion, the surface source. |
| `Sources/StageUtilityOutputCore/CardModes.swift`, `CardTrouble.swift` | Mode naming and refusal, and when repeats or drops start and stop. |
| `Sources/DeckLinkProbe/` | The bench tool. |
