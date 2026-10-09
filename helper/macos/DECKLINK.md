# DeckLink outputs

The Mac output helper's DeckLink layer: Blackmagic DeckLink and UltraStudio ports
as outputs, each its own device on the server like a display. A port is not a
display: macOS never sees it, and the helper writes frames to the card through the
Desktop Video SDK, so DeckLink outputs are not limited by the Mac's display count.

It is a library (`DeckLinkKit`) and a bench tool (`DeckLinkProbe`). Every card output
in the helper, a real port or a `--virtual-sdi` one, runs through it, its pictures
coming from a windowless Chromium browser; [How it plugs in](#how-it-plugs-in) says how.

## Requirements

- **Desktop Video 12.0 or later**, Blackmagic's driver, installed by the user. It
  provides `/Library/Frameworks/DeckLinkAPI.framework`, which the helper loads at
  run time. The SDK headers the helper builds against are vendored in
  [`Vendor/DeckLink/`](Vendor/DeckLink/README.md) (SDK 12.0); nothing of the driver
  ships with the helper.
- Without the driver there are no DeckLink outputs and the log says so once:
  "Desktop Video is not installed, so there are no DeckLink outputs; install it and
  restart the helper". A driver older than 12.0, or one whose API will not load, is
  reported the same way with what to do. Display outputs are unaffected.
- **Installing or updating Desktop Video takes a restart of the helper.** The SDK's
  dispatch looks for the framework once per process, so a driver installed while
  the helper runs is not seen until it starts again.

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
  picture straight into it (see [Helper frames and card frames](#helper-frames-and-card-frames)).
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

Health posts report `fps` as frames sent per second (repeats included), `repeated` as
the percent of those that were repeats, and `dropped` as every slot missed since the
port was made: reported dropped by the card, or passed over by a resync (`skipped`).

## Helper frames and card frames

A port sends its pictures in one of two kinds of frame, shown in its state
(`.running(mode:frames:)`, `port.frames`):

| Frames | What happens per frame | Cost |
|---|---|---|
| **The helper's** (the default) | Metal writes the picture into the helper's own page-aligned memory, which is handed to the card as an `IDeckLinkVideoFrame`. | No copy. |
| **The card's** | Metal writes into the same helper memory, then the picture is copied into a frame the card made (`IDeckLinkOutput::CreateVideoFrame`, 8-bit YUV), a line at a time if the card pads its lines. | One `memcpy` of 4 MB per 1080p frame: about 0.1 ms on an M4 Mac mini (0.07-0.10 ms, about 45 GB/s, measured with buffers larger than the caches). Eight outputs at 59.94 is about 5% of one core and 4 GB/s more memory traffic. |

The SDK lets an application hand over its own frames, but whether a given driver
takes them is unproven until a card is on the bench. So a port that has its own
frames refused while it is filling the pre-roll opens again by itself in the
card's frames for the rest of that open (a reopening tries the helper's frames
first again), and logs the switch once per port:

```
<port>: the card refused the helper's own frames, so it gets the card's frames, with one copy of each picture
```

Its open line then reads `opened in 1080p59.94 with the card's frames`. A frame
refused once playback is running is not a refusal of the kind of frame but a
failed port, and is handled as one. The card's frames are not written by Metal
directly, because nothing promises their memory is page-aligned and a whole number
of pages, which a Metal buffer without a copy needs.

`DeckLinkOutputPort(cardFrames: true)` and `DeckLinkProbe … --card-frames` use the
card's frames from the start.

## Bandwidth

8-bit 4:2:2 is 2 bytes a pixel: 1080p59.94 is about 249 MB/s per output, and eight
outputs about 2 GB/s across the bus. BGRA would be twice that. A Thunderbolt 3
PCIe enclosure carries roughly 2.7 GB/s of PCIe data, so eight should fit, but
**whether a DeckLink Quad 2 in a Thunderbolt enclosure sustains eight outputs is
unverified** until one is on the bench.

On the Mac's side the conversion costs about 1.3 ms of GPU time per 1080p frame on
an M4 Mac mini, measured with eight outputs at 59.94 (`DeckLinkProbe null 5 8`).

## Unplugged and failed ports

A device removed, a frame the driver refuses, playback stopping by itself, or a
running port that has sent nothing for two seconds closes that port's output and
logs it. The port tries to open again every 2 s, and at once
on `retry()`, which its owner calls when `DeckLinkDriver.watchDevices` reports a
device arriving. It logs when it is back, and its counts run on across the gap.

## Logging

Under the helper's subsystem, category `decklink`:

```sh
log stream --level info --predicate 'subsystem == "com.stageutility.output" && category == "decklink"'
```

| Line | When |
|---|---|
| `Desktop Video is not installed, so there are no DeckLink outputs; install it and restart the helper` | At the first scan, and again only if that changes. Likewise too old or not loading. |
| `Desktop Video 14.2: 2 output ports: …` | The driver found, or its ports changed. |
| `<port>: opened in 1080p59.94` / `reopened in …` | A port started, or came back. `… with the card's frames` when it sends in those. |
| `<port>: the card refused the helper's own frames, so it gets the card's frames, …` | Once per port, the first time it falls back. |
| `<port>: refused 1080p59.94: <reason>` | The mode cannot be played on that port. |
| `<port>: could not open (<reason>)` / `lost (<reason>)` | A port that will not open or went away; retried. A running port that sends nothing for two seconds is lost with "the card stopped taking frames". |
| `<port>: falling behind: r repeated and d dropped in the last second` / `keeping up again after n s` | A second with 3 or more repeats (5% at 59.94, the server's line) or any slot missed, and five good seconds in a row after it (`CardWatch`). |

Healthy frames are not logged.

## The bench tool

```sh
swift run DeckLinkProbe list                       # the driver, the ports, their modes
swift run DeckLinkProbe bars <output key> [mode] [seconds] [--card-frames]
swift run DeckLinkProbe null [seconds] [outputs] [--card-frames]   # the software clock, no card
```

`--card-frames` sends in frames the card makes, as a port does when its driver
refuses the helper's: the way to check that mode on a card that would take either.

`bars` and `null` play 75% colour bars with a moving white line through the whole
path (an IOSurface presented, the Metal conversion, the scheduler) and print the
counts every second. Each picture is drawn when the clock takes the frame before
it, on another thread, as a browser's begin frame would be.

## How it plugs in

| Type | Role |
|---|---|
| `CardFrameSource` | Answers "the picture for frame *n*", on the card's thread. Return false for a repeat. |
| `CardSink` | Pulls from a source on its own clock and counts: `counters` (`scheduled`, `rendered`, `repeated`, `dropped`, `resyncs`, `skipped`) and `takeHealthSample()`, in the server's units. |
| `DeckLinkOutputPort` | The `CardSink` for a port. `.port(DeckLinkPort)` for a card; `.virtual` for a `--virtual-sdi` output, the scheduler on a software clock at the size and rate of whichever server mode it is opened in; `.softwareClock(…)`, a fixed size, for tests and the bench tool. Once a second it logs falling behind and catching up, and calls `onSourceStalled` when the source has had nothing new for 5 s. |
| `SurfaceFrameSource` | A `CardFrameSource` an engine presents IOSurfaces to, with the `rotation`, the Metal conversion, and `captureNextFrame` for a dump of what the card was sent. |
| `DeckLinkInventory`, `DeckLinkDriver.watchDevices` | The ports to announce (`seen`: every port found since launch), and when to look again. |

In the helper, each card output (`CardOutput`) is a windowless CEF browser at the
port's frame size, a `SurfaceFrameSource` and a `DeckLinkOutputPort`. The browser's
`OnAcceleratedPaint` presents into the source, which copies the surface before the
callback returns; the source's `onFrameTaken` sends the browser its next begin frame
(CEF runs `SendExternalBeginFrame` on its UI thread), so the page renders once per
output frame, ahead of the frame that will carry it; the screen's `rotation` is the
source's, with the browser laid out at the turned size; its `videoMode` opens the
port. The helper's [README](README.md#chromium) has the rest.

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
- the card-frame fallback, on a software clock that refuses the helper's frames:
  it opens in its own frames, frames flow whole (its lines are longer than the
  helper's), the counts are right, the switch is said once, and closing frees
  every frame it made;
- the Metal conversion on this Mac's GPU, against exact UYVY bytes for white,
  black, the 75% bars and turned patterns;
- eight 1080p59.94 outputs on the software clock through the whole path;
- in the helper, four `--virtual-sdi` outputs through Chromium, the Metal conversion
  and the scheduler, claimed on a server, one turned a quarter and one reopened in
  720p59.94, at 59.94 fps with no repeats or drops once settled (the frames checked
  by `--dump-frames`, which decodes what the card was sent).

Only a card can prove:

- whether the driver accepts the helper's own frames (an `IDeckLinkVideoFrame` over
  helper memory, which the SDK allows) and DMAs from them, or refuses them at the
  pre-roll so the fallback takes over; a driver that took them and then sent
  garbage would not be caught, and is what `bars` with and without
  `--card-frames` side by side is for;
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
| `Sources/StageUtilityOutputCore/CardModes.swift`, `CardHealth.swift` | Mode naming and refusal; health in the server's units, and when an output is falling behind. |
| `Sources/DeckLinkProbe/` | The bench tool. |
