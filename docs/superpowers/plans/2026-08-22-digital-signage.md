# Digital Signage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn any enrolled display into a digital-signage screen — a media library, playlists, display groups, ordered schedules (weekly, date-range, one-off, PCO-derived), live per-group overrides, and displays that keep playing with no server and no network.

**Architecture:** Signage adds no display model. A signage screen is an existing `Output` routed to a `View` of the new kind `signage`; four new config stores hold media, playlists, groups and schedules. A pure resolver turns those plus PCO windows into a per-output **24-hour horizon**, pushed on one SSE channel and broadcast only on change. The display picks its current entry off its own clock, derives the playing item from cumulative durations (so every screen in a group stays in step), and advances at a boundary **only while connected**.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node's built-in test runner (`node --import tsx --test`), React 19 + TanStack Router, Tailwind v4 configured in CSS, `DataStore` for JSON persistence, existing SSE broadcaster. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-22-digital-signage-design.md`. Section references below (§3.1, §4.5 …) point at it. Read the relevant section before starting a task; this plan does not restate design rationale.

**Branch:** `feat/signage`, already created off `beta`. Every task commits to it. Do not push to `beta` or `main`, and do not open the PR until Task 24.

## Global Constraints

- **No emojis anywhere** — not in UI copy, code, comments, commit messages or PR text. No "Generated with Claude" footer.
- **Commit trailers**, on every commit:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L`
- **Public repository.** No credentials, church names, real service-type ids, LAN addresses or customer ids in code, tests, fixtures or docs. Test fixtures use invented names.
- **Never read or write `~/.stage-utility`.** Run every manual server against a copy via `STAGE_UTILITY_DATA=<copy>`.
- **Kill a test server by port, never `pkill -f`.** `lsof -ti tcp:8799 | xargs -r kill`.
- **Every guard is proven red in-session.** Write the test, run it, paste the failure, then implement. The commit message says it was proven red.
- **A new `catch` rethrows or returns the failure.** A `catch` that only logs is forbidden.
- **Time is app time.** Any "what day is it" or "is it 13:00 yet" goes through `main/services/app-timezone.ts`, never the host clock.
- **Every new config `DataStore` is `"config"` classified and imported in `main/services/stores.ts`** in the same commit, or it is silently missing from every backup.
- **Numeric inputs use the themed `NumberInput`** (`renderer/components/ui/`), never a raw `<input type="number">`.
- **No new npm dependencies.**
- Fixed values from the spec: image cap **12 MB**, video cap **200 MB**, transition duration range **0–3000 ms**, default transition **crossfade at 600 ms**, horizon length **24 hours**, PCO poll **30 minutes**, scheduler safety tick **60 s**, prefetch cap **1 GB**, `w`/`h` clamp **[1, 65535]**, `durationMs` clamp **[100, 86400000]**, mime allowlist **`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `video/mp4`, `video/webm`** (SVG deliberately excluded).

---

## File Structure

**New — types**

| File | Responsibility |
|---|---|
| `main/types/signage.ts` | Every signage type. Re-exported from `stage.ts`. |

**New — server**

| File | Responsibility |
|---|---|
| `main/services/signage-media-store.ts` | The media manifest `DataStore` plus file read/write/prune. |
| `main/services/signage-upload.ts` | Streaming upload to a temp file, hashing as it goes. No buffering. |
| `main/services/signage-playlists-store.ts` | Playlists `DataStore`. |
| `main/services/signage-groups-store.ts` | Groups `DataStore`. |
| `main/services/signage-schedules-store.ts` | Ordered schedules `DataStore`. |
| `main/services/signage-overrides-store.ts` | Overrides `DataStore`, classified `runtime`. |
| `main/services/signage-window.ts` | PURE. `windowActiveAt` / `nextBoundaryAfter`. |
| `main/services/signage-resolve.ts` | PURE. Stores + windows -> per-output horizon. |
| `main/services/signage-pco-windows.ts` | Polls PCO, caches windows, keeps last known on failure. |
| `main/services/signage-scheduler.ts` | Recompute triggers, diffing, broadcast. |
| `main/services/signage-integrity.ts` | PURE. What references what, for delete refusals. |
| `main/services/routes/signage-routes.ts` | Every `/api/signage/*` route plus `/signage-media/:file`. |

**New — renderer**

| File | Responsibility |
|---|---|
| `renderer/main/signage-cycle.ts` | PURE. Horizon + now -> which item, and how far into it. |
| `renderer/main/signage-player.tsx` | The player. Used by the view kind, the editor preview and the Now board. |
| `renderer/main/signage-transition.ts` | PURE. A transition kind + progress -> the two layers' inline styles. |
| `renderer/main/use-signage-plan.ts` | Subscribes to `signage:plan`, exposes this output's horizon plus connection state. |
| `renderer/main/signage-prefetch.ts` | Bounded asset prefetch for the current entry. |
| `renderer/app/signage/signage-route.tsx` | The tab shell and its five sections. |
| `renderer/app/signage/now-board.tsx` | Section: Now. |
| `renderer/app/signage/media-section.tsx` | Section: Media. |
| `renderer/app/signage/playlists-section.tsx` | Section: Playlists. |
| `renderer/app/signage/groups-section.tsx` | Section: Groups. |
| `renderer/app/signage/schedule-section.tsx` | Section: Schedule. |
| `renderer/app/signage/window-editor.tsx` | The per-`kind` window form. |
| `renderer/app/signage/use-signage-config.ts` | Fetch/mutate the four stores from the UI. |

**New — kiosk offline**

| File | Responsibility |
|---|---|
| `public/signage-sw.js` | Service worker: shell + asset precache. |
| `renderer/main/signage-offline.ts` | SW registration, `storage.persist()`, horizon persistence, cache reporting. |

**Modified**

| File | Change |
|---|---|
| `main/types/views.ts` | `ViewKind` gains `"signage"`. |
| `main/types/stage.ts` | Re-export `main/types/signage.ts`. |
| `main/services/stores.ts` | Import the five new stores. |
| `main/services/remote-server.ts` | `ROUTE_MODULES` gains `signageRoutes`; hello burst gains `signage:plan`. |
| `main/services/routes/context.ts` | `isDisplayKind` accepts `"signage"`. |
| `main/services/config-snapshot.ts` | `signage-media` with a per-file size filter and a skip report. |
| `main/services/stage-controller.ts` | Start the scheduler; recompute on views/outputs change. |
| `renderer/main/stage-view.tsx` | Render `kind === "signage"`. |
| `renderer/app/destinations.tsx` | The Signage tab. |
| `renderer/app/screens/screen-device.tsx` | Group chips on a signage screen. |
| `scripts/kiosk/install-linux.sh` | Secure-origin flag; last-known-server fallback. |
| `docs/reference/data-model.md` | Signage nouns. |
| `docs/features/signage.md` | New. |

---

## Phase 1 — Media

### Task 1: Signage types

**Files:**
- Create: `main/types/signage.ts`
- Modify: `main/types/stage.ts` (add the re-export beside the existing `views.js` one)
- Modify: `main/types/views.ts` (`ViewKind` union)
- Test: `main/types/signage.test.ts`

**Interfaces:**
- Produces: every type in spec §2.2 verbatim — `SignageFit`, `SignageTransitionKind`, `SignageDirection`, `SignageTransition`, `SignageMedia`, `SignagePlaylistItem`, `SignagePlaylist`, `SignageGroup`, `SignageWindow`, `SignageSchedule`, `SignageOverride`, `PcoWindow`, `WindowCtx`. Plus `SignageHorizonEntry` and `SignageHorizon` from §4.1, and the constants below.

- [ ] **Step 1: Write the failing test**

```ts
// main/types/signage.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  DEFAULT_TRANSITION,
  MAX_TRANSITION_MS,
  SIGNAGE_MIME_CAPS,
  isSignageMime,
} from "./signage.js";

describe("signage constants", () => {
  test("the default transition is crossfade at 600ms", () => {
    assert.deepEqual(DEFAULT_TRANSITION, { kind: "crossfade", ms: 600 });
  });

  test("transitions are capped at 3000ms", () => {
    assert.equal(MAX_TRANSITION_MS, 3000);
  });

  test("images cap at 12MB and video at 200MB", () => {
    assert.equal(SIGNAGE_MIME_CAPS["image/png"], 12 * 1024 * 1024);
    assert.equal(SIGNAGE_MIME_CAPS["video/mp4"], 200 * 1024 * 1024);
  });

  test("SVG is not an accepted signage mime", () => {
    // Deliberately unlike layout-image-store: an SVG can carry script, and a
    // media library is uploaded by more people and served from more URLs.
    assert.equal(isSignageMime("image/svg+xml"), false);
    assert.equal(isSignageMime("image/png"), true);
    assert.equal(isSignageMime("video/webm"), true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="signage constants"`
Expected: FAIL — cannot find module `./signage.js`.

- [ ] **Step 3: Write `main/types/signage.ts`**

Copy every interface from spec §2.2 and §4.1 verbatim, keeping the doc comments. Then add:

```ts
export const MAX_TRANSITION_MS = 3000;
export const DEFAULT_TRANSITION: SignageTransition = { kind: "crossfade", ms: 600 };

/** Per-mime upload ceiling. Membership in this map IS the allowlist — there is no
 *  second list to drift from it. SVG is absent on purpose: it can carry script,
 *  and unlike a layout image this is served from a directory anyone with LAN
 *  access can enumerate. */
export const SIGNAGE_MIME_CAPS: Record<string, number> = {
  "image/png": 12 * 1024 * 1024,
  "image/jpeg": 12 * 1024 * 1024,
  "image/webp": 12 * 1024 * 1024,
  "image/gif": 12 * 1024 * 1024,
  "video/mp4": 200 * 1024 * 1024,
  "video/webm": 200 * 1024 * 1024,
};

export const SIGNAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function isSignageMime(m: string): boolean {
  return Object.hasOwn(SIGNAGE_MIME_CAPS, m);
}

export function isSignageVideo(m: string): boolean {
  return m.startsWith("video/");
}

/** Clamps for client-measured values. Out of range is REJECTED, never defaulted:
 *  a zero duration would make a playlist's cycle length unusable. */
export const MAX_MEDIA_DIMENSION = 65535;
export const MIN_ITEM_MS = 100;
export const MAX_ITEM_MS = 86_400_000;
```

- [ ] **Step 4: Add `"signage"` to `ViewKind`**

In `main/types/views.ts`, extend the union:

```ts
export type ViewKind =
  | "slots"
  | "dashboard"
  | "stage"
  | "transcription"
  | "custom"
  | "script"
  | "spl-rundown"
  | "signage";
```

Then in `main/types/stage.ts`, add `export * from "./signage.js";` beside the existing `export * from "./views.js";`.

- [ ] **Step 5: Run the test and the type checker**

Run: `npm test -- --test-name-pattern="signage constants" && npm run type-check`
Expected: tests PASS. `type-check` will now report every `switch` on `ViewKind` that does not handle `"signage"` — that is the point of adding it first. Note the list; Task 9 handles the renderer, and any server-side switch is handled here by adding a `"signage"` arm that behaves like `"custom"` (no slots, no ScriptView columns).

- [ ] **Step 6: Commit**

```bash
git add main/types/signage.ts main/types/signage.test.ts main/types/views.ts main/types/stage.ts
git commit -m "feat(signage): types, mime allowlist and the signage view kind

SVG is excluded from the media allowlist unlike layout images: it can carry
script and this directory is served from more URLs. Proven red first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 2: Media store — manifest, files, dedupe, prune

**Files:**
- Create: `main/services/signage-media-store.ts`
- Modify: `main/services/stores.ts`
- Test: `main/services/signage-media-store.test.ts`

**Interfaces:**
- Consumes: `SignageMedia`, `SIGNAGE_MIME_CAPS`, `SIGNAGE_EXT_BY_MIME`, `isSignageMime`, `MAX_MEDIA_DIMENSION`, `MIN_ITEM_MS`, `MAX_ITEM_MS` from Task 1.
- Produces:
  - `signageMediaStore: DataStore<SignageMedia[]>` (filename `signage-media.json`, default `[]`, class `"config"`)
  - `SIGNAGE_MEDIA_DIR = "signage-media"`
  - `addMedia(o: { file: string; name: string; mime: string; bytes: number; w: number; h: number; durationMs?: number }): Promise<{ media: SignageMedia; deduped: boolean }>`
  - `listMedia(): Promise<SignageMedia[]>`
  - `renameMedia(id: string, name: string): Promise<SignageMedia | null>`
  - `deleteMedia(id: string): Promise<SignageMedia | null>`
  - `readMediaFile(file: string): Promise<{ data: Buffer; mime: string } | null>`
  - `mediaFilePath(file: string): string`
  - `pruneSignageMedia(): Promise<number>`
  - `clampMeasured(o: { w: unknown; h: unknown; durationMs?: unknown; mime: string }): { w: number; h: number; durationMs?: number }` — throws on out-of-range.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-media-store.test.ts
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

let dir: string;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-signage-"));
  process.env.STAGE_UTILITY_DATA = dir;
});
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const { addMedia, listMedia, clampMeasured } = await import("./signage-media-store.js");

describe("clamping what the browser measured", () => {
  test("keeps sane values", () => {
    assert.deepEqual(
      clampMeasured({ w: 1920, h: 1080, mime: "image/png" }),
      { w: 1920, h: 1080 },
    );
  });

  test("REJECTS a zero duration rather than defaulting it", () => {
    // A zero would make the playlist cycle length unusable, and a default would
    // hide that the measurement failed.
    assert.throws(
      () => clampMeasured({ w: 1920, h: 1080, durationMs: 0, mime: "video/mp4" }),
      /duration/i,
    );
  });

  test("rejects an absurd dimension", () => {
    assert.throws(() => clampMeasured({ w: 999999, h: 1080, mime: "image/png" }), /dimension/i);
  });

  test("a video without a measured duration is rejected", () => {
    assert.throws(() => clampMeasured({ w: 1920, h: 1080, mime: "video/mp4" }), /duration/i);
  });
});

describe("adding media", () => {
  test("identical bytes collapse to ONE record, not two", async () => {
    const a = await addMedia({
      file: "aaaaaaaaaaaaaaaa.png", name: "welcome.png",
      mime: "image/png", bytes: 100, w: 1920, h: 1080,
    });
    const b = await addMedia({
      file: "aaaaaaaaaaaaaaaa.png", name: "welcome-copy.png",
      mime: "image/png", bytes: 100, w: 1920, h: 1080,
    });
    assert.equal(a.deduped, false);
    assert.equal(b.deduped, true, "a second upload of the same bytes made a duplicate record");
    assert.equal(b.media.id, a.media.id);
    assert.equal((await listMedia()).length, 1);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="clamping what the browser measured|adding media"`
Expected: FAIL — cannot find module `./signage-media-store.js`.

- [ ] **Step 3: Implement the store**

Model the file layer on `main/services/layout-image-store.ts` — read it first. Key points:

```ts
export const SIGNAGE_MEDIA_DIR = "signage-media";

export const signageMediaStore = new DataStore<SignageMedia[]>(
  "signage-media.json",
  [],
  "config",
);

function dir(): string {
  return path.join(getUserDataPath(), SIGNAGE_MEDIA_DIR);
}

/** `<sha256-16>.<ext>` only. Rejects traversal and anything we did not write. */
function isMediaName(file: string): boolean {
  return /^[0-9a-f]{16}\.(png|jpg|webp|gif|mp4|webm)$/.test(file);
}

export function clampMeasured(o: {
  w: unknown; h: unknown; durationMs?: unknown; mime: string;
}): { w: number; h: number; durationMs?: number } {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const w = Math.round(num(o.w));
  const h = Math.round(num(o.h));
  if (!(w >= 1 && w <= MAX_MEDIA_DIMENSION) || !(h >= 1 && h <= MAX_MEDIA_DIMENSION)) {
    throw new Error(`dimension out of range: ${o.w}x${o.h}`);
  }
  if (!isSignageVideo(o.mime)) return { w, h };
  const d = Math.round(num(o.durationMs));
  if (!(d >= MIN_ITEM_MS && d <= MAX_ITEM_MS)) {
    throw new Error(`duration out of range for a video: ${String(o.durationMs)}`);
  }
  return { w, h, durationMs: d };
}
```

`addMedia` looks up an existing record by `file` first and returns `{ media: existing, deduped: true }` when found — the file is content-addressed, so identical bytes are identical content and a second record would be a lie. `deleteMedia` removes the record only; the file goes on the next prune, so a delete-then-undo does not lose bytes.

`readMediaFile` returns `null` unless `isMediaName(file)`.

`pruneSignageMedia` mirrors `pruneLayoutImages`: collect referenced `file` values from `signagePlaylistsStore` (Task 4 — until then, from the media store's own records so nothing is reaped), keep anything newer than a 6-hour grace window, and **return 0 without deleting** if any store read throws. Never risk deleting a referenced file because a read failed.

- [ ] **Step 4: Register the store**

Add `import "./signage-media-store.js";` to `main/services/stores.ts` in alphabetical position.

- [ ] **Step 5: Run the tests**

Run: `npm test -- --test-name-pattern="clamping what the browser measured|adding media|store registry"`
Expected: PASS, including the existing store-registry test now seeing the new config store.

- [ ] **Step 6: Commit**

```bash
git add main/services/signage-media-store.ts main/services/signage-media-store.test.ts main/services/stores.ts
git commit -m "feat(signage): media manifest, content-addressed files, dedupe

Measured dimensions and durations are rejected out of range rather than
defaulted - a zero duration would make a playlist cycle unusable. Dedupe and
rejection tests proven red first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 3: Streaming upload

**Files:**
- Create: `main/services/signage-upload.ts`
- Test: `main/services/signage-upload.test.ts`

**Why this is its own module:** `readRawBody` in `routes/context.ts` accumulates chunks and then `Buffer.concat`s them, so peak memory is roughly twice the body — its own comment says a body past 128 MB "wants streaming to a temp file, not a bigger number". A 200 MB video is exactly that case. Do not raise `MAX_UPLOAD_BODY_BYTES`.

**Interfaces:**
- Consumes: `SIGNAGE_MIME_CAPS`, `SIGNAGE_EXT_BY_MIME`, `isSignageMime` from Task 1; `mediaFilePath`, `SIGNAGE_MEDIA_DIR` from Task 2.
- Produces: `streamUploadToMedia(req: Readable, mime: string): Promise<{ file: string; bytes: number; existed: boolean }>` and `class UploadTooLargeError extends Error { readonly status = 413 }`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-upload.test.ts
import { strict as assert } from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";

let dir: string;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "su-upload-"));
  process.env.STAGE_UTILITY_DATA = dir;
});
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const { streamUploadToMedia, UploadTooLargeError } = await import("./signage-upload.js");

function body(bytes: Buffer, chunk = 64 * 1024): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  return Readable.from(parts.length ? parts : [Buffer.alloc(0)]);
}

describe("streaming an upload", () => {
  test("names the file after its own bytes", async () => {
    const bytes = Buffer.from("pretend png");
    const r = await streamUploadToMedia(body(bytes), "image/png");
    const want = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    assert.equal(r.file, `${want}.png`);
    assert.equal(r.bytes, bytes.length);
    assert.equal(r.existed, false);
    assert.deepEqual(await fs.readFile(path.join(dir, "signage-media", r.file)), bytes);
  });

  test("the same bytes twice writes once", async () => {
    const bytes = Buffer.from("pretend png");
    const r = await streamUploadToMedia(body(bytes), "image/png");
    assert.equal(r.existed, true);
  });

  test("stops at the per-mime cap INSTEAD OF buffering the whole body", async () => {
    // The regression this guards: raising a constant and using readRawBody would
    // hold ~400MB for a 200MB video on a Pi. The cap must bite mid-stream.
    const big = Buffer.alloc(13 * 1024 * 1024, 7);   // over the 12MB image cap
    await assert.rejects(() => streamUploadToMedia(body(big), "image/png"), UploadTooLargeError);
  });

  test("leaves no temp file behind when it refuses", async () => {
    const big = Buffer.alloc(13 * 1024 * 1024, 7);
    await streamUploadToMedia(body(big), "image/png").catch(() => {});
    const files = await fs.readdir(path.join(dir, "signage-media")).catch(() => []);
    assert.equal(files.filter((f) => f.includes(".tmp")).length, 0, "an aborted upload left a temp file");
  });

  test("refuses a mime that is not on the allowlist", async () => {
    await assert.rejects(
      () => streamUploadToMedia(body(Buffer.from("<svg/>")), "image/svg+xml"),
      /not accepted/i,
    );
  });

  test("refuses an empty body", async () => {
    await assert.rejects(() => streamUploadToMedia(body(Buffer.alloc(0)), "image/png"), /empty/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="streaming an upload"`
Expected: FAIL — cannot find module `./signage-upload.js`.

- [ ] **Step 3: Implement**

```ts
// signage-upload.ts
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";

import { SIGNAGE_EXT_BY_MIME, SIGNAGE_MIME_CAPS, isSignageMime } from "../types/signage.js";
import { getUserDataPath } from "./app-paths.js";
import { SIGNAGE_MEDIA_DIR } from "./signage-media-store.js";

export class UploadTooLargeError extends Error {
  readonly status = 413;
  constructor(limit: number) {
    super(`Upload exceeds ${Math.round(limit / (1024 * 1024))} MB`);
    this.name = "UploadTooLargeError";
  }
}

/**
 * Stream a request body straight to disk, hashing as it goes.
 *
 * Never holds the body in memory: a 200 MB video read through readRawBody would
 * peak at roughly twice that during Buffer.concat, which is above what a Pi
 * survives. The name is the hash of what actually arrived, so it cannot
 * disagree with its contents.
 */
export async function streamUploadToMedia(
  req: Readable,
  mime: string,
): Promise<{ file: string; bytes: number; existed: boolean }> {
  if (!isSignageMime(mime)) throw new Error(`${mime} is not accepted`);
  const limit = SIGNAGE_MIME_CAPS[mime];
  const ext = SIGNAGE_EXT_BY_MIME[mime];

  const dir = path.join(getUserDataPath(), SIGNAGE_MEDIA_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `upload-${crypto.randomBytes(8).toString("hex")}.tmp`);

  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const out = fs.createWriteStream(tmp);

  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.byteLength;
      // Checked as it arrives, not against content-length: that is the sender's
      // claim, and a chunked request does not send one at all.
      if (bytes > limit) throw new UploadTooLargeError(limit);
      hash.update(buf);
      if (!out.write(buf)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
    if (bytes === 0) throw new Error("empty upload");

    const file = `${hash.digest("hex").slice(0, 16)}.${ext}`;
    const dest = path.join(dir, file);
    try {
      // wx: same hash means same bytes, so there is nothing to write and nothing
      // to overwrite. link+unlink rather than rename, so an existing file is
      // never clobbered by a concurrent upload of the same content.
      await fsp.link(tmp, dest);
      return { file, bytes, existed: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return { file, bytes, existed: true };
    }
  } finally {
    out.destroy();
    // The temp file is removed on every path, including the 413 — an aborted
    // upload must not leave a 200 MB orphan on an SD card.
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern="streaming an upload"`
Expected: PASS, all six.

- [ ] **Step 5: Prove the cap actually streams**

Add a temporary `console.log(process.memoryUsage().heapUsed)` inside the chunk loop, run the over-cap test, and confirm heap does not grow with the body. Remove the log. Note the observation in the commit message.

- [ ] **Step 6: Commit**

```bash
git add main/services/signage-upload.ts main/services/signage-upload.test.ts
git commit -m "feat(signage): stream uploads to disk instead of buffering them

readRawBody concats the whole body, peaking at twice its size - past what a Pi
survives for a 200MB video, and its own comment says so. This hashes as it
streams and removes the temp file on every path including the 413. Cap and
orphan-temp tests proven red; heap confirmed flat across an over-cap upload.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 4: Playlists, groups, schedules and overrides stores

**Files:**
- Create: `main/services/signage-playlists-store.ts`, `signage-groups-store.ts`, `signage-schedules-store.ts`, `signage-overrides-store.ts`
- Modify: `main/services/stores.ts`, `main/services/signage-media-store.ts` (prune now reads playlists)
- Test: `main/services/signage-stores.test.ts`

**Interfaces:**
- Produces: `signagePlaylistsStore`, `signageGroupsStore`, `signageSchedulesStore` (all `DataStore<T[]>`, class `"config"`), `signageOverridesStore` (`DataStore<SignageOverride[]>`, class **`"runtime"`**), plus `reorderSchedules(ids: string[]): Promise<SignageSchedule[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-stores.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { allStores } from "./stores.js";

describe("how signage stores are classified", () => {
  const find = (f: string) => allStores().find((s) => s.filename === f);

  test("media, playlists, groups and schedules are the operator's work", () => {
    for (const f of [
      "signage-media.json",
      "signage-playlists.json",
      "signage-groups.json",
      "signage-schedules.json",
    ]) {
      assert.equal(find(f)?.classification, "config", `${f} is not backed up`);
    }
  });

  test("overrides are runtime, so a stale backup cannot re-announce", () => {
    // An override must survive a restart, but restoring a two-week-old snapshot
    // must never put a forgotten announcement back on a wall.
    assert.equal(find("signage-overrides.json")?.classification, "runtime");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="how signage stores are classified"`
Expected: FAIL — every `find(...)` returns `undefined`.

- [ ] **Step 3: Create the four stores**

Each is a small module. Example:

```ts
// signage-playlists-store.ts
import type { SignagePlaylist } from "../types/signage.js";
import { DataStore } from "./data-store.js";

export const signagePlaylistsStore = new DataStore<SignagePlaylist[]>(
  "signage-playlists.json",
  [],
  "config",
);
```

`signage-overrides-store.ts` is identical in shape but classified `"runtime"`, with a comment saying why (spec §2.1).

`reorderSchedules` lives in `signage-schedules-store.ts`: it reorders the stored array to match `ids`, appending any schedule whose id was not listed so a concurrent create cannot be dropped by a stale reorder.

- [ ] **Step 4: Register them and point prune at playlists**

Add all four imports to `main/services/stores.ts`. In `signage-media-store.ts`, change `pruneSignageMedia` to collect referenced `file` names by joining `signagePlaylistsStore.load()` against the media manifest.

- [ ] **Step 5: Run the tests**

Run: `npm test -- --test-name-pattern="how signage stores are classified|store registry|config snapshot"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add main/services/signage-playlists-store.ts main/services/signage-groups-store.ts main/services/signage-schedules-store.ts main/services/signage-overrides-store.ts main/services/signage-stores.test.ts main/services/stores.ts main/services/signage-media-store.ts
git commit -m "feat(signage): playlist, group, schedule and override stores

Overrides are runtime so a stale snapshot cannot re-announce something; the
other four are config. Classification test proven red first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 5: Media routes and static serving

**Files:**
- Create: `main/services/routes/signage-routes.ts`
- Modify: `main/services/remote-server.ts` (`ROUTE_MODULES`)
- Test: `main/services/routes/signage-routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: `signageRoutes: RouteModule` handling `GET/POST /api/signage/media`, `PATCH/DELETE /api/signage/media/:id`, `GET /signage-media/:file`.

- [ ] **Step 1: Write the failing test**

Use the existing `main/services/routes/route-harness.ts` — read it first.

```ts
// main/services/routes/signage-routes.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { callRoute } from "./route-harness.js";
import { signageRoutes } from "./signage-routes.js";

describe("serving signage media", () => {
  test("refuses a name we did not write", async () => {
    // Path traversal, and anything that is not our content-addressed name.
    for (const bad of ["../settings.json", "..%2Fsettings.json", "welcome.png", "abc.png"]) {
      const r = await callRoute(signageRoutes, "GET", `/signage-media/${bad}`);
      assert.equal(r.status, 404, `${bad} was served`);
    }
  });

  test("a served file cannot execute in the app's origin", async () => {
    // Belt and braces beside the SVG exclusion: whatever the bytes turn out to
    // be, a file opened directly is inert.
    const r = await callRoute(signageRoutes, "GET", "/signage-media/0123456789abcdef.png");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(r.headers["content-security-policy"]), /sandbox/);
  });
});

describe("uploading media", () => {
  test("rejects a mime that is not on the allowlist", async () => {
    const r = await callRoute(signageRoutes, "POST", "/api/signage/media", {
      headers: { "content-type": "image/svg+xml", "x-signage-name": "logo.svg" },
      body: Buffer.from("<svg/>"),
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /not accepted/i);
  });

  test("rejects measurements it cannot trust rather than defaulting them", async () => {
    const r = await callRoute(signageRoutes, "POST", "/api/signage/media", {
      headers: {
        "content-type": "video/mp4",
        "x-signage-name": "clip.mp4",
        "x-signage-w": "1920",
        "x-signage-h": "1080",
      },
      body: Buffer.from("fake mp4"),
    });
    assert.equal(r.status, 400, "a video with no measured duration was accepted");
    assert.match(r.json.error, /duration/i);
  });
});
```

If `route-harness.ts` cannot express a raw body or custom headers, extend it — it is a test helper and other route tests benefit.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="serving signage media|uploading media"`
Expected: FAIL — cannot find module `./signage-routes.js`.

- [ ] **Step 3: Implement the media routes**

Upload metadata rides in headers, not the body, because the body is the file:
`X-Signage-Name`, `X-Signage-W`, `X-Signage-H`, `X-Signage-Duration-Ms`. The handler calls `streamUploadToMedia(c.req, mime)`, then `clampMeasured(...)`, then `addMedia(...)`, and answers `{ media, deduped }`.

The name header is operator text. Sanitise it to a display name — strip control characters, cap at 200 characters — before storing. It is never used as a path.

Static serving:

```ts
res.writeHead(200, {
  "Content-Type": mime,
  "Content-Length": String(data.length),
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
});
```

`Cache-Control: immutable` is safe precisely because the name is the hash: the bytes at a name can never change.

- [ ] **Step 4: Register the module**

In `main/services/remote-server.ts`, import `signageRoutes` and add it to `ROUTE_MODULES` after `viewRoutes`.

- [ ] **Step 5: Run the tests**

Run: `npm test -- --test-name-pattern="serving signage media|uploading media|route coverage"`
Expected: PASS, including the existing route-coverage test.

- [ ] **Step 6: Drive it against a real server**

```bash
rm -rf /tmp/su-signage-dev && cp -r ~/.stage-utility /tmp/su-signage-dev
STAGE_UTILITY_DATA=/tmp/su-signage-dev STAGE_UTILITY_PORT=8799 npm run server &
sleep 4
curl -s -X POST http://127.0.0.1:8799/api/signage/media \
  -H 'Content-Type: image/png' -H 'X-Signage-Name: test.png' \
  -H 'X-Signage-W: 8' -H 'X-Signage-H: 8' \
  --data-binary @public/favicon.png | tee /tmp/up.json
curl -s -o /dev/null -D - "http://127.0.0.1:8799/signage-media/$(python3 -c "import json;print(json.load(open('/tmp/up.json'))['media']['file'])")"
lsof -ti tcp:8799 | xargs -r kill
```

Expected: a 200 with the three headers, and the same file returned on a second upload with `"deduped": true`. Paste the output into the commit.

- [ ] **Step 7: Commit**

```bash
git add main/services/routes/signage-routes.ts main/services/routes/signage-routes.test.ts main/services/remote-server.ts
git commit -m "feat(signage): media upload and immutable static serving

Traversal, mime and untrusted-measurement tests proven red. Media is served
nosniff under a sandbox CSP so a file opened directly is inert whatever its
bytes; verified against a real server on 8799.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 6: The Signage tab shell and the Media section

**Files:**
- Create: `renderer/app/signage/signage-route.tsx`, `media-section.tsx`, `use-signage-config.ts`
- Modify: `renderer/app/destinations.tsx`
- Test: `renderer/app/signage/media-upload.test.ts`

**Interfaces:**
- Produces: `SignageRoute` (default tab component), `useSignageConfig()` returning `{ media, playlists, groups, schedules, reload, ... }`, and `measureFile(file: File): Promise<{ w: number; h: number; durationMs?: number }>`.

- [ ] **Step 1: Write the failing test for the measurement helper**

```ts
// renderer/app/signage/media-upload.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { uploadHeadersFor } from "./use-signage-config.js";

describe("what an upload tells the server", () => {
  test("sends the measured size, and the duration only for video", () => {
    assert.deepEqual(
      uploadHeadersFor({ name: "welcome.png", mime: "image/png", w: 1920, h: 1080 }),
      {
        "Content-Type": "image/png",
        "X-Signage-Name": "welcome.png",
        "X-Signage-W": "1920",
        "X-Signage-H": "1080",
      },
    );
    assert.equal(
      uploadHeadersFor({ name: "c.mp4", mime: "video/mp4", w: 1920, h: 1080, durationMs: 42000 })[
        "X-Signage-Duration-Ms"
      ],
      "42000",
    );
  });

  test("a name with a newline cannot forge a header", () => {
    // Operator text going into a header value. A CRLF here would inject one.
    const h = uploadHeadersFor({
      name: "ok.png\r\nX-Evil: 1", mime: "image/png", w: 8, h: 8,
    });
    assert.ok(!/[\r\n]/.test(h["X-Signage-Name"]), "a newline survived into a header value");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="what an upload tells the server"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `use-signage-config.ts`**

`uploadHeadersFor` strips `[\r\n]` and control characters from the name and caps it at 200 characters. `measureFile` uses `Image` for images and a hidden `HTMLVideoElement` (`preload="metadata"`) for video, resolving `{ w, h, durationMs }`, and **rejects** rather than resolving defaults when metadata never arrives — the server would reject it anyway and a silent default is how a bad duration reaches a wall.

`useSignageConfig()` fetches the four lists through the existing `invoke`/`api` helper in `renderer/lib/api.ts`.

- [ ] **Step 4: Build the tab shell and Media section**

`signage-route.tsx` renders five sections; use the existing tab/segmented control from `renderer/components/ui/`. Media section: thumbnail grid, drag-and-drop upload with per-file progress, rename, delete, and a size/dimension line per item. Video tiles show duration. Follow `STYLE_GUIDE.md` — Plex Sans for UI, Plex Mono for numerals, `su-card` material, semantic tokens only.

Add to `renderer/app/destinations.tsx`:

```tsx
{
  path: "/signage",
  label: "Signage",
  Component: SignageRoute,
  icon: <MonitorPlayIcon className="size-4" />,
},
```

and add `"/signage"` to the `Screens` entry in `NAV_GROUPS`.

- [ ] **Step 5: Run the suite and the type checker**

Run: `npm test && npm run lint && npm run type-check`
Expected: all green, including the existing route/destination parity tests.

- [ ] **Step 6: Drive it in a browser**

Start the 8799 server as in Task 5, open `/signage`, drag in a real PNG and a real MP4. Confirm both appear with correct dimensions and the video's duration, that a duplicate says so instead of adding a second tile, and that delete removes it. Note what you observed in the commit.

- [ ] **Step 7: Commit**

```bash
git add renderer/app/signage renderer/app/destinations.tsx
git commit -m "feat(signage): Signage tab and the media library

Header injection through an operator-supplied filename proven red first.
Measurement failure rejects rather than defaulting. Uploaded a real PNG and MP4
against 8799 and confirmed dedupe and delete.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 2 — Playlists and the player

### Task 7: Cycle math

**Files:**
- Create: `renderer/main/signage-cycle.ts`
- Test: `renderer/main/signage-cycle.test.ts`

**Interfaces:**
- Produces:
  - `cycleMs(items: { durationMs: number }[]): number`
  - `itemAt(items, elapsedMs): { index: number; offsetMs: number } | null`
  - `entryAt(h: SignageHorizon, nowMs: number): SignageHorizonEntry | null`

- [ ] **Step 1: Write the failing test**

```ts
// renderer/main/signage-cycle.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { cycleMs, itemAt, entryAt } from "./signage-cycle.js";

const ITEMS = [{ durationMs: 8000 }, { durationMs: 8000 }, { durationMs: 12000 }];

describe("where a playlist is in its cycle", () => {
  test("the cycle is the plain sum of durations", () => {
    // Load-bearing: transitions consume the head of an item's own slot, so they
    // must NOT lengthen the cycle or two screens in a group drift apart.
    assert.equal(cycleMs(ITEMS), 28000);
  });

  test("the same elapsed time gives the same answer every time", () => {
    assert.deepEqual(itemAt(ITEMS, 0), { index: 0, offsetMs: 0 });
    assert.deepEqual(itemAt(ITEMS, 9000), { index: 1, offsetMs: 1000 });
    assert.deepEqual(itemAt(ITEMS, 20000), { index: 2, offsetMs: 4000 });
  });

  test("it wraps, and keeps wrapping days later", () => {
    assert.deepEqual(itemAt(ITEMS, 28000), { index: 0, offsetMs: 0 });
    assert.deepEqual(itemAt(ITEMS, 28000 * 1000 + 9000), { index: 1, offsetMs: 1000 });
  });

  test("a single item is a static graphic", () => {
    assert.deepEqual(itemAt([{ durationMs: 8000 }], 100000), { index: 0, offsetMs: 4000 });
  });

  test("an empty playlist yields null rather than dividing by zero", () => {
    // This crashed a wall screen before the resolver learned to fall through.
    assert.equal(cycleMs([]), 0);
    assert.equal(itemAt([], 5000), null);
  });

  test("a negative elapsed time still lands inside the cycle", () => {
    // A display whose clock is behind the horizon's startedAt.
    const r = itemAt(ITEMS, -1000);
    assert.ok(r && r.index >= 0 && r.index < 3, "a clock behind startedAt fell outside the cycle");
  });
});

describe("which horizon entry is current", () => {
  const H = [
    { from: 100, until: 200, reason: "schedule", reasonLabel: "A" },
    { from: 200, until: 300, reason: "blank", reasonLabel: "" },
  ] as never;

  test("boundaries are half-open, so no instant belongs to two entries", () => {
    assert.equal(entryAt(H, 199)?.reasonLabel, "A");
    assert.equal(entryAt(H, 200)?.reason, "blank");
  });

  test("outside the horizon is null, not the nearest entry", () => {
    assert.equal(entryAt(H, 99), null);
    assert.equal(entryAt(H, 300), null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="where a playlist is in its cycle|which horizon entry"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
export function cycleMs(items: { durationMs: number }[]): number {
  let t = 0;
  for (const i of items) t += Math.max(0, i.durationMs);
  return t;
}

export function itemAt(
  items: { durationMs: number }[],
  elapsedMs: number,
): { index: number; offsetMs: number } | null {
  const total = cycleMs(items);
  if (total <= 0) return null;
  // Double modulo: a display whose clock sits behind startedAt would otherwise
  // land on a negative position and fall out of the walk below.
  let pos = ((elapsedMs % total) + total) % total;
  for (let i = 0; i < items.length; i++) {
    const d = Math.max(0, items[i].durationMs);
    if (pos < d) return { index: i, offsetMs: pos };
    pos -= d;
  }
  return { index: items.length - 1, offsetMs: 0 };
}

export function entryAt(h: SignageHorizon, nowMs: number): SignageHorizonEntry | null {
  for (const e of h) if (nowMs >= e.from && nowMs < e.until) return e;
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- --test-name-pattern="where a playlist is in its cycle|which horizon entry"`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
git add renderer/main/signage-cycle.ts renderer/main/signage-cycle.test.ts
git commit -m "feat(signage): cycle and horizon-entry math

Every display in a group derives its position from the same arithmetic, so they
stay in step with no extra traffic. Empty playlist, wrap and behind-the-clock
cases proven red first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 8: Transitions and the player

**Files:**
- Create: `renderer/main/signage-transition.ts`, `renderer/main/signage-player.tsx`
- Test: `renderer/main/signage-transition.test.ts`, `renderer/main/signage-player.test.tsx`

**Interfaces:**
- Consumes: `itemAt`, `cycleMs` from Task 7; `SignageTransition`, `DEFAULT_TRANSITION` from Task 1.
- Produces:
  - `layerStyles(t: SignageTransition, progress: number): { incoming: CSSProperties; outgoing: CSSProperties; veilOpacity: number }` — `progress` is 0 to 1 through the transition.
  - `<SignagePlayer entry={SignageHorizonEntry | null} nowMs={number} />`

- [ ] **Step 1: Write the failing test**

```ts
// renderer/main/signage-transition.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { layerStyles } from "./signage-transition.js";

const props = (s: Record<string, unknown>) => Object.keys(s).filter((k) => k !== "willChange");

describe("what a transition animates", () => {
  test("ONLY opacity and transform, so the compositor does the work", () => {
    // A Pi 4 repainting a clip-path every frame looks worse than a cut. This is
    // the guard on that: any other animated property is the regression.
    for (const kind of ["crossfade", "fade-through-black", "slide", "wipe"] as const) {
      const s = layerStyles({ kind, ms: 600, direction: "right" }, 0.5);
      for (const side of [s.incoming, s.outgoing]) {
        for (const p of props(side)) {
          assert.ok(
            p === "opacity" || p === "transform",
            `${kind} animates ${p}, which is not compositor-only`,
          );
        }
      }
    }
  });

  test("a cut is instantaneous at any progress", () => {
    assert.equal(layerStyles({ kind: "cut", ms: 0 }, 0.5).incoming.opacity, 1);
    assert.equal(layerStyles({ kind: "cut", ms: 0 }, 0.5).outgoing.opacity, 0);
  });

  test("crossfade takes the incoming up while the outgoing comes down", () => {
    const s = layerStyles({ kind: "crossfade", ms: 600 }, 0.25);
    assert.equal(s.incoming.opacity, 0.25);
    assert.equal(s.outgoing.opacity, 0.75);
  });

  test("fade through black is fully dark at the midpoint", () => {
    // The thing that distinguishes it from a crossfade. If the veil never
    // reaches 1 it IS a crossfade with extra steps.
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 0.5).veilOpacity, 1);
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 0).veilOpacity, 0);
    assert.equal(layerStyles({ kind: "fade-through-black", ms: 600 }, 1).veilOpacity, 0);
  });

  test("slide moves both layers; wipe moves only the incoming one", () => {
    const slide = layerStyles({ kind: "slide", ms: 600, direction: "right" }, 0.5);
    const wipe = layerStyles({ kind: "wipe", ms: 600, direction: "right" }, 0.5);
    assert.notEqual(slide.outgoing.transform, "none");
    assert.equal(wipe.outgoing.transform ?? "none", "none", "wipe moved the outgoing layer");
    assert.notEqual(wipe.incoming.transform, "none");
  });

  test("direction actually reverses the movement", () => {
    const l = layerStyles({ kind: "slide", ms: 600, direction: "left" }, 0.5).incoming.transform;
    const r = layerStyles({ kind: "slide", ms: 600, direction: "right" }, 0.5).incoming.transform;
    assert.notEqual(l, r);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="what a transition animates"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `signage-transition.ts`**

Pure. `progress` is clamped to `[0, 1]`. `wipe` translates the incoming layer only; `slide` translates both in opposite directions. Neither writes `clipPath`, `filter`, `width`, `height`, `left` or `top`.

- [ ] **Step 4: Write the player test**

```tsx
// renderer/main/signage-player.test.tsx
import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

import { installDom } from "../test-dom.js";
const teardown = installDom();
const { render, cleanup } = await import("@testing-library/react");
const React = await import("react");
const { SignagePlayer } = await import("./signage-player.js");
after(() => { cleanup(); teardown(); });

const ENTRY = {
  from: 0, until: 1e12, reason: "schedule", reasonLabel: "Weekend",
  playlist: {
    id: "p1", startedAt: 0, fit: "contain",
    transition: { kind: "cut", ms: 0 },
    items: [
      { url: "/signage-media/a.png", mime: "image/png", durationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 }, bytes: 1 },
      { url: "/signage-media/b.png", mime: "image/png", durationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 }, bytes: 1 },
    ],
  },
} as never;

describe("the signage player", () => {
  test("shows the item the clock says, not always the first", () => {
    cleanup();
    const { container } = render(React.createElement(SignagePlayer as never, { entry: ENTRY, nowMs: 9000 }));
    assert.ok(container.innerHTML.includes("b.png"), "the player ignored the clock");
  });

  test("a blank entry renders black and no media at all", () => {
    cleanup();
    const blank = { from: 0, until: 1e12, reason: "blank", reasonLabel: "" } as never;
    const { container } = render(React.createElement(SignagePlayer as never, { entry: blank, nowMs: 5000 }));
    assert.ok(!container.querySelector("img"), "a blank entry still rendered media");
    assert.ok(!container.querySelector("video"));
  });

  test("a null entry is also black, never a crash or a placeholder", () => {
    cleanup();
    const { container } = render(React.createElement(SignagePlayer as never, { entry: null, nowMs: 5000 }));
    assert.ok(!container.querySelector("img"));
  });
});
```

- [ ] **Step 5: Run it, confirm it fails, then implement the player**

`SignagePlayer` derives the item from `itemAt`, renders `<img>` or `<video muted playsInline>`, keeps the previous item mounted for the transition's duration, and applies `layerStyles`. Ground is always black. When `entry` is null or has no `playlist`, it renders a black box and nothing else.

Video that is not ready when its turn arrives **cuts** rather than stuttering: check `readyState >= 3` before applying a transition.

- [ ] **Step 6: Run the tests**

Run: `npm test -- --test-name-pattern="what a transition animates|the signage player"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add renderer/main/signage-transition.ts renderer/main/signage-transition.test.ts renderer/main/signage-player.tsx renderer/main/signage-player.test.tsx
git commit -m "feat(signage): five transitions and the player

Compositor-only guard proven red against a clip-path wipe. Player shows the item
the clock says rather than the first, and a blank entry renders nothing at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 9: The Playlists section

**Files:**
- Create: `renderer/app/signage/playlists-section.tsx`
- Modify: `renderer/app/signage/signage-route.tsx`, `main/services/routes/signage-routes.ts` (playlist CRUD)
- Test: `renderer/app/signage/playlist-edit.test.ts`

**Interfaces:**
- Produces: playlist CRUD routes, and `playlistCycleLabel(items, media): string` for the header line.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/app/signage/playlist-edit.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { resolveItemDurations } from "./playlists-section.js";

const MEDIA = [
  { id: "m1", mime: "image/png", file: "a.png" },
  { id: "m2", mime: "video/mp4", file: "b.mp4", durationMs: 42000 },
] as never;

describe("how long each playlist item is on screen", () => {
  test("an image falls back to the playlist default", () => {
    const r = resolveItemDurations({ items: [{ mediaId: "m1" }], defaultDurationMs: 8000 } as never, MEDIA);
    assert.equal(r[0].durationMs, 8000);
  });

  test("a per-item duration wins for an image", () => {
    const r = resolveItemDurations(
      { items: [{ mediaId: "m1", durationMs: 15000 }], defaultDurationMs: 8000 } as never, MEDIA);
    assert.equal(r[0].durationMs, 15000);
  });

  test("a video uses its own length and IGNORES both", () => {
    // Cutting a clip off at 8s because that is the playlist default is the bug.
    const r = resolveItemDurations(
      { items: [{ mediaId: "m2", durationMs: 8000 }], defaultDurationMs: 8000 } as never, MEDIA);
    assert.equal(r[0].durationMs, 42000);
  });

  test("an item whose media is gone is dropped, not rendered broken", () => {
    const r = resolveItemDurations(
      { items: [{ mediaId: "missing" }, { mediaId: "m1" }], defaultDurationMs: 8000 } as never, MEDIA);
    assert.equal(r.length, 1);
    assert.equal(r[0].mediaId, "m1");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, implement `resolveItemDurations`**

Exported from `playlists-section.tsx` so the resolver (Task 12) and the UI share one definition of item duration.

- [ ] **Step 3: Build the section**

List of playlists plus an editor: drag-ordered items (use the existing drag primitives from the Home grid editor or the bar configurator — read `renderer/app/bar-configurator.tsx` first), per-item duration via `NumberInput`, per-item fit and transition override, playlist defaults, and a live preview using `SignagePlayer`.

- [ ] **Step 4: Add playlist CRUD routes**

`GET/POST /api/signage/playlists`, `PATCH/DELETE /api/signage/playlists/:id`. Delete refusal comes in Task 19; for now delete simply removes.

- [ ] **Step 5: Run everything**

Run: `npm test && npm run lint && npm run type-check`

- [ ] **Step 6: Drive it in a browser**

On 8799: build a playlist with two images and the MP4 from Task 6, watch the preview cycle, change the transition and confirm it changes on screen, and confirm the MP4 plays for its own length rather than the default.

- [ ] **Step 7: Commit**

```bash
git add renderer/app/signage main/services/routes/signage-routes.ts
git commit -m "feat(signage): playlists, per-item duration and the editor preview

A video ignores both the per-item and the playlist default duration - cutting a
clip off at 8s was the bug that test was written against, proven red first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 3 — Groups and the signage view

### Task 10: Groups, and the signage view kind on a real screen

**Files:**
- Create: `renderer/app/signage/groups-section.tsx`
- Modify: `renderer/main/stage-view.tsx`, `main/services/routes/context.ts`, `main/services/routes/signage-routes.ts`, `renderer/app/screens/screen-device.tsx`
- Test: `renderer/main/signage-view-kind.test.tsx`

**Interfaces:**
- Produces: group CRUD routes; `kind === "signage"` rendering; `groupsForOutput(groups, outputId): SignageGroup[]`.

- [ ] **Step 1: Write the failing test**

```tsx
// renderer/main/signage-view-kind.test.tsx
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { isDisplayKind } from "@main/services/routes/context";

describe("signage is a real view kind", () => {
  test("the server accepts it when routing an output", () => {
    // Without this a signage View can be created but never bound to a screen.
    assert.equal(isDisplayKind("signage"), true);
  });

  test("and still refuses nonsense", () => {
    assert.equal(isDisplayKind("banana"), false);
    assert.equal(isDisplayKind(""), false);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, then widen `isDisplayKind`**

- [ ] **Step 3: Render the kind**

In `renderer/main/stage-view.tsx`, beside the existing `if (kind === "…")` arms, add a `"signage"` arm that renders `<SignagePlayer>` fed from `useSignagePlan()` — which does not exist until Task 14. Until then, feed it `null`, which correctly renders black. Leave a comment saying Task 14 wires the horizon; do not invent a placeholder data source.

- [ ] **Step 4: Build the Groups section and its routes**

Members are picked from Outputs whose routed View is `kind === "signage"`. "Add displays" creates the signage View if none exists and routes the chosen Output to it, so nothing has to be set up in Screens first. Each group carries an optional default playlist.

`GET/POST /api/signage/groups`, `PATCH/DELETE /api/signage/groups/:id`.

- [ ] **Step 5: Show membership in Screens**

In `renderer/app/screens/screen-device.tsx`, add read-only group chips plus a link to `/signage` for any output in at least one group.

- [ ] **Step 6: Run everything and drive it**

Run: `npm test && npm run lint && npm run type-check`, then on 8799 create a group, add a real enrolled screen to it, and confirm the screen goes black rather than showing a placeholder or an error.

- [ ] **Step 7: Commit**

```bash
git add renderer/main/stage-view.tsx renderer/main/signage-view-kind.test.tsx main/services/routes/context.ts main/services/routes/signage-routes.ts renderer/app/signage renderer/app/screens/screen-device.tsx
git commit -m "feat(signage): display groups and the signage view kind

isDisplayKind rejecting signage would have let a view be created and never
bound - proven red first. A signage screen with no horizon renders black.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 4 — Schedules, the resolver and the horizon

### Task 11: Window math

**Files:**
- Create: `main/services/signage-window.ts`
- Test: `main/services/signage-window.test.ts`

**Interfaces:**
- Consumes: `SignageWindow`, `WindowCtx`, `PcoWindow` from Task 1; `zonedParts` / `appTimeZone` from `app-timezone.ts`.
- Produces: `windowActiveAt(w, atMs, tz, ctx): boolean` and `nextBoundaryAfter(w, afterMs, tz, ctx): number | null`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-window.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { windowActiveAt, nextBoundaryAfter } from "./signage-window.js";

const TZ = "America/Chicago";
const CTX = { pcoWindows: [], liveServiceTypeId: null };
const at = (iso: string) => Date.parse(iso);

describe("a weekly window", () => {
  const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;

  test("is open inside its hours on its day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T14:00:00Z"), TZ, CTX), true); // Sun 09:00 CDT
  });

  test("is shut on another day at the same hour", () => {
    assert.equal(windowActiveAt(w, at("2026-08-24T14:00:00Z"), TZ, CTX), false);
  });

  test("is half-open at the end, so 13:00 is already out", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, CTX), false); // Sun 13:00 CDT
  });
});

describe("a weekly window that crosses midnight", () => {
  // 22:00-02:00 on Thursday must run into Friday morning. The day tested is the
  // day the window STARTED - testing "today" would shut it at midnight.
  const w = { kind: "weekly", days: [4], start: "22:00", end: "02:00" } as const;

  test("is open before midnight on its own day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-21T04:00:00Z"), TZ, CTX), true); // Thu 23:00 CDT
  });

  test("is STILL open after midnight, on the next calendar day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-21T06:00:00Z"), TZ, CTX), true); // Fri 01:00 CDT
  });

  test("is shut once it passes the end", () => {
    assert.equal(windowActiveAt(w, at("2026-08-21T08:00:00Z"), TZ, CTX), false); // Fri 03:00 CDT
  });

  test("is shut on Friday night, which is not its day", () => {
    assert.equal(windowActiveAt(w, at("2026-08-22T04:00:00Z"), TZ, CTX), false); // Fri 23:00 CDT
  });
});

describe("windows and daylight saving", () => {
  // Local hours must stay local hours across a DST change. A UTC-offset
  // calculation drifts by an hour, which is how a 05:00 window opened at 04:00
  // for half the year.
  const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;

  test("opens at 05:00 local in CDT", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T10:00:00Z"), TZ, CTX), true);  // Sun 05:00 CDT
    assert.equal(windowActiveAt(w, at("2026-08-23T09:59:00Z"), TZ, CTX), false);
  });

  test("and at 05:00 local in CST, an hour later in UTC", () => {
    assert.equal(windowActiveAt(w, at("2026-12-06T11:00:00Z"), TZ, CTX), true);  // Sun 05:00 CST
    assert.equal(windowActiveAt(w, at("2026-12-06T10:59:00Z"), TZ, CTX), false);
  });
});

describe("a date range", () => {
  const w = { kind: "dates", from: "2026-12-01", to: "2026-12-25", start: "08:00", end: "20:00" } as const;

  test("includes BOTH end dates", () => {
    assert.equal(windowActiveAt(w, at("2026-12-01T15:00:00Z"), TZ, CTX), true);
    assert.equal(windowActiveAt(w, at("2026-12-25T15:00:00Z"), TZ, CTX), true);
  });

  test("and excludes the days either side", () => {
    assert.equal(windowActiveAt(w, at("2026-11-30T15:00:00Z"), TZ, CTX), false);
    assert.equal(windowActiveAt(w, at("2026-12-26T15:00:00Z"), TZ, CTX), false);
  });
});

describe("a PCO window", () => {
  const w = { kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: true } as const;
  const base = { pcoWindows: [{ serviceTypeId: "st-1", from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z"), fresh: true }] };

  test("is open inside the precomputed window", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T15:00:00Z"), TZ, { ...base, liveServiceTypeId: null }), true);
  });

  test("is shut after it, when nothing is live", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, { ...base, liveServiceTypeId: null }), false);
  });

  test("STAYS OPEN past its end while PCO says that service type is live", () => {
    // A service running long must not have the foyer go black mid-service.
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, { ...base, liveServiceTypeId: "st-1" }), true);
  });

  test("ignores a different service type being live", () => {
    assert.equal(windowActiveAt(w, at("2026-08-23T18:00:00Z"), TZ, { ...base, liveServiceTypeId: "st-2" }), false);
  });

  test("does not extend when the operator turned extension off", () => {
    const noExt = { ...w, liveExtension: false };
    assert.equal(windowActiveAt(noExt, at("2026-08-23T18:00:00Z"), TZ, { ...base, liveServiceTypeId: "st-1" }), false);
  });
});

describe("the next moment a window's answer could change", () => {
  test("a weekly window reports its own end while it is open", () => {
    const w = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;
    const now = at("2026-08-23T14:00:00Z");
    assert.equal(nextBoundaryAfter(w, now, TZ, CTX), at("2026-08-23T18:00:00Z"));
  });

  test("always has no boundary at all", () => {
    assert.equal(nextBoundaryAfter({ kind: "always" }, at("2026-08-23T14:00:00Z"), TZ, CTX), null);
  });

  test("a PCO window reports its SCHEDULED end, not a guess at when live stops", () => {
    // A live extension is not a predictable instant; the scheduler recomputes on
    // the live-state change instead.
    const w = { kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: true } as const;
    const ctx = { pcoWindows: [{ serviceTypeId: "st-1", from: at("2026-08-23T13:00:00Z"), to: at("2026-08-23T17:00:00Z"), fresh: true }], liveServiceTypeId: "st-1" };
    assert.equal(nextBoundaryAfter(w, at("2026-08-23T15:00:00Z"), TZ, ctx), at("2026-08-23T17:00:00Z"));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="a weekly window|windows and daylight saving|a date range|a PCO window|the next moment"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Use `zonedParts(ms, tz)` from `app-timezone.ts` for every calendar and clock decision. For a wrapping weekly window, test whether the instant belongs to a window that *started* on an earlier local day: check both "today at `start`" and "yesterday at `start`". `nextBoundaryAfter` scans forward in local time and returns the first instant the answer flips, searching at most 8 days before returning `null`.

- [ ] **Step 4: Prove the DST guard is real**

Temporarily replace the zoned comparison with a fixed-offset one (`new Date(ms + OFFSET)`), re-run, and confirm the CST case fails. Restore. Say so in the commit.

- [ ] **Step 5: Run the tests**

Expected: PASS, all nineteen.

- [ ] **Step 6: Commit**

```bash
git add main/services/signage-window.ts main/services/signage-window.test.ts
git commit -m "feat(signage): window activity and boundary math

Midnight wrap, both DST directions, inclusive date ranges and the PCO live
extension. Proven red, and the DST case re-checked against a fixed-offset
implementation to confirm the guard bites.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 12: The resolver

**Files:**
- Create: `main/services/signage-resolve.ts`
- Test: `main/services/signage-resolve.test.ts`

**Interfaces:**
- Consumes: `windowActiveAt`, `nextBoundaryAfter` from Task 11; `resolveItemDurations` semantics from Task 9 (reimplemented server-side in this module against `SignageMedia`).
- Produces: `resolveSignage(input): Record<string, SignageHorizon>` with the input shape in spec §3.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-resolve.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { resolveSignage } from "./signage-resolve.js";

const TZ = "America/Chicago";
const NOW = Date.parse("2026-08-23T15:00:00Z"); // Sunday 10:00 CDT

const media = [
  { id: "m1", file: "a.png", name: "a", mime: "image/png", bytes: 1, w: 1920, h: 1080, createdAt: "" },
  { id: "m2", file: "b.png", name: "b", mime: "image/png", bytes: 1, w: 1920, h: 1080, createdAt: "" },
];
const pl = (id: string, mediaId: string) => ({
  id, name: id, items: [{ mediaId }], defaultDurationMs: 8000,
  fit: "contain" as const, transition: { kind: "cut" as const, ms: 0 }, createdAt: "",
});
const base = {
  now: NOW, tz: TZ,
  outputs: [{ id: "out-1", name: "Foyer", viewId: "v-sign" }],
  playlists: [pl("weekend", "m1"), pl("office", "m2"), pl("house", "m1")],
  media, pcoWindows: [], liveServiceTypeId: null, overrides: [],
} as never;
const sundayMorning = { kind: "weekly", days: [0], start: "05:00", end: "13:00" } as const;
const allDay = { kind: "always" } as const;
const sched = (id: string, playlistId: string, groupIds: string[], window: unknown) =>
  ({ id, name: id, enabled: true, groupIds, playlistId, window, createdAt: "" });
const now = (r: Record<string, never[]>, out = "out-1") =>
  (r[out] as never[]).find((e: never) => NOW >= (e as { from: number }).from && NOW < (e as { until: number }).until) as never;

describe("what a display resolves to", () => {
  test("the schedule that is higher in the list wins", () => {
    // Both match. Nothing about the groups decides it - the order does.
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "Foyer", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], sundayMorning), sched("s2", "office", ["g1"], allDay)],
    } as never);
    assert.equal((now(r) as { playlist: { id: string } }).playlist.id, "weekend");
  });

  test("reversing the list reverses the answer", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "Foyer", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s2", "office", ["g1"], allDay), sched("s1", "weekend", ["g1"], sundayMorning)],
    } as never);
    assert.equal((now(r) as { playlist: { id: string } }).playlist.id, "office");
  });

  test("an output in two groups is still decided by schedule order", () => {
    const r = resolveSignage({ ...base,
      groups: [
        { id: "g1", name: "Foyer", outputIds: ["out-1"], createdAt: "" },
        { id: "g2", name: "All", outputIds: ["out-1"], createdAt: "" },
      ],
      schedules: [sched("s1", "weekend", ["g2"], sundayMorning), sched("s2", "office", ["g1"], allDay)],
    } as never);
    assert.equal((now(r) as { playlist: { id: string } }).playlist.id, "weekend");
  });

  test("an override beats every schedule", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "Foyer", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], sundayMorning)],
      overrides: [{ groupId: "g1", playlistId: "house", startedAt: NOW - 1000 }],
    } as never);
    const e = now(r) as { playlist: { id: string }; reason: string };
    assert.equal(e.playlist.id, "house");
    assert.equal(e.reason, "override");
  });

  test("the most RECENT override wins when two groups both have one", () => {
    const r = resolveSignage({ ...base,
      groups: [
        { id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" },
        { id: "g2", name: "B", outputIds: ["out-1"], createdAt: "" },
      ],
      schedules: [],
      overrides: [
        { groupId: "g1", playlistId: "weekend", startedAt: NOW - 9000 },
        { groupId: "g2", playlistId: "office", startedAt: NOW - 1000 },
      ],
    } as never);
    assert.equal((now(r) as { playlist: { id: string } }).playlist.id, "office");
  });

  test("a blank override really does blank it", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], allDay)],
      overrides: [{ groupId: "g1", blank: true, startedAt: NOW }],
    } as never);
    assert.equal((now(r) as { playlist?: unknown }).playlist, undefined);
  });

  test("the group default takes over only when no schedule matches", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], defaultPlaylistId: "house", createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], { kind: "weekly", days: [1], start: "05:00", end: "13:00" })],
    } as never);
    const e = now(r) as { playlist: { id: string }; reason: string };
    assert.equal(e.playlist.id, "house");
    assert.equal(e.reason, "default");
  });

  test("with nothing at all it is blank", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" }],
      schedules: [],
    } as never);
    assert.equal((now(r) as { reason: string }).reason, "blank");
  });

  test("a disabled schedule does not match", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" }],
      schedules: [{ ...sched("s1", "weekend", ["g1"], allDay), enabled: false }],
    } as never);
    assert.equal((now(r) as { reason: string }).reason, "blank");
  });
});

describe("a playlist that cannot play", () => {
  test("an EMPTY playlist falls through to the group default", () => {
    // It would otherwise emit an entry with a zero-length cycle, which divides
    // by zero on the display.
    const r = resolveSignage({ ...base,
      playlists: [{ ...pl("weekend", "m1"), items: [] }, pl("house", "m1")],
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], defaultPlaylistId: "house", createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], allDay)],
    } as never);
    assert.equal((now(r) as { playlist: { id: string } }).playlist.id, "house");
  });

  test("a playlist whose media is ALL missing also falls through", () => {
    const r = resolveSignage({ ...base,
      playlists: [{ ...pl("weekend", "gone"), items: [{ mediaId: "gone" }] }, pl("house", "m1")],
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], defaultPlaylistId: "house", createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], allDay)],
    } as never);
    assert.equal((now(r) as { playlist: { id: string } }).playlist.id, "house");
  });

  test("but ONE missing item just drops that item", () => {
    const r = resolveSignage({ ...base,
      playlists: [{ ...pl("weekend", "m1"), items: [{ mediaId: "gone" }, { mediaId: "m1" }] }],
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], allDay)],
    } as never);
    assert.equal((now(r) as { playlist: { items: unknown[] } }).playlist.items.length, 1);
  });
});

describe("the horizon itself", () => {
  test("is contiguous, ordered, and covers 24 hours", () => {
    const r = resolveSignage({ ...base,
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], sundayMorning)],
    } as never);
    const h = r["out-1"] as unknown as { from: number; until: number }[];
    assert.equal(h[0].from, NOW);
    assert.equal(h[h.length - 1].until, NOW + 24 * 3600_000);
    for (let i = 1; i < h.length; i++) {
      assert.equal(h[i].from, h[i - 1].until, "the horizon has a gap or an overlap");
    }
  });

  test("startedAt does NOT move when a recompute changes nothing", () => {
    // Otherwise every unrelated config edit restarts the loop on every wall.
    const input = { ...base,
      groups: [{ id: "g1", name: "A", outputIds: ["out-1"], createdAt: "" }],
      schedules: [sched("s1", "weekend", ["g1"], sundayMorning)],
    } as never;
    const a = resolveSignage(input);
    const b = resolveSignage(input);
    assert.equal(
      (now(a) as { playlist: { startedAt: number } }).playlist.startedAt,
      (now(b) as { playlist: { startedAt: number } }).playlist.startedAt,
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="what a display resolves to|a playlist that cannot play|the horizon itself"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Build the horizon by walking boundaries: start at `now`, resolve the winner, find the earliest `nextBoundaryAfter` across every window that could change the answer, emit an entry, repeat until `now + 24h`. Cap at 200 entries so a pathological config cannot loop.

`startedAt` for an entry is its own `from` — deterministic, so an identical input gives an identical output, which is what the last test pins.

Item URLs are `/signage-media/<file>`.

- [ ] **Step 4: Run the tests**

Expected: PASS, all fifteen.

- [ ] **Step 5: Commit**

```bash
git add main/services/signage-resolve.ts main/services/signage-resolve.test.ts
git commit -m "feat(signage): per-output horizon resolver

Precedence is override, then schedule list order, then group default, then
blank - resolved per OUTPUT so an output in several groups is still decided by
order. Empty and all-missing playlists fall through rather than emitting a
zero-length cycle. Fifteen cases proven red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 13: The scheduler

**Files:**
- Create: `main/services/signage-scheduler.ts`
- Modify: `main/services/stage-controller.ts`, `main/services/remote-server.ts` (hello burst)
- Test: `main/services/signage-scheduler.test.ts`

**Interfaces:**
- Produces: `signageScheduler` with `start()`, `stop()`, `recompute(): Promise<void>`, `getHorizons(): Record<string, SignageHorizon>`; broadcasts on channel `"signage:plan"`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-scheduler.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { shouldBroadcast, nextWakeMs } from "./signage-scheduler.js";

describe("when the scheduler talks", () => {
  test("stays quiet when nothing changed", () => {
    // Broadcast-on-change is the standing rule for new integrations. Pushing an
    // identical map wakes every display for nothing.
    const a = { "out-1": [{ from: 1, until: 2, reason: "blank", reasonLabel: "" }] } as never;
    const b = { "out-1": [{ from: 1, until: 2, reason: "blank", reasonLabel: "" }] } as never;
    assert.equal(shouldBroadcast(a, b), false);
  });

  test("talks when an output's horizon differs", () => {
    const a = { "out-1": [{ from: 1, until: 2, reason: "blank", reasonLabel: "" }] } as never;
    const b = { "out-1": [{ from: 1, until: 3, reason: "blank", reasonLabel: "" }] } as never;
    assert.equal(shouldBroadcast(a, b), true);
  });

  test("talks when an output appears or disappears", () => {
    assert.equal(shouldBroadcast({} as never, { "out-1": [] } as never), true);
    assert.equal(shouldBroadcast({ "out-1": [] } as never, {} as never), true);
  });
});

describe("when the scheduler wakes up", () => {
  const NOW = 1_000_000;

  test("at the earliest boundary across every output", () => {
    const h = {
      "out-1": [{ from: NOW, until: NOW + 90_000, reason: "blank", reasonLabel: "" }],
      "out-2": [{ from: NOW, until: NOW + 30_000, reason: "blank", reasonLabel: "" }],
    } as never;
    assert.equal(nextWakeMs(h, NOW), 30_000);
  });

  test("never later than the 60s safety tick", () => {
    // A horizon whose first boundary is hours away must still be re-checked, so
    // a missed external change cannot leave a wall stale all afternoon.
    const h = { "out-1": [{ from: NOW, until: NOW + 8 * 3600_000, reason: "blank", reasonLabel: "" }] } as never;
    assert.equal(nextWakeMs(h, NOW), 60_000);
  });

  test("never zero or negative, however stale the horizon is", () => {
    // A past boundary would busy-loop the server.
    const h = { "out-1": [{ from: NOW - 10_000, until: NOW - 5_000, reason: "blank", reasonLabel: "" }] } as never;
    assert.ok(nextWakeMs(h, NOW) > 0, "the scheduler would spin");
  });

  test("with no outputs at all, still the safety tick", () => {
    assert.equal(nextWakeMs({} as never, NOW), 60_000);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, then implement**

`recompute()` loads the five stores plus the PCO windows (Task 15 — until then an empty array), calls `resolveSignage`, and broadcasts `"signage:plan"` only when `shouldBroadcast` says so **and** `channelHasSubscribers("signage:plan")`. It then arms a single `setTimeout(nextWakeMs(...))` — never a polling interval.

`start()` subscribes to the existing store-change and PCO-live signals so a config edit recomputes immediately.

- [ ] **Step 3: Wire it into the controller and the hello burst**

Start the scheduler in `stage-controller.ts` where the other services start. Add `sseWrite(res, "signage:plan", signageScheduler.getHorizons());` to the hello burst in `remote-server.ts` — the channel otherwise only broadcasts on change, so a display connecting mid-window would sit blank until the next boundary.

- [ ] **Step 4: Run the tests**

Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add main/services/signage-scheduler.ts main/services/signage-scheduler.test.ts main/services/stage-controller.ts main/services/remote-server.ts
git commit -m "feat(signage): boundary-driven scheduler and the signage:plan channel

One timeout at the next boundary rather than a poll, broadcast only on change
and only when something is subscribed. Busy-loop and safety-tick cases proven
red. The hello burst hydrates the channel so a reconnecting display is not blank
until its next boundary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 14: The display consumes the horizon, and holds at a boundary when disconnected

**Files:**
- Create: `renderer/main/use-signage-plan.ts`, `renderer/main/signage-hold.ts`
- Modify: `renderer/main/stage-view.tsx`
- Test: `renderer/main/signage-hold.test.ts`

**This is spec §4.5 — the single most important behaviour in the feature.**

**Interfaces:**
- Consumes: `entryAt` from Task 7.
- Produces:
  - `pickEntry(o: { horizon, nowMs, connected, held }): { entry: SignageHorizonEntry | null; held: SignageHorizonEntry | null }`
  - `useSignagePlan(outputId): { entry, connected }`

- [ ] **Step 1: Write the failing test**

```ts
// renderer/main/signage-hold.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { pickEntry } from "./signage-hold.js";

const P = (id: string) => ({ id, startedAt: 0, fit: "contain", transition: { kind: "cut", ms: 0 }, items: [{ url: `/${id}.png`, mime: "image/png", durationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 }, bytes: 1 }] });
const H = [
  { from: 0,     until: 10_000, reason: "schedule", reasonLabel: "Weekend", playlist: P("weekend") },
  { from: 10_000, until: 20_000, reason: "blank",   reasonLabel: "" },
  { from: 20_000, until: 30_000, reason: "schedule", reasonLabel: "Youth", playlist: P("youth") },
] as never;

describe("a display at a horizon boundary", () => {
  test("advances normally while it is connected", () => {
    const r = pickEntry({ horizon: H, nowMs: 12_000, connected: true, held: null });
    assert.equal(r.entry?.reason, "blank");
  });

  test("HOLDS what it is playing when it is not", () => {
    // The whole point. The server is gone, the clock has passed 10s, and the
    // display must keep playing Weekend rather than going black.
    const before = pickEntry({ horizon: H, nowMs: 5000, connected: true, held: null });
    const after = pickEntry({ horizon: H, nowMs: 12_000, connected: false, held: before.entry });
    assert.equal(after.entry?.reasonLabel, "Weekend", "a disconnected display blanked at its boundary");
  });

  test("holds across MANY boundaries, not just the first", () => {
    const before = pickEntry({ horizon: H, nowMs: 5000, connected: true, held: null });
    const after = pickEntry({ horizon: H, nowMs: 25_000, connected: false, held: before.entry });
    assert.equal(after.entry?.reasonLabel, "Weekend");
  });

  test("stays blank if it was ALREADY blank when the server went away", () => {
    // Holding what you are doing is the whole rule. A dark 2am screen must not
    // light itself up because the server rebooted.
    const before = pickEntry({ horizon: H, nowMs: 15_000, connected: true, held: null });
    const after = pickEntry({ horizon: H, nowMs: 25_000, connected: false, held: before.entry });
    assert.equal(after.entry?.reason, "blank");
  });

  test("jumps straight to what is correct now when it reconnects", () => {
    const held = pickEntry({ horizon: H, nowMs: 5000, connected: true, held: null }).entry;
    const back = pickEntry({ horizon: H, nowMs: 25_000, connected: true, held });
    assert.equal(back.entry?.reasonLabel, "Youth");
    assert.equal(back.held, null, "the hold was not released on reconnect");
  });

  test("a blip that resolves before the next boundary changes nothing", () => {
    // No grace timer, no threshold: connection is only consulted AT a boundary.
    const a = pickEntry({ horizon: H, nowMs: 5000, connected: true, held: null });
    const b = pickEntry({ horizon: H, nowMs: 6000, connected: false, held: a.entry });
    const c = pickEntry({ horizon: H, nowMs: 7000, connected: true, held: b.held });
    assert.equal(c.entry?.reasonLabel, "Weekend");
  });

  test("a disconnected display that has never played anything shows nothing", () => {
    const r = pickEntry({ horizon: [] as never, nowMs: 5000, connected: false, held: null });
    assert.equal(r.entry, null);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- --test-name-pattern="a display at a horizon boundary"`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement `pickEntry`**

```ts
export function pickEntry(o: {
  horizon: SignageHorizon;
  nowMs: number;
  connected: boolean;
  held: SignageHorizonEntry | null;
}): { entry: SignageHorizonEntry | null; held: SignageHorizonEntry | null } {
  const live = entryAt(o.horizon, o.nowMs);
  // Connected: the horizon is authoritative, and any hold is released.
  if (o.connected) return { entry: live, held: null };
  // Disconnected: still inside the entry we were already playing, so nothing has
  // happened yet — keep tracking it.
  if (o.held && o.nowMs >= o.held.from && o.nowMs < o.held.until) {
    return { entry: o.held, held: o.held };
  }
  // Disconnected AND past a boundary: hold. This is the rule.
  if (o.held) return { entry: o.held, held: o.held };
  return { entry: live, held: live };
}
```

- [ ] **Step 4: Implement `useSignagePlan` and wire the view**

Subscribes to `signage:plan`, selects this output's horizon, tracks SSE connection state from the existing stage-state hook, and threads `pickEntry` through a ref across renders. Replace the `null` placeholder in `stage-view.tsx`'s `"signage"` arm.

- [ ] **Step 5: Run the tests**

Expected: PASS, all seven.

- [ ] **Step 6: Drive the real thing — this cannot be proven by unit tests**

```bash
# with the 8799 server running, a signage group with a schedule ending soon,
# and a browser open on the signage output
lsof -ti tcp:8799 | xargs -r kill    # stop the server mid-window
# wait past the scheduled end, confirm the display KEEPS PLAYING rather than blanking
STAGE_UTILITY_DATA=/tmp/su-signage-dev STAGE_UTILITY_PORT=8799 npm run server &
# confirm it jumps to the correct entry within a second of reconnecting
```

Paste what you observed into the commit message. If it blanked, the bug is real and the task is not done.

- [ ] **Step 7: Commit**

```bash
git add renderer/main/use-signage-plan.ts renderer/main/signage-hold.ts renderer/main/signage-hold.test.ts renderer/main/stage-view.tsx
git commit -m "feat(signage): a display advances at a boundary only while connected

Connection is consulted AT a boundary and nowhere else - no grace timer, no
threshold, and a blip that resolves in between changes nothing. Seven cases
proven red, then confirmed against a real server: killed it mid-window, watched
the display hold past the scheduled end, restarted it and watched it jump to the
correct entry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 15: The Schedule section

**Files:**
- Create: `renderer/app/signage/schedule-section.tsx`, `window-editor.tsx`
- Modify: `main/services/routes/signage-routes.ts`
- Test: `renderer/app/signage/window-editor.test.ts`

**Interfaces:**
- Produces: schedule CRUD plus `POST /api/signage/schedules/reorder`; `describeWindow(w: SignageWindow): string` for the row summary.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/app/signage/window-editor.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { describeWindow } from "./window-editor.js";

describe("how a window reads on a schedule row", () => {
  test("a weekly window names its days and hours", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [0], start: "05:00", end: "13:00" }),
      "Sun 05:00-13:00",
    );
  });

  test("consecutive weekdays collapse to a range", () => {
    assert.equal(
      describeWindow({ kind: "weekly", days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }),
      "Mon-Fri 09:00-17:00",
    );
  });

  test("a window that crosses midnight SAYS so", () => {
    // Otherwise "Thu 22:00-02:00" reads as a four-hour window that never opens.
    assert.match(describeWindow({ kind: "weekly", days: [4], start: "22:00", end: "02:00" }), /next day/i);
  });

  test("a PCO window names its padding", () => {
    assert.equal(
      describeWindow({ kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: true }),
      "PCO plan times, 60 min before to 30 min after, held while live",
    );
  });

  test("and says when the live extension is off", () => {
    assert.ok(
      !/held while live/.test(describeWindow({ kind: "pco", serviceTypeId: "st-1", leadMinutes: 60, trailMinutes: 30, liveExtension: false })),
    );
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, implement `describeWindow`**

- [ ] **Step 3: Build the section**

Ordered list, drag to reorder (persisting via `/reorder`), each row showing name, enabled switch, groups, playlist and `describeWindow(...)`. Mark the row currently winning for a chosen group by reading `GET /api/signage/now`. `window-editor.tsx` switches on `kind` and renders the right form; durations and minute offsets use `NumberInput`.

- [ ] **Step 4: Run everything, then drive it**

Run: `npm test && npm run lint && npm run type-check`. On 8799, create two overlapping schedules on one group, confirm the higher one wins on a real screen, drag to reorder, and confirm the screen changes.

- [ ] **Step 5: Commit**

```bash
git add renderer/app/signage main/services/routes/signage-routes.ts
git commit -m "feat(signage): the ordered schedule list and window editor

A midnight-crossing window says so on its row - reading as a four-hour window
that never opens was the confusion that test was written against.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 5 — PCO windows

### Task 16: PCO-derived windows

**Files:**
- Create: `main/services/signage-pco-windows.ts`
- Modify: `main/services/signage-scheduler.ts`
- Test: `main/services/signage-pco-windows.test.ts`

**Interfaces:**
- Consumes: `pcoService.listUpcomingPlans`, `pcoService.listPlanTimes` (see `main/services/pco-service.ts:540` and `:716`).
- Produces: `windowsFromPlanTimes(times, leadMinutes, trailMinutes, tz, dayKey): PcoWindow | null`, and `signagePcoWindows` with `get(): PcoWindow[]`, `isStale(): boolean`, `refresh(): Promise<void>`, `start()`, `stop()`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-pco-windows.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { windowsFromPlanTimes, mergeKeepingLastKnown } from "./signage-pco-windows.js";

const TZ = "America/Chicago";
const times = [
  { startsAt: "2026-08-23T14:00:00Z", timeType: "service" },
  { startsAt: "2026-08-23T16:00:00Z", timeType: "service" },
  { startsAt: "2026-08-23T12:00:00Z", timeType: "rehearsal" },
] as never;

describe("turning plan times into a window", () => {
  test("spans the FIRST service time minus lead to the LAST plus trail", () => {
    const w = windowsFromPlanTimes(times, 60, 30, TZ, "2026-08-23");
    assert.equal(w?.from, Date.parse("2026-08-23T13:00:00Z"));
    assert.equal(w?.to, Date.parse("2026-08-23T16:30:00Z"));
  });

  test("ignores rehearsals - only service times define the window", () => {
    // Otherwise a 7am rehearsal opens the foyer TVs two hours early.
    const w = windowsFromPlanTimes(times, 0, 0, TZ, "2026-08-23");
    assert.equal(w?.from, Date.parse("2026-08-23T14:00:00Z"));
  });

  test("no service times at all is no window, not a zero-length one", () => {
    assert.equal(windowsFromPlanTimes([{ startsAt: "2026-08-23T12:00:00Z", timeType: "rehearsal" }] as never, 60, 30, TZ, "2026-08-23"), null);
  });

  test("an unparseable time is skipped rather than poisoning the window", () => {
    const w = windowsFromPlanTimes(
      [{ startsAt: "not a date", timeType: "service" }, { startsAt: "2026-08-23T14:00:00Z", timeType: "service" }] as never,
      0, 0, TZ, "2026-08-23");
    assert.equal(w?.from, Date.parse("2026-08-23T14:00:00Z"));
  });
});

describe("when PCO cannot be reached", () => {
  test("KEEPS the last known windows rather than going dark", () => {
    // Failing closed means dark foyer TVs on a Sunday because an API call timed
    // out. That is the wrong trade.
    const known = [{ serviceTypeId: "st-1", from: 1, to: 2, fresh: true }];
    const after = mergeKeepingLastKnown(known, null);
    assert.equal(after.length, 1);
    assert.equal(after[0].fresh, false, "a stale window was not marked stale");
  });

  test("a successful refresh replaces them and marks them fresh", () => {
    const known = [{ serviceTypeId: "st-1", from: 1, to: 2, fresh: false }];
    const after = mergeKeepingLastKnown(known, [{ serviceTypeId: "st-1", from: 5, to: 6, fresh: true }]);
    assert.equal(after[0].from, 5);
    assert.equal(after[0].fresh, true);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, then implement**

The poller refreshes every 30 minutes, only for service types named by an **enabled** `pco` schedule, and does nothing at all when there are none. A failed fetch is logged **and** surfaced through `isStale()` — it is never swallowed.

- [ ] **Step 3: Feed the scheduler**

`signage-scheduler.ts` now passes `signagePcoWindows.get()` and the live service-type id into `resolveSignage`, and recomputes on both a window refresh and a PCO live change.

- [ ] **Step 4: Run the tests and commit**

```bash
git add main/services/signage-pco-windows.ts main/services/signage-pco-windows.test.ts main/services/signage-scheduler.ts
git commit -m "feat(signage): PCO-derived windows with a live extension

Only service times define a window - a rehearsal opening the foyer two hours
early was the case proven red. An unreachable PCO keeps its last known windows,
marked stale, rather than blanking a wall because a call timed out.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 6 — Overrides and the Now board

### Task 17: Overrides

**Files:**
- Modify: `main/services/routes/signage-routes.ts`, `main/services/signage-scheduler.ts`
- Test: `main/services/routes/signage-override.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// main/services/routes/signage-override.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { callRoute } from "./route-harness.js";
import { signageRoutes } from "./signage-routes.js";

describe("setting an override", () => {
  test("refuses one that names neither a playlist nor blank", () => {
    // An override with no content would resolve as "nothing", which is
    // indistinguishable from a bug on a dark wall.
    return callRoute(signageRoutes, "POST", "/api/signage/groups/g1/override", { json: {} })
      .then((r) => {
        assert.equal(r.status, 400);
        assert.match(r.json.error, /playlist or blank/i);
      });
  });

  test("refuses one naming both", async () => {
    const r = await callRoute(signageRoutes, "POST", "/api/signage/groups/g1/override", {
      json: { playlistId: "p1", blank: true },
    });
    assert.equal(r.status, 400);
  });

  test("refuses a playlist that does not exist", async () => {
    const r = await callRoute(signageRoutes, "POST", "/api/signage/groups/g1/override", {
      json: { playlistId: "nope" },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /playlist/i);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, implement**

`POST` validates and stores with `startedAt = Date.now()`, then triggers `signageScheduler.recompute()`. `DELETE` removes and recomputes.

- [ ] **Step 3: Run the tests and commit**

```bash
git add main/services/routes/signage-routes.ts main/services/routes/signage-override.test.ts main/services/signage-scheduler.ts
git commit -m "feat(signage): per-group take-over and release

An override naming neither a playlist nor blank is refused - it would have
resolved as nothing, which looks exactly like a bug on a dark wall. Proven red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 18: The Now board

**Files:**
- Create: `renderer/app/signage/now-board.tsx`
- Modify: `main/services/routes/signage-routes.ts` (`GET /api/signage/now`), `renderer/app/signage/signage-route.tsx`

- [ ] **Step 1: Add `GET /api/signage/now`**

Returns `{ horizons, groups, staleWindows: boolean, problems: { kind: "empty-playlist" | "missing-media", playlistId: string, detail: string }[] }` — the same resolver output the SSE channel carries, so the page and the diagnostic cannot disagree.

- [ ] **Step 2: Build the board**

Per group: what is playing, `reasonLabel`, a `SignagePlayer` preview, member screens, and Take over · Blank · Release. A persistent banner names every active override with a Release control. A warning strip appears when `staleWindows` is true or `problems` is non-empty — an empty playlist must be **visible**, not silently skipped.

- [ ] **Step 3: Run everything, then drive it**

Run: `npm test && npm run lint && npm run type-check`. On 8799, take over a group and confirm the real screen changes within a second and the banner appears; release it and confirm both revert. Create an empty playlist, schedule it, and confirm the board says so rather than the screen just going blank.

- [ ] **Step 4: Commit**

```bash
git add renderer/app/signage main/services/routes/signage-routes.ts
git commit -m "feat(signage): the Now board

Shows what each group is playing and why, from the same resolver output the SSE
channel carries. An empty playlist or a missing file is surfaced here rather
than silently falling through.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 7 — Integrity, backups, docs

### Task 19: Deleting something in use

**Files:**
- Create: `main/services/signage-integrity.ts`
- Modify: `main/services/routes/signage-routes.ts`
- Test: `main/services/signage-integrity.test.ts`

**Interfaces:**
- Produces: `playlistUsage(id, schedules, groups): { schedules: string[]; groups: string[] }`, `groupUsage(id, schedules): string[]`, `mediaUsage(id, playlists): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-integrity.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { playlistUsage, groupUsage, mediaUsage } from "./signage-integrity.js";

const schedules = [
  { id: "s1", name: "Weekend mornings", groupIds: ["g1"], playlistId: "p1" },
  { id: "s2", name: "Office hours", groupIds: ["g2"], playlistId: "p2" },
] as never;
const groups = [{ id: "g1", name: "Foyer", defaultPlaylistId: "p3" }] as never;
const playlists = [{ id: "p1", items: [{ mediaId: "m1" }, { mediaId: "m2" }] }] as never;

describe("what is using this", () => {
  test("names the schedules holding a playlist, not just a count", () => {
    // "In use by 1 schedule" makes the operator hunt for it.
    assert.deepEqual(playlistUsage("p1", schedules, groups).schedules, ["Weekend mornings"]);
  });

  test("a playlist used only as a group default is still in use", () => {
    // Easy to miss, and deleting it would silently blank that group.
    assert.deepEqual(playlistUsage("p3", schedules, groups).groups, ["Foyer"]);
  });

  test("names the schedules holding a group", () => {
    assert.deepEqual(groupUsage("g2", schedules), ["Office hours"]);
  });

  test("names the playlists holding a media item", () => {
    assert.deepEqual(mediaUsage("m1", playlists), ["p1"]);
  });

  test("something unused is genuinely unused", () => {
    assert.deepEqual(playlistUsage("nope", schedules, groups), { schedules: [], groups: [] });
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, implement**

- [ ] **Step 3: Wire the refusals**

`DELETE /api/signage/playlists/:id` and `/groups/:id` answer **409** with the names when in use. `DELETE /api/signage/media/:id` succeeds but removes the item from every playlist and **returns which playlists changed** — the caller decides what to tell the operator; it is never logged and dropped.

- [ ] **Step 4: Run the tests and commit**

```bash
git add main/services/signage-integrity.ts main/services/signage-integrity.test.ts main/services/routes/signage-routes.ts
git commit -m "feat(signage): refuse to delete something in use, and say what uses it

A playlist used only as a group default is still in use - deleting it would have
silently blanked that group. Proven red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 20: Backups

**Files:**
- Modify: `main/services/config-snapshot.ts`
- Test: `main/services/signage-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// main/services/signage-snapshot.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { configFiles } from "./config-snapshot.js";
import { SIGNAGE_SNAPSHOT_MAX_FILE_BYTES, shouldSnapshotMedia } from "./config-snapshot.js";

describe("what a backup carries for signage", () => {
  test("all four config stores, by name", () => {
    const f = configFiles();
    for (const n of ["signage-media.json", "signage-playlists.json", "signage-groups.json", "signage-schedules.json"]) {
      assert.ok(f.includes(n), `${n} is missing from every backup`);
    }
  });

  test("NOT the overrides", () => {
    assert.ok(!configFiles().includes("signage-overrides.json"));
  });

  test("graphics ride along, video does not", () => {
    assert.equal(SIGNAGE_SNAPSHOT_MAX_FILE_BYTES, 12 * 1024 * 1024);
    assert.equal(shouldSnapshotMedia({ bytes: 2 * 1024 * 1024, mime: "image/png" }), true);
    assert.equal(shouldSnapshotMedia({ bytes: 168 * 1024 * 1024, mime: "video/mp4" }), false);
  });

  test("an oversized IMAGE is skipped too - the rule is size, not type", () => {
    assert.equal(shouldSnapshotMedia({ bytes: 13 * 1024 * 1024, mime: "image/png" }), false);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, implement**

Add `SIGNAGE_MEDIA_DIR` to `IMAGE_DIRS` with a per-file size filter. The snapshot records a `skippedMedia: { file: string; name: string; bytes: number }[]` list, and the restore path returns it so the UI can name what did not come back.

- [ ] **Step 3: Drive a real round trip**

On 8799: upload an image and the MP4, save a snapshot, wipe the data dir, restore, and confirm the manifest is intact, the image returned, the video is named in the skipped list, and the Signage tab offers Re-upload for it.

- [ ] **Step 4: Commit**

```bash
git add main/services/config-snapshot.ts main/services/signage-snapshot.test.ts
git commit -m "feat(signage): media in backups, capped at 12MB per file

Every graphic rides along, video does not, and the restore report names what it
skipped so nothing goes missing quietly. Verified with a real save-wipe-restore
round trip on 8799.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 21: Docs

**Files:**
- Create: `docs/features/signage.md`
- Modify: `docs/reference/data-model.md`, `docs/reference/api.md`, `docs/kiosk-devices.md`

- [ ] **Step 1: Write `docs/features/signage.md`**

Concise reference for a stranger on GitHub — never before/after narrative or personal notes. Cover: what signage is and how a screen becomes one; media, playlists, groups, schedules; the four window types; precedence, including that list order decides; overrides; what happens when the server goes away; and the known limits (a stale horizon, and a Pi clock with no RTC).

- [ ] **Step 2: Update the reference docs**

`data-model.md` gains the signage nouns beside views and outputs. `api.md` gains the `/api/signage/*` table from spec §13. `kiosk-devices.md` gains a line pointing at signage for a screen used that way.

- [ ] **Step 3: Commit**

```bash
git add docs/features/signage.md docs/reference/data-model.md docs/reference/api.md docs/kiosk-devices.md
git commit -m "docs(signage): feature reference, data model and API

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

## Phase 8 — Offline-capable displays

### Task 22: Prefetch, the service worker and persistence

**Files:**
- Create: `public/signage-sw.js`, `renderer/main/signage-offline.ts`, `renderer/main/signage-prefetch.ts`
- Modify: `renderer/main/use-signage-plan.ts`
- Test: `renderer/main/signage-prefetch.test.ts`

**Interfaces:**
- Produces: `planPrefetch(h, nowMs, capBytes): { urls: string[]; skipped: { url: string; bytes: number }[] }`, `registerSignageWorker(): Promise<boolean>`, `persistHorizon(outputId, h)`, `loadPersistedHorizon(outputId)`, `cacheReport(): Promise<{ cached: number; total: number; bytes: number }>`.

- [ ] **Step 1: Write the failing test**

```ts
// renderer/main/signage-prefetch.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { planPrefetch } from "./signage-prefetch.js";

const item = (u: string, bytes: number) => ({ url: u, mime: "image/png", durationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 }, bytes });
const H = [
  { from: 0, until: 10_000, reason: "schedule", reasonLabel: "A",
    playlist: { id: "a", startedAt: 0, fit: "contain", transition: { kind: "cut", ms: 0 }, items: [item("/a1.png", 100), item("/a2.png", 100)] } },
  { from: 10_000, until: 20_000, reason: "schedule", reasonLabel: "B",
    playlist: { id: "b", startedAt: 0, fit: "contain", transition: { kind: "cut", ms: 0 }, items: [item("/b1.png", 100), item("/b2.png", 100)] } },
] as never;

describe("what a display fetches ahead", () => {
  test("the whole current window, plus the FIRST item of the next", () => {
    // The first item of the next window is what stops a visible fetch at the
    // boundary; fetching all of it would be gigabytes once video is involved.
    const r = planPrefetch(H, 5000, 1e9);
    assert.deepEqual(r.urls, ["/a1.png", "/a2.png", "/b1.png"]);
  });

  test("stops at the cap and REPORTS what it dropped", () => {
    // Silently fetching less reads as "everything is cached" when it is not.
    const r = planPrefetch(H, 5000, 150);
    assert.deepEqual(r.urls, ["/a1.png"]);
    assert.equal(r.skipped.length, 2);
    assert.equal(r.skipped[0].url, "/a2.png");
  });

  test("a blank current entry still warms the next window's first item", () => {
    const blankFirst = [{ from: 0, until: 10_000, reason: "blank", reasonLabel: "" }, H[1]] as never;
    assert.deepEqual(planPrefetch(blankFirst, 5000, 1e9).urls, ["/b1.png"]);
  });

  test("outside the horizon it fetches nothing rather than guessing", () => {
    assert.deepEqual(planPrefetch(H, 99_000, 1e9).urls, []);
  });
});
```

- [ ] **Step 2: Run it, confirm it fails, implement `planPrefetch`**

- [ ] **Step 3: The service worker**

`public/signage-sw.js` precaches the app shell and, on a message from the page, the current window's assets. Cache name is keyed on the build version string. It takes control **only after a successful shell fetch**, so a bad deploy cannot strand a screen on a broken cached app.

- [ ] **Step 4: `signage-offline.ts`**

Feature-detected throughout — where `navigator.serviceWorker` is undefined (a phone, a Mac kiosk, a browser tab) everything still works, just without reload survival. Registers the worker, calls `navigator.storage.persist()`, writes the horizon to IndexedDB on every change, and reads it back at startup.

- [ ] **Step 5: Run the tests, then verify in a browser**

Run: `npm test`. Then on 8799 with a signage screen open, confirm in DevTools that the worker registers, `storage.persist()` resolves true, the window's assets are in Cache Storage, and the horizon is in IndexedDB.

- [ ] **Step 6: Commit**

```bash
git add public/signage-sw.js renderer/main/signage-offline.ts renderer/main/signage-prefetch.ts renderer/main/signage-prefetch.test.ts renderer/main/use-signage-plan.ts
git commit -m "feat(signage): bounded prefetch, service worker and horizon persistence

Prefetches the current window plus the next window's first item, and reports
what the cap dropped rather than silently fetching less. All of it is
feature-detected, so a Mac kiosk or a phone is unaffected.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 23: The kiosk launcher, booting offline, and Prepare for offline

**Files:**
- Modify: `scripts/kiosk/install-linux.sh`, `renderer/main/use-signage-plan.ts`, `main/services/routes/signage-routes.ts`, `renderer/app/signage/groups-section.tsx`
- Create: `scripts/kiosk/launcher-fallback.test.ts`
- Test: `renderer/main/signage-boot-offline.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// renderer/main/signage-boot-offline.test.ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { bootEntry } from "./signage-hold.js";

const P = (id: string) => ({ id, startedAt: 0, fit: "contain", transition: { kind: "cut", ms: 0 }, items: [{ url: `/${id}.png`, mime: "image/png", durationMs: 8000, fit: "contain", transition: { kind: "cut", ms: 0 }, bytes: 1 }] });

describe("a display that BOOTS with no server", () => {
  test("plays the group default, whatever the clock believes", () => {
    // A Pi has no RTC. It must not consult a window it cannot trust - it plays
    // the thing it was deliberately given.
    const e = bootEntry({ persisted: [{ from: 0, until: 10, reason: "default", reasonLabel: "Camp loop", playlist: P("camp") }] as never, nowMs: 0 });
    assert.equal(e?.playlist?.id, "camp");
  });

  test("finds the default entry even when the clock lands nowhere near it", () => {
    const e = bootEntry({ persisted: [{ from: 0, until: 10, reason: "default", reasonLabel: "Camp", playlist: P("camp") }] as never, nowMs: 9e12 });
    assert.equal(e?.playlist?.id, "camp", "a wrong clock left the screen black");
  });

  test("prefers a default entry over a scheduled one", () => {
    const e = bootEntry({ persisted: [
      { from: 0, until: 10, reason: "schedule", reasonLabel: "Weekend", playlist: P("weekend") },
      { from: 10, until: 20, reason: "default", reasonLabel: "Camp", playlist: P("camp") },
    ] as never, nowMs: 5 });
    assert.equal(e?.playlist?.id, "camp");
  });

  test("with no default anywhere in the horizon it is black, not a guess", () => {
    const e = bootEntry({ persisted: [{ from: 0, until: 10, reason: "schedule", reasonLabel: "W", playlist: P("w") }] as never, nowMs: 5 });
    assert.equal(e, null);
  });
});
```

```ts
// scripts/kiosk/launcher-fallback.test.ts
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

const SRC = fs.readFileSync("scripts/kiosk/install-linux.sh", "utf8");

describe("the kiosk launcher", () => {
  test("makes its own origin a secure context, so a service worker can register", () => {
    // Without this the SW never registers on plain HTTP and an offline reboot is
    // a dead screen. Asserted on the flag being APPLIED to the discovered URL,
    // not merely mentioned.
    assert.match(SRC, /--unsafely-treat-insecure-origin-as-secure="\$URL"/);
  });

  test("remembers the server it found", () => {
    assert.match(SRC, /LAST_SERVER_FILE=/);
    assert.match(SRC, /printf '%s' "\$URL" > "\$LAST_SERVER_FILE"/);
  });

  test("launches at the last known server rather than blocking forever", () => {
    // The launcher used to loop on discovery and never start a browser without a
    // server, so a Pi taken offsite showed nothing at all.
    assert.match(SRC, /URL="\$\(cat "\$LAST_SERVER_FILE"/);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test -- --test-name-pattern="a display that BOOTS with no server|the kiosk launcher"`
Expected: FAIL on all seven.

- [ ] **Step 3: Implement `bootEntry`**

Returns the first entry in the persisted horizon whose `reason === "default"`, else `null`. Deliberately clock-independent: it never calls `entryAt`.

Wire it into `useSignagePlan`: when the page starts with no server connection and no live horizon, use `bootEntry(loadPersistedHorizon(outputId))`.

- [ ] **Step 4: Amend the launcher**

Add the secure-origin flag to the `exec $CHROME` line, persist `$URL` to `$STATE_DIR/last-server` on a successful discovery, and after roughly 30 seconds of failed discovery fall back to that file instead of continuing to loop. Keep the existing `server` file behaviour for the VLAN case.

- [ ] **Step 5: Add Prepare for offline**

`POST /api/signage/groups/:id/prepare-offline` pushes a horizon containing the group's default playlist in full. `POST /api/signage/cache-report` takes a display's Cache Storage inventory. The Groups section shows per-display readiness — *34 of 34 assets · 812 MB · ready*.

- [ ] **Step 6: Verify on real hardware**

Re-run the installer on a Pi, confirm the flag is present and the worker registers. Press Prepare for offline and wait for ready. Then unplug the network entirely and reboot the Pi: it must come up playing the group's default playlist. **This is the whole point of the phase — if it comes up black, the task is not done.** Paste what you observed into the commit.

- [ ] **Step 7: Commit**

```bash
git add scripts/kiosk/install-linux.sh scripts/kiosk/launcher-fallback.test.ts renderer/main/signage-hold.ts renderer/main/signage-boot-offline.test.ts renderer/main/use-signage-plan.ts main/services/routes/signage-routes.ts renderer/app/signage/groups-section.tsx
git commit -m "feat(signage): displays that boot and play with no server

The launcher used to block on UDP discovery and never start a browser without a
server, so a Pi taken offsite showed nothing at all - it now falls back to the
last known URL. A cold boot plays the group default and never consults a window,
so a Pi with no RTC cannot show the wrong thing. Seven cases proven red, then
confirmed on real hardware: unplugged the network, rebooted, came up playing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SjvyJC9Y4Qj4NqPpCF864L"
```

---

### Task 24: Whole-diff review and the PR

- [ ] **Step 1: Run everything**

Run: `npm test && npm run lint && npm run type-check`
Expected: fully green. Paste the counts.

- [ ] **Step 2: Three review passes over the final diff**

Correctness, then simplification, then whole-PR. Fix what they find before opening the PR; if you disagree with a finding, say why in the PR body rather than skipping it silently.

- [ ] **Step 3: Grep for the repeated-pattern trap**

The most expensive recurring mistake in this repo is fixing one instance of a shape that exists in several. Before opening the PR, grep for each of these across `main/` and `renderer/` and confirm every instance is handled, stating the counts in the PR body:

```bash
grep -rn "ViewKind" main renderer --include=*.ts --include=*.tsx | grep -v signage
grep -rn "IMAGE_DIRS\|configFiles()" main
grep -rn "sseWrite(res," main/services/remote-server.ts
```

- [ ] **Step 4: Full manual pass on 8799**

Upload, playlist, group, all four window types, override, restart mid-window, snapshot round trip. Confirm nothing regressed on a non-signage display.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/signage
gh pr create --base beta --title "feat(signage): digital signage" --body "$(cat <<'EOF'
Media library, playlists, display groups, ordered schedules (weekly, date range,
one-off, PCO-derived), per-group overrides, and displays that keep playing with
no server and no network.

Signage adds no display model: a signage screen is an existing Output routed to
a View of the new kind `signage`. Content resolves per output on the server and
is pushed as a 24h horizon, so a display switches itself at boundaries and only
advances while connected.

Design: docs/superpowers/specs/2026-08-22-digital-signage-design.md

Verified against a real server on 8799 and on Pi hardware: killed the server
mid-window and watched a display hold past its scheduled end, then jump to the
correct entry on reconnect; unplugged the network and rebooted a prepared Pi and
watched it come up playing its group's default playlist.
EOF
)"
```

**Do not merge.** The maintainer merges.

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 → 10; §2.1 → 2, 4; §2.2 → 1; §3 → 12; §3.1a → 12; §3.2 → 11; §4.1 → 12, 13; §4.2 → 7; §4.3 → 13; §4.4 → 22; §4.5 → 14; §5 → 8; §6 → 16; §7 → 17; §8 → 2, 3, 5; §9 → 19; §10 → 6, 9, 10, 15, 18; §10.1 → 8; §11.1–11.4 → 22, 23; §11.5–11.6 → 23; §12 → 20; §13 → 5, 9, 10, 15, 17, 18, 19, 23; §14 → distributed, with the two stateful cases in 14 and 23; §15 → the phase headings; §16 → nothing, correctly.

**Type consistency.** `defaultPlaylistId` (not `fallbackPlaylistId`) throughout. `reason` is `"override" | "schedule" | "default" | "blank"` in Tasks 12, 14, 18 and 23. `SignageHorizonEntry` uses `from`/`until` everywhere. `resolveItemDurations` (Task 9) and the resolver's server-side duration logic (Task 12) are noted as two implementations of one rule — Task 12 says so explicitly.

**Known gap, stated rather than hidden.** Task 10 renders the `signage` view kind against `null` because `useSignagePlan` does not exist until Task 14. That is a deliberate ordering choice — a signage screen renders black, which is correct behaviour, not a placeholder — and Task 10 Step 3 says so.
