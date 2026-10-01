# Video Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live video in custom layouts and on Home, from feeds defined once on a new Video feeds page, played through a MediaMTX relay that Stage Utility downloads, runs and watches, with each screen reporting how its playback is doing.

**Architecture:** A `config` DataStore holds feeds; a `VideoService` owns them, the relay and the `video:state` hydrated SSE channel. Everything outside `main/services/video/` talks to a `VideoRelay` interface whose one implementation drives a MediaMTX child process over its loopback REST API. Browsers reach the relay only through Stage Utility's own origin (`/video/<feedId>/whep`, `/whip`, `/index.m3u8`); WebRTC media then flows over UDP 8189. The renderer's `video` layout object picks WebRTC, then HLS, then the platform's embed player, and reports playback stats with the display-presence heartbeat.

**Tech Stack:** TypeScript, Node's built-in test runner (`node:test` + `node:assert/strict`), React 19, Vite, Tailwind with the app's `--color-*` tokens, SSE over `GET /api/events`, MediaMTX v1.21.1 (MIT, a separate binary, never bundled), hls.js 1.7.3 (Apache-2.0).

**Spec:** [docs/superpowers/specs/2026-09-27-video-feeds-design.md](../specs/2026-09-27-video-feeds-design.md)

**Mockup (the UI spec):** https://claude.ai/artifact/XWy5PQBhojfMC6uh4z7NJf (v2). A local copy for agents on the Mac mini: `/Users/hstreuber/projects/stage-utility/.superpowers/sdd/2026-09-27-video-feeds/mockup-v2.html` (gitignored; not in a worktree — read it by absolute path). **Read the mockup before the prose of any UI task.** Where this plan and the mockup disagree, the mockup wins, except for the three corrections listed under "Deviations from the mockup" below.

## Global Constraints

- **Branch per PR off `beta`. Never push to `beta`, `main` or any default branch. Every change is a PR.** Do not merge; the maintainer presses every button.
- **No emoji anywhere. No `Co-Authored-By` trailer, no "Generated with" footer** in commits, PR bodies or comments.
- Commit subject line alone by default: `<type>: <what changed>`, types `feat|fix|perf|refactor|docs|test|build|ci|chore|revert` (`scripts/check-commit-subjects.mjs` rejects `style`). No `BREAKING CHANGE` anywhere in a body: release.yml greps bodies and it forces a major.
- **`Beta-only: true` as the LAST paragraph of the commit body** on every `fix:`/`perf:` in this plan. Nothing here exists on `main`.
- **Every guard ships proven red.** Delete the guard or reintroduce the bug, watch the test fail in the same session, and say so in the commit. A test that passes on the defect it was written for is not a guard.
- **Exact-list guards are sorted lists, one entry per line — never a bare number.**
- **A new `catch` either rethrows or returns the failure.** A `catch` that only logs is forbidden.
- **Do not delete an operator's data to tidy up.** Log it or offer an explicit action.
- **Fixing a repeated pattern:** grep for every instance first and fix them together; say how many you found and changed.
- Verification gate, run and read in-session before any PR: `npm run lint && npm run type-check && npm test && npm run build`. Chain with `&&`.
- Dev server on port **8799** with an **always-empty** data dir and `STAGE_UTILITY_FRIENDLY_PORT=0`. Never copy production data. Kill the server **by port** (`lsof -ti tcp:8799 | xargs kill`), never `pkill -f` on an env-var prefix. Before any mutating request, confirm `/api/version` is your own build.
- Time: anything asking "what day is it" goes through `main/services/app-timezone.ts`. Nothing in this plan should need it; durations use `Date.now()` differences.
- No purple. Dark surfaces are strictly R=G=B. Numeric fields use the themed `NumberInput`.
- **Prod is plain HTTP.** Nothing may use a secure-context-only API: no WebCodecs, no `navigator.clipboard` without a fallback (the mockup's Copy button falls back to selecting the text).
- **Video is muted, always.** Never request an audio track, never show controls.
- **MediaMTX pin** (exact; the only version the app runs):

  ```
  version v1.21.1
  base    https://github.com/bluenviron/mediamtx/releases/download/v1.21.1/
  be403a36d2225668ea695cbd2c784109bc23ef9a32f886837e43c920b6818813  mediamtx_v1.21.1_darwin_amd64.tar.gz
  25e20ed41611f1f3103b8359585210b29b11b69fa0d9e11bd11b92f7bbcb42ef  mediamtx_v1.21.1_darwin_arm64.tar.gz
  653abc672a3e693f8d3b2717752492fdcfb8072291ec108d03d3dd857411b0ee  mediamtx_v1.21.1_linux_amd64.tar.gz
  6a3aa635fb60ea9b8d566ec306f0a42ff1b6b52a3942bc2baffbe55880d4c3dd  mediamtx_v1.21.1_linux_arm64.tar.gz
  faa97974861eb75a68b5aa326c78e7e7a6f670b5ef191bace78e715130381f23  mediamtx_v1.21.1_windows_amd64.zip
  ```

## What the real binary does (probed 27 Sep 2026, v1.21.1 darwin_arm64)

Facts later tasks rely on. Each was observed, not read.

- **An unknown config key stops startup** with `ERR: json: unknown field "<key>"` and exit. There is no `rtsps` or `rtmps` key; RTSPS and RTMPS are `rtspEncryption: "no"` and `rtmpEncryption: "no"`.
- **The config file may be JSON** (valid YAML). The generator writes `JSON.stringify`; no YAML dependency.
- With `rtsp: false`, `moq: false` and the listeners below, the process binds exactly: TCP `*:1935`, TCP `127.0.0.1:8888`, TCP `127.0.0.1:8889`, TCP `127.0.0.1:9997`, UDP `*:8189`, UDP `*:8890`. MoQ left at its default binds `:8892` and `:8893` on every interface.
- **Startup lines** name each listener: `INF [RTMP] started with listener on :1935 (TCP/RTMP)`, `INF [API] started with listener on 127.0.0.1:9997 (TCP/HTTP)`, and the first line is `INF MediaMTX v1.21.1, <os>, <arch>`.
- **Several users may share the name `video`** with different passwords, each allowed to publish to one path. A wrong password is refused (`WAR [RTMP] [conn …] failed to authenticate`).
- **`PATCH /v3/config/global/patch` with a new `authInternalUsers` applies at runtime** (`INF reloading configuration (API request)`) and every live publisher and reader survives it. So a new password does not kick the device already sending; `POST /v3/<rtmpconns|srtconns|webrtcsessions>/kick/<id>` does, and the next connection needs the new password.
- **Paths API:** `POST /v3/config/paths/add/<name>` (a duplicate is `400 {"error":"path already exists"}`), `POST /v3/config/paths/replace/<name>`, `DELETE /v3/config/paths/delete/<name>` (terminates that path's publisher and readers), `GET /v3/config/paths/list` (`items[]` with `name`, `source`, `sourceOnDemand`, `overridePublisher`, …), `GET /v3/paths/get/<name>` (404 `path not found`).
- **Runtime path list** `GET /v3/paths/list`: `{itemCount, pageCount, items:[{name, confName, ready, readyTime, available, online, onlineTime, source:{type:"rtmpConn"|"srtConn"|"webRTCSession"|…, id}, tracks:["H264"], tracks2:[{codec:"H264", codecProps:{width, height, profile, level}}], readers:[…], inboundBytes, outboundBytes, inboundFramesInError, bytesReceived, bytesSent}]}`.
- **WHEP:** `POST http://127.0.0.1:8889/<path>/whep` with `Content-Type: application/sdp` answers `201` with `Location: /<path>/whep/<uuid>` and an SDP body.
- **B-frames over WebRTC:** the WHEP offer still gets `201`, the peer connection comes up, then the relay logs, verbatim (`.superpowers/sdd/2026-09-27-video-feeds/bframes-fixture.log`):

  ```
  2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] created by 127.0.0.1:52936
  2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] peer connection established, local candidate: host/udp/127.0.0.1/18189, remote candidate: prflx/udp/127.0.0.1/60195
  2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] is reading from path 'bframes', 1 track (H264)
  2026/09/27 17:47:50 INF [WebRTC] [session b84d469e] closed: WebRTC doesn't support H264 streams with B-frames
  ```

- **Credentials by protocol:** SRT `streamid=publish:<path>:<user>:<pass>`; RTMP `?user=<user>&pass=<pass>`; OBS's WHIP "Bearer Token" field `<user>:<pass>`; RTSP pull `rtsp://<user>:<pass>@host/…`.
- **FFmpeg test streams** need `-pix_fmt yuv420p`. `-bf 0` gives a Baseline-safe stream; x264's default gives B-frames. Under zsh an unquoted `$FF` does not word-split — run multi-arg FFmpeg lines under `bash -c`.

## Decisions this plan makes (the spec left them to the plan)

| Thing | Decision |
|---|---|
| Feed store | `video-feeds.json`, `"config"`, `{ feeds, ports }` |
| Seen store | `video-seen.json`, `"runtime"`, `{ [feedId]: lastLiveAt }` (PR 2) |
| Secrets | slot `video:<feedId>`, field `password` (pull credentials and push publish password alike) |
| Publisher user | `video` for every push feed; the password is per feed |
| SSE channel | `video:state`, hydrated, rev'd: `{ rev, relay, feeds, screens }` (`screens` from PR 3) |
| On/off switch | the integration manager's enabled flag for id `video` (PR 2). Embed and external feeds play whether or not it is on |
| Routes | `GET /api/video/state`; `GET/POST /api/video/feeds`; `PATCH/DELETE /api/video/feeds/:id`; `GET /api/video/feeds/:id/usage`; PR 2: `GET /api/video/feeds/:id/push`, `POST /api/video/feeds/:id/push/new-password`, `PATCH /api/video/ports` |
| Proxy routes | `/video/<feedId>/whep[/<session>]`, `/video/<feedId>/whip[/<session>]`, `/video/<feedId>/<file>.m3u8|.mp4|.m4s` |
| IPC channels | `video:state`, `video:addFeed`, `video:updateFeed`, `video:removeFeed`, `video:feedUsage`; PR 2 `video:pushAddress`, `video:newPushPassword`, `video:setPorts` |
| Relay directory | `<data>/video-relay/` (runtime, never backed up): `downloads/<asset>`, `v1.21.1/mediamtx[.exe]`, `mediamtx.yml`, `relay.pid` |
| Unwatched pull feed | new state `standby`: "Standby", neutral pill. An on-demand pull connects only when watched, so the relay cannot know the source is up until someone looks. The spec's five states did not cover it |
| Heartbeat while video plays | every 10 s (`VIDEO_HEARTBEAT_MS`), so the 60 s window holds six samples; otherwise unchanged (20 s / 60 s) |

### Deviations from the mockup (say each in the PR body)

1. The relay status line reads `Inputs RTMP 1935 · SRT 8890` — no `RTSP 8554`. No push kind uses RTSP, so the RTSP server is off; pulling RTSP uses the relay's RTSP client and needs no listener.
2. `Change ports in Advanced` links to a new **Video relay** card in Advanced. Advanced has no port settings today, so "with the app's other ports" in the spec was wrong.
3. A pull feed nothing is watching shows **Standby**, a state the mockup does not draw.

## File Structure

**PR 1 — the page, the widget and the player** (`embed` and `external` kinds)

| File | Responsibility |
|---|---|
| `main/types/video.ts` (create) | Every video type, the ports default, the pull/push/embed/external source union |
| `main/services/video/feed-store.ts` (create) | The `config` store and `loadFeedsFile()` default-filling |
| `main/services/stores.ts` (modify) | Import the new store so snapshots see it |
| `main/services/config-snapshot.test.ts` (modify) | `"video-feeds.json"` in `EXPECTED_CONFIG` |
| `main/services/video/feed-id.ts` (create) | Slug a first name into a permanent id |
| `main/services/video/feed-input.ts` (create) | Parse and validate a feed body from the wire |
| `main/services/video/embed.ts` (create) | Validate YouTube/Resi refs; build the iframe `src` |
| `main/services/video/video-service.ts` (create) | Feed CRUD, usage, the `video:state` snapshot and broadcast |
| `main/services/routes/video-routes.ts` (create) | `/api/video/*` |
| `main/services/remote-server.ts` (modify) | Register the route module; `video:state` in the hello burst |
| `renderer/lib/sse-channels.ts`, `renderer/lib/api.ts` (modify) | Hydrated channel; IPC channels |
| `renderer/app/video-feeds/video-feeds-route.tsx`, `feed-list.tsx`, `feed-editor.tsx` (create) | The page |
| `renderer/app/destinations.tsx`, `main/services/routes/operator-paths.ts` (modify) | Sidebar entry under Screens; `/video-feeds` served as the operator app |
| `main/types/views.ts`, `renderer/main/layout-objects.ts`, `renderer/editor/palette.tsx`, `renderer/editor/inspector.tsx`, `renderer/main/layout-renderer.tsx`, `main/types/object-capabilities.ts` (modify) | The `video` layout object |
| `renderer/main/video/use-video-state.ts` (create) | The `video:state` hook |
| `renderer/main/video/choose-playback.ts` (create) | Pure: which way this screen plays this feed |
| `renderer/main/video/whep-client.ts` (create) | Receive-only WHEP, no library |
| `renderer/main/video/hls-player.ts` (create) | Native HLS or hls.js, lazily imported |
| `renderer/main/video/use-on-screen.ts` (create) | IntersectionObserver + page visibility with a teardown delay |
| `renderer/main/video/video-object.tsx` (create) | The widget: states, fit, label, badge, error boundary, preview pause |
| `docs/integrations/video-feeds.md` (create), `docs/integrations/README.md`, `docs/reference/api.md`, `docs/reference/widgets.md`, `docs/features/operator-app.md` (modify) | Docs |

**PR 2 — the relay**

| File | Responsibility |
|---|---|
| `main/services/video/mediamtx-pin.ts` (create) | Version, asset per platform, checksums |
| `main/services/video/acquire.ts` (create) | Download, verify, extract, hand-placed archive |
| `main/services/video/mediamtx-config.ts` (create) | The generated config object |
| `main/services/video/relay-log.ts` (create) | Parse the child's lines: B-frames, errors, version |
| `main/services/video/supervisor.ts` (create) | The child process, backoff, stop, leftover pid |
| `main/services/video/port-check.ts` (create) | Is each TCP/UDP port free; who holds it |
| `main/services/video/relay.ts` (create) | The `VideoRelay` interface and its types |
| `main/services/video/reconcile-plan.ts` (create) | Pure diff: desired paths and users against the relay's |
| `main/services/video/mediamtx-relay.ts` (create) | The API client implementing `VideoRelay` |
| `main/services/video/feed-state.ts` (create) | Pure: a feed's state from the relay's path, marks and demand |
| `main/services/video/seen-store.ts` (create) | `runtime` store of when each feed was last live |
| `main/services/routes/video-proxy-routes.ts` (create) | WHEP/WHIP/HLS proxy, in `EARLY_ROUTE_MODULES` |
| `main/services/integration-ids.ts`, `integration-manager.ts`, `automation-triggers.ts`, `renderer/components/integrations-panel.tsx` (+ the tests keyed on those lists) | The `video` integration |
| `renderer/app/video-feeds/relay-status.tsx` (create), `renderer/settings/sections/video-relay-ports.tsx` (create), `advanced-section.tsx` (modify) | Relay line and switch; ports card |
| `docs/…` | Relay setup, ports, firewall, log tag |

**PR 3 — health from the screens**

| File | Responsibility |
|---|---|
| `renderer/main/video/playback-stats.ts` (create) | Frames decoded/dropped, stalls, resolution, per path |
| `renderer/main/video/playback-reports.ts` (create) | Module registry the heartbeat drains |
| `renderer/main/stage-view.tsx` (modify) | Heartbeat carries reports; 10 s while video plays |
| `main/services/video/playback-health.ts` (create) | 60 s window per screen and feed; struggling |
| `main/services/remote-server.ts` (modify) | Parse reports on the heartbeat |
| `main/types/views.ts`, `view-routes.ts`, `stage-controller.ts`, `renderer/settings/sections/outputs-section.tsx` (modify) | `allowHls` per screen; the Screens warning |
| `docs/…` | Health, the switch, network cost |

---

# PR 1 — the page, the widget and the player

Branch: `feat/video-feeds-page` off `origin/beta`.

### Task 1: Types and the feed store

**Files:**
- Create: `main/types/video.ts`, `main/services/video/feed-store.ts`, `main/services/video/feed-store.test.ts`
- Modify: `main/services/stores.ts`, `main/services/config-snapshot.test.ts`

**Interfaces:**
- Produces: every type below; `videoFeedsStore`; `loadFeedsFile(): Promise<VideoFeedsFile>`; `DEFAULT_VIDEO_PORTS`.

- [ ] **Step 1: Write the types**

```ts
// main/types/video.ts — video feeds, the relay and what a screen plays.
//
// A feed is defined once and a layout's Video widget names it by id. The id is
// permanent; renaming changes only `name`, so a layout never loses its feed.

export const PUSH_PROTOCOLS = ["srt", "rtmp", "whip"] as const;
export type PushProtocol = (typeof PUSH_PROTOCOLS)[number];

export const EMBED_PLAYERS = ["youtube-channel", "youtube-video", "resi"] as const;
export type EmbedPlayer = (typeof EMBED_PLAYERS)[number];

/** Where a feed's picture comes from. Passwords are never here: they live in
 *  secretsStore under `video:<feedId>`, so a config snapshot never carries one. */
export type VideoSource =
  /** The relay fetches it, only while something watches. `url` has no userinfo. */
  | { kind: "pull"; url: string; username: string }
  /** The device connects to the relay with the feed's password. */
  | { kind: "push"; protocol: PushProtocol }
  /** The platform's own iframe player. `ref` is a channel id, video id or Resi URL. */
  | { kind: "embed"; player: EmbedPlayer; ref: string }
  /** Something else already serves WHEP or HLS; screens play it as given. */
  | { kind: "external"; url: string };

export type VideoSourceKind = VideoSource["kind"];

export interface VideoFeed {
  id: string;
  name: string;
  source: VideoSource;
}

/** LAN inputs (rtmp, srt, webrtcUdp) and loopback-only listeners (the rest). */
export interface VideoPorts {
  rtmp: number;
  srt: number;
  webrtcUdp: number;
  webrtcHttp: number;
  hls: number;
  api: number;
}

export const DEFAULT_VIDEO_PORTS: VideoPorts = {
  rtmp: 1935,
  srt: 8890,
  webrtcUdp: 8189,
  webrtcHttp: 8889,
  hls: 8888,
  api: 9997,
};

export interface VideoFeedsFile {
  feeds: VideoFeed[];
  ports: VideoPorts;
}

/** null state: an external feed, which Stage Utility cannot see. */
export type FeedState = "live" | "delayed" | "standby" | "waiting" | "offline" | "embed";

export interface FeedStatus {
  state: FeedState | null;
  /** Set with "delayed": why WebRTC cannot carry it. */
  delayedBecause?: "b-frames" | "codec";
  codec?: string;
  width?: number;
  height?: number;
  profile?: string;
  /** Epoch ms the feed was last live; set with "offline". */
  lastSeenAt?: number | null;
}

/** How a screen plays a feed. Relay URLs are same-origin paths. */
export type FeedPlay =
  | { via: "relay"; whep: string; hls: string }
  | { via: "external"; url: string; protocol: "whep" | "hls" }
  | { via: "embed"; src: string };

/** A feed as the wire carries it: no secrets, ever. */
export interface VideoFeedView {
  id: string;
  name: string;
  kind: VideoSourceKind;
  /** One line for the page's list, e.g. "rtsp://10.0.40.21:8554/stream2". */
  sourceLine: string;
  source: VideoSource;
  play: FeedPlay;
  status: FeedStatus;
}

export type RelayStatus =
  | { state: "off" }
  | { state: "downloading"; receivedBytes: number; totalBytes: number }
  | { state: "starting"; version: string }
  | { state: "running"; version: string; ports: VideoPorts }
  | { state: "failing"; reason: string; retryAt: number | null; placeArchiveAt?: string };

export interface VideoState {
  rev: number;
  relay: RelayStatus;
  /** The Source kinds this build offers; the page's dropdown lists exactly these. */
  kinds: VideoSourceKind[];
  feeds: VideoFeedView[];
}
```

- [ ] **Step 2: Write the store and its failing test**

```ts
// main/services/video/feed-store.ts — the operator's feeds. Config: backed up.

import { DataStore } from "../data-store.js";
import { DEFAULT_VIDEO_PORTS, type VideoFeedsFile } from "../../types/video.js";

export const videoFeedsStore = new DataStore<VideoFeedsFile>(
  "video-feeds.json",
  { feeds: [], ports: DEFAULT_VIDEO_PORTS },
  "config",
);

/** The file with every missing field defaulted. A file written by an older build
 *  (or restored from one) has no `ports`, or only some; each gets its default. */
export async function loadFeedsFile(): Promise<VideoFeedsFile> {
  const raw = (await videoFeedsStore.load()) as Partial<VideoFeedsFile> | null;
  return {
    feeds: Array.isArray(raw?.feeds) ? raw.feeds : [],
    ports: { ...DEFAULT_VIDEO_PORTS, ...(raw?.ports ?? {}) },
  };
}
```

```ts
// main/services/video/feed-store.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-feeds-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { videoFeedsStore, loadFeedsFile } = await import("./feed-store.js");

test("a file with no ports gets every default port", async () => {
  await fs.writeFile(path.join(TMP, "video-feeds.json"), JSON.stringify({ feeds: [] }));
  await videoFeedsStore.reload();
  const file = await loadFeedsFile();
  assert.deepEqual(file.ports, { rtmp: 1935, srt: 8890, webrtcUdp: 8189, webrtcHttp: 8889, hls: 8888, api: 9997 });
});

test("a partial ports object keeps what it has", async () => {
  await fs.writeFile(path.join(TMP, "video-feeds.json"), JSON.stringify({ feeds: [], ports: { rtmp: 1936 } }));
  await videoFeedsStore.reload();
  assert.equal((await loadFeedsFile()).ports.rtmp, 1936);
  assert.equal((await loadFeedsFile()).ports.srt, 8890);
});
```

- [ ] **Step 3: Register the store and add it to the snapshot list**

Add `import "./video/feed-store.js";` to `main/services/stores.ts` (keep the file's order convention). In `main/services/config-snapshot.test.ts` `EXPECTED_CONFIG`, insert `"video-feeds.json",` between `"slots.json",` and `"views.json",`.

- [ ] **Step 4: Run and prove red**

Run: `node --import tsx --test main/services/video/feed-store.test.ts main/services/config-snapshot.test.ts`
Expected: PASS. Then remove the `stores.ts` import and rerun: `config-snapshot.test.ts` FAILS (the store is constructed on disk but never imported). Restore it. Then change `"config"` to `"runtime"` in the store: it FAILS again (wrong half). Restore.

- [ ] **Step 5: Commit**

```bash
git add main/types/video.ts main/services/video/feed-store.ts main/services/video/feed-store.test.ts main/services/stores.ts main/services/config-snapshot.test.ts
git commit -m "feat(video): the feed store, classified as config"
```

Body: one line saying the snapshot guard was seen red with the import removed and with the store reclassified.

### Task 2: Feed ids, input validation and embed URLs

**Files:**
- Create: `main/services/video/feed-id.ts`, `main/services/video/feed-input.ts`, `main/services/video/embed.ts`, and a `.test.ts` beside each

**Interfaces:**
- Produces:
  - `feedIdFor(name: string, taken: ReadonlySet<string>): string`
  - `FEED_ID_PATTERN: RegExp` (`/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/`)
  - `parseFeedInput(body: unknown, allowKinds: ReadonlySet<VideoSourceKind>): { ok: true; name: string; source: VideoSource; password?: string } | { ok: false; error: string }`
  - `embedSrc(player: EmbedPlayer, ref: string): string`, `normalizeEmbedRef(player, raw): { ok: true; ref: string } | { ok: false; error: string }`
  - `externalProtocol(url: string): "whep" | "hls"`

- [ ] **Step 1: Write the failing tests**

```ts
// main/services/video/feed-id.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { feedIdFor, FEED_ID_PATTERN } from "./feed-id.js";

test("slugs a name", () => assert.equal(feedIdFor("Program (IMAG)", new Set()), "program-imag"));
test("never empty", () => assert.equal(feedIdFor("!!!", new Set()), "feed"));
test("unique by suffix", () => assert.equal(feedIdFor("PTZ", new Set(["ptz", "ptz-2"])), "ptz-3"));
test("capped at 40 and still valid", () => {
  const id = feedIdFor("a".repeat(80), new Set());
  assert.ok(id.length <= 40 && FEED_ID_PATTERN.test(id));
});
test("prototype names are ordinary ids", () => {
  assert.equal(feedIdFor("__proto__", new Set()), "proto");
});
```

```ts
// main/services/video/embed.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { embedSrc, normalizeEmbedRef } from "./embed.js";

test("a channel URL becomes its UC id", () => {
  assert.deepEqual(
    normalizeEmbedRef("youtube-channel", "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"),
    { ok: true, ref: "UCabcdefghijklmnopqrstuv" },
  );
});
test("a handle is refused with where to find the id", () => {
  const r = normalizeEmbedRef("youtube-channel", "@cornerstone");
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /starts with UC/);
});
test("a watch URL, a youtu.be URL and a bare id give one video id", () => {
  for (const raw of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"]) {
    assert.deepEqual(normalizeEmbedRef("youtube-video", raw), { ok: true, ref: "dQw4w9WgXcQ" });
  }
});
test("a Resi embed must be a control.resi.io player URL, pasted as the iframe or the src", () => {
  const src = "https://control.resi.io/webplayer/video.html?id=abc-123";
  assert.deepEqual(normalizeEmbedRef("resi", `<iframe src="${src}"></iframe>`), { ok: true, ref: src });
  assert.equal(normalizeEmbedRef("resi", "https://evil.example/webplayer/video.html?id=1").ok, false);
});
test("every src is muted, autoplays and has no controls", () => {
  assert.equal(
    embedSrc("youtube-channel", "UCabcdefghijklmnopqrstuv"),
    "https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv&autoplay=1&mute=1&controls=0&playsinline=1",
  );
  assert.equal(
    embedSrc("youtube-video", "dQw4w9WgXcQ"),
    "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&mute=1&controls=0&playsinline=1",
  );
  const resi = new URL(embedSrc("resi", "https://control.resi.io/webplayer/video.html?id=abc-123"));
  assert.equal(resi.searchParams.get("autoplay"), "true");
  assert.equal(resi.searchParams.get("mute"), "true");
});
```

```ts
// main/services/video/feed-input.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseFeedInput, externalProtocol } from "./feed-input.js";

const PR1 = new Set(["embed", "external"] as const);
const ALL = new Set(["pull", "push", "embed", "external"] as const);

test("a name is required and trimmed", () => {
  assert.equal(parseFeedInput({ name: "  ", source: { kind: "external", url: "http://x/a.m3u8" } }, PR1).ok, false);
});
test("a kind this build does not offer is refused", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://10.0.0.1/s", username: "" } }, PR1);
  assert.equal(r.ok, false);
});
test("external needs http(s)", () => {
  assert.equal(parseFeedInput({ name: "X", source: { kind: "external", url: "file:///etc/passwd" } }, PR1).ok, false);
  assert.equal(parseFeedInput({ name: "X", source: { kind: "external", url: "https://cdn/x/index.m3u8" } }, PR1).ok, true);
});
test("pull allows rtsp, rtsps, srt, http(s) and refuses userinfo in the address", () => {
  for (const url of ["rtsp://10.0.0.1:8554/s", "rtsps://h/s", "srt://10.0.0.1:9000", "http://h/x.m3u8"]) {
    assert.equal(parseFeedInput({ name: "P", source: { kind: "pull", url, username: "" } }, ALL).ok, true, url);
  }
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://u:p@10.0.0.1/s", username: "" } }, ALL);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /own fields/);
  assert.equal(parseFeedInput({ name: "P", source: { kind: "pull", url: "udp://h:1", username: "" } }, ALL).ok, false);
});
test("push needs a known protocol", () => {
  assert.equal(parseFeedInput({ name: "P", source: { kind: "push", protocol: "rtsp" } }, ALL).ok, false);
  assert.equal(parseFeedInput({ name: "P", source: { kind: "push", protocol: "whip" } }, ALL).ok, true);
});
test("a pull password is returned separately, never inside the source", () => {
  const r = parseFeedInput({ name: "P", source: { kind: "pull", url: "rtsp://h/s", username: "admin" }, password: "pw" }, ALL);
  assert.ok(r.ok);
  assert.equal((r as { password?: string }).password, "pw");
  assert.equal(JSON.stringify((r as { source: unknown }).source).includes("pw"), false);
});
test("external protocol follows the path", () => {
  assert.equal(externalProtocol("https://h/live/index.m3u8?t=1"), "hls");
  assert.equal(externalProtocol("http://h/cam/whep"), "whep");
});
```

- [ ] **Step 2: Run them and see them fail** (`Cannot find module`)

Run: `node --import tsx --test main/services/video/feed-id.test.ts main/services/video/embed.test.ts main/services/video/feed-input.test.ts`

- [ ] **Step 3: Implement**

```ts
// main/services/video/feed-id.ts — a feed's permanent id, from its first name.

export const FEED_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function feedIdFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/g, "") || "feed";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}
```

```ts
// main/services/video/embed.ts — YouTube and Resi iframe players.
//
// Built server-side, once, so the wire carries a finished `src` and no screen
// assembles a URL from operator text.

import type { EmbedPlayer } from "../../types/video.js";

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAYER_FLAGS = "autoplay=1&mute=1&controls=0&playsinline=1";

type Ref = { ok: true; ref: string } | { ok: false; error: string };

export function normalizeEmbedRef(player: EmbedPlayer, raw: string): Ref {
  const text = raw.trim();
  if (player === "youtube-channel") {
    const id = text.match(/(UC[A-Za-z0-9_-]{22})/)?.[1];
    if (id && CHANNEL_ID.test(id)) return { ok: true, ref: id };
    return {
      ok: false,
      error: "Use the channel ID, which starts with UC. It is in YouTube Studio under Settings, Channel, Advanced settings.",
    };
  }
  if (player === "youtube-video") {
    let id = text;
    try {
      const u = new URL(text);
      id = u.hostname === "youtu.be" ? u.pathname.slice(1) : (u.searchParams.get("v") ?? u.pathname.split("/").pop() ?? "");
    } catch {
      // Not a URL: a bare id, checked below.
    }
    return VIDEO_ID.test(id) ? { ok: true, ref: id } : { ok: false, error: "That is not a YouTube video or stream address." };
  }
  const src = text.match(/src="([^"]+)"/)?.[1] ?? text;
  try {
    const u = new URL(src);
    if (u.protocol === "https:" && u.hostname === "control.resi.io" && u.pathname.startsWith("/webplayer/")) {
      return { ok: true, ref: u.toString() };
    }
  } catch {
    // Falls through to the refusal.
  }
  return { ok: false, error: "Paste Resi's embed code or its player address (https://control.resi.io/webplayer/…)." };
}

export function embedSrc(player: EmbedPlayer, ref: string): string {
  if (player === "youtube-channel") return `https://www.youtube.com/embed/live_stream?channel=${ref}&${PLAYER_FLAGS}`;
  if (player === "youtube-video") return `https://www.youtube.com/embed/${ref}?${PLAYER_FLAGS}`;
  const u = new URL(ref);
  if (!u.searchParams.has("autoplay")) u.searchParams.set("autoplay", "true");
  if (!u.searchParams.has("mute")) u.searchParams.set("mute", "true");
  return u.toString();
}
```

`feed-input.ts`: validate `body` is an object; `name` a string trimmed to 1–60 chars; `source.kind` one of `allowKinds`; per kind:
- `pull`: `url` parses with `new URL`, protocol in `rtsp: rtsps: srt: http: https:`, `username === "" && password === ""` on the URL object or refuse with `"Put the username and password in their own fields, not the address."`; `username` a string (default `""`, max 100); optional top-level `password` string (max 200) returned as `password`.
- `push`: `protocol` in `PUSH_PROTOCOLS`.
- `embed`: `player` in `EMBED_PLAYERS`; `ref` through `normalizeEmbedRef`; return the normalized ref.
- `external`: `url` with protocol `http:` or `https:`.
Return `{ ok: false, error }` with a sentence an operator can act on for every refusal. Never throw. `externalProtocol(url)` is `new URL(url).pathname.endsWith(".m3u8") ? "hls" : "whep"`.

- [ ] **Step 4: Run to pass**, then prove one guard red: remove the userinfo check in `feed-input.ts` and watch "refuses userinfo" fail. Restore.

- [ ] **Step 5: Commit**

```bash
git add main/services/video/feed-id.ts main/services/video/feed-id.test.ts main/services/video/feed-input.ts main/services/video/feed-input.test.ts main/services/video/embed.ts main/services/video/embed.test.ts
git commit -m "feat(video): feed ids, input validation and embed players"
```

### Task 3: The video service, routes and the `video:state` channel

**Files:**
- Create: `main/services/video/video-service.ts`, `main/services/routes/video-routes.ts`, `main/services/routes/video-routes.test.ts`
- Modify: `main/services/remote-server.ts` (`ROUTE_MODULES`, `writeHelloBurst`), `renderer/lib/sse-channels.ts` (`HYDRATED_CHANNELS`), `renderer/lib/hydrated-channels.test.ts` (its list), `renderer/lib/api.ts` (`IpcChannel` + `invoke` cases), and, if PR #618 has merged, `SHARED_READ_PATHS` in `renderer/lib/api.ts` plus its sorted table test

**Interfaces:**
- Consumes: Task 1 types and store; Task 2 `feedIdFor`, `parseFeedInput`, `embedSrc`, `externalProtocol`.
- Produces:
  - `videoService.state(): Promise<VideoState>`
  - `videoService.addFeed(body: unknown): Promise<{ ok: true; feed: VideoFeedView } | { ok: false; error: string }>`
  - `videoService.updateFeed(id: string, body: unknown)` (same result shape; 404 when unknown is `{ ok: false, error: "not-found" }`)
  - `videoService.removeFeed(id: string): Promise<boolean>`
  - `videoService.usage(id: string): Promise<{ viewId: string; name: string }[]>`
  - `videoService.allowedKinds(): ReadonlySet<VideoSourceKind>` (PR 1: embed, external)
  - A protected `relayStatus(): RelayStatus` and `feedStatus(feed): FeedStatus` that PR 2 replaces; PR 1 returns `{ state: "off" }` and embed → `{ state: "embed" }`, external → `{ state: null }`.

- [ ] **Step 1: Write the failing route tests**

```ts
// main/services/routes/video-routes.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-video-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
const { callRoute } = await import("./route-harness.js");
const { videoRoutes } = await import("./video-routes.js");

const EMBED = { name: "Online stream", source: { kind: "embed", player: "youtube-video", ref: "dQw4w9WgXcQ" } };

test("create, list, rename, delete", async () => {
  const made = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: EMBED });
  assert.equal(made.status, 201);
  const feed = (made.json as { feed: { id: string; play: { via: string; src: string } } }).feed;
  assert.equal(feed.id, "online-stream");
  assert.equal(feed.play.via, "embed");
  assert.match(feed.play.src, /mute=1/);

  const renamed = await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "PATCH", body: { name: "Lobby" } });
  assert.equal((renamed.json as { feed: { id: string; name: string } }).feed.id, "online-stream", "the id never changes");

  const state = await callRoute(videoRoutes, "/api/video/state");
  const s = state.json as { rev: number; relay: { state: string }; feeds: { name: string; status: { state: string } }[] };
  assert.equal(s.relay.state, "off");
  assert.deepEqual(s.feeds.map((f) => [f.name, f.status.state]), [["Lobby", "embed"]]);

  assert.equal((await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "DELETE" })).status, 200);
  assert.equal((await callRoute(videoRoutes, "/api/video/feeds/online-stream", { method: "DELETE" })).status, 404);
});

test("a refused body says why, with 400", async () => {
  const r = await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "X", source: { kind: "external", url: "ftp://h" } } });
  assert.equal(r.status, 400);
  assert.ok((r.json as { error: string }).error.length > 0);
});

test("an id outside the pattern is 404, not a lookup", async () => {
  for (const id of ["__proto__", "constructor", "..", "A"]) {
    const r = await callRoute(videoRoutes, `/api/video/feeds/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: "x" } });
    assert.equal(r.status, 404, id);
  }
});

test("usage names the layouts that place the feed, inside containers too", async () => {
  const box = { x: 0, y: 0, w: 1, h: 1 };
  await fs.writeFile(
    path.join(TMP, "views.json"),
    JSON.stringify([
      {
        id: "v1", name: "Stage confidence", kind: "custom", createdAt: "2026-09-27T00:00:00.000Z",
        layout: {
          version: 1, canvas: { w: 1920, h: 1080 },
          objects: [{ id: "c1", ...box, config: { type: "container" },
            children: [{ id: "o1", ...box, config: { type: "video", feedId: "cam" } }] }],
        },
      },
      { id: "v2", name: "Unrelated", kind: "custom", createdAt: "2026-09-27T00:00:00.000Z",
        layout: { version: 1, canvas: { w: 1920, h: 1080 }, objects: [] } },
    ]),
  );
  const { viewsStore } = await import("../views-store.js");
  await viewsStore.reload();
  await callRoute(videoRoutes, "/api/video/feeds", { method: "POST", body: { name: "Cam", source: { kind: "external", url: "http://h/cam/whep" } } });
  const r = await callRoute(videoRoutes, "/api/video/feeds/cam/usage");
  assert.deepEqual(r.json, { layouts: [{ viewId: "v1", name: "Stage confidence" }] });
});
```

Red proof for this one: replace `walkLayoutObjects` with a loop over the top-level objects only and watch it fail (the object sits inside a container).

- [ ] **Step 2: Run and see them fail**

Run: `node --import tsx --test main/services/routes/video-routes.test.ts`

- [ ] **Step 3: Implement the service**

Shape (write it out in full):

```ts
// main/services/video/video-service.ts — feeds, their status and the relay.
//
// The one owner of `video:state`. Every change goes through here and ends in
// publish(), so the page, every widget and the hello burst see one snapshot.

import { broadcast } from "../broadcaster.js";
import { secretsStore } from "../secrets.js";
import { walkLayoutObjects } from "../view-refs.js";
import { viewsStore } from "../views-store.js";
import { embedSrc } from "./embed.js";
import { FEED_ID_PATTERN, feedIdFor } from "./feed-id.js";
import { externalProtocol, parseFeedInput } from "./feed-input.js";
import { loadFeedsFile, videoFeedsStore } from "./feed-store.js";
import type { FeedPlay, FeedStatus, RelayStatus, VideoFeed, VideoFeedView, VideoSourceKind, VideoState } from "../../types/video.js";

type Result = { ok: true; feed: VideoFeedView } | { ok: false; error: string };

export const SECRET_SLOT = (feedId: string) => `video:${feedId}`;

class VideoService {
  private rev = 0;

  allowedKinds(): ReadonlySet<VideoSourceKind> {
    return new Set<VideoSourceKind>(["embed", "external"]);
  }

  protected relayStatus(): RelayStatus {
    return { state: "off" };
  }

  protected feedStatus(feed: VideoFeed): FeedStatus {
    return { state: feed.source.kind === "embed" ? "embed" : null };
  }

  private play(feed: VideoFeed): FeedPlay {
    const s = feed.source;
    if (s.kind === "embed") return { via: "embed", src: embedSrc(s.player, s.ref) };
    if (s.kind === "external") return { via: "external", url: s.url, protocol: externalProtocol(s.url) };
    const base = `/video/${feed.id}`;
    return { via: "relay", whep: `${base}/whep`, hls: `${base}/index.m3u8` };
  }

  private sourceLine(feed: VideoFeed): string {
    const s = feed.source;
    if (s.kind === "pull" || s.kind === "external") return s.url;
    if (s.kind === "push") return { srt: "SRT", rtmp: "RTMP", whip: "WHIP (OBS)" }[s.protocol];
    return { "youtube-channel": "YouTube channel", "youtube-video": "YouTube video", resi: "Resi" }[s.player];
  }

  view(feed: VideoFeed): VideoFeedView {
    return {
      id: feed.id, name: feed.name, kind: feed.source.kind, source: feed.source,
      sourceLine: this.sourceLine(feed), play: this.play(feed), status: this.feedStatus(feed),
    };
  }

  async state(): Promise<VideoState> {
    const { feeds } = await loadFeedsFile();
    return {
      rev: this.rev,
      relay: this.relayStatus(),
      kinds: [...this.allowedKinds()],
      feeds: feeds.map((f) => this.view(f)),
    };
  }

  protected async publish(): Promise<void> {
    this.rev++;
    broadcast("video:state", await this.state());
  }

  async addFeed(body: unknown): Promise<Result> { /* parse; id = feedIdFor(name, taken); store.update; password → setSecret(SECRET_SLOT(id), "password", pw) BEFORE the store write; publish; return view */ }
  async updateFeed(id: string, body: unknown): Promise<Result> { /* FEED_ID_PATTERN + existence → { ok:false, error:"not-found" }; name-only PATCH keeps source; parse full body when source present; publish */ }
  async removeFeed(id: string): Promise<boolean> { /* store.update filter; clearSecrets(SECRET_SLOT(id)); publish */ }

  async usage(id: string): Promise<{ viewId: string; name: string }[]> {
    const out: { viewId: string; name: string }[] = [];
    for (const v of await viewsStore.load()) {
      if (!v.layout) continue;
      let uses = false;
      walkLayoutObjects(v.layout.objects, (o) => {
        // Read structurally: the `video` config member lands in Task 4, and a
        // view written by a newer build may carry types this one does not know.
        const c = o.config as { type: string; feedId?: unknown };
        if (c.type === "video" && c.feedId === id) uses = true;
      });
      if (uses) out.push({ viewId: v.id, name: v.name });
    }
    return out;
  }
}

export const videoService = new VideoService();
```

Rules for the elided bodies: every write goes through `videoFeedsStore.update(...)` (the write queue); ids are checked with `FEED_ID_PATTERN` and then looked up with `Array.prototype.find` on the loaded list, never used as an object key; a secret write that throws propagates (no catch); `publish()` runs after the store write resolves. A name-only PATCH (`{ name }`) is validated by re-running `parseFeedInput({ name, source: existing.source }, allowedKinds)`, so the name rules live in one place.

- [ ] **Step 4: Implement the routes**

```ts
// video-routes.ts — video feeds and their state.
//
// Every route must finish responding before it returns (see RouteCtx).

import { type RouteCtx, json, error, readBody } from "./context.js";
import { videoService } from "../video/video-service.js";

export async function videoRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, method } = c;

  if (method === "GET" && pathname === "/api/video/state") {
    json(res, await videoService.state());
    return;
  }
  if (method === "GET" && pathname === "/api/video/feeds") {
    json(res, { feeds: (await videoService.state()).feeds });
    return;
  }
  if (method === "POST" && pathname === "/api/video/feeds") {
    const r = await videoService.addFeed(await readBody(req));
    if (r.ok) json(res, { feed: r.feed }, 201);
    else error(res, r.error);
    return;
  }

  const usage = pathname.match(/^\/api\/video\/feeds\/([^/]+)\/usage$/);
  if (method === "GET" && usage) {
    json(res, { layouts: await videoService.usage(decodeURIComponent(usage[1])) });
    return;
  }

  const one = pathname.match(/^\/api\/video\/feeds\/([^/]+)$/);
  if (one && (method === "PATCH" || method === "DELETE")) {
    const id = decodeURIComponent(one[1]);
    if (method === "DELETE") {
      if (await videoService.removeFeed(id)) json(res, { ok: true });
      else error(res, "No such feed", 404);
      return;
    }
    const r = await videoService.updateFeed(id, await readBody(req));
    if (r.ok) json(res, { feed: r.feed });
    else if (r.error === "not-found") error(res, "No such feed", 404);
    else error(res, r.error);
  }
}
```

Register `videoRoutes` in `ROUTE_MODULES` (`main/services/remote-server.ts:98`). In `writeHelloBurst`, add `sseWrite(res, "video:state", await videoService.state());` beside the other hydrated writes, as a quoted literal (the automation coverage scan reads `sseWrite(res, "<channel>"`). Add `"video:state"` to `HYDRATED_CHANNELS` and to `hydrated-channels.test.ts`'s sorted list.

IPC (`renderer/lib/api.ts`), each in the `IpcChannel` union in sorted position and in `invoke`:

```ts
case "video:state": return apiFetch("/api/video/state");
case "video:addFeed": return post("/api/video/feeds", params);
case "video:updateFeed": return patch(`/api/video/feeds/${encodeURIComponent((params as { id: string }).id)}`, (params as { patch: unknown }).patch);
case "video:removeFeed": return del(`/api/video/feeds/${encodeURIComponent((params as { id: string }).id)}`);
case "video:feedUsage": return apiFetch(`/api/video/feeds/${encodeURIComponent((params as { id: string }).id)}/usage`);
```

If `SHARED_READ_PATHS` exists (PR #618 merged), add `["/api/video/state", { channel: "video:state", rev: true }]` in sorted position and update its table test.

- [ ] **Step 5: Run to pass; prove red**

Run: `node --import tsx --test main/services/routes/video-routes.test.ts main/services/routes/dispatch.test.ts main/services/routes/route-coverage.test.ts renderer/lib/api-channels.test.ts renderer/lib/hydrated-channels.test.ts main/services/automation-coverage.test.ts`
Expected: PASS. Red proof: drop the `FEED_ID_PATTERN` check in `updateFeed` and watch the `__proto__` case fail (it must not 200 or throw). Restore.

- [ ] **Step 6: Commit**

```bash
git add main/services/video/video-service.ts main/services/routes/video-routes.ts main/services/routes/video-routes.test.ts main/services/remote-server.ts renderer/lib/sse-channels.ts renderer/lib/hydrated-channels.test.ts renderer/lib/api.ts
git commit -m "feat(video): feed routes and the video:state channel"
```

### Task 4: The `video` layout object

**Files:**
- Modify: `main/types/views.ts`, `renderer/main/layout-objects.ts`, `renderer/editor/palette.tsx`, `renderer/editor/inspector.tsx`, `renderer/main/layout-renderer.tsx`, `main/types/object-capabilities.ts`, and each exact-list test the type checker or `npm test` names (`object-catalog.test.ts`, `object-capabilities.test.ts`, `layout-objects.test.ts`, …)
- Test: `renderer/editor/video-inspector.test.tsx` (create)

**Interfaces:**
- Produces: `LayoutObjectConfig` member `{ type: "video"; feedId: string | null; fit?: "contain" | "cover"; showLabel?: boolean; whenOffline?: "message" | "logo" | "nothing" }` (absent `fit` = contain, absent `showLabel` = on, absent `whenOffline` = message).

- [ ] **Step 1: The config member**, placed after `screen-embed`:

```ts
  // A live video feed from the Video feeds page, by id. Always muted, no
  // controls. Absent fit = "contain", absent showLabel = on, absent whenOffline
  // = "message".
  | {
      type: "video";
      feedId: string | null;
      fit?: "contain" | "cover";
      showLabel?: boolean;
      whenOffline?: "message" | "logo" | "nothing";
    }
```

- [ ] **Step 2: Registry entry** in `layout-objects.ts`:

```ts
  "video": {
    label: "Video",
    blurb: "A live camera or program feed",
    group: "Layout",
    config: () => ({ type: "video", feedId: null, fit: "contain", showLabel: true, whenOffline: "message" }),
    style: BARE,
    homeSize: "l",
  },
```

Palette icon `"video": VideoIcon` (lucide-react). Capabilities: copy `ndi-video`'s row in `object-capabilities.ts` (a picture, no text styling), and add `"video"` to every exact sorted list a test names.

- [ ] **Step 3: Inspector section**, as the mockup's Layout editor tab shows: **Feed** (`RowSelect` of `video:state` feeds by name, plus "Choose a feed"), hint "Feeds are set up once on the Video feeds page. Change a feed there and every layout using it follows."; **Fit** (`RowSelect`: "Fit whole picture" → contain, "Fill the box" → cover); **Show feed name** (`RowSwitch`); **When the feed is offline** (`RowSelect`: "Say it is offline", "Show the logo", "Show nothing"); callout "Always muted, with no controls. A screen that can't keep up reports it on the Screens page." Test: render the inspector for a video object, change Fit, assert the patch is `{ fit: "cover" }`.

- [ ] **Step 4: Renderer case** in `layout-renderer.tsx`: `case "video": return <VideoObject o={o} config={c} ctx={ctx} />;` (Task 5 builds it; until then the case renders the feed id as text, replaced in Task 5).

- [ ] **Step 5: Run** `npm run type-check && node --import tsx --test renderer/editor/video-inspector.test.tsx renderer/main/object-catalog.test.ts main/types/object-capabilities.test.ts renderer/main/layout-objects.test.ts` — PASS.

- [ ] **Step 6: Commit** — `feat(video): the Video layout object and its inspector`

### Task 5: The player

**Files:**
- Create: `renderer/main/video/use-video-state.ts`, `choose-playback.ts`, `choose-playback.test.ts`, `whep-client.ts`, `whep-client.test.ts`, `hls-player.ts`, `use-on-screen.ts`, `video-object.tsx`, `video-object.test.tsx`
- Modify: `package.json` (hls.js)

**Interfaces:**
- Consumes: `VideoState`, `FeedPlay`, `FeedStatus`.
- Produces:
  - `useVideoState(): VideoState | null`
  - `choosePlayback(input: PlaybackInput): PlaybackChoice`
  - `startWhep(url: string, video: HTMLVideoElement, opts?: { onConnected?(): void; onFailed?(why: string): void }): Promise<WhepSession>` with `WhepSession.stop(): Promise<void>` and `WhepSession.pc: RTCPeerConnection`
  - `startHls(url: string, video: HTMLVideoElement): Promise<HlsSession>` with `stop()`, `latencySeconds(): number | null`
  - `useOnScreen(ref, teardownMs): boolean`
  - `VideoObject` component

- [ ] **Step 1: The dependency.** Check hls.js is maintained (`npm view hls.js time.modified version` — 1.7.3, modified 2026-09-23 when this plan was written) and has no stale transitives (`npm view hls.js dependencies` — none). `npm install hls.js@1.7.3 --save-exact`. It is imported only with `await import("hls.js")` inside `hls-player.ts`, so no layout without an HLS feed downloads it.

- [ ] **Step 2: The hook**

```ts
// renderer/main/video/use-video-state.ts
import { useCallback } from "react";
import { invoke } from "../../lib/api";
import { useStatusChannel } from "../use-status-channel";
import type { VideoState } from "@main/types/video";

/** Subscribes only where a Video widget or the Video feeds page is mounted, which
 *  is what lets the server poll the relay only while something watches. */
export function useVideoState(): VideoState | null {
  const read = useCallback(() => invoke<VideoState>("video:state"), []);
  return useStatusChannel<VideoState>(read, "video:state");
}
```

- [ ] **Step 3: Failing tests for the choice**

```ts
// renderer/main/video/choose-playback.test.ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { choosePlayback } from "./choose-playback.js";

const RELAY = { via: "relay", whep: "/video/p/whep", hls: "/video/p/index.m3u8" } as const;
const CAPS = { webrtc: true, nativeHls: false, mse: true };
const base = { play: RELAY, status: { state: "live" as const }, caps: CAPS, allowHls: true, webrtcFailed: false };

test("WebRTC first", () => assert.deepEqual(choosePlayback(base), { method: "webrtc", url: "/video/p/whep" }));
test("HLS when the relay saw B-frames", () => {
  assert.deepEqual(
    choosePlayback({ ...base, status: { state: "delayed", delayedBecause: "b-frames" } }),
    { method: "hls", url: "/video/p/index.m3u8" },
  );
});
test("HLS when WebRTC failed on this screen", () => {
  assert.equal(choosePlayback({ ...base, webrtcFailed: true }).method, "hls");
});
test("HLS when the browser has no WebRTC", () => {
  assert.equal(choosePlayback({ ...base, caps: { ...CAPS, webrtc: false } }).method, "hls");
});
test("the per-screen switch keeps a screen off HLS", () => {
  assert.deepEqual(choosePlayback({ ...base, webrtcFailed: true, allowHls: false }), { method: "none", reason: "hls-off-here" });
});
test("no HLS path at all is can't-play", () => {
  assert.deepEqual(
    choosePlayback({ ...base, webrtcFailed: true, caps: { webrtc: true, nativeHls: false, mse: false } }),
    { method: "none", reason: "no-player" },
  );
});
test("embed plays its iframe", () => {
  assert.deepEqual(choosePlayback({ ...base, play: { via: "embed", src: "https://y/e" } }), { method: "embed", url: "https://y/e" });
});
test("external WHEP has no HLS to fall back to", () => {
  const ext = { ...base, play: { via: "external", url: "http://h/whep", protocol: "whep" } as const };
  assert.equal(choosePlayback(ext).method, "webrtc");
  assert.deepEqual(choosePlayback({ ...ext, webrtcFailed: true }), { method: "none", reason: "no-player" });
});
test("external HLS obeys the switch", () => {
  const ext = { ...base, play: { via: "external", url: "http://h/x.m3u8", protocol: "hls" } as const };
  assert.equal(choosePlayback(ext).method, "hls");
  assert.equal(choosePlayback({ ...ext, allowHls: false }).method, "none");
});
```

- [ ] **Step 4: Implement**

```ts
// renderer/main/video/choose-playback.ts — which way this screen plays a feed.
//
// WebRTC first: under a second behind. HLS when WebRTC cannot carry the stream
// (B-frames), is missing, or failed here; 2 to 6 s behind, so the widget badges
// it. The embed player for YouTube and Resi. Otherwise this screen cannot play it.

import type { FeedPlay, FeedStatus } from "@main/types/video";

export interface PlaybackInput {
  play: FeedPlay;
  status: FeedStatus;
  caps: { webrtc: boolean; nativeHls: boolean; mse: boolean };
  /** The screen's "Use HLS on this screen" switch; true where it is not set. */
  allowHls: boolean;
  /** WebRTC connected but showed no frame, or did not connect, on this screen. */
  webrtcFailed: boolean;
}

export type PlaybackChoice =
  | { method: "webrtc"; url: string }
  | { method: "hls"; url: string }
  | { method: "embed"; url: string }
  | { method: "none"; reason: "hls-off-here" | "no-player" };

export function choosePlayback(i: PlaybackInput): PlaybackChoice {
  const p = i.play;
  if (p.via === "embed") return { method: "embed", url: p.src };
  const canHls = i.caps.nativeHls || i.caps.mse;
  const hls = (url: string): PlaybackChoice =>
    !i.allowHls ? { method: "none", reason: "hls-off-here" } : canHls ? { method: "hls", url } : { method: "none", reason: "no-player" };

  if (p.via === "external") {
    if (p.protocol === "hls") return hls(p.url);
    return i.caps.webrtc && !i.webrtcFailed ? { method: "webrtc", url: p.url } : { method: "none", reason: "no-player" };
  }
  const webrtcOk = i.caps.webrtc && !i.webrtcFailed && i.status.delayedBecause !== "b-frames";
  return webrtcOk ? { method: "webrtc", url: p.whep } : hls(p.hls);
}

export function browserCaps(): PlaybackInput["caps"] {
  const v = document.createElement("video");
  return {
    webrtc: typeof RTCPeerConnection === "function",
    nativeHls: v.canPlayType("application/vnd.apple.mpegurl") !== "",
    mse: typeof MediaSource === "function",
  };
}
```

- [ ] **Step 5: The WHEP client**

```ts
// renderer/main/video/whep-client.ts — receive-only WHEP, no library.
//
// RTCPeerConnection works on plain HTTP (only getUserMedia needs a secure
// context), which is the whole reason this path exists on a LAN app.

export interface WhepSession {
  pc: RTCPeerConnection;
  /** Closes locally, then tells the relay. `ok: false` when the relay could not
   *  be told; it times the session out itself, so an unmount can ignore it. */
  stop(): Promise<{ ok: boolean }>;
}

export async function startWhep(url: string, video: HTMLVideoElement): Promise<WhepSession> {
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (e) => {
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await iceGatheringComplete(pc, 2000);

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/sdp" }, body: pc.localDescription!.sdp });
  } catch (err) {
    pc.close();
    throw err;
  }
  if (res.status !== 201) {
    pc.close();
    throw new Error(`WHEP ${res.status}`);
  }
  const location = res.headers.get("Location");
  await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });

  return {
    pc,
    async stop() {
      pc.close();
      if (!location) return { ok: true };
      try {
        const r = await fetch(new URL(location, window.location.href), { method: "DELETE" });
        return { ok: r.ok };
      } catch {
        return { ok: false };
      }
    },
  };
}

function iceGatheringComplete(pc: RTCPeerConnection, capMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, capMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
    });
  });
}
```

Test with a fake `RTCPeerConnection` and a fake `fetch` (assign on `globalThis` in the test): a 201 with a `Location` results in a `DELETE` to `/video/p/whep/<uuid>` on stop; a 404 closes the peer connection and rejects.

- [ ] **Step 6: The HLS player**

```ts
// renderer/main/video/hls-player.ts — native HLS where the browser has it
// (Safari, iPad), hls.js elsewhere, imported only when a feed needs it.

export interface HlsSession {
  stop(): void;
  /** Seconds behind the live edge, for the "N s behind" badge. */
  latencySeconds(): number | null;
}

export async function startHls(url: string, video: HTMLVideoElement): Promise<HlsSession> {
  if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
    video.src = url;
    return {
      stop() { video.removeAttribute("src"); video.load(); },
      latencySeconds() {
        const r = video.seekable;
        return r.length ? Math.max(0, r.end(r.length - 1) - video.currentTime) : null;
      },
    };
  }
  const { default: Hls } = await import("hls.js");
  const hls = new Hls({ lowLatencyMode: true, backBufferLength: 10 });
  hls.loadSource(url);
  hls.attachMedia(video);
  return {
    stop() { hls.destroy(); },
    latencySeconds() { return typeof hls.latency === "number" && Number.isFinite(hls.latency) ? hls.latency : null; },
  };
}
```

A fatal hls.js error (`Hls.Events.ERROR` with `data.fatal`) is reported to the widget, which shows Offline and retries with its backoff: pass an `onFatal(why)` option and wire it.

- [ ] **Step 7: On screen**

```ts
// renderer/main/video/use-on-screen.ts — true while the element is on screen and
// the page is visible. Going false waits `teardownMs`, so scrolling past or a
// brief tab switch does not tear a session down and rebuild it.

import { useEffect, useState, type RefObject } from "react";

export function useOnScreen(ref: RefObject<Element | null>, teardownMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let intersecting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = intersecting && document.visibilityState === "visible";
      clearTimeout(timer);
      if (now) setShown(true);
      else timer = setTimeout(() => setShown(false), teardownMs);
    };
    const io = new IntersectionObserver(([e]) => { intersecting = e?.isIntersecting ?? false; update(); });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => { io.disconnect(); document.removeEventListener("visibilitychange", update); clearTimeout(timer); };
  }, [ref, teardownMs]);
  return shown;
}
```

- [ ] **Step 8: The widget.** `VideoObject({ o, config, ctx })`:

Constants at the top, named: `HIDDEN_TEARDOWN_MS = 3000`, `CONNECT_TIMEOUT_MS = 10_000`, `FIRST_FRAME_TIMEOUT_MS = 5000`, `RETRY_MIN_MS = 1000`, `RETRY_MAX_MS = 30_000`.

Behaviour:
1. Look up the feed in `useVideoState()` by `config.feedId`. No feed id: the editor shows "Choose a feed"; a deleted feed shows the offline state.
2. **Preview pause:** when `window.location.pathname.startsWith("/preview-")`, render "Video paused in preview" and a Play button (mockup, Home and Screens tab); nothing connects until Play.
3. Only while `useOnScreen(ref, HIDDEN_TEARDOWN_MS)` is true: run `choosePlayback` with `browserCaps()`, `allowHls` (PR 1: always true; PR 3 wires the screen's switch) and a `webrtcFailed` flag held in state.
4. `webrtc`: `startWhep`. If `pc.connectionState` is not `connected` within `CONNECT_TIMEOUT_MS`, or no frame arrives within `FIRST_FRAME_TIMEOUT_MS` of connecting (use `video.requestVideoFrameCallback` where present, else poll `getVideoPlaybackQuality().totalVideoFrames`), stop it, set `webrtcFailed`, and choose again (HLS, or can't-play).
5. `hls`: `startHls`; show the badge `${Math.max(1, Math.round(latency))} s behind` refreshed each second.
6. `embed`: `<iframe src={url} allow="autoplay; encrypted-media" referrerPolicy="strict-origin-when-cross-origin" style={{ border: 0, width: "100%", height: "100%", pointerEvents: "none" }} />`.
7. A dropped session (`connectionState` `failed`/`disconnected` for 3 s, hls.js fatal, `video` `error`) shows the offline state and retries with backoff `min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt)`; when the feed's `status.state` becomes `live` again, retry at once.
8. Always `<video muted playsInline autoPlay disablePictureInPicture>` with no `controls`, `object-fit` from `config.fit ?? "contain"`.
9. States and copy, exactly as the mockup: Connecting (pulse, "Connecting to {name}"); Live; Delayed (the badge); Waiting ("Waiting for the source" / "Nothing is sending to this feed yet"); Offline per `whenOffline` — message ("{name} is offline" / "It will appear here when the source comes back"), logo (`<BrandLogo logo={ctx.state.appLogo} monochrome={ctx.state.appLogoMonochrome} />`, as `stage-display-view.tsx:147`), nothing; Can't play ("This screen can't play video" / "{name} plays on the other screens"). The name tag when `showLabel !== false`.
10. Wrap it in `ErrorBoundary` from `renderer/components/ui/error-boundary-view.tsx` with a fallback that draws the Can't play state, so a throw never takes the layout down.
11. Unmount stops the session (WHEP `DELETE`, or `hls.destroy()`).

If PR #620 has merged, `gate-render-parity.test.ts` and `layout-data-reads.test.tsx` hold a table of what each object reads: add `video` reading nothing from `ctx` except `state` (its feed data comes from its own `useVideoState`), and follow that test's instructions.

- [ ] **Step 9: Failing widget tests, then pass** (`renderer/main/video/video-object.test.tsx`), each proven red:
  - With `window.location.pathname = "/preview-abc"`: renders "Video paused in preview" and makes NO request to any `/video/` URL until Play is clicked (stub `fetch`, count calls).
  - With a stubbed `IntersectionObserver` reporting not intersecting: no WHEP request. Flip it to intersecting: one POST. Flip back and advance fake timers past `HIDDEN_TEARDOWN_MS`: the session's `DELETE` is sent.
  - `document.visibilityState = "hidden"` behaves like off screen.
  - An embed feed renders an iframe whose `src` contains `mute=1` and no `<video>`.
  - A render error inside the player shows "This screen can't play video", and a sibling object still renders.
  Red proofs: remove the preview check (the first test fails); remove the `useOnScreen` gate (the second fails).

- [ ] **Step 10: Run** `node --import tsx --test renderer/main/video/*.test.ts renderer/main/video/*.test.tsx` — PASS.

- [ ] **Step 11: Commit** — `feat(video): the player, WebRTC first with HLS and embed fallbacks`, then a separate `build(deps): add hls.js 1.7.3 for HLS playback off Safari` if the lockfile change is large (it is its own concern).

### Task 6: The Video feeds page

**Files:**
- Create: `renderer/app/video-feeds/video-feeds-route.tsx`, `renderer/app/video-feeds/feed-list.tsx`, `renderer/app/video-feeds/feed-editor.tsx`, `renderer/app/video-feeds/video-feeds-route.test.tsx`
- Modify: `renderer/app/destinations.tsx`, `main/services/routes/operator-paths.ts`, `renderer/app/reachable.test.ts` (if it holds a list)

**Interfaces:**
- Consumes: `video:*` IPC channels; `useVideoState()` and `VideoObject` from Task 5.
- Produces: route `/video-feeds`.

**Build what the mockup's "Video feeds" tab shows**, top to bottom: the page header, the feed list on the left, the editor on the right. PR 1 differences from the mockup: no relay status line or switch (PR 2), and the Source dropdown offers only "YouTube or Resi player" and "Another WebRTC or HLS address" (the other two arrive in PR 2 by widening `allowedKinds`; the dropdown lists exactly `video:state`'s `kinds`, so nothing in the page changes when they do).

Copy, exactly as the mockup:
- Dropdown labels: `pull` "Pull from a device (RTSP, SRT, HLS)", `push` "The device pushes to Stage Utility (SRT, RTMP, WHIP)", `embed` "YouTube or Resi player", `external` "Another WebRTC or HLS address".
- Name field description: "What layouts and Home show. Renaming keeps every layout using it."
- Embed: Player select "YouTube, the channel's current live stream" / "YouTube, one video or stream" / "Resi embed"; the field label follows the player ("Channel", "Video", "Embed code"); callout "Plays in YouTube's own player, 5 to 15 seconds behind, and only while the stream is public or unlisted. Good for a lobby, not for the stage."
- External: label "WebRTC (WHEP) or HLS address"; description "Something else already serves this feed. Stage Utility plays it as given and cannot report its health."
- Pills: `live` "Live", `delayed` "Live, delayed", `standby` "Standby", `waiting` "Waiting for source", `offline` "Offline", `embed` "Live on YouTube" / "Live on Resi" by player; external shows no pill.
- Actions: Save, Cancel, Delete feed. Delete first calls `video:feedUsage` and confirms with "Used by N layouts: A, B." (or "Not used by any layout.") before `video:removeFeed`.
- The editor's picture is a live `VideoObject` (Task 5) for the selected feed, label off.

Sidebar: add to `DESTINATIONS` `{ path: "/video-feeds", label: "Video feeds", description: "Camera and program feeds for layouts and Home.", icon: <VideoIcon className="size-4" />, Component: VideoFeedsRoute }` (lucide-react `Video`), and `NAV_GROUPS` Screens becomes `["/screens", "/video-feeds"]`. Add `"/video-feeds"` to `OPERATOR_PATHS` in `operator-paths.ts` (vite.config.ts and `reserved-slugs.test.ts` both read it).

- [ ] **Step 1: Failing test** — render `VideoFeedsRoute` with a stubbed `invoke` answering `video:state` with two feeds (one embed, one external); assert both names render, the embed row's pill reads "Live on YouTube", the external row has no pill, and choosing "Another WebRTC or HLS address" in the Source select shows the "WebRTC (WHEP) or HLS address" field. Then a second test: Delete on a feed calls `video:feedUsage` BEFORE `video:removeFeed`, and the confirmation names the layouts. Follow an existing route test's stub pattern (`grep -rln "vi\?nvoke" renderer/app --include='*.test.tsx'`; reset the stage-state and SSE replay caches between cases, per `renderer-test-and-browser-gotchas`).
- [ ] **Step 2: Run to fail** — `node --import tsx --test renderer/app/video-feeds/video-feeds-route.test.tsx`
- [ ] **Step 3: Build the page.** Save sends `video:addFeed` for a new feed and `video:updateFeed` otherwise; a refusal shows the server's `error` under the Save button, and nothing reads as saved until the call resolves.
- [ ] **Step 4: Run to pass**, plus `node --import tsx --test renderer/app/reachable.test.ts main/services/routes/operator-paths.test.ts main/services/reserved-slugs.test.ts`
- [ ] **Step 5: Commit** — `feat(video): the Video feeds page under Screens`

### Task 7: Docs, verification, PR 1

- [ ] **Step 1: Docs**, reference voice, describing what exists now:
  - `docs/integrations/video-feeds.md` (new): what a feed is; the four kinds, with `pull` and `push` marked as needing the relay (arrives next); YouTube (channel ID, public or unlisted, 5 to 15 s behind) and Resi (paste the embed code); an external WHEP or HLS address; the Video widget's playback order and states; the Screens preview pause.
  - `docs/integrations/README.md`: a row `| [Video feeds](video-feeds.md) | Live camera and program video in layouts and on Home |`.
  - `docs/reference/api.md`: the five routes and `video:state` in the SSE channel table.
  - `docs/reference/widgets.md`: the Video widget, its four settings and its states.
  - `docs/features/operator-app.md`: Video feeds in the sidebar under Screens.
  - Logging: PR 1 has no failure path on the server that is not a 400 to the operator; say "nothing worth logging in PR 1" in the PR body. The client logs nothing new.
- [ ] **Step 2: The gate** — `npm run lint && npm run type-check && npm test && npm run build`, read in this session.
- [ ] **Step 3: Drive it for real.** Sandbox server on 8799, empty data dir:

  ```bash
  lsof -ti tcp:8799 | xargs kill 2>/dev/null; rm -rf /tmp/su-video && mkdir /tmp/su-video
  STAGE_UTILITY_DATA=/tmp/su-video PORT=8799 STAGE_UTILITY_FRIENDLY_PORT=0 npm run build && STAGE_UTILITY_DATA=/tmp/su-video PORT=8799 STAGE_UTILITY_FRIENDLY_PORT=0 npm start
  ```

  Check `/api/version` is your build. In a real browser (Playwright): add an external HLS feed pointing at a local FFmpeg HLS output served by `python3 -m http.server` (`ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -c:v libx264 -pix_fmt yuv420p -f hls -hls_time 1 -hls_list_size 5 -hls_flags delete_segments /tmp/su-hls/index.m3u8`); place a Video widget in a custom layout; open the layout's display URL and see the picture with the "N s behind" badge; open Screens and see "Video paused in preview", press Play, see it play; rename the feed and see the layout keep it; delete it and see the confirmation name the layout, then the widget's offline state. Add a YouTube video embed and see the iframe muted. Kill the server by port.
- [ ] **Step 4: Pre-PR passes** — correctness, simplification, whole-PR (the `verifier` agent, `code-simplifier`, `pr-review-toolkit`). Fix what they find.
- [ ] **Step 5: Push and open** — `git push -u origin feat/video-feeds-page`, `gh pr create --base beta --title "feat(video): video feeds page, the Video widget and its player"`. Body: what it does, the deviations list, docs answer, logging answer, how it was driven. No footer.

---

# PR 2 — the relay

Branch: `feat/video-relay` off `origin/beta` once PR 1 has merged (never stacked on an unmerged branch; if PR 1 is still open, branch with `--base feat/video-feeds-page`).

### Task 8: The pin and acquisition

**Files:**
- Create: `main/services/video/mediamtx-pin.ts`, `main/services/video/acquire.ts`, `main/services/video/acquire.test.ts`

**Interfaces:**
- Produces:
  - `MEDIAMTX_VERSION = "v1.21.1"`, `MEDIAMTX_DOWNLOAD_BYTES = 27_000_000`, `MEDIAMTX_DISK_BYTES = 55_000_000`
  - `assetFor(platform: NodeJS.Platform, arch: string): { name: string; sha256: string; exe: string } | null`
  - `relayDir(): string` (`<data>/video-relay`)
  - `ensureBinary(opts?: { fetchImpl?: typeof fetch; onProgress?(received: number, total: number): void; assets?: typeof ASSETS }): Promise<{ ok: true; path: string } | { ok: false; reason: string; placeArchiveAt: string }>`

- [ ] **Step 1: The pin** — the Global Constraints table as a `ReadonlyMap` keyed `"<platform>-<arch>"`: `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, each `{ name, sha256, exe: "mediamtx" | "mediamtx.exe" }`. Any other platform returns null and the relay fails with "Video relay is not available for <platform> <arch>."
- [ ] **Step 2: Failing tests**, with a temp data dir and an injected `fetchImpl`:
  - Bytes whose hash does not match: `ensureBinary` returns `{ ok: false }` with a reason naming the checksum, the downloaded file no longer exists, and the extract step never ran (inject an `extract` spy through an `opts.extract` seam, default the real one).
  - A matching archive already in `downloads/` (hand-placed) is verified and extracted without calling `fetchImpl`.
  - A hand-placed archive that does not match is refused with its path in the reason, and is NOT deleted (it is the operator's file; say so and log it).
  - An already-extracted binary at `v1.21.1/<exe>` is used as-is with no fetch.
  Build the test archive in the test with the system `tar` (`tar -czf` of a small shell script named `mediamtx`) and pass its real SHA-256 as the pinned value through `opts.assets`.
- [ ] **Step 3: Implement.** Download with `fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) })`, stream to `downloads/<name>.part` while hashing (`crypto.createHash("sha256")`), refuse past 64 MB, rename to `downloads/<name>` only after the hash matches, else unlink the `.part` and return the failure. Extract with `execFile("tar", ["-xf", archive, "-C", versionDir, exe])` (`-xf` reads both gzip and zip on bsdtar/Windows 10+ and gzip on GNU tar), then `chmod 0o755` except on Windows. Every failure returns `{ ok: false, reason, placeArchiveAt: path.join(relayDir(), "downloads", name) }`. Logging, each once: `[video] downloading MediaMTX v1.21.1 (<name>)`, `[video] checksum mismatch for <name>: expected <a>, got <b>; deleted`, `[video] hand-placed <path> does not match the pinned checksum; left in place`.
- [ ] **Step 4: Run to pass**: `node --import tsx --test main/services/video/acquire.test.ts`. Red proof: skip the hash comparison and watch the mismatch test fail.
- [ ] **Step 5: Commit** — `feat(video): download and verify the pinned MediaMTX`

### Task 9: The config and the log watcher

**Files:**
- Create: `main/services/video/mediamtx-config.ts`, `mediamtx-config.test.ts`, `relay-log.ts`, `relay-log.test.ts`

**Interfaces:**
- Produces:
  - `RelayUser = { user: string; pass: string; ips: string[]; permissions: { action: "publish" | "read" | "api"; path: string }[] }`
  - `READER_USER: RelayUser` (`any`, no password, `127.0.0.1` and `::1`, read + api on every path)
  - `relayConfig(opts: { ports: VideoPorts; lanIp: string; users: RelayUser[] }): Record<string, unknown>`
  - `class RelayLogWatcher { line(text: string): RelayLogEvent | null; lastError(): string | null; version(): string | null }`
  - `RelayLogEvent = { kind: "b-frames"; path: string } | { kind: "error"; text: string }`

- [ ] **Step 1: Failing config test** — an exact `deepEqual` against the object below (a test that pins every key is the guard that a MediaMTX default can never switch on a listener silently):

```ts
export function relayConfig({ ports, lanIp, users }: { ports: VideoPorts; lanIp: string; users: RelayUser[] }) {
  return {
    logLevel: "info",
    logDestinations: ["stdout"],
    authMethod: "internal",
    authInternalUsers: users,
    api: true,
    apiAddress: `127.0.0.1:${ports.api}`,
    metrics: false,
    pprof: false,
    playback: false,
    // No push kind uses RTSP and pulling RTSP needs no listener.
    rtsp: false,
    rtspEncryption: "no",
    rtmp: true,
    rtmpAddress: `:${ports.rtmp}`,
    rtmpEncryption: "no",
    hls: true,
    hlsAddress: `127.0.0.1:${ports.hls}`,
    hlsVariant: "lowLatency",
    webrtc: true,
    webrtcAddress: `127.0.0.1:${ports.webrtcHttp}`,
    webrtcLocalUDPAddress: `:${ports.webrtcUdp}`,
    webrtcLocalTCPAddress: "",
    webrtcAdditionalHosts: [lanIp],
    srt: true,
    srtAddress: `:${ports.srt}`,
    // v1.21.1 turns MoQ on by default and binds :8892 and :8893 on every interface.
    moq: false,
    pathDefaults: { overridePublisher: false },
    paths: {},
  };
}
```

Written to disk as `JSON.stringify(config, null, 2)` into `<relayDir>/mediamtx.yml` on every start.

- [ ] **Step 2: Failing log test**, built from the fixture lines verbatim (copy the four lines from "What the real binary does" into the test as a const):
  - Feeding the four lines in order returns `null` three times and then `{ kind: "b-frames", path: "bframes" }`.
  - A close line for an unknown session returns null.
  - `2026/09/27 18:05:03 INF MediaMTX v1.21.1, darwin, arm64` sets `version()` to `v1.21.1`.
  - `ERR: json: unknown field "rtsps"` and `2026/09/27 18:00:33 ERR [API] path already exists` both set `lastError()` and return `{ kind: "error" }`.
  - The session map holds at most 256 entries (feed 300 "is reading" lines; the first session's close line then returns null).
  Red proof: change the close regex to the old spec's wording ("B-frames are not supported") and watch the fixture test fail — this is the guard that a MediaMTX bump changing the wording fails CI.

```ts
const READING = /\[WebRTC\] \[session ([0-9a-f]+)\] is reading from path '([^']+)'/;
const BFRAMES = /\[WebRTC\] \[session ([0-9a-f]+)\] closed: WebRTC doesn't support H264 streams with B-frames/;
const CLOSED = /\[WebRTC\] \[session ([0-9a-f]+)\] (?:closed|destroyed)/;
const VERSION = /INF MediaMTX (v\d+\.\d+\.\d+)/;
const ERROR = /(?:^ERR: | ERR )(.+)$/;
```

- [ ] **Step 3: Implement both; run to pass** — `node --import tsx --test main/services/video/mediamtx-config.test.ts main/services/video/relay-log.test.ts`
- [ ] **Step 4: Commit** — `feat(video): the relay's generated config and log watcher`

### Task 10: The supervisor and the port check

**Files:**
- Create: `main/services/video/supervisor.ts`, `supervisor.test.ts`, `port-check.ts`, `port-check.test.ts`

**Interfaces:**
- Consumes: `RelayLogWatcher`; `describePortHolder(port)` from `main/services/port-holder.ts`.
- Produces:
  - `restartDelayMs(attempt: number): number` = `Math.min(60_000, 1000 * 2 ** attempt)`
  - `class RelaySupervisor extends EventEmitter` with `start(binary: string, configPath: string)`, `stop(): Promise<void>`, `status(): SupervisorStatus`; events `"line"` (text), `"exit"` (code, lastError), `"spawned"`.
  - `SupervisorStatus = { state: "off" } | { state: "starting" } | { state: "running"; since: number } | { state: "failing"; reason: string; retryAt: number }`
  - `busyPorts(ports: VideoPorts): Promise<{ port: number; proto: "tcp" | "udp"; holder: string }[]>`

- [ ] **Step 1: Failing tests** with an injected `spawnImpl` returning a fake child (an `EventEmitter` with `stdout`/`stderr` `PassThrough` streams, `kill()`, `pid`) and `mock.timers.enable({ apis: ["setTimeout", "Date"] })`:
  - Exit after 1 s: status becomes `failing` with the last `ERR` line as `reason` and `retryAt = now + 1000`; advancing 1000 ms spawns again. Three quick exits in a row give delays 1, 2, 4 s. After 20 exits the delay is 60 s and a spawn still follows: it never gives up.
  - A child that has run for 60 s resets the attempt count (the next exit waits 1 s again).
  - `stop()` sends SIGTERM, then SIGKILL after 5 s if no exit, and schedules no restart.
  - `line` events carry each stdout and stderr line (readline over both).
  Red proof: remove the attempt reset and watch the second test fail.
- [ ] **Step 2: Implement.** `spawn(binary, [configPath], { stdio: ["ignore", "pipe", "pipe"] })`. Write `<relayDir>/relay.pid` on spawn, delete it on exit. Before a start, if `relay.pid` names a live process whose command (`ps -p <pid> -o command=`, skipped on Windows) is this binary, SIGTERM it and log `[video] stopped a relay left over from the last run (pid <n>)`. `process.once("exit", () => child.kill())` so the server never leaves one behind. Log `[video] relay exited (code <c>): <lastError>; restarting in <n> s` once per failing streak through an `OutageLog` (`main/services/repeat-log.ts`, key `"relay"`), and `[video] relay recovered after <note>` on `ok`.
- [ ] **Step 3: Port check.** TCP: `net.createServer().listen({ port, host })` then close; UDP: `dgram.createSocket("udp4").bind(port)` then close. Host `127.0.0.1` for the loopback ports, `0.0.0.0` for the LAN ones. Each busy port gets `holder: await describePortHolder(port)`. Test: occupy a random free TCP port and a random UDP port in the test, pass them as ports, and assert both come back busy with the right `proto`; release them and assert none.
- [ ] **Step 4: Run to pass**, then commit — `feat(video): supervise the relay with backoff that never gives up`

### Task 11: The relay adapter and reconcile

**Files:**
- Create: `main/services/video/relay.ts`, `reconcile-plan.ts`, `reconcile-plan.test.ts`, `mediamtx-relay.ts`, `mediamtx-relay.test.ts`

**Interfaces:**
- Produces:

```ts
// relay.ts — everything outside main/services/video/ sees only this.
export type RelayFeed =
  | { id: string; kind: "pull"; source: string }        // URL with credentials folded in
  | { id: string; kind: "push"; password: string };

export interface RelayPath {
  name: string;
  ready: boolean;
  readyTime: string | null;
  source: { type: string; id: string } | null;
  video: { codec: string; width?: number; height?: number; profile?: string } | null;
  readers: number;
}

export interface VideoRelay {
  /** Make the relay's paths and publish users match `feeds` exactly. */
  reconcile(feeds: RelayFeed[]): Promise<void>;
  /** Every path the relay has, or throws when the relay does not answer. */
  status(): Promise<RelayPath[]>;
  /** Same-origin playback URLs for a feed. */
  playback(feedId: string): { whep: string; hls: string };
  /** Drop whoever is publishing to a feed, so a new password takes effect now. */
  kickPublisher(feedId: string): Promise<void>;
}
```

  - `planReconcile(desired: RelayFeed[], current: { name: string; conf: Record<string, unknown> }[]): { add: [string, PathConf][]; replace: [string, PathConf][]; remove: string[] }`
  - `pathConf(feed: RelayFeed): PathConf` — pull: `{ source, sourceOnDemand: true, sourceOnDemandStartTimeout: "10s", sourceOnDemandCloseAfter: "10s" }`; push: `{ source: "publisher", overridePublisher: false }`
  - `publishUsers(feeds: RelayFeed[]): RelayUser[]` — `READER_USER` then one `{ user: "video", pass, ips: [], permissions: [{ action: "publish", path: id }] }` per push feed, sorted by path

- [ ] **Step 1: Failing pure tests** for `planReconcile`: empty relay + two feeds adds both; a relay path not in the list is removed; a pull feed whose URL changed is replaced; a path whose conf matches on every key `pathConf` sets is left alone even though the relay reports dozens of other keys; `all_others` (if present) is never removed.
- [ ] **Step 2: Failing adapter test against a fake MediaMTX API** — an `http.createServer` in the test that implements `GET /v3/config/paths/list`, `POST /v3/config/paths/add|replace/<n>`, `DELETE /v3/config/paths/delete/<n>`, `GET /v3/config/global/get`, `PATCH /v3/config/global/patch`, `GET /v3/paths/list` and `POST /v3/rtmpconns/kick/<id>`, keeping state in memory and recording calls. Assert: reconcile patches `authInternalUsers` BEFORE adding paths (so a push feed's first publisher is accepted); a second reconcile with no changes makes no writes; after the fake "restarts" (state cleared), reconcile restores every path; `status()` maps `tracks2[0].codecProps` to `video`; `kickPublisher` on a path whose `source.type` is `rtmpConn` posts to `/v3/rtmpconns/kick/<id>` (`srtConn` → `srtconns`, `webRTCSession` → `webrtcsessions`). Pull feed credentials: `rtsp://h/s` with user `admin` and password `p@ss` becomes `rtsp://admin:p%40ss@h/s`; an SRT pull's password becomes `passphrase=<pw>` in the query.
- [ ] **Step 3: Implement** `MediaMtxRelay` with `fetch` to `http://127.0.0.1:<api>` and a 5 s timeout per call. A non-2xx answer throws an `Error` carrying the relay's `error` text; nothing here catches.
- [ ] **Step 4: Run to pass**; red proof: reverse the order (paths before users) and watch the ordering assertion fail.
- [ ] **Step 5: Commit** — `feat(video): reconcile the relay's paths and publishers with the feed list`

### Task 12: Feed state, the seen store and the status poll

**Files:**
- Create: `main/services/video/feed-state.ts`, `feed-state.test.ts`, `seen-store.ts`
- Modify: `main/services/video/video-service.ts`, `main/services/stores.ts`, `main/services/config-snapshot.test.ts` (runtime list: `"video-seen.json"` in sorted position)

**Interfaces:**
- Produces:
  - `feedState(i: { kind: "pull" | "push"; path: RelayPath | undefined; bframesMark: { readyTime: string | null } | undefined; recentlyRequested: boolean; lastSeenAt: number | null }): FeedStatus`
  - `videoSeenStore` (`"runtime"`), `{ [feedId: string]: number }` stored as a `Map` in memory
  - `STATUS_POLL_MS = 3000`, `RECENT_REQUEST_MS = 15_000`

- [ ] **Step 1: Failing table test** for `feedState`, one case per row:

| Input | Status |
|---|---|
| path ready, H264, no mark | `live`, with codec/width/height/profile |
| path ready, H264, mark with the same `readyTime` | `delayed`, `delayedBecause: "b-frames"` |
| path ready, mark with a different `readyTime` | `live` (the source reconnected; the mark is stale) |
| path ready, codec `H265` | `delayed`, `delayedBecause: "codec"` |
| pull, not ready, not recently requested | `standby` |
| pull, not ready, requested in the last 15 s | `offline`, `lastSeenAt` |
| push, not ready, never seen | `waiting` |
| push, not ready, seen before | `offline`, `lastSeenAt` |
| no path at all (relay down) | `offline`, `lastSeenAt` |

- [ ] **Step 2: Implement `feedState`** as a pure function; wire the service:
  - The service's `relayStatus()` and `feedStatus()` (PR 1's placeholders) now read the supervisor's status and the latest poll.
  - Poll `relay.status()` every `STATUS_POLL_MS` only while `channelInDemand("video:state")` is true (a page or a widget subscribed); `addSubscriptionListener` starts and stops the loop. A relay that does not answer counts as a failure through the supervisor's `OutageLog`, not a new log line per poll.
  - Publish `video:state` only when the computed snapshot differs from the last one published (compare `JSON.stringify` of everything but `rev`).
  - Log `[video] <name> is live (<w>×<h> <codec>)` and `[video] <name> went offline` on the transition only; `[video] <name> sends B-frames, so screens play it over HLS, 2 to 6 s behind. Turn B-frames off on the device for under a second.` once per mark.
  - The watcher's `b-frames` event stores a mark `{ readyTime }` taken from the latest poll's path; `feedState` clears it by comparison.
  - A feed going live writes `lastSeenAt` to the seen store (at most once a minute per feed, so a live feed does not write every 3 s).
- [ ] **Step 3: Run** `node --import tsx --test main/services/video/feed-state.test.ts main/services/config-snapshot.test.ts` — PASS; red proof: drop the `readyTime` comparison and watch the stale-mark row fail.
- [ ] **Step 4: Commit** — `feat(video): each feed's live state, polled only while watched`

### Task 13: The playback proxy

**Files:**
- Create: `main/services/routes/video-proxy-routes.ts`, `video-proxy-routes.test.ts`
- Modify: `main/services/remote-server.ts` (`EARLY_ROUTE_MODULES = [logRoutes, videoProxyRoutes]`)

**Interfaces:**
- Consumes: `videoService.relayTarget(feedId, kind: "whep" | "whip" | "hls"): { host: "127.0.0.1"; port: number; path: string } | { refuse: 404 | 503 }` (add it to the service: 404 for an unknown id, a non-relay kind, or `whip` on a feed that is not push/whip; 503 while the relay is not running), and `videoService.noteRequested(feedId)`.

- [ ] **Step 1: Failing tests** against a fake upstream (`http.createServer` answering WHEP with `201` and `Location: /cam/whep/abc`, serving `index.m3u8` and a segment, and holding a playlist request for 2 s to model LL-HLS blocking reload):
  - `POST /video/cam/whep` with an SDP body is forwarded with the body and `Content-Type` intact; the answer is 201 and `Location` is rewritten to `/video/cam/whep/abc`.
  - `DELETE /video/cam/whep/abc` reaches the upstream as `DELETE /cam/whep/abc`.
  - `POST /video/cam/whip` forwards the `Authorization` header (OBS's Bearer token) and is 404 on a pull feed.
  - `GET /video/cam/index.m3u8?_HLS_msn=4&_HLS_part=1` keeps the query and streams the held response when it arrives.
  - `GET /video/nope/whep` is 404; `GET /video/cam/../../v3/paths/list` is 404; a file name outside `^[A-Za-z0-9_.-]+\.(m3u8|mp4|m4s)$` is 404.
  - A request body over 64 KB to WHEP is 413 and never reaches upstream.
  - Relay not running: 503 `{ "error": "The video relay is not running" }`.
  Use `callRoute` for the refusals and a real listening server for the streaming cases (the harness has no socket).
- [ ] **Step 2: Implement** with `http.request` piping (`req.pipe(upstream)`, `upstreamRes.pipe(res)`), `Cache-Control: no-store` on playlists, timeouts 10 s for WHEP/WHIP and 30 s for HLS. An upstream error before headers is a 502 with the message; after headers, destroy the response. Record `noteRequested(feedId)` on every WHEP POST and playlist GET. Log `[video] proxy to relay failed for <feed>: <err>` through a `RepeatLog` so a dead relay is one line per outage.
- [ ] **Step 3: Run** `node --import tsx --test main/services/routes/video-proxy-routes.test.ts main/services/routes/dispatch.test.ts` — PASS. Red proof: remove the file-name pattern and watch the traversal case fail.
- [ ] **Step 4: Commit** — `feat(video): proxy WHEP, WHIP and HLS to the relay on Stage Utility's origin`

### Task 14: Pull and push feeds, passwords and the page

**Files:**
- Modify: `main/services/video/video-service.ts`, `main/services/routes/video-routes.ts`, `video-routes.test.ts`, `renderer/lib/api.ts`, `renderer/app/video-feeds/feed-editor.tsx`, `feed-list.tsx`

**Interfaces:**
- Produces:
  - `allowedKinds()` now returns all four.
  - `videoService.pushAddress(id): Promise<{ protocol: PushProtocol; address: string; password: string } | null>` — SRT `srt://<lan>:<srt>?streamid=publish:<id>:video:<pw>`; RTMP `rtmp://<lan>:<rtmp>/<id>?user=video&pass=<pw>`; WHIP `http://<lan>:<Stage Utility's port, 8788>/video/<id>/whip`. For WHIP, `password` is `video:<pw>`, because that whole string is what OBS's Bearer Token field takes; for SRT and RTMP it is `<pw>`
  - `videoService.newPushPassword(id)`: writes the secret, reconciles, then `relay.kickPublisher(id)`
  - Routes `GET /api/video/feeds/:id/push`, `POST /api/video/feeds/:id/push/new-password`; IPC `video:pushAddress`, `video:newPushPassword`
  - A push feed gets a password at creation: 16 characters from `crypto.randomBytes`, base62.

- [ ] **Step 1: Failing route tests**: creating a push feed stores a password in `secretsStore` slot `video:<id>` and nowhere in `video-feeds.json` (read the file and assert it lacks the password); `GET …/push` returns an address containing it; `new-password` returns a different one; `GET /api/video/state` and the `video:state` broadcast never contain it (capture broadcasts with `addBroadcastListener`). Deleting the feed clears the slot. Red proof: store the password on the source object and watch the file assertion fail.
- [ ] **Step 2: Implement**; the server's LAN address comes from the same `getLanIp()` remote-server uses — export it from a small shared module rather than copying it (it is one function in `remote-server.ts:156`; move it to `main/services/lan-ip.ts` and import it from both, per the repeated-pattern rule).
- [ ] **Step 3: The page**, as the mockup: for `pull`, Address with the hint "An RTSP, SRT or HLS address the relay fetches. It only fetches while something is showing this feed.", Username and password ("If the device asks for one" / "Password"), callout "**Magewell Ultra Stream:** turn on its RTSP server as the second output. It keeps streaming to Resi on the first."; for `push`, the "How it connects" segmented SRT / RTMP / WHIP (OBS), "Paste this into the device" with Copy (fallback: select the text), the description ("In OBS: Settings, Stream, Service WHIP. Use the password below as the Bearer Token." for WHIP; "The password is part of the address. Anything that pushes without it is refused." otherwise), and Password with New password. A delayed feed shows the mockup's warning callout, with the B-frame fix text for OBS.
- [ ] **Step 4: Run to pass; commit** — `feat(video): pull and push feeds with per-feed publish passwords`

### Task 15: The integration, the switch and the ports

**Files:**
- Modify: `main/services/integration-ids.ts` (`INTEGRATION_IDS` and `CONNECTION_MANAGED_IDS`, sorted), `main/services/integration-manager.ts` (descriptor, `DESCRIPTORS`, `OUT_OF_BAND_CONFIGURED` with a `videoFeeds` count on `OutOfBandSetup`, secret-fields table `["video", []]`, applier `video: () => this.applyVideo()`, test branch), `main/services/automation-triggers.ts` (`INTEGRATIONS` gains `{ id: "video", label: "Video relay" }`, which gives `video.connected` / `video.disconnected` for free), `renderer/components/integrations-panel.tsx` (`CATEGORY_ORDER` streaming row `["resi", "youtube", "video"]`, `bespokePanelFor`), `renderer/test-fixtures/integration-descriptors.ts`, and each list test (`integration-ids.test.ts`, `integrations-category-order.test.ts` EXPECTED, `automation-triggers.test.ts`, `integration-tile.test.tsx`)
- Create: `renderer/app/video-feeds/relay-status.tsx`, `renderer/settings/sections/video-relay-ports.tsx`
- Modify: `renderer/settings/sections/advanced-section.tsx`, `main/services/routes/video-routes.ts` (`PATCH /api/video/ports`)

- [ ] **Step 1: Register.** Descriptor:

```ts
const VIDEO_DESCRIPTOR: IntegrationDescriptor = {
  id: "video",
  kind: "control",
  label: "Video feeds",
  description: "Runs the relay that turns encoder and camera streams into video for layouts and Home.",
  docs: "video-feeds",
  configSchema: [],
};
```

`applyVideo()` calls `videoService.setEnabled(this.states.get("video")?.enabled === true)`. `videoService` maps its relay status to the manager's connection state through a callback it is given (`running` → `connected`; `starting`/`downloading` → `connecting`; `failing` → `error` with the reason; `off` → `disconnected`) and calls `broadcastStates()`, so the context bar counts a failing relay. `setEnabled(true)` with at least one pull/push feed runs `ensureBinary` → port check → config write → supervisor start → reconcile on `spawned` + API answering; `setEnabled(false)` stops it. The relay does not run with zero relay feeds.

- [ ] **Step 2: Run the whole suite** and fix every exact list it names; each is an addition in sorted position. `bespokePanelFor`: `if (descriptor.id === "video") return <VideoFeedsLinkPanel />` — a line of text and a link "Open Video feeds" to `/video-feeds`.
- [ ] **Step 3: The switch and status line** (`relay-status.tsx`), as the mockup's top of the Video feeds page: the switch calls `integrations:setEnabled` with `{ id: "video", enabled }`; beside it, before the first download, "Turning this on downloads MediaMTX v1.21.1, a 27 MB download and 55 MB on disk."; the status line per state — running: version, "Inputs RTMP <n> · SRT <n>", "Video to screens UDP <n>", "Change ports in Advanced"; downloading: a progress bar; failing: the reason, the next retry, and when the download failed, "Or place <asset name> at <path> by hand."
- [ ] **Step 4: Ports card** in Advanced (`video-relay-ports.tsx`): six `NumberInput`s grouped "On the network" (RTMP, SRT, Video to screens UDP) and "This machine only" (WebRTC signalling, HLS, relay API); `PATCH /api/video/ports` accepts only integers from 1024 to 65535, all six different, saves, and restarts the relay. A busy port shows in the relay's failing reason as "Port 1935 is in use by <holder>."
- [ ] **Step 5: Run to pass; commit** — `feat(video): the video relay as an integration, with its switch and ports`

### Task 16: Docs, the real drive, PR 2

- [ ] **Step 1: Docs**:
  - `docs/integrations/video-feeds.md`: the relay (downloaded on first use, pinned, where it lives, offline machines place the archive by hand); pull and push setup for the Ultra Stream's second output (RTSP server), OBS over WHIP with B-frames off (Settings, Output, Streaming: Profile baseline, or keyframe interval 1 s with B-frames 0), a Panasonic AW-UE160 pushing SRT, NDI sources through a converter as a push feed; the ports and the firewall (UDP 8189 must reach the server from the screens' network, and UDP 8890 / TCP 1935 from the encoders); Pi guidance (720p for Pi 4 screens); what B-frames are and why they delay a feed; the states, including Standby.
  - `docs/reference/api.md`: the push routes, `PATCH /api/video/ports`, the proxy routes.
  - `docs/ops/updates-and-logs.md` tag table: ``| `[video]` | Relay starts, exits and restarts, downloads and checksums, port conflicts, feeds going live or offline, B-frames: [Video feeds](../integrations/video-feeds.md) |``.
  - `docs/ops/network-traffic.md`: about 6 Mbps per screen per feed; pull feeds fetch only while watched; the status poll runs only while something watches.
- [ ] **Step 2: The gate**, read in-session.
- [ ] **Step 3: Drive it for real** on the 8799 sandbox (empty data dir): turn video on and watch the download and checksum on `/log`; add a push SRT feed and a push RTMP feed and a pull feed; publish with FFmpeg under `bash -c` (Baseline: `-bf 0`; B-frames: x264 defaults) to the paste-ready addresses; in a real browser play each: WebRTC under a second, the B-frame feed falling back to HLS with its badge and the page's B-frame hint; kill the FFmpeg and see Offline, restart it and see it recover; hide the widget (switch tabs) and see the relay's reader count drop on `/v3/paths/list`; `lsof -nP -p <relay pid> -i` shows exactly the six sockets from "What the real binary does"; kill the relay process by pid and watch it restart with backoff on `/log`. Stop the sandbox by port; confirm the relay child is gone.
- [ ] **Step 4: Pre-PR passes; push; open** — `feat(video): the video relay`. Body: what it does, the on-site checklist from the spec (it runs on the beta server after this merges), docs and logging answers, how it was driven, the deviations.

---

# PR 3 — health from the screens

Branch: `feat/video-health` off `origin/beta` once PR 2 has merged.

### Task 17: Playback stats and the heartbeat

**Files:**
- Create: `renderer/main/video/playback-stats.ts`, `playback-stats.test.ts`, `renderer/main/video/playback-reports.ts`
- Modify: `renderer/main/video/video-object.tsx`, `renderer/main/stage-view.tsx`

**Interfaces:**
- Produces:
  - `VideoPlaybackReport = { feedId: string; via: "webrtc" | "hls"; decoded: number; dropped: number; stalls: number; width: number; height: number }` (in `main/types/video.ts`; counts are deltas since the last report)
  - `registerPlayback(key: string, sample: () => VideoPlaybackReport | null): () => void`, `drainReports(): VideoPlaybackReport[]`, `anyPlaying(): boolean`
  - `VIDEO_HEARTBEAT_MS = 10_000`

- [ ] **Step 1: Stats.** WebRTC: `pc.getStats()` → the `inbound-rtp` video report's `framesDecoded`, `framesDropped`, `frameWidth`, `frameHeight`; stalls counted from the `<video>` element's `waiting` events. HLS: `video.getVideoPlaybackQuality()` `totalVideoFrames` and `droppedVideoFrames`, `video.videoWidth/Height`, `waiting` events. Each sampler keeps the last cumulative numbers and returns deltas. Test with fake stats objects: two samples give the difference; a counter that goes backwards (a new session) restarts from zero rather than going negative.
- [ ] **Step 2: Heartbeat.** In `stage-view.tsx`'s presence effect, add `video: drainReports()` to the body when non-empty, and use `VIDEO_HEARTBEAT_MS` as the interval while `anyPlaying()` (re-evaluate on each tick). Previews never heartbeat already; keep it that way.
- [ ] **Step 3: Commit** — `feat(video): screens report their video playback with the presence heartbeat`

### Task 18: The rolling window and the Screens warning

**Files:**
- Create: `main/services/video/playback-health.ts`, `playback-health.test.ts`
- Modify: `main/services/remote-server.ts` (presence handler), `main/types/video.ts` (`ScreenVideoHealth`, `VideoState.screens`), `main/services/video/video-service.ts`, `renderer/settings/sections/outputs-section.tsx`, `renderer/app/video-feeds/feed-list.tsx` ("On N screens")

**Interfaces:**
- Produces:
  - `WINDOW_MS = 60_000`, `DROPPED_FRACTION = 0.05`, `STALLS_IN_WINDOW = 3`, `CLEAR_AFTER_MS = 60_000`
  - `class PlaybackHealth { record(outputId: string, reports: VideoPlaybackReport[], now: number): boolean /* changed */; snapshot(now: number): ScreenVideoHealth[] }`
  - `ScreenVideoHealth = { outputId: string; feedId: string; via: "webrtc" | "hls"; struggling: boolean; droppedInWindow: number; decodedInWindow: number; stallsInWindow: number; width: number; height: number; reportedAt: number }`

- [ ] **Step 1: Failing tests**, each at the thresholds:
  - 1000 decoded and 50 dropped in the window: not struggling (5% is not more than 5%); 51 dropped: struggling.
  - 2 stalls: not; 3: struggling.
  - Once struggling, a clean report 30 s later keeps it struggling; clean reports until 60 s after the last bad sample clear it.
  - Samples older than 60 s leave the window.
  - A pair that stops reporting drops out of `snapshot` after `WINDOW_MS`.
  - Parsing: a report with a non-string `feedId`, a negative count or 500 entries is refused whole (the heartbeat still counts).
  Red proof: change `>` to `>=` on the fraction and watch the 50-dropped case fail.
- [ ] **Step 2: Implement; wire.** The presence POST parses `body.video` with the refusal rules above and calls `record`; when it returns `changed` (a struggling flag flipped, a pair appeared or left, or a struggling pair's totals moved) the service publishes `video:state` with `screens`. Log `[video] <screen name> is struggling with <feed name>: dropped <n> of <m> frames, <s> stalls in the last minute` and `[video] <screen name> is playing <feed name> smoothly again` on the flips only.
- [ ] **Step 3: The Screens card warning**, as the mockup's Home and Screens tab: "Struggling with {feed}. This screen dropped {n} frames in the last minute." plus, when the feed's height is over 720, "The feed is {w} × {h}; a Pi 4 plays 1280 × 720 smoothly. Lower the encoder's output to 720p." and, when stalls caused it, "It stalled {s} times; check this screen's network." The feed list's "On N screens" counts distinct `outputId`s in `screens` for the feed.
- [ ] **Step 4: Run to pass; commit** — `feat(video): mark a screen struggling with a feed and say what to change`

### Task 19: "Use HLS on this screen"

**Files:**
- Modify: `main/types/views.ts` (`Output.allowHls?: boolean`, absent = allowed), `main/services/routes/view-routes.ts` (PATCH `/api/outputs/:id`), `main/services/stage-controller.ts`, `renderer/settings/types.ts`, `renderer/settings/sections/outputs-section.tsx`, `renderer/main/video/video-object.tsx`

- [ ] **Step 1:** Follow `hideTopBar` through every file it touches (`grep -rn "hideTopBar" main renderer --include='*.ts' --include='*.tsx' | grep -v test`) and add `allowHls` beside it at each step, including the resolved output the display receives. Count the call sites and say the number in the commit.
- [ ] **Step 2:** The Screens card menu gains a switch "Use HLS on this screen", on by default, with the hint "Off, this screen plays only WebRTC. A feed that needs HLS says it can't play here."
- [ ] **Step 3:** The widget passes the display's `allowHls !== false` into `choosePlayback`. Test: a display whose output has `allowHls: false` shows "This screen can't play video" for a B-frame feed and makes no `index.m3u8` request. Red proof: hard-code `allowHls: true` and watch it fail.
- [ ] **Step 4: Commit** — `feat(video): a per-screen switch to keep a screen off HLS`

### Task 20: Docs pass, the real drive, PR 3

- [ ] **Step 1: Docs**: health from the screens and the thresholds in `docs/integrations/video-feeds.md`; the switch in the Screens docs; `docs/reference/api.md` presence body's `video` field; the log tag row now also names struggling screens.
- [ ] **Step 2: The gate; the drive** — on the sandbox, throttle the browser's CPU (`Emulation.setCPUThrottlingRate` rate 20 via CDP) while a 1080p feed plays, watch the Screens card warn within a minute and clear a minute after the throttle is lifted; turn the HLS switch off on the screen and see the B-frame feed say it can't play there.
- [ ] **Step 3: Pre-PR passes; push; open** — `feat(video): health from the screens`.

---

## Self-review against the spec

| Spec section | Where |
|---|---|
| Feeds: store, permanent id, four kinds, secrets, paste-ready address, delete names layouts | Tasks 1, 2, 3, 6, 14 |
| One adapter; reconcile / status / playback | Task 11 (`kickPublisher` added; a password change needs it) |
| Getting the binary: pin, first-use download, checksum, tar, hand-placed, runtime dir | Task 8 |
| Running it: child process, fresh config, backoff never gives up, reconcile after start | Tasks 9, 10, 15 |
| Configuration: API/HLS/WebRTC loopback, MoQ and every unused listener off by name, on-demand pull, per-feed publish password, overridePublisher false | Task 9 (exact-object test), Task 11 |
| Playback through Stage Utility; B-frames from the log; player backup at 5 s | Tasks 9, 12, 13, 5 |
| Status: polled only while watched; states; relay states; integration health | Tasks 12, 15 |
| The page, its own sidebar entry, Integrations link card, ports in Advanced | Tasks 6, 14, 15 |
| The widget: config, playback order, visibility, preview pause, retry, states, error boundary | Tasks 4, 5 |
| Health from the screens: stats, heartbeat, window, warning, per-screen switch | Tasks 17, 18, 19 |
| Docs, logging | Tasks 7, 16, 20 and each task's log lines |
| Tests, each proven red; the real drive | Every task's red proof; Tasks 7, 16, 20 |

Spec items this plan changes, with the reason (also corrected in the spec in this PR): the RTSP server is off (no push kind uses it); ports get a new Advanced card (there was no ports section); WHIP signalling goes through the proxy too (the relay's HTTP listener is loopback-only); a new password kicks the current publisher (auth changes apply without dropping sessions); `standby` for an unwatched pull feed; the heartbeat runs every 10 s while video plays (at 60 s the 60 s window would hold one sample).
