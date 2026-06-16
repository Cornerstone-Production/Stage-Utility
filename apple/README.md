# StageDisplay — native Apple client

A SwiftUI multiplatform app (tvOS · iPadOS · macOS) that is a **second client** of
the same Stage Utility server the web app talks to. It renders all four display
kinds — **slots · dashboard · stage · transcription** — from live server state, and
(Phase 2) adds the one thing a browser can't do: **receive and display NDI video**
behind the data overlays.

The server stays the single source of truth. This app consumes the **identical**
REST + SSE contract as the web client; neither owns state. See the repo root
`README.md` and `/Users/.../plans` design doc for the full architecture.

> **Status: Phases 1–3 built out.** Data rendering, server connection, the NDI
> receive pipeline (gated on the SDK), appliance mode, keep-awake, and the NDI
> attribution are all in place. The one remaining step is **wiring the licensed
> NDI SDK** (below) — until then the app builds and runs with a placeholder where
> video would be. Open in Xcode to build; it hasn't been compiled in CI (only
> type-checked file-by-file against the 27 SDK with Command Line Tools).

---

## Requirements

- **Xcode 26** (stable, ships the macOS 26 "Tahoe" / iOS · tvOS 26 SDK with Liquid
  Glass). Xcode 27 beta also works — the project is 27-ready (see *SDK targets*).
- Deployment target **26.0** on all platforms (so Liquid Glass is available without
  `#available` gymnastics). You can lower this; the glass helpers fall back to a
  material below 26.
- Optional: **XcodeGen** (`brew install xcodegen`) to generate the `.xcodeproj`
  from `project.yml`. You can also create the project by hand instead.

## Generate / open the project

**With XcodeGen (recommended):**
```sh
cd apple
xcodegen generate      # produces StageDisplay.xcodeproj (git-ignored)
open StageDisplay.xcodeproj
```

**By hand:** create a new **Multiplatform App** in Xcode named `StageDisplay`, set
the deployment targets to 26.0, delete the template `ContentView`/`App` files, and
drag the `StageDisplay/` folder in (folder reference or groups). Add the Info.plist
keys listed under *NDI / networking* below.

Pick a run destination (Apple TV, iPad, or My Mac) and ⌘R. On first launch enter
your server URL (e.g. `http://stage-utility.local:8788` or `http://<ip>:8788`).

## File layout

```
apple/
  project.yml                 XcodeGen spec (targets, SDK, Info.plist keys)
  NDISupport/module.modulemap  makes the licensed NDI SDK importable as `import NDI`
  StageDisplay/
    StageDisplayApp.swift      @main entry
    Models/DTOs.swift          Codable mirrors of main/types/stage.ts  ← CONTRACT
    Networking/
      SSEClient.swift          /api/events stream (event:/data:, reconnect)
      ServerClient.swift        REST hydrate (/api/state + best-effort PP/PCO/transcript)
    State/AppModel.swift        @Observable store: SSE channels → published state
    NDI/
      NDIReceiver.swift         NDIReceiving seam + factory + NDISupport.isAvailable
      NDISDKReceiver.swift      real pipeline (#if canImport(NDI)): find → recv → CMSampleBuffer
      SampleBufferDisplayView.swift  NDIVideoView: AVSampleBufferDisplayLayer host
    Theme/                      AppBackground (#080810), Glass helper, Color(hex:), KeepAwake
    Views/
      RootView                  routes connect / appliance / picker; keep-awake; reconnect
      ServerConnectionView / DisplayPickerView (pin) / AboutView (NDI attribution)
      DisplayContainerView      NDI video + overlays + long-press appliance control bar
      Components/               CountdownView (+ skew-corrected math), TranscriptStrip, NDIVideoLayer
      Displays/                 Slots · Dashboard · StageConfidence · Transcription
```

## How it talks to the server

- **Hydrate on connect:** `GET /api/state` (required). `GET /api/propresenter/status`,
  `GET /api/pco/live`, `GET /api/prodcom/transcript` are best-effort (`try?`) — on
  servers that don't expose them, the SSE channels backfill the same data on the
  next push.
- **Live:** SSE `GET /api/events`, channels `stage:state-changed`, `pco:live`,
  `propresenter:status`, `prodcom:transcript` (see `AppModel.handle`).
- **NDI assignment:** delivered for free inside `stage:state-changed` as
  `DisplayInfo.ndiSource` — no separate channel. Set it in the web settings under
  **Displays**.

## SDK targets & Liquid Glass (HIG)

- Build against the **latest stable SDK**. As of June 2026 that's the **26** SDK
  (Liquid Glass shipped). macOS 27 "Golden Gate" is dev-beta (GA ~Sept 2026) — when
  it ships, develop in Xcode 27, gate any 27-only API with `if #available(macOS 27, *)`,
  and bump the deployment target.
- **Glass goes on the functional layer, not the content layer.** The connection
  screen / pills / buttons use `.controlGlass()` / `.glassProminent`. The live
  slide/lyric/caption text stays **solid and high-contrast** so it reads over NDI
  video on a wall monitor. Keep it that way.

## Phase 2 — NDI receive (built; needs the SDK wired)

The pipeline is implemented in `NDI/`:
- `NDIReceiver.swift` — the `NDIReceiving` seam + `makeNDIReceiver` factory +
  `NDISupport.isAvailable`. All gated on `#if canImport(NDI)`.
- `NDISDKReceiver.swift` — the real receiver: `NDIlib_find` (discover by name) →
  `NDIlib_recv` → CVPixelBuffer (UYVY/BGRA) → CMSampleBuffer (display-immediately).
- `SampleBufferDisplayView.swift` — `NDIVideoView`, a layer-backed
  `AVSampleBufferDisplayLayer` host (UIView on iOS/tvOS, NSView on macOS) that
  enqueues frames via `sampleBufferRenderer`. AVFoundation uses VideoToolbox under
  the hood for compressed formats.
- `NDIVideoLayer.swift` shows live video when the SDK is linked, else a placeholder.

**To enable video** (the SDK is licensed/downloaded separately — never vendored
in git):
1. Download the **NDI SDK** from ndi.video, accept the SDK terms, and confirm
   H.264/H.265/AAC codec licensing for your distribution.
2. Drop its headers + libs under `apple/Vendor/NDI/` (git-ignored). Add the
   `libndi` XCFramework to the target.
3. Point the build at the module map so `import NDI` (and thus
   `#if canImport(NDI)`) resolves — see `apple/NDISupport/module.modulemap`. Set
   `SWIFT_INCLUDE_PATHS = $(SRCROOT)/NDISupport`,
   `HEADER_SEARCH_PATHS = $(SRCROOT)/Vendor/NDI/include`,
   `LIBRARY_SEARCH_PATHS = $(SRCROOT)/Vendor/NDI/lib`. Confirm the enum/field
   spellings in `NDISDKReceiver.swift` against your installed headers.
4. **Info.plist** is already set in `project.yml`: `NSLocalNetworkUsageDescription`
   + `NSBonjourServices` (`_ndi._tcp`) for the Local Network prompt + mDNS.

The "Powered by NDI®" attribution is in `AboutView` (open from the picker's ⓘ or
the appliance control bar).

## Phase 3 — appliance & distribution (built)

- **Pin a display as the appliance:** long-press a display (or its context menu
  → *Pin as appliance*). On next launch the app opens straight to it, no chrome
  (`@AppStorage("pinnedDisplayId")` in `RootView`). Long-press again →
  *Exit appliance*.
- **Keep-awake:** `.keepAwake()` disables the idle timer (iOS/tvOS) / holds a
  `ProcessInfo` activity (macOS) while a display is up.
- **Silent reconnect:** SSE auto-reconnects; the app also re-`connect()`s when the
  scene becomes active.
- **Distribution:** sign + ship to the church's Apple TVs via MDM, an unlisted App
  Store build, or ad-hoc. (TestFlight for iPad/Mac testers.)
- *Optional, not built:* report discovered NDI source names back to the server so
  the web settings can offer a dropdown instead of free text — needs a small
  server endpoint.

## Keeping the contract in sync

`Models/DTOs.swift` mirrors `main/types/stage.ts`. When a DTO changes there, change
it here **in the same PR**. Codable ignores unknown JSON keys, so additive server
changes won't break this client.
