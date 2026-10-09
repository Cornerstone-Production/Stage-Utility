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

A connector set as an input in Desktop Video Setup (each of a DeckLink 8K Pro's four
is an input or an output) is not an output. Desktop Video 16.4 still lists its
modes, but refuses every one of them for playback, so a port that can play none
of its modes is listed in the helper's window as "Set as an input in Desktop Video
Setup", with no switch, and is not announced to the server. Desktop Video Setup sends
no device notification when a connector changes, so the helper looks at the ports
again every 10 s, off the main thread (a scan takes 22 to 45 ms on an 8K Pro). A
port that has become an output is announced from the scan that finds it.

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

The card's clock drives each output, through scheduled playback. Every slot (one
frame of the mode) is handled at two fixed times before it goes to air, on the
card's clock:

| When | What |
|---|---|
| **Head start**, 20 ms before air | The page is asked for the slot's picture: a begin frame to Chromium (`begin`). |
| **Fill lead**, 5 ms before air | The newest picture the page has handed over is copied into one of the card's frames, and the frame is scheduled (`fill`). |

- **A clock of its own.** Each output has a real-time thread that sleeps until the
  next begin or fill. The card's clock is read from its completions (each frame
  finishes exactly as the next slot begins), not by asking the driver, which takes
  up to 0.8 ms to answer. A real-time thread wakes within about 35 us of when it
  asked; at user-interactive priority macOS woke it 1.4 ms late, most of a fill
  lead.
- **Frames.** Three of the card's frames per output: the one on air, the one
  scheduled after it, and one to fill while a completion is on its way. More frames
  add no delay; when a frame goes out is set by the leads. Two are filled before
  playback starts (the pre-roll).
- **A late page.** If the page has handed over nothing new since the last fill, the
  frame carries the previous picture again and counts as **repeated**. Nothing waits
  for the page.
- **A late fill.** A fill that starts with less than 3.5 ms left before its slot
  could not reach the card in time, and one that finds every frame still with the
  card (its completions are late) has nothing to write into. Either way the slot is
  **skipped**: nothing of ours is sent for it, and the card holds its previous
  picture, rather than showing a frame late. A run of skipped slots is one **resync**.
- **The card's own report.** A frame the card reports displayed late
  (`bmdOutputFrameDisplayedLate`) or dropped (`bmdOutputFrameDropped`) counts as
  **dropped**.

The leads are measured, not guessed: see [Latency](#latency). `DeckLinkOutputPort`
takes others (`CardLeads`), and the helper's `--head-start` and `--fill-lead`
flags set them for every card output, for measuring.

Health posts report `fps` as frames sent per second (repeats included), `repeated` as
the percent of those that were repeats, and `dropped` as every slot missed since the
port was made: reported dropped by the card, or skipped.

## Latency

**Render to air** is the time from the page drawing a picture's content to the slot
carrying it beginning to go out of the card: how far the card's output runs behind
the page. Each slot's times are kept in the shim (`dl_frame_timing`, `FrameTiming`):
when the picture's content was drawn, handed over, converted, filled, copied into
the frame, taken by the card, on air, and finished with. The health sample carries
the window's median (`latencyMs`), the window shows it ("20 ms behind the page"), and
the log says it when it changes. The server's health route keeps only `fps`,
`repeated`, `dropped` and `at`, so `latencyMs` stays in the helper for now.

With the standard leads it is **20 ms at 1080p59.94**, down from 64.7 ms.

### How it is measured

- **Content.** For a page in general, a picture's content is taken to be drawn when
  the begin frame it answers was asked for (the last before it arrived): Chromium's
  animation frame runs on that begin frame's time. With `--test-pattern latency` the
  page writes its animation frame's time into its corner as a row of black and white
  blocks (`LatencyPage.Stamp`: a marker, 40 bits of microseconds, a checksum), and
  the helper reads it back out of every picture, so content time is exact there.
  It agreed with the begin frame's time to within 0.15 ms in every frame checked.
- **Air.** The card's completion of a frame is the start of the next slot, on the
  host clock: `GetFrameCompletionReferenceTimestamp` is already in
  `mach_absolute_time` on an 8K Pro with Desktop Video 16.4, 0.14 ms before the
  completion callback. The playback position from `GetScheduledStreamTime` agreed
  with it to 0.05 ms. The card's hardware reference clock is a different clock.
- **The card's need.** A frame handed to the card (`ScheduleVideoFrame` returned) 2.5
  ms or more before its slot went out on time; at 1.9 ms or less it was shown late.
  With a 4 ms fill lead, which gave the card 2.7 ms, it reported 1,173 of 7,190
  frames late. `ScheduleVideoFrame` itself takes 0.7 to 1.0 ms; it copies the frame.
- **Glass to glass.** Run the latency page on two outputs at once (a display and a
  card port), photograph both screens in one shot, and subtract the clocks: the
  difference between the two paths' delays, monitors included.

### Measured

On an M4 Mac mini, a DeckLink 8K Pro in a Thunderbolt enclosure, Desktop Video
16.4, 1080p59.94 out of port 1, two minutes per row, the stage view (a clock ticking
once a second) and the latency page (which changes every frame). `--frame-timings`
gives every row's figures.

| Pipeline | Page | Render to air, p50 / p95 | Repeats | Skipped | Card late | CPU (one core), memory |
|---|---|---|---|---|---|---|
| Before: filled at each completion, 3 frames queued | latency | 64.7 / 65.0 ms | 0 in 23 s | | | |
| Before | stage | not stamped | 1 a second | | 0 | 23%, 1.07 GB, with three input ports each running a page |
| 16 / 5 ms, capture at 60 fps, helper frames | stage | 16.0 / 16.0 | 61 in 59 s | 0 | 2 | |
| 20 / 5 ms, capture at 60 fps | stage | 20.0 / 20.0 | 116 in 115 s | 0 | 0 | 19% |
| 20 / 5 ms, capture at 120 fps | stage | 20.0 / 20.0 | 114 in 115 s | 0 | 1 | 19% |
| 16 / 5 ms, capture at 1000 fps | stage | 16.0 / 16.0 | 2 in 118 s | 3 | 0 | 17%, 477 MB |
| 16 / 5 ms, capture at 1000 fps | latency | 16.5 / 17.0 | 0 | 0 | 0 | 64%, 421 MB |
| 18 / 5 ms | stage | 18.0 / 18.0 | 0 | 3 | 0 | 17%, 472 MB |
| 18 / 5 ms | latency | 18.5 / 19.0 | 0 | 0 | 0 | 64%, 417 MB |
| **20 / 5 ms (standard)** | stage | 20.0 / 20.0 | 1 in 125 s | 1 | 0 | 18%, 468 MB |
| **20 / 5 ms (standard)** | latency | 20.5 / 21.0 | 0 | 0 | 0 | 63%, 419 MB |
| **20 / 5 ms (standard)**, again after review fixes | stage | 20.0 / 20.0 | 0 in 123 s | 0 | 0 | 17%, 477 MB |
| **20 / 5 ms (standard)**, again after review fixes | latency | 21.1 / 21.9 | 1 in 125 s | 0 | 0 | 63%, 422 MB |
| 19 / 4 ms | stage | 19.0 / 19.0 | 0 | 0 | 1,173 | 18%, 473 MB |

The pairs are head start / fill lead. The latency page's figures run up to a
millisecond higher, more as a run goes on, because they are read from its stamp:
the page's clock is fixed when it loads, and the helper places it on the host clock
through the wall clock, which macOS keeps adjusting. The helper's own figure for the
same frames, from the begin frames, is 20.0 ms. The page costs more CPU
because it draws a new picture every frame.

- **Why 20 ms.** The head start has to cover the page's render, the conversion and
  the fill lead. The stage view hands over a picture about 1 ms after its begin
  frame when nothing changed, and up to 12 ms after on the frame its clock ticks or
  the server pushes an update. The latency page takes 8 ms, and up to 9.2 at p99.
  At 16 ms the stage view repeated twice in two minutes. At 18 ms the tightest
  picture was ready 0.08 ms before its fill, which is luck, not margin. At 20 ms
  there is about 2 ms to spare at the worst page render seen.
- **Why 5 ms.** The fill copies the picture into the frame (0.5 ms) and the card
  takes it (0.8 ms), leaving the card 3.7 ms (p50; 2.6 at the least outside a
  driver stall) where it needs about 3. At 4 ms it showed one frame in six late.
- **Capture rate.** Chromium's capture of a windowless page is limited to
  `windowless_frame_rate` captures a second. At 60 or 120 it held back the picture
  for the frame after a page change past the card's deadline, a repeat every time
  the clock ticked. The host sets 1000; the begin frames set the cadence.
- **What still costs a frame.** About once every one to two minutes the driver's
  `ScheduleVideoFrame` slows down for a few seconds, from under 1 ms to 3, 10, and
  at worst 30 to 55 ms. It happened with nothing else using the card, and in both
  kinds of frame, though more in the helper's (`DeckLinkProbe bars` saw it there
  with no browser running at all). A fill that waits that long makes the slots after
  it too late, and they are skipped; the standard row's one repeat and one skip are
  one such stall. A lead that rode it out would have to be more than 50 ms, more
  than the whole delay this replaced. It is the one thing in the table not caused
  by the page or the helper.

### The budget, slot by slot

At 1080p59.94 a slot is 16.68 ms. Times are before the slot goes to air, the
standard leads, the medians measured above.

| ms before air | Stage view (a still page) | Latency page (a new picture every frame) |
|---|---|---|
| 20.0 | Begin frame sent; Chromium runs the page's animation frame on this time | The same |
| 19.0 | Picture handed over (Chromium's capture of the page as it is) | |
| 17.6 | Converted to UYVY, ready | |
| 12.0 | | Picture handed over, the page drawn |
| 10.7 | | Converted, ready |
| 5.0 | Fill: the newest picture copied into one of the card's frames (0.5 ms) | The same |
| 4.5 | `ScheduleVideoFrame`: the card takes it (0.8 ms) | The same |
| 3.7 | In the card's queue | The same |
| 0 | The slot begins going out of the SDI port: **20 ms after the content was drawn** | The same |
| -16.7 | The last line of the frame has gone out; the card reports it complete | The same |

The monitor then adds its own delay. The SDI picture's top line leaves at 0 and its
bottom line 16.7 ms later, as on any progressive output.

### Glass to glass

`--test-pattern latency` puts the latency page on every output that is on, a
display output as well as a card port. Both read the same clock, so a photograph of
the two screens shows their difference, each monitor included:

```sh
STAGE_UTILITY_OUTPUT_STATE_DIR=<a folder of its own> \
  dist/arm64/StageUtilityOutput.app/Contents/MacOS/StageUtilityOutput --test-pattern latency --log-stderr
```

A card port is on from the start; the main display's output is off until it is
turned on in the helper's window (or in that folder's `outputs.json`). It then covers
the main display, menu bar included, and the helper's window opens over it: move
the window off the clock, and quit from it when done. A shutter of 1/250 s or faster keeps the milliseconds legible; the moving
bar and its tick marks give the same reading where they blur.

## Helper frames and card frames

A port sends its pictures in one of two kinds of frame, shown in its state
(`.running(mode:frames:)`, `port.frames`). Either way the page's picture, already
converted to UYVY when the page handed it over, is copied straight into the frame
at the fill: one `memcpy` of 4 MB per 1080p frame, about 0.5 ms.

| Frames | What they are | Used |
|---|---|---|
| **The card's** (the default) | Frames the card made (`IDeckLinkOutput::CreateVideoFrame`). | Always, unless the card will not make them. |
| **The helper's** | Page-aligned memory of the helper's own, handed to the card as an `IDeckLinkVideoFrame`. | When the card will not make frames, or when asked for. |

On an 8K Pro with Desktop Video 16.4, the driver took the helper's frames, but now
and then `ScheduleVideoFrame` stalled on them for 3 to 38 ms at a time, in episodes
of a few seconds, with nothing else running; over the same two minutes in the card's
frames it never took more than 2 ms (`DeckLinkProbe bars`, 7,240 frames each). So a
port asks for the card's frames. One whose card will not make frames opens again by
itself in the helper's, and one asked for the helper's whose card refuses them during
the pre-roll opens again in the card's; either switch is logged once per port:

```
<port>: the card would not make frames of its own, so it gets the helper's frames
<port>: the card refused the helper's own frames, so it gets the card's frames
```

and its open line then reads `opened in 1080p59.94 with the helper's frames`. A frame
refused once playback is running is not a refusal of the kind of frame but a failed
port, and is handled as one.

`DeckLinkOutputPort(frames: .helper)` and `DeckLinkProbe … --helper-frames` ask for the
helper's frames.

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
| `<port>: opened in 1080p59.94` / `reopened in …` | A port started, or came back. `… with the helper's frames` when it sends in those; `; pictures asked for 16 ms and filled 4 ms before air` when the leads are not the standard ones. |
| `<port>: the card would not make frames of its own, so it gets the helper's frames` / `the card refused the helper's own frames, so it gets the card's frames` | Once per port, the first time it switches. |
| `<port>: render to air 20.0 ms (p95 20.1, max 20.2) over 591 new pictures` | When a health window first measures it, and again when it moves by 4 ms or more: how far behind the page the card's output runs (see [Latency](#latency)). |
| `<port>: refused 1080p59.94: <reason>` | The mode cannot be played on that port. |
| `<port>: could not open (<reason>)` / `lost (<reason>)` | A port that will not open or went away; retried. A running port that sends nothing for two seconds is lost with "the card stopped taking frames". |
| `<port>: no picture from the page in 10 s of sending, so the card is sending black` / `pictures from the page again` | A running port whose page has never handed over a picture, and the first picture after that or after a stall (`CardWatch`). The window says "No picture from the page. Sending black" meanwhile, in place of the frame rate. |
| `<port>: falling behind: r repeated and d dropped in the last second` / `keeping up again after n s` | A second with 5% or more of its frames repeated (the server's line: 3 at 59.94, 2 at 23.98 to 30) or any slot missed, and five good seconds in a row after it (`CardWatch`). |

Healthy frames are not logged.

## The bench tool

```sh
swift run DeckLinkProbe list                       # the driver, the ports, their modes
swift run DeckLinkProbe bars <output key> [mode] [seconds] [--helper-frames] [--head-start ms] [--fill-lead ms]
swift run DeckLinkProbe null [seconds] [outputs] [--helper-frames] [--head-start ms] [--fill-lead ms]
```

`--helper-frames` sends in frames of the helper's own memory, as a port does when its
card will not make frames: the way to check that kind on a card that would take
either. `--head-start` and `--fill-lead` move the two times each slot is handled at.

`bars` and `null` play 75% colour bars with a moving white line through the whole
path (an IOSurface presented, the Metal conversion, the scheduler) and print the
counts every second, and at the end where the delay went, stage by stage
(`LatencyBreakdown`). Each picture is drawn when the clock asks for it, on another
thread, as a browser's begin frame would be. With `DECKLINK_PROBE_CSV=<file>` every
slot's timing is written out too.

## How it plugs in

| Type | Role |
|---|---|
| `CardFrameSource` | Starts the picture for slot *n* when asked (`begin`, the head start before air), and hands over the newest picture with its times (`fill`, the fill lead before air), on the output's clock thread. Nil for a repeat. |
| `CardSink` | Pulls from a source on its own clock and counts: `counters` (`scheduled`, `rendered`, `repeated`, `dropped`, `resyncs`, `skipped`) and `takeHealthSample()`, in the server's units, with the window's render-to-air latency (`latencyMs`). |
| `DeckLinkOutputPort` | The `CardSink` for a port. `.port(DeckLinkPort)` for a card; `.virtual` for a `--virtual-sdi` output, the scheduler on a software clock at the size and rate of whichever server mode it is opened in; `.softwareClock(…)`, a fixed size, for tests and the bench tool. Once a second it logs falling behind and catching up, and a page that has never drawn 10 s after it started sending, and calls `onSourceStalled` when the source has had nothing new for 5 s; `status` carries why a running port is not sending the page. |
| `SurfaceFrameSource` | A `CardFrameSource` an engine presents IOSurfaces to, with the `rotation`, the Metal conversion at the size of the frames it is asked to fill, and `captureNextFrame` for a dump of what the card was sent. |
| `DeckLinkInventory`, `DeckLinkDriver.watchDevices` | The ports to announce (`seen`: every port found since launch), and when to look again. |

In the helper, each card output (`CardOutput`) is a windowless CEF browser, a
`SurfaceFrameSource` and a `DeckLinkOutputPort`. The browser's `OnAcceleratedPaint`
presents into the source, which converts the surface to UYVY before the callback
returns, at the size of the frames the port last asked it to fill; the source's
`onBeginFrame` sends the browser its begin frame for each slot (CEF runs
`SendExternalBeginFrame` on its UI thread), so the page renders once per output frame;
the screen's `rotation` is the source's; its `videoMode` opens the port. Every time
the port opens, the first time or on a retry, it says so with its frame size
(`onOpened`), and the browser is laid out at that size, turned for a quarter turn
(`CardPageLayout`). Neither the conversion nor the layout follows the format asked
for, so a port that opens late, or reopens in another format after it was lost, sends
the page at its own size. The helper's [README](README.md#chromium) has the rest.

## What is proven, and what needs a card

Proven on a Mac with no DeckLink hardware and no driver:

- the shim builds and links against the vendored SDK; with no driver, the driver
  reads as not installed, the port list is empty, and opening a port says why,
  without crashing;
- mode naming and refusal against the SDK's documented mode timings;
- the scheduler, on the software clock: each slot begun and filled at its leads,
  exactly the late frames repeat with the previous picture, a slot whose frames the
  card still holds or that is too late for the card is skipped, an unplugged port is
  lost and reopens, every slot's times reach the health sample, the start and stop
  lines;
- the frame fallbacks, on software clocks: one that makes no frames gets the
  helper's, one that refuses the helper's gets its own, frames flow whole (the
  card's lines are longer than the picture's), the switch is said once, and closing
  frees every frame made;
- the Metal conversion on this Mac's GPU, against exact UYVY bytes for white,
  black, the 75% bars and turned patterns;
- eight 1080p59.94 outputs on the software clock through the whole path;
- in the helper, four `--virtual-sdi` outputs through Chromium, the Metal conversion
  and the scheduler, claimed on a server, one turned a quarter and one reopened in
  720p59.94, at 59.94 fps with no repeats or drops once settled (the frames checked
  by `--dump-frames`, which decodes what the card was sent).

Proven on a DeckLink 8K Pro, Desktop Video 16.4, an M4 Mac mini, an SDI monitor on
port 1:

- port enumeration, persistent ids, four sub-devices, and the connectors set as
  inputs (modes listed, none playable);
- both kinds of frame accepted and shown, with no drops over two minutes of bars in
  either; the helper's stalled `ScheduleVideoFrame` in episodes, the card's did not;
- completion timestamps on the host clock, the playback position, the card's need of
  2.5 to 3 ms, a skipped slot held by the card with nothing reported late;
- the stage view and the latency page through Chromium at 59.94 fps, 20 ms render
  to air, the counts above.

Still only a card can prove:

- unplug and re-plug notifications, and `E_ACCESSDENIED` when another app holds the
  port;
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
