# Digital signage — design

**Goal.** Turn any enrolled display into a digital-signage screen: upload graphics
and video, arrange them into playlists, group the screens, and schedule which
playlist plays on which group and when — including windows derived from Planning
Center. Outside any window a connected screen goes black. A screen that loses the
server keeps playing rather than going dark, and a Pi prepared for it plays with
no network and no correct clock at all.

**Status.** Approved design. Implementation plan follows in
`docs/superpowers/plans/`.

---

## 1. Where signage sits in the existing model

A signage screen is not a new kind of thing. It is an `Output` — already
enrolled, named, slugged, blackout-able and bound to a kiosk device — routed to a
`View` of a new kind, `signage`.

That reuses the whole enrollment story unchanged. Swap a dead Pi and the Output,
its group membership and its schedules are untouched, because a kiosk binding is
to an Output and not to a name.

One `signage` View drives every signage screen. What each screen *plays* is
resolved per-output on the server, so a single View is correct however many
groups and schedules exist.

**Groups are net-new.** Nothing in the app groups Outputs today. A group is a
name and a list of `outputId`s. A display may belong to any number of groups.

**A static graphic is a one-item playlist.** There is no separate "static image"
concept and no second code path.

---

## 2. Data model

### 2.1 Stores

| File | Class | Holds |
|---|---|---|
| `signage-media.json` | config | the media library manifest |
| `signage-playlists.json` | config | playlists and their ordered items |
| `signage-groups.json` | config | groups, their members and default playlist |
| `signage-schedules.json` | config | the ordered schedule list |
| `signage-overrides.json` | **runtime** | active take-overs |

All four config stores are registered with `StoreClass = "config"`, which the
existing store-registry test enforces, so they cannot be missing from a backup.

Overrides are `runtime` deliberately. They must survive a server restart — a
dropped announcement is a real failure — but restoring a two-week-old backup must
never put a stale announcement back on a wall.

### 2.2 Types

Added in `main/types/signage.ts`, re-exported from `stage.ts` alongside the other
domain types.

```ts
export type SignageFit = "contain" | "cover";

export type SignageTransitionKind =
  | "cut"
  | "crossfade"
  | "fade-through-black"
  | "slide"
  | "wipe";

export type SignageDirection = "left" | "right" | "up" | "down";

export interface SignageTransition {
  kind: SignageTransitionKind;
  /** 0-3000. Ignored when kind === "cut". */
  ms: number;
  /** Only meaningful for "slide" and "wipe". */
  direction?: SignageDirection;
}

/** One file in the library. The bytes live at
 *  `<userData>/signage-media/<file>` and are served at `/signage-media/<file>`. */
export interface SignageMedia {
  id: string;
  /** `<sha256-16>.<ext>`. Content-addressed, so the name is verifiable. */
  file: string;
  /** The operator's name for it. Defaults to the uploaded filename. */
  name: string;
  mime: string;
  bytes: number;
  /** Intrinsic pixel size, measured client-side and clamped server-side. */
  w: number;
  h: number;
  /** Video only: the clip's own length, which is its item duration. */
  durationMs?: number;
  createdAt: string;
}

export interface SignagePlaylistItem {
  mediaId: string;
  /** Images: overrides the playlist default. Ignored for video, whose duration
   *  is the clip's own length. */
  durationMs?: number;
  fit?: SignageFit;
  transition?: SignageTransition;
}

export interface SignagePlaylist {
  id: string;
  name: string;
  items: SignagePlaylistItem[];
  /** Applied to any image item without its own. */
  defaultDurationMs: number;
  fit: SignageFit;
  transition: SignageTransition;
  createdAt: string;
}

export interface SignageGroup {
  id: string;
  name: string;
  outputIds: string[];
  /**
   * This group's content when there is nothing else to go on. Two jobs:
   * played when no schedule matches instead of going black, AND played by a
   * display that boots with no server reachable (§11.6). "Default playlist" in
   * the UI.
   */
  defaultPlaylistId?: string | null;
  createdAt: string;
}

export type SignageWindow =
  | { kind: "always" }
  | { kind: "weekly"; days: number[]; start: string; end: string }
  | {
      kind: "dates";
      from: string;               // "YYYY-MM-DD", inclusive
      to: string;                 // "YYYY-MM-DD", inclusive
      days?: number[];            // optional weekly pattern inside the range
      start: string;
      end: string;
    }
  | { kind: "once"; date: string; start: string; end: string }
  | {
      kind: "pco";
      serviceTypeId: string;
      leadMinutes: number;
      trailMinutes: number;
      /** Stay open while PCO Live reports this service type live. */
      liveExtension: boolean;
    };

export interface SignageSchedule {
  id: string;
  name: string;
  enabled: boolean;
  groupIds: string[];
  playlistId: string;
  window: SignageWindow;
  createdAt: string;
}

export interface SignageOverride {
  groupId: string;
  /** Exactly one of these. `blank` is an explicit "show nothing". */
  playlistId?: string;
  blank?: boolean;
  startedAt: number;
  /** Who set it, for the banner. */
  note?: string;
}

/** One PCO-derived open window, precomputed by §6. */
export interface PcoWindow {
  serviceTypeId: string;
  from: number;
  to: number;
  /** False when this came from cache after a failed fetch (§6). */
  fresh: boolean;
}

/** The live state a window test may consult. */
export interface WindowCtx {
  pcoWindows: PcoWindow[];
  /** The service type PCO Live currently reports live, or null. */
  liveServiceTypeId: string | null;
}
```

`days` uses `0 = Sunday`, matching `Date.prototype.getDay` and the existing
`ZonedParts.weekday`.

`start`/`end` are `"HH:MM"` in the **app time zone** (`app-timezone.ts`), never
the host clock.

---

## 3. Resolution

One pure function in `main/services/signage-resolve.ts`:

```ts
resolveSignage(input: {
  now: number;
  tz: TimeZone;
  outputs: Output[];
  groups: SignageGroup[];
  schedules: SignageSchedule[];   // ordered; index is priority
  playlists: SignagePlaylist[];
  media: SignageMedia[];
  overrides: SignageOverride[];
  pcoWindows: PcoWindow[];        // precomputed, see §6
}): Record<string, SignageHorizon>
```

Pure, and returning the whole per-output map, so it is testable without a server
and so `GET /api/signage/now` and the SSE push cannot disagree.

### 3.1 Precedence, per output

Resolution is per **output**, not per group, because an output may belong to
several groups whose schedules disagree.

1. **Override** on any group containing this output. If several, the one with the
   most recent `startedAt` wins — the last thing the operator pressed.
2. **Schedules, in list order.** The first schedule that is `enabled`, whose
   window is active, and whose `groupIds` intersect this output's groups.
3. **Default** — the `defaultPlaylistId` of the first group (in group-list order)
   containing this output that names one.
4. **Blank.**

Ordering resolves multi-group membership without a second rule: a display in both
Foyer and All-Building shows whichever schedule sits higher in the list. The
answer is readable off the screen, which is the point.

Blank is rendered by the signage view. The resolver never writes
`Output.blackout` — that field stays the operator's manual override, and a
scheduler that mutates config is a scheduler that fights its operator.

### 3.1a A playlist that cannot play

Two ways a chosen playlist yields nothing, both of which must be handled at the
resolver rather than crashing a wall screen:

- **No items.** `cycleMs` would be zero and §4.2's modulo would divide by it.
- **Every item's file is missing** — the state after restoring a snapshot that
  skipped video, or after a media file is lost.

In both cases the resolver **falls through to the next precedence step** rather
than emitting an unplayable entry: an empty scheduled playlist behaves as if that
schedule did not match, so the group default still gets its turn. Items whose
file is missing are dropped individually; a playlist keeps playing its surviving
items.

Both conditions are reported on the Now board and by `GET /api/signage/now`, so
an empty playlist is visible rather than silently ignored. Neither is logged and
swallowed.

### 3.2 Window activity

A separate pure module, `main/services/signage-window.ts`, exposing:

```ts
windowActiveAt(w: SignageWindow, atMs: number, tz: TimeZone, ctx: WindowCtx): boolean
nextBoundaryAfter(w: SignageWindow, afterMs: number, tz: TimeZone, ctx: WindowCtx): number | null
```

- `always` — always true, no boundary.
- `weekly` — active when the zoned weekday is in `days` and the zoned time is in
  `[start, end)`. When `end <= start` the window **wraps past midnight**, and the
  day tested is the day the window *started*: `22:00-02:00` on Thursday runs into
  Friday morning.
- `dates` — the zoned date is within `[from, to]` inclusive, and the weekly and
  time-of-day tests above pass.
- `once` — the zoned date equals `date` and the time test passes.
- `pco` — see §6.

Evaluating in the app zone means `05:00-13:00` is 05:00-13:00 local on both sides
of a DST change, and that a UTC host does not roll the date at 19:00 Chicago —
the failure that once stopped every recorder mid-service.

`nextBoundaryAfter` is what makes the scheduler cheap: it returns the next instant
at which this window's answer could change, so the server sets one timeout rather
than polling. For a `pco` window it returns the **scheduled** end; a live
extension is not a predictable instant, and is handled by the scheduler
recomputing when the live state changes.

---

## 4. The plan horizon

### 4.1 What is pushed

The SSE channel `signage:plan` carries `Record<outputId, SignageHorizon>`,
broadcast **only on change**.

```ts
export interface SignageHorizonEntry {
  from: number;                 // epoch ms
  until: number;                // epoch ms
  /** Absent means blank. */
  playlist?: {
    id: string;
    /** Cycle position is derived from this, so all displays agree. */
    startedAt: number;
    fit: SignageFit;
    transition: SignageTransition;
    items: {
      url: string;              // "/signage-media/<file>"
      mime: string;
      durationMs: number;
      fit: SignageFit;
      transition: SignageTransition;
      bytes: number;
    }[];
  };
  /** Why this entry is what it is — shown on the Now board and in the log. */
  reason: "override" | "schedule" | "default" | "blank";
  reasonLabel: string;          // e.g. the schedule's name
}

export type SignageHorizon = SignageHorizonEntry[];
```

The horizon covers the next **24 hours** as a contiguous, non-overlapping,
chronologically-ordered list. Every entry is fully resolved — URLs, durations,
transitions — so the kiosk performs no joins, matching why `resolvedByOutput`
exists.

A horizon rather than "what to show now" is what makes the rest work:

- The display switches itself at each boundary from its own clock, so the server
  pushes on **config change**, not on every boundary. That is less traffic than
  pushing the current item would be.
- A display knows what is coming, so it can prefetch it.
- A display knows when its window ends, so a boundary is a decision point rather
  than something only the server can see — which is what §4.5 hangs on.

### 4.5 A boundary only advances while connected

**At a horizon boundary, the display advances only if it currently has a server
connection. Disconnected, it holds the playlist it is on and loops it
indefinitely — it does not advance to a later entry, and it does not blank.**

On reconnect it takes the fresh horizon immediately and jumps to whatever is
correct now, using the playlist's normal transition.

This is deliberately not a timer or a grace threshold. A brief SSE blip that
resolves before the next boundary changes nothing at all, and there is no
disconnection duration to tune. The only question ever asked is "am I connected
*right now*, at this boundary".

Two consequences, both intended:

- A Pi taken offsite plays its content continuously and never dark, whatever its
  clock believes. This is the mobile-deployment case, and it is why the offline
  path does not depend on the clock at all.
- A server outage that spans a scheduled end leaves the current playlist up
  rather than blanking. A foyer TV still showing Sunday's welcome loop is a
  smaller failure than a wall of black screens, and the outage is the thing to
  fix.

A display that is *already blank* when it loses the server stays blank. Holding
what you are doing is the whole rule; a dark 2am screen must not light itself up
because the server rebooted.

### 4.2 Playback and multi-display sync

Playback is derived from the clock, never driven by messages:

```
cycleMs = sum(item.durationMs)
elapsed = now + skewMs - playlist.startedAt
pos     = elapsed % cycleMs
```

then walk the cumulative durations to find the item and its offset. Every display
resolving the same playlist computes the same answer, so two foyer TVs stay in
step with no extra traffic, and video's variable lengths fall out of the same
arithmetic. Clock skew reuses the `skewMs` displays already receive.

`startedAt` moves only when the resolved *playlist* changes for that output, so a
page reload does not restart the loop.

### 4.3 Scheduler

`main/services/signage-scheduler.ts` recomputes and broadcasts on:

- any signage store change,
- an override set or released,
- a PCO window refresh,
- a PCO live-state change,
- a timer set to the **earliest `nextBoundaryAfter` across all windows**, capped
  at 60 s as a safety net.

Broadcast is diffed against the last map and skipped when unchanged, and skipped
entirely when nothing is subscribed to `signage:plan` — the efficiency-first rule
for new integrations.

### 4.4 Prefetch

The display prefetches every asset in the **current** horizon entry, plus the
first item of the next, under a total byte cap (default 1 GB). Images through
`Image()` and `decode()`; video through a hidden element with `preload="auto"`.
Media is content-hashed and served `immutable, max-age=31536000`, so the browser
cache holds it.

Hitting the cap logs what was not prefetched. It does not silently fetch less.

---

## 5. Transitions

Configurable per playlist with a per-item override.

| Kind | Behaviour |
|---|---|
| `cut` | no transition |
| `crossfade` | outgoing fades out as incoming fades in |
| `fade-through-black` | outgoing to black, black to incoming |
| `slide` | incoming pushes in from `direction` |
| `wipe` | incoming revealed by an edge moving in `direction` |

Duration is free in `[0, 3000]` ms. Default: `crossfade` at 600 ms.

Two constraints the implementation holds to:

- **Only `opacity` and `transform` are animated,** so the compositor does the
  work and a Pi 4 holds 60 fps. `wipe` is a translating overlay, not an animated
  `clip-path`, because that repaints every frame.
- **A transition occupies the first `ms` of the incoming item's own slot.** So
  `cycleMs` stays the plain sum of item durations and §4.2's sync arithmetic is
  untouched.

Video keeps its transitions, but if the next clip is not buffered when its turn
comes it cuts instead of stuttering.

---

## 6. PCO-driven windows

`main/services/signage-pco-windows.ts` polls `pcoService.listUpcomingPlans` and
`listPlanTimes` for each service type named by an **enabled** `pco` schedule,
every 30 minutes, caching windows for today and tomorrow. Nothing polls when no
`pco` schedule exists.

A window for a service type on a given local day is:

```
[ firstPlanTime - leadMinutes , lastPlanTime + trailMinutes ]
```

over that day's plan times of `time_type = "service"`. When `liveExtension` is
set and PCO Live reports that service type live at the moment the window would
close, the window stays open until live ends.

The live extension makes the horizon's `until` for a `pco` entry *provisional*.
The horizon carries the scheduled `until`; when live extends past it the
scheduler recomputes and pushes a new horizon.

A display that has lost the server never acts on that boundary at all — by §4.5 it
holds its current playlist rather than advancing — so a stale provisional `until`
cannot cut a service short.

**When PCO is unreachable the last known windows are kept**, marked stale, and
surfaced in the Signage tab. Failing closed here means dark foyer TVs on a Sunday
because an API call timed out — the wrong trade. The failure is logged and
returned to the UI, never swallowed.

---

## 7. Overrides

Per group: pick a playlist, or blank. It beats every schedule and holds until
released. The Signage tab shows a persistent banner naming every active override
with a Release control, so a forgotten override is visible rather than
mysterious.

`POST /api/signage/groups/:id/override` sets one; `DELETE` releases it.

---

## 8. Media store

Bytes at `<userData>/signage-media/<sha256-16>.<ext>`, served at
`/signage-media/<file>` with immutable caching. The same content-addressed,
hash-verified shape as `layout-image-store.ts`, including rejecting a filename
that disagrees with its bytes.

**Upload** is `POST /api/signage/media` with a raw streamed body — not the JSON
body path, whose `MAX_CONFIG_BODY_BYTES` cap is far below a video. The request
streams to a temp file, hashing as it goes, then moves into place.

- Dimensions and video duration are measured **in the browser**
  (`Image.naturalWidth`, `HTMLVideoElement.duration`) and sent as headers, then
  range-clamped server-side: `w`/`h` to `[1, 65535]`, `durationMs` to
  `[100, 86_400_000]`. Anything outside, missing or unparseable is rejected, not
  defaulted — a zero duration would make `cycleMs` unusable. They are timing and
  layout hints rather than security boundaries, so client measurement is
  acceptable and avoids adding ffmpeg.
- Caps: **12 MB** for images, **200 MB** for video. Mime allowlist:
  `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `video/mp4`,
  `video/webm`.
- Identical bytes uploaded twice collapse to one file **and one record**; the
  response says which existing item it matched, rather than making a silent
  duplicate.

**SVG is deliberately excluded**, unlike `layout-image-store`. An SVG can carry
script, and a media library is uploaded by more people and served from more URLs
than a layout image is. Everything under `/signage-media/` is additionally served
with `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'; sandbox`, so a file opened directly
cannot execute in the app's origin whatever its bytes turn out to be. This
repository is public and the app runs on a church LAN; the cost of excluding SVG
is that a logo is uploaded as PNG.

**Pruning** mirrors layout images: a file is reaped only when no playlist
references it and it is older than a grace window.

---

## 9. Referential integrity

Deleting something in use is refused, naming what uses it — the same behaviour as
converting a View that screens are currently showing.

| Deleting | Behaviour |
|---|---|
| a playlist used by a schedule or as a group's default | **refused**, naming them |
| media used by a playlist | removes it from those playlists and **returns which ones changed** |
| a group used by a schedule | **refused**, naming the schedules |
| an output that is a group member | already deletable; it is removed from its groups and the change is reported |

No delete path logs-and-continues. A partial failure returns what failed and the
caller decides what to tell the operator.

---

## 10. The Signage tab

`/signage`, in `DESTINATIONS`, grouped under `Screens` in `NAV_GROUPS`. Five
sections.

**Now** — the board. Every group with what is playing, why (`reasonLabel`), a
live preview, and Take over · Blank · Release. Backed by `GET /api/signage/now`,
which returns the same resolver output, so the page and the diagnostic cannot
disagree. Shows the PCO staleness warning and the override banner.

**Media** — thumbnail grid, drag-and-drop upload with per-file progress, rename,
replace, delete, and where-used. Video tiles show duration and a poster frame
captured client-side at upload.

**Playlists** — list plus editor: drag-ordered items, per-item duration, fit and
transition override, playlist defaults, and an inline preview player driven by
the same component the display uses.

**Groups** — members picked from Outputs routed to a signage View, plus the
optional default playlist. "Add displays" creates the signage View and routes
the Output when needed, so nothing has to be set up by hand in Screens first.

**Schedule** — the ordered list, drag to reorder, each row showing name, enabled,
groups, playlist and a window summary, with the currently-winning row marked. The
window editor switches on `kind`.

Screens gets read-only group chips on signage outputs and a link across.

### 10.1 Rendering

`renderer/main/signage-player.tsx` is a standalone component taking a
`SignageHorizon` and rendering the current item. It is used by the `signage` View
kind, by the playlist editor's preview, and by the Now board's per-group preview.
Building it standalone also makes a future "signage playlist" custom-layout
object a wrapper rather than a rewrite.

Black ground always. Nothing on screen but the media.

---

## 11. Offline-capable displays

The horizon and prefetch already carry a display through a server restart or a
multi-hour outage, as long as the page does not reload. They cannot survive a
**reload or reboot**, because the app shell itself comes from the server.

Closing that needs five pieces, all Pi-side. None needs HTTPS.

**11.1 Secure context.** Service workers and `navigator.storage.persist()`
require a secure context, which `http://<server>:8788` is not. The kiosk launcher
generated by `scripts/kiosk/install-linux.sh` already interpolates the discovered
`$URL` at launch, so it gains:

```
--unsafely-treat-insecure-origin-as-secure="$URL"
```

Scoped to the kiosk browser, adapts if the server's address changes, needs no
certificate. Re-running the installer preserves the device id, so rolling this
out to existing Pis is non-destructive.

**11.2 Service worker.** Precaches the app shell and the current horizon entry's
assets into Cache Storage, and calls `storage.persist()` so Chromium will not
evict them. Feature-detected: where `navigator.serviceWorker` is absent —
macOS/Windows kiosks, a phone, a browser tab — everything in §4 still applies
unchanged.

Cache versioning is keyed on the build's version string, and the worker takes
control only after a successful shell fetch, so a bad deploy cannot strand a
screen on a broken cached app.

**11.3 Persisted horizon.** The last horizon is written to IndexedDB, so a cold
boot knows what to play and when before any network is available.

**11.4 Launcher fallback.** The launcher currently loops on UDP discovery and
will not start Chromium until a server answers, so a Pi with no server on the
network never launches a browser at all. It gains: persist the discovered URL to
`last-server` on success, and after ~30 s of failed discovery launch at that URL
instead of blocking. The service worker then serves the shell, and the page polls
for the server returning.

**11.5 Prepare for offline.** A per-group action that pushes a full horizon *and
the group's default playlist in full*, then reports each display's real cache
state — *34 of 34 assets · 812 MB · ready* — by having the display report its
Cache Storage contents back. This turns "I hope it cached" into something
verifiable before a Pi leaves the building.

**11.6 Booting with no server.** §4.5 says a disconnected display holds what it is
playing, but a display that *boots* offline has nothing to hold. It plays the
group's **default playlist** from the persisted horizon, looping indefinitely,
and starts consulting the schedule only once a server answers.

So a mobile deployment is configured by putting the Pi in a group, giving that
group a default playlist, and pressing Prepare for offline. It then plays that
playlist continuously, from a cold boot, with no network and no correct clock,
until it is plugged back into a server.

**No clock dependence offline.** Because §4.5 and §11.6 between them never
consult a window while disconnected, a Pi with a wrong clock cannot show the
wrong thing — it shows the playlist it was given. `fake-hwclock` keeping
approximate time across a reboot is a nicety, not a requirement.

**Known limit: a stale horizon.** A horizon is a snapshot. If a PCO plan time
moves during an outage, the display cannot know — and by §4.5 it will hold its
current playlist rather than acting on the stale entry, which is the safe
direction.

---

## 12. Backups

The four config stores ride in every snapshot via the registry.

Media bytes ride along **up to 12 MB per file** — which covers every graphic and
excludes video. `IMAGE_DIRS` in `config-snapshot.ts` gains `signage-media` with a
per-file size filter.

The restore report **names every file it skipped**, and Signage shows any media
record whose file is missing with a Re-upload affordance. Nothing goes missing
quietly.

---

## 13. API surface

`main/services/routes/signage-routes.ts`, registered in the route chain and
covered by the existing route-coverage test.

| Route | |
|---|---|
| `GET/POST /api/signage/media` | list; streamed upload |
| `PATCH/DELETE /api/signage/media/:id` | rename; delete with usage report |
| `GET/POST /api/signage/playlists` | |
| `PATCH/DELETE /api/signage/playlists/:id` | |
| `GET/POST /api/signage/groups` | |
| `PATCH/DELETE /api/signage/groups/:id` | |
| `POST/DELETE /api/signage/groups/:id/override` | |
| `POST /api/signage/groups/:id/prepare-offline` | |
| `GET/POST /api/signage/schedules` | |
| `PATCH/DELETE /api/signage/schedules/:id` | |
| `POST /api/signage/schedules/reorder` | the priority order |
| `GET /api/signage/now` | resolver output — the board and the diagnostic |
| `POST /api/signage/cache-report` | a display reporting its cached assets |
| `GET /signage-media/:file` | static, immutable |

---

## 14. Testing

Pure-function tests, then the real thing. Every guard is proven red in-session
before its fix lands.

**Pure**

- `signage-window` — weekly midnight wrap; a window spanning a DST change in
  `America/Chicago` in both directions; `dates` inclusivity at both ends; `once`;
  `nextBoundaryAfter` returning the true next change for each kind.
- `signage-resolve` — override beats schedule; most-recent override wins; schedule
  list order decides between two matching schedules; an output in two groups
  resolves by schedule order; the group default only when no schedule matches;
  blank otherwise; `startedAt` stable across a recompute that did not change the
  playlist.
- Boundary behaviour — a boundary reached while connected advances; the same
  boundary reached while disconnected holds the current playlist and does not
  blank; a display already blank at disconnection stays blank; reconnecting
  jumps straight to the correct entry.
- Player cycle math — position within a cycle; mixed image and video durations;
  a one-item playlist; a transition consuming the head of an item's slot without
  changing `cycleMs`.
- PCO windows — lead and trail around plan times; live extension holding a window
  open and releasing it; last-known windows kept when the fetch fails.

**Stateful, against a real server on port 8799 with a copy of a real config**

- Upload an image and a video; verify hashes, caps, mime rejection (including
  SVG), the dimension and duration clamps, the `nosniff` and CSP headers, and
  that a duplicate collapses to one record.
- An empty playlist and a playlist whose files are missing both fall through to
  the group default rather than putting an unplayable entry on a screen.
- A real enrolled signage output plays, blanks outside its window, switches on
  override, and resumes correctly after a server restart.
- With the server stopped, a display carried across a horizon boundary keeps
  playing instead of blanking, and jumps to the correct entry when the server
  comes back. This is §4.5's whole claim and is not provable from unit tests.
- A Pi prepared for offline, rebooted with the server unreachable, comes up
  playing its group's default playlist. Covers the launcher fallback, the service
  worker's shell cache and the persisted horizon in one pass — the three of them
  only work as a chain.
- Delete a playlist in use and confirm the refusal names the schedules.
- Take a config snapshot and restore it; confirm the manifest is intact, files
  under 12 MB return, and the skipped list names the video.

**Browser-measured**, per the repo's convention for anything with layout: the
player's fit modes and each transition, measured rather than asserted from
classnames.

---

## 15. Phases

One branch, `feat/signage`. Complete before it merges.

1. Media store, streamed upload, static serve, Media section.
2. Playlists, the player component, the editor preview.
3. Groups, the `signage` View kind, rendering on a real enrolled screen.
4. Schedules, the resolver, the scheduler, the `signage:plan` horizon.
5. PCO windows and the live extension.
6. Overrides and the Now board.
7. Backups, referential integrity, Screens integration, docs.
8. Offline-capable displays — kiosk flag, service worker, persisted horizon,
   launcher fallback, boot-offline default playlist, Prepare for offline.

The hold-at-boundary rule (§4.5) belongs to phase 4, not phase 8. It needs no
service worker and no Pi changes, so every client gets outage tolerance as soon
as the horizon exists.

---

## 16. Out of scope

Named rather than dropped silently:

- **Shuffle.** Deterministic sync needs a seeded shuffle keyed on cycle number.
  Cheap to add later; not needed to ship.
- **Ken Burns / motion on stills.** A per-item effect, not a transition.
- **A "signage playlist" custom-layout object.** The player is built standalone
  so this becomes a wrapper, but signage ships as a View kind first.
- **HTTPS for the app.** It would remove the whole insecure-context class of
  bugs, but it needs a real certificate to avoid warning every phone that scans a
  QR code, makes renewal a Sunday-morning failure mode, and moves the port-80
  friendly URL, the installer one-liners, the discovery reply and the Companion
  module. Worth doing on its own merits; not a dependency of signage, which uses
  the kiosk browser flag instead.
- **Per-display content within a group.** Groups of one cover it.
