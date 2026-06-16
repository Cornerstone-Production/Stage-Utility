# StageDisplay — native Apple client

A SwiftUI multiplatform app (tvOS · iPadOS · macOS) that is a **second client** of
the same Stage Utility server the web app talks to. It renders all four display
kinds — **slots · dashboard · stage · transcription** — from live server state, and
(Phase 2) adds the one thing a browser can't do: **receive and display NDI video**
behind the data overlays.

The server stays the single source of truth. This app consumes the **identical**
REST + SSE contract as the web client; neither owns state. See the repo root
`README.md` and `/Users/.../plans` design doc for the full architecture.

> **Status: Phase 1 foundation.** Data rendering + connection + the composite
> structure are in place. The NDI layer is a placeholder (`NDIVideoLayer`) wired
> behind every display, ready to be filled in for Phase 2. This is a starting
> point to open and iterate in Xcode — it has not been compiled in CI.

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
  StageDisplay/
    StageDisplayApp.swift      @main entry
    Models/DTOs.swift          Codable mirrors of main/types/stage.ts  ← CONTRACT
    Networking/
      SSEClient.swift          /api/events stream (event:/data:, reconnect)
      ServerClient.swift        REST hydrate (/api/state + best-effort PP/PCO/transcript)
    State/AppModel.swift        @Observable store: SSE channels → published state
    Theme/                      AppBackground (#080810), Liquid Glass helper, Color(hex:)
    Views/
      RootView / ServerConnectionView / DisplayPickerView
      DisplayContainerView      composites NDIVideoLayer behind the kind view
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

## Phase 2 — adding NDI receive

1. Download the **NDI SDK** from ndi.video and accept the SDK terms. Add the macOS
   + iOS/tvOS `libndi` **XCFramework** to the target (keep it out of git — see
   `.gitignore`; vendor under `apple/Vendor/NDI/`).
2. Add the "Powered by NDI" link/attribution (About screen) and confirm H.264/H.265
   codec licensing for distribution — these are SDK obligations.
3. Implement the pipeline in `NDIVideoLayer` (replace the placeholder body):
   `NDIlib_find` (discover by name) → match `sourceName` → `NDIlib_recv` →
   VideoToolbox hardware decode → enqueue `CMSampleBuffer` into an
   `AVSampleBufferDisplayLayer`, wrapped in a `UIViewRepresentable` (iOS/tvOS) /
   `NSViewRepresentable` (macOS). The SwiftUI surface stays the same so callers
   don't change.
4. **Info.plist** (already set in `project.yml`): `NSLocalNetworkUsageDescription`
   and `NSBonjourServices` (`_ndi._tcp`) for the Local Network prompt + mDNS
   discovery.

## Phase 3 — appliance & distribution

- tvOS: auto-open a pinned display, hide navigation chrome, reconnect silently.
- Sign + distribute to the church's Apple TVs (MDM / unlisted App Store / ad-hoc).
- Optional: report discovered NDI source names back to the server so the web
  settings can offer a dropdown instead of free text.

## Keeping the contract in sync

`Models/DTOs.swift` mirrors `main/types/stage.ts`. When a DTO changes there, change
it here **in the same PR**. Codable ignores unknown JSON keys, so additive server
changes won't break this client.
