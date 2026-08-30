# ProVideoPlayer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read ProVideoPlayer's transport state over its HTTP Network API and surface it in three places — a custom layout object, a Home card, and a full set of automation triggers, conditions and actions — with every action verified by reading the state back.

**Architecture:** One polling integration (`StatusIntegration`, the REAPER shape) fetches `GET /api/0/transportState/workspace` once per tick and folds it with a pure `parseWorkspace` into a per-layer DTO. It broadcasts on `pvp:status` only when the layer *state* changes, when the progress clock drifts off its last anchor, or on a slow keepalive — never once per poll. Both renderer surfaces compose one shared `PvpLayerRow`, so the layout object and the Home card are two sizes of the same thing. Every write action posts and then re-reads `transportState` to prove it landed.

**Tech Stack:** TypeScript, React, node:test, existing `StatusIntegration` / `settingsStore` / `secretsStore` / SSE plumbing. **No new npm dependencies. No new persisted store.**

**Research:** `docs/superpowers/research/2026-08-29-provideoplayer.md` — every field, size and behaviour was observed live on 2026-08-29 over 702 polled samples plus authorised POST testing. Its "Unverified" section is binding: where it says something was not observed, this plan either verifies it in a step or says plainly that it is building without it.

**Branch:** `feat/pvp`, off `beta` (`af64294`).

---

## The three facts that shape every surface

Stated first because a plan that forgets any one of them produces a widget that lies.

**1. There is no picture.** All 80 documented paths were enumerated and every synonym grepped: PVP has no thumbnail, preview, frame or screenshot endpoint. **Every surface this integration can offer is text, state and progress.** "Visualize the current playing content" is answerable only as *name it and time it*, never as *show it*. This goes into `docs/integrations/provideoplayer.md` in Task 7 so an operator reads it as a stated limit rather than discovering it.

**2. `playingItem` is residual and must never be rendered as "now playing".** Four idle layers simultaneously reported the same `playingItem` name while displaying nothing. It is the last cue that *touched* the layer and it never clears. The only reliable has-content signal is the **presence** of the `playingMedia` key — absent, not null, when a layer holds nothing.

**3. `isPlaying: true` does not mean a video is rolling.** A still image reported `isPlaying: true` with `playbackRate: 0` and `timeRemaining: 0`. The three-way test the UI actually needs:

| State | Test |
|---|---|
| Nothing on this layer | `playingMedia` absent |
| A still graphic | `playingMedia` present and `playbackRate === 0` |
| A rolling video | `playbackRate > 0` |

`isPlaying` is not read by this integration at all. It is not on the DTO, because a DTO field nothing branches on is a field somebody will branch on wrongly.

---

## Decision 1 — the efficiency decision, and why `emitIfChanged` cannot be used as it stands

`timeElapsed` and `timeRemaining` change on **every single poll** during playback. There are two ways to handle that and this plan takes the first.

**Taken: exclude them from the change comparison and interpolate on the client.**

The precedent is in this repo and is explicit. `main/services/live-poller.ts:42`:

> `serverNow` is deliberately excluded: it changes every tick but the client ticks the countdown itself from `targetAt`/`liveStartAt` + its own clock, so re-pushing it every second is pure overhead. We broadcast only when one of these changes (plus a slow keepalive for clock re-sync).

`LIVE_KEEPALIVE_MS = 15_000` there. PVP takes the same constant and the same shape: the DTO carries `sampledAt`, `anchorElapsedSec` and `durationSec`; those three are **not** in the change signature; and `renderer/main/pvp-progress.ts` derives the live number from `(layer, sampledAt, now, skewMs)` the way `pco-timer.ts` derives the countdown. `now` and `skewMs` are already threaded into every render surface (`layout-renderer.tsx:2425-2433`, and `LayoutRenderCtx.now` / `.skewMs`), so the progress bar needs no new plumbing at all.

**Rejected: accept the frame rate.** REAPER does this — `docs/integrations/reaper.md` says it "broadcasts on change (and each second while recording, to tick the position display)" — and it is defensible there, because REAPER's DTO is six scalars for one recorder and at most one widget reads it. PVP's DTO is an array of eleven layer objects, and a wall can carry nine tiles of it. A 1 Hz push of that to every connected display for the whole of a pre-service loop is exactly the standing efficiency rule's target case.

### The trap: `emitIfChanged` is a shallow `!==` and the DTO carries an array

`main/services/integration-base.ts:203-212` compares every key of the DTO with `!==`. `layers` is a fresh array on every poll, so `prev.layers !== next.layers` is **always true** and the base implementation would broadcast at the poll rate no matter which fields were in it. Excluding `timeElapsed` from the DTO would not help on its own.

So `PvpService` **overrides `emitIfChanged`** with a signature compare, the way REAPER overrides it for the opposite reason. This is not optional and it is the easiest thing in the whole integration to get wrong. Task 2 ships a test that fails if the override is removed.

### The three reasons a frame is sent

1. **The signature changed.** `layerSignature()` covers layer uuid, name, index, state, media uuid, last cue name, hidden, muted, opacity and playbackRate. Nothing time-varying.
2. **The progress clock drifted.** Predict where `timeElapsed` should be from the last anchor we sent and the elapsed wall time, compare with what PVP now reports, and re-anchor when the two differ by more than a second. This is what catches a **loop restarting on the same media uuid** (predicted 20.5, observed 0.3), a scrub, a seek and a pause. Without it a looping single clip would sit at 100% for up to a keepalive.
3. **The keepalive.** 15 s, so a client's anchor and its clock-skew estimate cannot go stale, and a display that connects between changes is fresh.

**Frame budget.** A pre-service playlist advancing every 20 s at a 1 Hz poll: ~3 media-change frames per minute plus 4 keepalives ≈ 7 frames/minute, against 60 for a 1 Hz push. An idle workspace: 4 frames/minute.

**What the decision cost.** One trigger changed shape. The research proposed *"playback reaches its end"* derived from `timeRemaining` crossing 0 — but `timeRemaining` is deliberately not broadcast, so the engine, which only ever sees broadcast frames, cannot watch it cross. The trigger ships as **`pvp.playback-stopped`**: a layer that was rolling (`playbackRate > 0`) is no longer rolling. Same moment on the wall, and observable on a frame this design actually sends. Recorded again in Self-Review.

---

## Decision 2 — every action verifies, because a 200 proves nothing

From authorised live POST testing (research §4.1): **every POST returns HTTP 200 with an entirely empty body**. No echo of the applied value, no confirmation, nothing to read. That half of the finding is unchanged by the §4.2 correction and is the whole reason this design exists — a 200 tells you the request arrived and nothing else.

An action that reports success while doing nothing is the worst failure this repo has a rule about. CLAUDE.md: *"A new `catch` either rethrows or returns the failure to its caller"*, and *"an archive import reported success having written nothing"*. Treating a 200 as proof is that failure in a new costume — a rule would appear to run, log `fired`, and never touch a screen.

**So every PVP action goes through one method that posts, re-reads `transportState/workspace`, and asks a caller-supplied predicate whether the world now looks the way the write claimed.** A predicate that says no returns `{ ok: false, detail }`, which `automation-engine.ts:192-210` records as outcome `failed` (red in the Activity log) and `automation-section.tsx:358` surfaces as a toast on Test fire. The code is in Task 6, Step 1.

Two details that matter:

- **No fixed settle sleep.** Nothing has measured how long PVP takes to apply a POST before the next GET reflects it, so a single guessed number would be building on an unverified value — and worse, would make "no effect" and "read too early" look identical. The verifier re-reads up to four times at 150 ms intervals and succeeds on the first read that confirms: bounded at 600 ms, correct whatever the real settle time is.
- **A read that fails is a failure, not a success.** If the write goes out but the confirming read throws, the result is `{ ok: false, detail: "sent, but could not read the state back to confirm it: …" }`. We cannot say it worked, and saying so is the exact thing this path exists to prevent.

---

## Decision 3 — triggering cues, now that Task 0 is settled

**Task 0 has been run by the operator and every one of the five addressing forms fires.** Research §4.2 records the measurement, and it supersedes the rest of this plan wherever the two disagree — this section, Task 0 and the Self-Review were all written while four forms were wrongly believed to be no-ops, and have been rewritten here to match the evidence.

The original result was a measurement error twice over: the before/after `transportState` reads were taken within the same second, and PVP applies a change a beat after the 200; and the retest asked "did the media change at all", which is unanswerable while a pre-service playlist auto-advances every 20 seconds. Re-measured by asking **"did the media become the media of the cue I asked for"**, cues 4, 9, 2 and 11 each landed on exactly the cue requested.

So `pvp.trigger-cue` ships, addressed as `/trigger/playlist/{playlist}/cue/{cue}` by name.

**SETTLED AFTER THE FACT (research §4.3): the layer argument is ignored.** `/trigger/layer/{l}/playlist/{p}/cue/{c}` fires and plays the cue on the cue's OWN configured layer whatever layer is named. Re-measured against three different empty layers with three different cues — all three landed on layer 0, and the three named layers stayed empty, which is the control that rules out one layer refusing one file.

This plan originally shipped that form as `pvp.trigger-cue-on-layer` with a verify asking about the named layer, reasoning that a failure report was "the design working". It is not shippable: the action fires a real cue, changes what is on screen, and *then* reports a failure — a side effect logged as a no-op, which invites a retry that fires it again. **The action was removed.** Which layer a cue plays on is set in ProVideoPlayer, and nothing here can change it.

**What did NOT change, and is the half that shaped every other decision in this plan:** a POST returns HTTP 200 with an empty body whether or not anything happened. Every action still verifies by reading state back. Decision 2 needs no revision.

---

## Global Constraints

- **No emojis anywhere** — UI, code, comments, commit messages, PR body. **No Claude attribution footer in any commit.**
- **Public repo.** No LAN addresses, no API tokens, no church name, no real service-type ids, no real layer or media names in code, tests, fixtures or docs. Use `PVP_HOST` / `PVP_PORT` placeholders in prose, and neutral synthetic names in the fixture.
- **The API token is a SECRET.** `SECRET_KEYS.pvp = ["token"]`, so it lives in `secrets.bin` via `secretsStore` — never in a config `DataStore`, never in `settings.json`, never in a log line. `config-snapshot.test.ts:158-163` already asserts `secrets.bin` is never in a snapshot; the token inherits that.
- **No new persisted store.** Verified: REAPER's host and port live in `settings.json` under `settings.integrationConfigs`, reached through the descriptor's `configSchema` (`integration-manager.ts:748-755`). PVP is the same shape, so **`EXPECTED_CONFIG` in `main/services/config-snapshot.test.ts` does not move.** If a later change gives PVP its own target list (the `osc-targets.json` shape), that store is `"config"`-classified, imported from `main/services/stores.ts`, and added to `EXPECTED_CONFIG` in the same commit. Nothing in this plan does.
- **Every new `catch` rethrows or returns the failure to its caller.** A poll failure reaches the operator through `this.report("error", …)`; an action failure through `ActionResult { ok: false, detail }`. There is no `catch` in this plan that only logs.
- **Gate on `inDemand`, not `hasSubscribers`.** PVP has triggers that read `pvp:status`, so a `hasSubscribers` gate would silently disable every one of them on an unattended appliance — the bug `integration-base.ts:114-127` records. Also register `pvpService.addDemandSource(() => automationEngine.wantsChannel("pvp:status"))` beside the four existing registrations at `automation-engine.ts:285-291`; without it `inDemand` never becomes true for a rule-only consumer and the gate is decorative.
- **Numeric settings fields use the themed `NumberInput`** (`renderer/components/ui/number-input.tsx`). Both places this matters are already compliant by construction: the integrations panel routes `ConfigField.type: "number"` to it (`integrations-panel.tsx:360`), and the automation param renderer routes `ParamDef.type: "number"` to it (`automation-section.tsx` `ParamField`). No raw `<input type="number">` appears anywhere in this diff.
- **Every guard ships with a named mutation that makes it go red.** Delete the guard or reintroduce the bug, watch it fail in-session, and name the mutation in the commit message.
- **Exact counts, not floors.** Two new layout object types move six numeric assertions; the table is below.
- **Time.** This integration reads no calendar and makes no "is it Sunday" judgement, so `app-timezone.ts` is not involved. The only clock it reads is `Date.now()` for anchor arithmetic, which is a duration, not a date.
- **PR-only.** Three review passes (correctness, simplification, whole-PR) before opening. Never push to `beta`/`main`. Henry merges.

### The exact-count assertions this plan moves

Two new layout object types (`pvp-layers`, `home-pvp`), each value read from the file on `beta` rather than guessed:

| File | Assertion | From | To |
|---|---|---|---|
| `renderer/main/object-catalog.test.ts:19` | `TYPES.length` | 54 | 56 |
| `main/types/object-capabilities.test.ts:20` | `Object.keys(CAPABILITIES).length` | 54 | 56 |
| `renderer/main/object-fit.test.ts:34` | `Object.keys(CAPABILITIES).length` | 54 | 56 |
| `renderer/main/object-look.test.ts:60` | `all.length` | 54 | 56 |
| `renderer/main/object-look.test.ts:61` | `all.filter(hasCard).length` | 29 | 30 |
| `renderer/app/home/home-card-routing.test.ts:25` | `HOME_TYPES.length` | 12 | 13 |

`pvp-layers` is carded (hence 29 → 30). `home-pvp` is bare, so it joins `HOST_FRAMED_TYPES` (`renderer/main/layout-objects.ts:135`, 12 entries) **and** the `BARE` list (`object-look.test.ts:19-37`, 25 entries → 26). Those two are asserted equal at `object-look.test.ts:196-203`, and `object-look.test.ts:62` asserts `!hasCard` count `=== BARE.length`, so adding the name to `BARE` satisfies line 62 with no number to bump. `renderer/main/layout-objects.test.ts:328` `ADDED_SINCE` (19 entries) takes two appended entries, each `{ type, label, group, after }`, and `layout-objects.test.ts:434-450` asserts the `after` ordering is real.

`renderer/main/widget-docs.test.ts:48-63` compares bolded labels in `docs/reference/widgets.md` against the registry **in both directions**; that file has exactly 54 bolded rows today, so two new rows are mandatory and must match the labels verbatim.

Moved but computed rather than hard-coded — no edit needed, listed so nobody is surprised when they fail for the right reason:

| File | Assertion | Why it moves |
|---|---|---|
| `main/services/integration-ids.test.ts:60-65` | `CONNECTION_MANAGED_IDS.length + NOT_CONNECTION_MANAGED.size === INTEGRATION_IDS.length` | 9 + 5 = 14 becomes **10 + 5 = 15**. Green only if `"pvp"` is added to **both** id lists. |
| `main/services/automation-coverage.test.ts:62-65` | `INTEGRATIONS.map(i => i.id).sort()` deep-equals `[...INTEGRATION_IDS].sort()` | Adding to one list without the other is red. |
| `main/services/automation-coverage.test.ts:75-84` | every trigger's channel is in `BROADCAST_CHANNELS` | `"pvp:status"` must be added to that set (`:23`, 20 entries → 21). |
| `renderer/lib/hydrated-channels.test.ts` | server `sseWrite` literals ⇄ `HYDRATED_CHANNELS`, both directions | The hello burst (20 calls) and the replay list (20 names) move together. The channel name must be a **string literal** in `remote-server.ts` — the scan is a regex over the file text and cannot see a constant. |
| `renderer/app/home/home-cards.test.ts:74-79` | every registry type's `defaultSize` is in `SIZE_ORDER` | `home-pvp` declares `homeSize: "m"`, which is in the list. |
| `renderer/main/object-catalog.test.ts:48-53` | every `PALETTE_GROUP_ORDER` group has at least one type | The new `"ProVideoPlayer"` group holds both new types. |

### Six key names that must NOT appear on a PVP config

`renderer/app/home/card-toggles.ts:34-56` declares `APPLIES` with `satisfies { [K in ToggleKey]: Record<TypesWith<K>, true> }`, where `TypesWith<K>` is every object type whose config carries key `K`. Naming a PVP config field `hideWhenIdle`, `showPosition`, `showElapsed`, `showTimecode`, `fillWhenLive`, `fillWhenRecording`, `showSeconds`, `format`, `showMeridiem` or `warnStates` makes that record non-exhaustive and breaks `tsc` until PVP is listed there.

This plan uses **`hideWhenEmpty`** and **`showProgress`**, which collide with nothing. Deliberate, not evasive: PVP's "nothing on this layer" is not the recorders' "nothing is going out", and reusing their key to inherit a free Home toggle would put two different meanings behind one word.

`renderer/main/status-fill-parity.test.ts` is likewise untouched, because neither new object carries a `fillWhen*` key. That is a decision: PVP's object is a **list of layers**, not a one-word status slab, so there is no whole-box fill for it to be in parity about. `renderer/main/captions.test.ts` is untouched for the same reason — neither config carries a `caption`.

---

## File Structure

**Server**

| File | Responsibility |
|---|---|
| `main/types/pvp.ts` (new) | `PvpLayerDTO`, `PvpStatusDTO`, `PvpLayerState`, `PVP_OFFLINE`. Shapes only, no logic. |
| `main/services/pvp-parse.ts` (new) | Pure. `parseWorkspace`, `layerSignature`, `anchorDriftSec`, `driftedLayers`. No I/O, no clock. |
| `main/services/pvp-service.ts` (new) | `StatusIntegration<PvpStatusDTO>`. The timer, the HTTP, the `emitIfChanged` override, and `command()` — the post-then-verify method every action goes through. |

Split this way because `pvp-parse.ts` is where the three findings live — residual `playingItem`, `playingMedia` presence, `playbackRate` over `isPlaying` — and each has to be testable against a saved fixture with no network. The drift arithmetic sits beside them for the same reason: "should this frame be sent" is a pure function of two snapshots and two timestamps, and it is the half of the efficiency decision that can actually be got wrong.

**Renderer**

| File | Responsibility |
|---|---|
| `renderer/main/use-pvp-state.ts` (new) | Mirrors `use-reaper-state.ts` exactly, including the `enabled` gate. |
| `renderer/main/pvp-progress.ts` (new) | Pure. `computePvpProgress(layer, sampledAt, now, skewMs)`. Mirrors `pco-timer.ts`. |
| `renderer/main/pvp-layer-row.tsx` (new) | **The one component both surfaces render.** Name, cue, badges, progress bar. |
| `renderer/main/pvp-object.tsx` (new) | The custom layout object body — filter mode, then a stack of rows. |

`PvpLayerRow` exists because the residual-cue rule has to live in exactly one place. With a component per surface there would be two chances to draw a stale cue name on an empty layer, and CLAUDE.md names fixing a shape in one of the places it exists as the most expensive recurring mistake in this repo.

---

## Task 0: Pre-flight — SETTLED, do not re-run

**The operator ran this and the answer is in research §4.2. Nothing here is
outstanding.** This section is kept rather than deleted because the rest of the
plan refers to it, and because the way the first measurement went wrong is worth
carrying forward.

**Result: all five trigger addressing forms fire, and each lands on the cue asked
for.** Controlled against the obvious alternative — that any trigger merely
resets to the top of the playlist — by requesting cues 4, 9, 2 and 11 in turn and
getting exactly those.

| Form | Result |
|---|---|
| `/trigger/cue/{n}` (current playlist) | fires |
| `/trigger/playlist/{name}/cue/{n}` | fires |
| `/trigger/playlist/{uuid}/cue/{n}` | fires |
| `/trigger/playlist/{index}/cue/{n}` | fires |
| `/trigger/layer/{l}/playlist/{p}/cue/{c}` | fires |

**How the first pass got it wrong**, because the same two mistakes are available
to anyone re-measuring anything against PVP:

1. **PVP has apply latency.** The change lands a beat after the 200. Reading
   `transportState` immediately before and immediately after the POST, inside the
   same second, sees nothing and reads that as proof of nothing. Re-read with
   retries; never once, immediately.
2. **"Did it change" is the wrong question** while a playlist auto-advances every
   20 seconds — a change may be the trigger or may be the loop. The answerable
   question is **"did it become the thing I asked for"**.

**The one genuine no-op, and the only thing still open:** sending a cue to a
specific *empty* layer via `/trigger/layer/{l}/playlist/{p}/cue/{c}` did not put
content on that layer. Unknown whether the layer argument is ignored or the layer
refused that media. Task 6 exposes the form as its own action and lets the
verifier catch it; nothing in this plan relies on the layer argument redirecting
a cue.

**Unchanged, and the half that shaped the design:** a POST returns HTTP 200 with
an empty body whether or not anything happened. Every action must still verify by
reading state back and return a real failure when the read does not confirm the
write.

**Not settled, and not settled by this branch either** — the two smaller unknowns
the original Task 0 also proposed to answer:

- `/clear/layer/{id}` against a layer holding content. Only the empty case was
  ever tested. The action ships anyway, because it verifies: if the clear does
  nothing, the rule reports a failure rather than a success.
- `isHidden`, `isMuted` and `opacity < 1` read back off a real workspace. Every
  observed layer was visible, unmuted and fully opaque. These are synthesised into
  the fixture (layer 4) so the renderer branch is exercised by something, and the
  docs say the live path is unobserved.

## Task 1: The types and the pure fold

**Files:**
- Create: `main/types/pvp.ts`
- Create: `main/services/pvp-parse.ts`
- Create: `main/services/pvp-parse.test.ts`
- Create: `main/services/fixtures/pvp-workspace.json`
- Modify: `main/types/stage.ts`
- Modify: `renderer/types.d.ts`

**Interfaces:**
- Produces: `PvpLayerState`, `PvpLayerDTO`, `PvpStatusDTO`, `PVP_OFFLINE`; `parseWorkspace(json): PvpLayerDTO[]`, `layerSignature(layers): string`, `anchorDriftSec(prevElapsed, prevAtMs, nextElapsed, nextAtMs, rate): number`, `driftedLayers(prev, next, toleranceSec): string[]`.
- Consumes: nothing.

- [ ] **Step 1: Write `main/types/pvp.ts`**

```ts
// pvp.ts — the shapes the ProVideoPlayer integration speaks.
//
// Every field here was observed live on 2026-08-29; see
// docs/superpowers/research/2026-08-29-provideoplayer.md. Fields that research
// could not observe are NOT here — a DTO field nothing ever fills is a renderer
// branch that is never exercised.
//
// `isPlaying` is deliberately absent even though PVP sends it. A still image
// reports isPlaying: true with playbackRate: 0, so it means "this layer is live",
// not "time is advancing" — and a field whose name says the opposite of what it
// means is one somebody will read wrongly. playbackRate answers the real question.

/**
 * What a layer is doing, as the UI actually needs it.
 *
 * "empty" is decided by the ABSENCE of `playingMedia`, not by any of the flags.
 * `playingItem` is residual — four idle layers were observed simultaneously
 * naming the same cue while showing nothing — so nothing about it can decide
 * whether a layer holds content.
 */
export type PvpLayerState = "empty" | "still" | "video";

export interface PvpLayerDTO {
  /** PVP's layer uuid. The diff key for every trigger and the address for every
   *  action. NOT the index: layer order is presentation, and an operator
   *  reordering layers would read as every layer changing at once. */
  uuid: string;
  /** The layer's own name, as PVP shows it. */
  name: string;
  /** Position in the workspace's layer stack, as PVP returns them. Display order
   *  only — nothing keys on it. */
  index: number;
  state: PvpLayerState;
  /** File name of the media on this layer, or null when the layer is empty. */
  mediaName: string | null;
  /**
   * Media uuid, or null when empty.
   *
   * The change key for "a cue started". Not the media NAME: the observed
   * workspace had seven files whose names differed only by a trailing digit, and
   * two cues in different playlists can point at the same file.
   */
  mediaUuid: string | null;
  /**
   * The LAST cue that touched this layer. Never "now playing".
   *
   * Kept raw, including on an empty layer where it is stale by definition,
   * because it is the only field that can confirm a trigger action landed. The
   * single place that decides whether to DRAW it is PvpLayerRow, which draws it
   * only when `state !== "empty"`.
   */
  lastCueName: string | null;
  hidden: boolean;
  muted: boolean;
  /** 0..1. PVP silently CLAMPS an out-of-range value it is sent rather than
   *  rejecting it, so this is clamped on read too and the two agree. */
  opacity: number;
  /** 0 for a still or a paused clip, > 0 while a video is rolling. */
  playbackRate: number;
  /**
   * `timeElapsed` at the moment of the sample, or null when there is nothing to
   * time. The ANCHOR the client interpolates from — deliberately excluded from
   * the change signature, so it rides only on frames that were being sent anyway.
   */
  anchorElapsedSec: number | null;
  /**
   * timeElapsed + timeRemaining, or null when nothing is rolling.
   *
   * Both halves are given, so a progress bar needs no duration lookup. Null for a
   * still, whose timeRemaining is 0 and whose "duration" would be a meaningless
   * echo of its elapsed.
   */
  durationSec: number | null;
}

export interface PvpStatusDTO {
  connected: boolean;
  layers: PvpLayerDTO[];
  /**
   * Server clock when this sample was taken (ISO), so a client can anchor the
   * progress bar and correct for its own drift.
   *
   * Excluded from the change signature for the reason live-poller.ts:42 excludes
   * serverNow: it moves every tick, and re-pushing it every second is pure
   * overhead when the client can tick the number itself.
   */
  sampledAt: string | null;
}

export const PVP_OFFLINE: PvpStatusDTO = { connected: false, layers: [], sampledAt: null };
```

- [ ] **Step 2: Write the fixture, `main/services/fixtures/pvp-workspace.json`**

Synthetic, deliberately. The real workspace's layer and media names identify a specific church and this repository is public — so the names are neutral while the *shapes* are exactly the two key sets observed across 702 samples.

```json
{
  "data": [
    {
      "transportState": {
        "isPlaying": true,
        "isScrubbing": false,
        "playbackRate": 1,
        "timeElapsed": 9.6,
        "timeRemaining": 10.4,
        "playingItem": { "name": "MAIN GRAPHIC", "uuid": "cue-0001" },
        "playingMedia": { "name": "loop_a.mp4", "uuid": "media-0001" },
        "layer": { "name": "Graphics", "uuid": "layer-0001", "isHidden": false, "isMuted": false, "opacity": 1 }
      }
    },
    {
      "transportState": {
        "isPlaying": true,
        "isScrubbing": false,
        "playbackRate": 0,
        "timeElapsed": 0,
        "timeRemaining": 0,
        "playingItem": { "name": "LOWER THIRD", "uuid": "cue-0002" },
        "playingMedia": { "name": "still_b.png", "uuid": "media-0002" },
        "layer": { "name": "Lower third", "uuid": "layer-0002", "isHidden": false, "isMuted": false, "opacity": 1 }
      }
    },
    {
      "transportState": {
        "isPlaying": false,
        "isScrubbing": false,
        "playbackRate": 0,
        "timeElapsed": 0,
        "timeRemaining": 0,
        "playingItem": { "name": "MAIN GRAPHIC", "uuid": "cue-0001" },
        "layer": { "name": "Exit screen", "uuid": "layer-0003", "isHidden": false, "isMuted": false, "opacity": 1 }
      }
    },
    {
      "transportState": {
        "isPlaying": false,
        "isScrubbing": false,
        "playbackRate": 0,
        "timeElapsed": 0,
        "timeRemaining": 0,
        "playingItem": { "name": "MAIN GRAPHIC", "uuid": "cue-0001" },
        "layer": { "name": "Hidden layer", "uuid": "layer-0004", "isHidden": true, "isMuted": true, "opacity": 0.5 }
      }
    }
  ]
}
```

Layer 3 is the residual-`playingItem` case verbatim: it names a cue it is not showing, with `playingMedia` **absent** rather than null. Layer 4 carries the hidden / muted / half-opacity combination the research says has never been seen live — synthesised on purpose, so the renderer branch that handles it is exercised by something.

- [ ] **Step 3: Write the failing tests, `main/services/pvp-parse.test.ts`**

```ts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { parseWorkspace, layerSignature, anchorDriftSec, driftedLayers } from "./pvp-parse.js";
import type { PvpLayerDTO, PvpStatusDTO } from "../types/pvp.js";

const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/pvp-workspace.json", import.meta.url), "utf8"),
);

function byName(layers: PvpLayerDTO[], name: string): PvpLayerDTO {
  const l = layers.find((x) => x.name === name);
  assert.ok(l, `no layer named ${name}`);
  return l;
}

describe("parseWorkspace", () => {
  test("reads every layer in the workspace", () => {
    assert.equal(parseWorkspace(FIXTURE).length, 4);
  });

  test("a layer with a rolling video is 'video'", () => {
    const l = byName(parseWorkspace(FIXTURE), "Graphics");
    assert.equal(l.state, "video");
    assert.equal(l.mediaName, "loop_a.mp4");
    assert.equal(l.mediaUuid, "media-0001");
    assert.equal(l.playbackRate, 1);
  });

  test("a still image is 'still', NOT 'video', even though PVP says isPlaying", () => {
    // The finding this test exists for: a still reports isPlaying: true with
    // playbackRate: 0. Reading isPlaying would call it a rolling video.
    const l = byName(parseWorkspace(FIXTURE), "Lower third");
    assert.equal(l.state, "still");
    assert.equal(l.playbackRate, 0);
  });

  test("a layer with NO playingMedia key is empty, whatever else it says", () => {
    const l = byName(parseWorkspace(FIXTURE), "Exit screen");
    assert.equal(l.state, "empty");
    assert.equal(l.mediaName, null);
    assert.equal(l.mediaUuid, null);
  });

  test("an empty layer still carries its residual cue name, for verification", () => {
    // Kept, not nulled: it is the only field that can confirm a trigger landed.
    // PvpLayerRow is the one place that refuses to DRAW it — see its own test.
    assert.equal(byName(parseWorkspace(FIXTURE), "Exit screen").lastCueName, "MAIN GRAPHIC");
  });

  test("duration is elapsed + remaining for a video, and null for a still", () => {
    const layers = parseWorkspace(FIXTURE);
    assert.equal(byName(layers, "Graphics").durationSec, 20);
    assert.equal(byName(layers, "Graphics").anchorElapsedSec, 9.6);
    // A still's timeRemaining is 0, so a "duration" would just echo its elapsed.
    assert.equal(byName(layers, "Lower third").durationSec, null);
  });

  test("an empty layer has no anchor and no duration", () => {
    const l = byName(parseWorkspace(FIXTURE), "Exit screen");
    assert.equal(l.anchorElapsedSec, null);
    assert.equal(l.durationSec, null);
  });

  test("hidden, muted and part-opacity are read", () => {
    // Never observed live on a real workspace — synthesised so the renderer
    // branch that handles it is exercised by something.
    const l = byName(parseWorkspace(FIXTURE), "Hidden layer");
    assert.equal(l.hidden, true);
    assert.equal(l.muted, true);
    assert.equal(l.opacity, 0.5);
  });

  test("opacity is clamped, because PVP itself clamps what it is sent", () => {
    const high = parseWorkspace({ data: [{ transportState: { layer: { uuid: "a", name: "A", opacity: 5 } } }] });
    assert.equal(high[0].opacity, 1);
    const low = parseWorkspace({ data: [{ transportState: { layer: { uuid: "b", name: "B", opacity: -2 } } }] });
    assert.equal(low[0].opacity, 0);
  });

  test("a missing opacity is fully opaque, not zero", () => {
    // Defaulting to 0 would render every layer of a build that omits the field
    // invisible, and the badge row would claim every layer was faded out.
    const l = parseWorkspace({ data: [{ transportState: { layer: { uuid: "c", name: "C" } } }] });
    assert.equal(l[0].opacity, 1);
  });

  test("garbage never throws and never yields NaN", () => {
    for (const junk of [null, undefined, {}, { data: null }, { data: "nope" }, { data: [null, 3, {}] }]) {
      const layers = parseWorkspace(junk);
      assert.ok(Array.isArray(layers), `${JSON.stringify(junk)} did not yield an array`);
      for (const l of layers) {
        assert.ok(Number.isFinite(l.opacity), `opacity was ${l.opacity}`);
        assert.ok(Number.isFinite(l.playbackRate), `playbackRate was ${l.playbackRate}`);
      }
    }
  });

  test("a layer with no uuid is dropped, not carried with an empty key", () => {
    // uuid is the diff key for every trigger and the address for every action.
    // Two layers keyed on "" would collide and read as one.
    assert.equal(parseWorkspace({ data: [{ transportState: { layer: { name: "no uuid" } } }] }).length, 0);
  });
});

describe("layerSignature", () => {
  const base = parseWorkspace(FIXTURE);

  test("the same state twice is the same signature", () => {
    assert.equal(layerSignature(base), layerSignature(parseWorkspace(FIXTURE)));
  });

  test("time moving does NOT change the signature", () => {
    // THE efficiency decision, pinned. If this fails, a 1 Hz poll has become a
    // 1 Hz SSE frame to every connected display.
    const later = base.map((l) => ({ ...l, anchorElapsedSec: 12.3, durationSec: 20 }));
    assert.equal(layerSignature(later), layerSignature(base));
  });

  test("a new media uuid DOES change the signature", () => {
    const next = base.map((l, i) => (i === 0 ? { ...l, mediaUuid: "media-9999" } : l));
    assert.notEqual(layerSignature(next), layerSignature(base));
  });

  test("hiding, muting, opacity and rate all change the signature", () => {
    for (const patch of [{ hidden: true }, { muted: true }, { opacity: 0.5 }, { playbackRate: 0 }]) {
      const next = base.map((l, i) => (i === 0 ? { ...l, ...patch } : l));
      assert.notEqual(layerSignature(next), layerSignature(base), `${JSON.stringify(patch)} was not noticed`);
    }
  });

  test("a layer disappearing changes the signature", () => {
    assert.notEqual(layerSignature(base.slice(1)), layerSignature(base));
  });
});

describe("anchorDriftSec", () => {
  test("ordinary playback has no drift", () => {
    // 10.0s elapsed, one second later, at rate 1 -> 11.0s. Exactly as predicted.
    assert.ok(anchorDriftSec(10, 0, 11, 1000, 1) < 0.01);
  });

  test("a loop restarting on the SAME media is a large drift", () => {
    // The case a media-uuid diff cannot see: one clip looping. Predicted 20.5,
    // observed 0.3.
    assert.ok(anchorDriftSec(19.5, 0, 0.3, 1000, 1) > 1);
  });

  test("a pause is a drift", () => {
    assert.ok(anchorDriftSec(10, 0, 10, 5000, 1) > 1);
  });

  test("a still frame never drifts, so it never re-anchors", () => {
    // rate 0 predicts no movement, and there is none. A still must not force a
    // frame on every poll for the rest of the service.
    assert.ok(anchorDriftSec(0, 0, 0, 60_000, 0) < 0.01);
  });

  test("a null anchor on either side is no drift, not NaN", () => {
    assert.equal(anchorDriftSec(null, 0, 5, 1000, 1), 0);
    assert.equal(anchorDriftSec(5, 0, null, 1000, 1), 0);
  });
});

describe("driftedLayers", () => {
  const at = (iso: string, layers: PvpLayerDTO[]): PvpStatusDTO => ({ connected: true, layers, sampledAt: iso });
  const T0 = "2026-08-30T12:00:00.000Z";
  const T1 = "2026-08-30T12:00:01.000Z";
  const base = parseWorkspace(FIXTURE);

  test("ordinary playback drifts nothing", () => {
    const next = base.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 10.6 } : l));
    assert.deepEqual(driftedLayers(at(T0, base), at(T1, next), 1), []);
  });

  test("a restarted loop is named", () => {
    const next = base.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 0.2 } : l));
    assert.deepEqual(driftedLayers(at(T0, base), at(T1, next), 1), ["layer-0001"]);
  });

  test("a layer that was not there before is not drift", () => {
    // It is a signature change, which already sends a frame. Reporting it twice
    // would be noise.
    const next = [...base, { ...base[0], uuid: "layer-9999", name: "New" }];
    assert.deepEqual(driftedLayers(at(T0, base), at(T1, next), 1), []);
  });

  test("an unparseable sampledAt is not drift", () => {
    // A NaN dt must not force a frame on every poll forever.
    const next = base.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 0.2 } : l));
    assert.deepEqual(driftedLayers(at("", base), at(T1, next), 1), []);
  });
});
```

- [ ] **Step 4: Run them and watch them fail**

```bash
npm test -- --test-name-pattern="parseWorkspace" 2>&1 | tail -20
```

Expected: `Cannot find module './pvp-parse.js'`.

- [ ] **Step 5: Write `main/services/pvp-parse.ts`**

```ts
// pvp-parse.ts — one PVP workspace response folded into layer DTOs, plus the
// two questions the service asks about consecutive samples.
//
// PURE. No I/O and no clock: every function takes what it needs, so the whole
// file is testable against a saved fixture. The three findings encoded here were
// established by watching a live workspace over 702 samples, not by reading the
// vendor documentation — see docs/superpowers/research/2026-08-29-provideoplayer.md.

import type { PvpLayerDTO, PvpLayerState, PvpStatusDTO } from "../types/pvp.js";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** A finite number, or the fallback. Never NaN, never Infinity. */
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Fold `GET /api/0/transportState/workspace` into one DTO per layer.
 *
 * Degrades rather than throws. The response is 11.5 KB of nested objects from a
 * build we do not control, and a parser that threw would take the whole poll
 * down — reported to the operator as "unreachable", which would be a lie.
 */
export function parseWorkspace(json: unknown): PvpLayerDTO[] {
  const data = rec(json).data;
  if (!Array.isArray(data)) return [];

  const out: PvpLayerDTO[] = [];
  data.forEach((entry, index) => {
    const t = rec(rec(entry).transportState);
    const layer = rec(t.layer);
    const uuid = str(layer.uuid);
    // No uuid, no layer. It is the diff key for every trigger and the address for
    // every action; two layers keyed on "" would collide and read as one.
    if (!uuid) return;

    const media = rec(t.playingMedia);
    // PRESENCE of the key, not truthiness of the value. The key is absent — not
    // null — when a layer holds nothing, and this is the only reliable
    // has-content signal PVP gives. isPlaying is not it: a still image reports
    // isPlaying: true. playingItem is not it either: it is residual and never
    // clears, so four idle layers were observed all naming the same cue.
    const hasMedia = "playingMedia" in t;

    const playbackRate = num(t.playbackRate, 0);
    const state: PvpLayerState = !hasMedia ? "empty" : playbackRate > 0 ? "video" : "still";

    const elapsed = num(t.timeElapsed, 0);
    const remaining = num(t.timeRemaining, 0);

    out.push({
      uuid,
      name: str(layer.name) ?? uuid,
      index,
      state,
      mediaName: hasMedia ? str(media.name) : null,
      mediaUuid: hasMedia ? str(media.uuid) : null,
      // Raw, including on an empty layer where it is stale by definition. It is
      // the only field that can confirm a trigger action landed; PvpLayerRow is
      // the single place that decides whether to draw it.
      lastCueName: str(rec(t.playingItem).name),
      hidden: layer.isHidden === true,
      muted: layer.isMuted === true,
      // Absent means fully opaque. Defaulting to 0 would render every layer of a
      // build that omits the field invisible.
      opacity: clamp01(num(layer.opacity, 1)),
      playbackRate,
      anchorElapsedSec: state === "empty" ? null : elapsed,
      // A still reports timeRemaining 0, so its "duration" would be a meaningless
      // echo of its elapsed. Only a rolling clip has one.
      durationSec: state === "video" && remaining > 0 ? elapsed + remaining : null,
    });
  });
  return out;
}

/**
 * Everything a client REACTS to, as a string.
 *
 * The efficiency decision lives here. `anchorElapsedSec`, `durationSec` and
 * `sampledAt` are deliberately absent: they move on every poll during playback,
 * and including any of them would turn a 1 Hz poll into a 1 Hz SSE frame to
 * every connected display. The client ticks the progress bar itself from the
 * anchor plus its own clock — the same trade live-poller.ts:42 makes for
 * serverNow, for the same reason.
 *
 * A string rather than a field-by-field compare because the payload is an ARRAY:
 * StatusIntegration.emitIfChanged compares keys with `!==`, and a fresh array is
 * never `===` its predecessor, so the base implementation would broadcast every
 * poll however few fields actually changed.
 */
export function layerSignature(layers: readonly PvpLayerDTO[]): string {
  return JSON.stringify(
    layers.map((l) => [
      l.uuid, l.name, l.index, l.state, l.mediaUuid, l.lastCueName,
      l.hidden, l.muted, l.opacity, l.playbackRate,
    ]),
  );
}

/**
 * How far the progress clock has moved away from what the last anchor predicted.
 *
 * The client interpolates between frames, so between frames it is guessing. This
 * bounds the guess: predict where `timeElapsed` should be by now and compare
 * with what PVP actually reports.
 *
 * The case this exists for is a single clip LOOPING. Its media uuid never
 * changes, so the signature never changes, and without this the bar would sit at
 * 100% until the keepalive — predicted 20.5, observed 0.3 on the first poll past
 * the loop point.
 *
 * Returns 0 rather than NaN whenever either side has no anchor, so a layer that
 * just gained or lost content cannot force a frame on every poll thereafter.
 */
export function anchorDriftSec(
  prevElapsedSec: number | null,
  prevAtMs: number,
  nextElapsedSec: number | null,
  nextAtMs: number,
  playbackRate: number,
): number {
  if (prevElapsedSec == null || nextElapsedSec == null) return 0;
  const dtSec = (nextAtMs - prevAtMs) / 1000;
  if (!Number.isFinite(dtSec) || dtSec < 0) return 0;
  const predicted = prevElapsedSec + playbackRate * dtSec;
  const drift = Math.abs(nextElapsedSec - predicted);
  return Number.isFinite(drift) ? drift : 0;
}

/**
 * Which layers need a fresh anchor sent, by uuid.
 *
 * A layer absent from `prev` is NOT drift — it is a signature change, which is
 * already a reason to broadcast, and reporting it twice would be noise.
 */
export function driftedLayers(
  prev: PvpStatusDTO,
  next: PvpStatusDTO,
  toleranceSec: number,
): string[] {
  const prevAtMs = Date.parse(prev.sampledAt ?? "");
  const nextAtMs = Date.parse(next.sampledAt ?? "");
  // No usable pair of timestamps, no prediction — and never a frame every poll.
  if (!Number.isFinite(prevAtMs) || !Number.isFinite(nextAtMs)) return [];

  const before = new Map(prev.layers.map((l) => [l.uuid, l]));
  const out: string[] = [];
  for (const l of next.layers) {
    const b = before.get(l.uuid);
    if (!b) continue;
    if (anchorDriftSec(b.anchorElapsedSec, prevAtMs, l.anchorElapsedSec, nextAtMs, b.playbackRate) > toleranceSec) {
      out.push(l.uuid);
    }
  }
  return out;
}
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
npm test -- --test-name-pattern="parseWorkspace|layerSignature|anchorDrift|driftedLayers" 2>&1 | tail -20
```

- [ ] **Step 7: PROVE four guards fail on the bugs they guard**

Apply each mutation, watch the named test go red in this session, revert. Name all four in the commit message.

| Mutation | Test that must go red |
|---|---|
| `const hasMedia = "playingMedia" in t;` → `const hasMedia = t.isPlaying === true;` | "a layer with NO playingMedia key is empty, whatever else it says" |
| `playbackRate > 0 ? "video" : "still"` → `t.isPlaying === true ? "video" : "still"` | "a still image is 'still', NOT 'video', even though PVP says isPlaying" |
| Add `l.anchorElapsedSec` to the array in `layerSignature` | "time moving does NOT change the signature" |
| `num(layer.opacity, 1)` → `num(layer.opacity, 0)` | "a missing opacity is fully opaque, not zero" |

- [ ] **Step 8: Export the types to the renderer**

`main/types/stage.ts` is a barrel. Add `export * from "./pvp.js";` beside `export * from "./live.js";`. Then mirror the two DTOs in `renderer/types.d.ts`, in the alphabetical run that already contains `type ProPresenterStatusDTO = Stage.ProPresenterStatusDTO;`:

```ts
  type PvpLayerDTO = Stage.PvpLayerDTO;
  type PvpStatusDTO = Stage.PvpStatusDTO;
```

- [ ] **Step 9: Type-check and commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git add main/types/pvp.ts main/types/stage.ts renderer/types.d.ts \
        main/services/pvp-parse.ts main/services/pvp-parse.test.ts \
        main/services/fixtures/pvp-workspace.json
git commit -m "feat(pvp): read a ProVideoPlayer workspace without believing what it says"
```

The commit body records the four guard mutations from Step 7, and states plainly that `/clear/layer` against a layer holding content and the hidden/muted/faded read-back are both still unobserved on a real workspace — synthesised into the fixture so the branches are exercised, and flagged in the docs.

---

## Task 2: The service and the registration chain

**Files:**
- Create: `main/services/pvp-service.ts`
- Create: `main/services/pvp-service.test.ts`
- Create: `renderer/main/use-pvp-state.ts`
- Modify: `main/services/integration-ids.ts`
- Modify: `main/services/integration-manager.ts`
- Modify: `main/services/automation-triggers.ts`
- Modify: `main/services/automation-engine.ts`
- Modify: `main/services/remote-server.ts`
- Modify: `main/services/routes/status-routes.ts`
- Modify: `renderer/lib/api.ts`
- Modify: `renderer/lib/sse-channels.ts`
- Modify: `renderer/components/integrations-panel.tsx`
- Modify: `main/services/automation-coverage.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseWorkspace`, `layerSignature`, `driftedLayers`, `PvpStatusDTO`, `PVP_OFFLINE`.
- Produces: `pvpService` with `configure(host, port, https, token)`, `getLatest(): PvpStatusDTO`, `test(host, port, https, token)`, `command(path, body, verify)`, and `readLayers()`; the `pvp:status` channel; `usePvpState(enabled?)`.

- [ ] **Step 1: Write `main/services/pvp-service.ts`**

```ts
// pvp-service.ts — polls ProVideoPlayer's Network API and broadcasts one
// snapshot of every layer on "pvp:status".
//
// PVP exposes no WebSocket, no SSE and no subscribe endpoint — the word does not
// appear anywhere in its API reference — so this polls, which puts it in the same
// family as reaper-service.ts and makes that file the model for the lifecycle.
//
// One request answers everything: GET /transportState/workspace returns all 11
// layers in ~11.5 KB. There is also /transportState/layer/{id}, but it costs one
// request per layer AND the vendor's own example for it omits playingMedia — the
// single field that says whether a layer holds anything.
//
// TWO THINGS HERE ARE DELIBERATE AND EASY TO UNDO BY ACCIDENT:
//
//   1. emitIfChanged is OVERRIDDEN. The base compares DTO keys with `!==`, and
//      `layers` is a fresh array every poll, so the base implementation would
//      broadcast at the poll rate forever. See shouldEmit below.
//   2. The cadence gates on inDemand, not hasSubscribers. This channel carries
//      automation triggers, and the engine is not a browser — gating on browser
//      subscribers is what silently disabled every SPL rule on an unattended box.

import { errorMessage } from "./errors.js";
import { StatusIntegration } from "./integration-base.js";
import { driftedLayers, layerSignature, parseWorkspace } from "./pvp-parse.js";
import { PVP_OFFLINE, type PvpLayerDTO, type PvpStatusDTO } from "../types/pvp.js";

/** Active cadence. Governs how fast a cue change reaches a rule, not how smooth
 *  the progress bar is — the bar is interpolated on the client. A 20-second loop
 *  needs 2 s at most; 1 s is chosen so an automation edge is not up to two
 *  seconds late, and 11.5 KB/s on a wired LAN is the same order as REAPER's. */
const POLL_MS = 1000;
/** Nothing is watching and no rule reads the channel. Keeps the badge warm. */
const IDLE_POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;

/** Re-push at least this often even when nothing changed, so a client's anchor
 *  and its clock-skew estimate cannot drift and a just-connected display stays
 *  fresh. The same value, for the same reason, as LIVE_KEEPALIVE_MS. */
const KEEPALIVE_MS = 15_000;

/** How far the progress clock may wander from its last anchor before a fresh one
 *  is sent. One second: below the eye's tolerance on a wall, and comfortably
 *  above the jitter of a 1 Hz poll against a video engine's own clock. */
const DRIFT_TOLERANCE_SEC = 1;

/** A verify read is retried rather than slept on once, because nothing has
 *  measured PVP's apply latency. Bounded at 4 x 150 ms. */
const VERIFY_ATTEMPTS = 4;
const VERIFY_INTERVAL_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a command claims it did, and how to tell whether it happened. */
export interface PvpVerify {
  /** Reads back to the operator as the action's detail. Present tense, no
   *  punctuation: "layer Graphics cleared". */
  what: string;
  holds(layers: readonly PvpLayerDTO[]): boolean;
}

export interface PvpTarget {
  host: string;
  port: number;
  https: boolean;
  token: string | null;
}

class PvpService extends StatusIntegration<PvpStatusDTO> {
  private target: PvpTarget | null = null;
  private lastBroadcastAtMs = 0;

  constructor() {
    super("pvp", "pvp:status", PVP_OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.target;
  }

  configure(host: string, port: number, https: boolean, token: string | null): void {
    const h = host?.trim() || null;
    const p = port > 0 ? Math.floor(port) : null;
    this.target = h && p ? { host: h, port: p, https, token: token?.trim() || null } : null;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.target) return;
    // The token is never logged, here or anywhere.
    console.log(`[pvp] polling ${this.origin(this.target)}`);
    super.start();
  }

  private origin(t: PvpTarget): string {
    return `${t.https ? "https" : "http"}://${t.host}:${t.port}`;
  }

  /**
   * One request to PVP.
   *
   * AbortSignal.timeout rather than a hand-rolled controller: the timer cannot be
   * leaked because there is no timer to forget. Every other fetch here does the
   * same.
   */
  private async request(t: PvpTarget, path: string, init?: { method: string; body?: string }): Promise<Response> {
    const headers: Record<string, string> = {};
    if (t.token) headers.Authorization = `Bearer ${t.token}`;
    if (init?.body != null) headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.origin(t)}/api/0${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // A 404 does NOT distinguish "wrong path" from "Network API disabled" —
      // PVP returns 404 for both, so the message says so rather than guessing.
      if (res.status === 404) {
        throw new Error("HTTP 404 — either the path is wrong or PVP's Network API is off. Check Preferences -> Network -> Network API, and that the port is the API port, not the documentation port.");
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`HTTP ${res.status} — PVP rejected the API token.`);
      }
      throw new Error(`ProVideoPlayer returned HTTP ${res.status}`);
    }
    return res;
  }

  /** The one read this integration makes. Exported through readLayers() so an
   *  action can verify itself against exactly the same fold the poll uses. */
  private async fetchWorkspace(t: PvpTarget): Promise<PvpLayerDTO[]> {
    const res = await this.request(t, "/transportState/workspace");
    return parseWorkspace(await res.json());
  }

  /** Current layer state, straight from PVP. Throws on a transport failure — the
   *  caller decides what to tell the operator. */
  async readLayers(): Promise<PvpLayerDTO[]> {
    if (!this.target) throw new Error("ProVideoPlayer is not configured");
    return await this.fetchWorkspace(this.target);
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(host: string, port: number, https: boolean, token: string | null): Promise<{ ok: boolean; message?: string }> {
    const t: PvpTarget = { host, port, https, token };
    try {
      const layers = await this.fetchWorkspace(t);
      const withContent = layers.filter((l) => l.state !== "empty").length;
      return {
        ok: true,
        message: `Connected to ProVideoPlayer at ${host}:${port} — ${layers.length} layers, ${withContent} with content`,
      };
    } catch (err) {
      const msg = errorMessage(err);
      // PVP's own documentation uses `curl -k` throughout, which implies a
      // self-signed certificate, and Node's fetch will not accept one. Say that
      // rather than letting an operator read a TLS failure as "PVP is down".
      if (https && /certificate|self.signed|TLS|SSL/i.test(msg)) {
        return {
          ok: false,
          message: `${msg}. PVP's HTTPS mode normally uses a self-signed certificate, which this app will not accept. Turn "Use HTTPS Connection" off in PVP unless you have installed a certificate this machine trusts.`,
        };
      }
      return { ok: false, message: msg };
    }
  }

  protected async connect(): Promise<void> {
    const t = this.target;
    if (!this.running || !t) return;
    try {
      const layers = await this.fetchWorkspace(t);
      if (!this.running) return;
      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", `Connected to ProVideoPlayer at ${t.host}:${t.port}`);
      }
      this.emitIfChanged({ connected: true, layers, sampledAt: new Date().toISOString() });
      // inDemand, not hasSubscribers: a rule reading this channel is a watcher,
      // and an appliance with no browser attached is exactly where "nobody is
      // looking" is permanent.
      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = errorMessage(err);
      if (this.attempt === 0) console.warn(`[pvp] ${t.host}:${t.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${t.host}:${t.port} — ${msg}`);
      this.goOffline();
      this.scheduleReconnect();
    }
  }

  /**
   * Post a command, then PROVE it happened.
   *
   * PVP answers every POST with HTTP 200 and an empty body whether or not
   * anything happened — no echo of the applied value, nothing to read. So a 200
   * is not evidence, and an action that reported success on one would be a rule
   * that appears to run, logs a success, and never touches a screen.
   *
   * It also applies a change a BEAT after the 200, which is why the confirming
   * read is retried rather than taken once: a single immediate read makes "no
   * effect" and "read too early" look identical, and that is exactly how the
   * research's first pass concluded four trigger forms were no-ops when all five
   * fire.
   *
   * Never throws. Every outcome — including "the write may have landed but we
   * could not confirm it" — comes back as a result the caller reports to the
   * operator. A catch here that only logged would be the swallowed failure this
   * whole method exists to prevent.
   */
  async command(path: string, body: unknown, verify: PvpVerify): Promise<{ ok: boolean; detail: string }> {
    const t = this.target;
    if (!t) return { ok: false, detail: "ProVideoPlayer is not configured" };

    try {
      await this.request(t, path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      return { ok: false, detail: errorMessage(err) };
    }

    // Re-read rather than sleep once. Nothing has measured PVP's apply latency,
    // and a single guessed sleep would make "no effect" and "read too early"
    // indistinguishable — the exact confusion the research warns about.
    let lastReadError: string | null = null;
    for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
      await delay(VERIFY_INTERVAL_MS);
      let layers: PvpLayerDTO[];
      try {
        layers = await this.fetchWorkspace(t);
      } catch (err) {
        lastReadError = errorMessage(err);
        continue;
      }
      lastReadError = null;
      // The read is free state — fold it back into the channel so a command does
      // not leave every display a poll behind.
      this.emitIfChanged({ connected: true, layers, sampledAt: new Date().toISOString() });
      if (verify.holds(layers)) return { ok: true, detail: verify.what };
    }

    if (lastReadError) {
      // The write may well have landed. We cannot say, and saying "sent" when we
      // cannot see the result is the failure this path exists to prevent.
      return { ok: false, detail: `sent, but could not read the state back to confirm it: ${lastReadError}` };
    }
    return { ok: false, detail: `PVP answered 200 but ${verify.what} did not take effect` };
  }

  /**
   * PURE, and separated from emitIfChanged so it can be tested without a socket.
   *
   * Three reasons to send a frame, and `nowMs - lastBroadcastAtMs` is the third.
   * `layerSignature` deliberately omits every time-varying field, so ordinary
   * playback produces NO frame at all between cue changes.
   */
  static shouldEmit(prev: PvpStatusDTO, next: PvpStatusDTO, lastBroadcastAtMs: number, nowMs: number): boolean {
    if (prev.connected !== next.connected) return true;
    if (layerSignature(prev.layers) !== layerSignature(next.layers)) return true;
    if (driftedLayers(prev, next, DRIFT_TOLERANCE_SEC).length > 0) return true;
    return nowMs - lastBroadcastAtMs >= KEEPALIVE_MS;
  }

  /**
   * Overrides the base's shallow compare, which cannot be used here at all: it
   * compares DTO keys with `!==`, and `layers` is a fresh array every poll, so
   * the base implementation broadcasts at the poll rate no matter what changed.
   *
   * Deleting this override is the single most expensive mistake available in
   * this file, so pvp-service.test.ts asserts the outcome rather than the shape.
   */
  protected override emitIfChanged(next: PvpStatusDTO): void {
    if (PvpService.shouldEmit(this.last, next, this.lastBroadcastAtMs, Date.now())) this.emit(next);
    else this.last = next;
  }

  /** Stamped here rather than in emitIfChanged so goOffline() — which calls
   *  emit() directly — also resets the keepalive clock. */
  protected override emit(snapshot: PvpStatusDTO): void {
    this.lastBroadcastAtMs = Date.now();
    super.emit(snapshot);
  }
}

export const pvpService = new PvpService();
export { PvpService };
```

- [ ] **Step 2: Write `main/services/pvp-service.test.ts`**

```ts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { PvpService } from "./pvp-service.js";
import { parseWorkspace } from "./pvp-parse.js";
import type { PvpStatusDTO } from "../types/pvp.js";

const LAYERS = parseWorkspace(
  JSON.parse(readFileSync(new URL("./fixtures/pvp-workspace.json", import.meta.url), "utf8")),
);
const snap = (over: Partial<PvpStatusDTO> = {}): PvpStatusDTO => ({
  connected: true,
  layers: LAYERS,
  sampledAt: "2026-08-30T12:00:00.000Z",
  ...over,
});

describe("shouldEmit", () => {
  test("a poll that changed nothing sends NO frame", () => {
    // THE efficiency decision, at the level that matters. A fresh array from
    // parseWorkspace is a different object every poll, so the base class's
    // shallow compare would say "changed" here and push at 1 Hz forever.
    const prev = snap();
    const next = snap({ layers: [...LAYERS], sampledAt: "2026-08-30T12:00:01.000Z" });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), false);
  });

  test("time advancing normally sends NO frame", () => {
    const prev = snap();
    const next = snap({
      sampledAt: "2026-08-30T12:00:01.000Z",
      layers: LAYERS.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: (l.anchorElapsedSec ?? 0) + 1 } : l)),
    });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), false);
  });

  test("a cue change sends a frame", () => {
    const prev = snap();
    const next = snap({ layers: LAYERS.map((l, i) => (i === 0 ? { ...l, mediaUuid: "media-9999" } : l)) });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), true);
  });

  test("a loop restarting on the same media sends a frame", () => {
    // The case a media-uuid diff cannot see. Without the drift check the bar
    // would sit at 100% until the keepalive.
    const prev = snap();
    const next = snap({
      sampledAt: "2026-08-30T12:00:01.000Z",
      layers: LAYERS.map((l) => (l.state === "video" ? { ...l, anchorElapsedSec: 0.2 } : l)),
    });
    assert.equal(PvpService.shouldEmit(prev, next, Date.now(), Date.now() + 1000), true);
  });

  test("going offline sends a frame", () => {
    assert.equal(
      PvpService.shouldEmit(snap(), snap({ connected: false, layers: [] }), Date.now(), Date.now()),
      true,
    );
  });

  test("the keepalive sends a frame once nothing has been sent for 15s", () => {
    const t0 = Date.now();
    assert.equal(PvpService.shouldEmit(snap(), snap(), t0, t0 + 14_000), false);
    assert.equal(PvpService.shouldEmit(snap(), snap(), t0, t0 + 15_000), true);
  });

  test("an idle workspace does not spin the keepalive faster than 15s", () => {
    // A still layer has rate 0, so it predicts no movement and never drifts.
    // Without that, every still on the wall would force a frame every poll.
    const t0 = Date.now();
    for (let sec = 1; sec < 15; sec++) {
      const prev = snap({ sampledAt: new Date(t0).toISOString() });
      const next = snap({ sampledAt: new Date(t0 + sec * 1000).toISOString() });
      assert.equal(PvpService.shouldEmit(prev, next, t0, t0 + sec * 1000), false, `sent a frame at ${sec}s`);
    }
  });
});
```

- [ ] **Step 3: Run it, then PROVE the override guard**

```bash
npm test -- --test-name-pattern="shouldEmit" 2>&1 | tail -20
```

Then the mutation, watched red in-session and named in the commit: **replace `emitIfChanged`'s body with `super.emitIfChanged(next)` and change `shouldEmit` to `return prev.layers !== next.layers;`** — "a poll that changed nothing sends NO frame" and "time advancing normally sends NO frame" both go red. Revert.

Second mutation, same step: **delete the `driftedLayers` line from `shouldEmit`** — "a loop restarting on the same media sends a frame" goes red. Revert.

- [ ] **Step 4: Register the id, both lists**

`main/services/integration-ids.ts` — `"pvp"` into `INTEGRATION_IDS` (14 → 15) **and** `CONNECTION_MANAGED_IDS` (9 → 10). It belongs in the second because it holds a poll that must be restarted when host, port or token change; the applier map is `Record<ConnectionManagedId, …>`, so adding the id without an applier is a compile error rather than an integration that silently never reconnects.

While in the file: the doc comment above `CONNECTION_MANAGED_IDS` says "The five that are absent" — still correct, leave it.

- [ ] **Step 5: Register the descriptor and the wiring in `integration-manager.ts`**

Import beside the other services, then the descriptor beside `REAPER_DESCRIPTOR`:

```ts
// ProVideoPlayer — polls PVP's Network API (Preferences -> Network -> Network
// API) for the transport state of every layer, shown by the custom-layout
// "ProVideoPlayer layers" object and drivable from automation rules.
//
// PVP has no thumbnail, preview or frame endpoint of any kind, so nothing here
// can ever show a picture of what is on screen — only its name, its state and
// how much of it is left. The description says so, because an operator setting
// this up is entitled to know that before they look for a preview.
const PVP_DESCRIPTOR: IntegrationDescriptor = {
  id: "pvp",
  kind: "control",
  label: "ProVideoPlayer",
  description:
    "Shows what ProVideoPlayer has on each layer, and lets automation rules clear, hide, mute and fade layers. Polls PVP's Network API over your LAN. Turn it on under ProVideoPlayer -> Preferences -> Network -> Network API, note the port shown there, and enter it below. That port is not the same as the one PVP serves its API documentation on. If Require Authentication is on, paste the generated token. PVP offers no preview image of any kind, so this reports names, states and times, never a picture.",
  configSchema: [
    { key: "host", label: "ProVideoPlayer Host", type: "text", placeholder: "192.168.1.50" },
    {
      key: "port",
      label: "Network API Port",
      type: "number",
      help: "From Preferences -> Network -> Network API. Not the documentation port.",
    },
    {
      key: "https",
      label: "Use HTTPS",
      type: "select",
      options: [
        { value: "off", label: "Off" },
        { value: "on", label: "On" },
      ],
      default: "off",
      help: "Match PVP's own 'Use HTTPS Connection' setting. PVP normally uses a self-signed certificate, which this app will not accept.",
    },
    { key: "token", label: "API Token", type: "password", help: "Only if Require Authentication is on in PVP." },
  ],
};
```

Then, in order:

1. `DESCRIPTORS` (14 → 15): add `PVP_DESCRIPTOR` after `REAPER_DESCRIPTOR`.
2. `SECRET_KEYS`: `pvp: ["token"],`. **This is the whole of the secret handling.** The manager already splits secret keys out of the config on save, masks them as `"••••"` in the state, and merges them back when dialling — `integration-manager.ts:736-768` and `:1194-1197`. Nothing else is written.
3. `getPvpTarget()`, beside `getReaperTarget()`:

```ts
  /** PVP's Network API port is whatever Preferences shows; the research never
   *  recorded a default and inventing one would let "configured" point at a
   *  port nothing is listening on. So the port is required, not defaulted. */
  private getPvpTarget(): { host: string | null; port: number | null; https: boolean } {
    const { host, port } = this.hostPort("pvp", null);
    return { host, port, https: this.states.get("pvp")?.config.https === "on" };
  }
```

4. Widen `hostPort`'s second parameter from `number` to `number | null`, and skip the default when it is null:

```ts
  private hostPort(
    id: ConnectionManagedId,
    defaultPort: number | null,
  ): { host: string | null; port: number | null } {
    …
    // Only default the port when a host was given AND there is a default worth
    // giving: no host is "not configured", and an integration whose port has no
    // conventional value (PVP's is whatever its Preferences pane shows) must not
    // be reported as configured on the strength of a guess.
    return {
      host,
      port: Number.isFinite(port) && port > 0 ? port : host && defaultPort != null ? defaultPort : null,
    };
  }
```

The three existing callers pass numbers and are unaffected.

5. `applyPvp()`, beside `applyReaper()`:

```ts
  /** Start/stop the PVP poll to match enabled + configured state. */
  private async applyPvp(): Promise<void> {
    await this.applyService("pvp", pvpService, async () => {
      const { host, port, https } = this.getPvpTarget();
      if (!host || !port) return null;
      // The state map holds secrets MASKED, so anything that dials has to read
      // the real value back out of the secrets store.
      const secrets = await secretsStore.getSecrets("pvp");
      return {
        connecting: `Connecting ${host}:${port}`,
        start: () => pvpService.configure(host, port, https, secrets.token ?? null),
      };
    });
  }
```

6. The applier map: `pvp: () => this.applyPvp(),`.
7. `init()`: `await this.applyPvp();` after `await this.applyReaper();`.
8. The `test()` ladder, after the `reaper` arm:

```ts
      if (id === "pvp") {
        const { host, port, https } = this.getPvpTarget();
        if (!host || !port) {
          return { ok: false, message: "Host and Port are required. The port is the one in PVP's Preferences -> Network -> Network API." };
        }
        const secrets = await secretsStore.getSecrets("pvp");
        const result = await pvpService.test(host, port, https, secrets.token ?? null);
        this.setConnectionState("pvp", result.ok ? "connected" : "error", result.message ?? null);
        this.broadcastStates();
        return result;
      }
```

`isConfigured()` needs no arm — PVP falls through to the generic "any config value present" branch, exactly like REAPER.

- [ ] **Step 6: Register the automation-facing half**

`main/services/automation-triggers.ts` — `{ id: "pvp", label: "ProVideoPlayer" }` into `INTEGRATIONS`, keeping the list's existing near-alphabetical order (after `"prodcom"`). This alone generates `pvp.connected` and `pvp.disconnected` triggers and, through the same list, the `pvp.is-connected` condition. Without it, `automation-coverage.test.ts:62` goes red the moment Step 4 lands.

While in the file, fix the stale count in the comment above `INTEGRATIONS`: "Labels for the twelve" describes a list that has had fourteen entries for some time and will now have fifteen. Same in `automation-conditions.ts:9-10` ("hand-written twelve times"), and in `integration-manager.ts:657-659` / `integration-ids.test.ts:4-5`, both of which say "the same nine integrations" and become wrong at Step 4. Four comments, one grep:

```bash
grep -rn "twelve\|the same nine" main/services/automation-triggers.ts main/services/automation-conditions.ts main/services/integration-manager.ts main/services/integration-ids.test.ts
```

`main/services/automation-coverage.test.ts` — `"pvp:status"` into `BROADCAST_CHANNELS` (20 → 21). Task 5 adds the triggers that watch it; adding the channel here now keeps the two commits independently green.

`main/services/automation-engine.ts` — beside the four existing registrations:

```ts
pvpService.addDemandSource(() => automationEngine.wantsChannel("pvp:status"));
```

Without this, `inDemand` is only ever true when a browser is watching, and every PVP rule on an unattended appliance would see the 5-second idle cadence at best and, once the browser closed, would be the only consumer of a channel nobody thinks is wanted. This is the registration the `inDemand` gate is useless without.

- [ ] **Step 7: Register the transport**

`main/services/remote-server.ts` — import `pvpService`, then in the hello burst, immediately after the `reaper:status` line:

```ts
      sseWrite(res, "pvp:status", pvpService.getLatest());
```

The channel name must be a **string literal**. `renderer/lib/hydrated-channels.test.ts` reads this file as text with `/sseWrite\(\s*res\s*,\s*"([^"]+)"/g`; a constant is invisible to it, and the test would then correctly report that nothing hydrates the channel.

`main/services/routes/status-routes.ts` — import `pvpService`, then after the `/api/reaper/status` arm:

```ts
    if (method === "GET" && pathname === "/api/pvp/status") {
      json(res, pvpService.getLatest());
      return;
    }
```

`renderer/lib/api.ts` — beside `case "reaper:getStatus"`:

```ts
    case "pvp:getStatus":
      return apiFetch<T>("/api/pvp/status");
```

`renderer/lib/sse-channels.ts` — `"pvp:status"` into `HYDRATED_CHANNELS` (20 → 21), after `"reaper:status"`. It belongs there for the reason the list exists: PVP broadcasts on change, and a workspace holding one still image between services changes nothing for hours, so a display that opens in that window would show dashes indefinitely.

`renderer/components/integrations-panel.tsx` — `"pvp"` into the `CATEGORY_ORDER` entry for **Control & output**, after `"reaper"`. **An id missing here renders no card at all**, so the integration would be registered, polling and invisible.

- [ ] **Step 8: Write `renderer/main/use-pvp-state.ts`**

```ts
import { useEffect, useState } from "react";

import { invoke, onNotification } from "../lib/api";

/**
 * Live ProVideoPlayer layer state, pushed on the "pvp:status" channel. Hydrates
 * once over HTTP so a freshly-loaded display is not blank until the next change,
 * then lives on the broadcast.
 *
 * `enabled` is the gate the layout renderer uses: a wall screen showing only a
 * clock must not hold a PVP subscription open, because the channel's demand is
 * what decides the poll cadence at the other end.
 */
export function usePvpState(enabled = true): PvpStatusDTO | null {
  const [pvp, setPvp] = useState<PvpStatusDTO | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    invoke<PvpStatusDTO>("pvp:getStatus")
      .then((s) => {
        if (alive) setPvp(s);
      })
      .catch(() => {
        // A failed hydrate is not an error state: the next broadcast fills it in,
        // and the Integrations panel is where a connection problem is reported.
        // Nothing is swallowed that anyone could act on here.
      });
    return () => {
      alive = false;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    return onNotification("pvp:status", (p) => setPvp(p as PvpStatusDTO));
  }, [enabled]);

  return pvp;
}
```

Copy the exact shape of `renderer/main/use-reaper-state.ts` and diff the two before committing; they should differ only in the names.

- [ ] **Step 9: Drive the real server**

Unit tests over `shouldEmit` are not evidence that the poll works. Start the dev server on the working branch (port 8799 — kill by port, never by an env-var prefix, which is not in the process command line), configure PVP under Settings → Integrations → Control & output, and:

1. Press **Test connection**. Confirm the message names a layer count.
2. Open `/api/events` in a second terminal and watch the burst. Confirm exactly one `pvp:status` frame arrives on connect.
3. Start a video in PVP. Confirm a frame arrives at the cue change, and then **count the frames for the next 30 seconds** — it must be two, not thirty. This is the efficiency decision observed rather than asserted.
4. Stop PVP. Confirm the Integrations badge goes to error with a message, and that the reconnect backs off rather than hammering.

```bash
lsof -ti :8799 | xargs -r kill
npm run server
```

- [ ] **Step 10: Type-check, full suite, commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git commit -m "feat(pvp): poll ProVideoPlayer, and broadcast only when something happened"
```

The commit body records both guard mutations from Step 3 and the observed frame count from Step 9.3.

---

## Task 3: The shared row, the progress interpolation, and the custom layout object

**Files:**
- Create: `renderer/main/pvp-progress.ts`
- Create: `renderer/main/pvp-progress.test.ts`
- Create: `renderer/main/pvp-layer-row.tsx`
- Create: `renderer/main/pvp-layer-row.test.tsx`
- Create: `renderer/main/pvp-object.tsx`
- Modify: `main/types/views.ts`
- Modify: `main/types/object-capabilities.ts`
- Modify: `renderer/main/layout-objects.ts`
- Modify: `renderer/main/layout-renderer.tsx`
- Modify: `renderer/editor/palette.tsx`
- Modify: `renderer/editor/inspector.tsx`
- Modify: `renderer/main/object-catalog.test.ts`
- Modify: `main/types/object-capabilities.test.ts`
- Modify: `renderer/main/object-fit.test.ts`
- Modify: `renderer/main/object-look.test.ts`
- Modify: `renderer/main/layout-objects.test.ts`
- Modify: `docs/reference/widgets.md`

**Interfaces:**
- Consumes: Task 1's `PvpLayerDTO` / `PvpStatusDTO`; Task 2's `usePvpState`.
- Produces: `computePvpProgress(layer, sampledAt, now, skewMs): PvpProgress | null`; `PvpLayerRow`; `PvpObject`; the `pvp-layers` object type.

- [ ] **Step 1: Write the failing progress tests, `renderer/main/pvp-progress.test.ts`**

```ts
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { computePvpProgress } from "./pvp-progress.js";
import type { PvpLayerDTO } from "@main/types/pvp";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);

describe("computePvpProgress", () => {
  test("at the moment of the sample it is the anchor exactly", () => {
    const p = computePvpProgress(layer(), T, AT, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 10);
    assert.equal(p.remainingSec, 10);
    assert.equal(p.fraction, 0.5);
  });

  test("it advances locally between frames, which is the whole point", () => {
    // No frame was sent for these three seconds. If this returned 10 the bar
    // would freeze between cue changes and the efficiency decision would have
    // cost the feature.
    const p = computePvpProgress(layer(), T, AT + 3000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 13);
    assert.equal(p.remainingSec, 7);
  });

  test("a slow browser clock is corrected by skew, not believed", () => {
    // Browser is 60s BEHIND the server. Without applying skew this would report
    // a minute of negative progress.
    const p = computePvpProgress(layer(), T, AT - 60_000, 60_000);
    assert.ok(p);
    assert.equal(p.elapsedSec, 10);
  });

  test("it never runs past the end, however stale the anchor", () => {
    // A display that slept through a keepalive must not draw a bar at 400%.
    const p = computePvpProgress(layer(), T, AT + 600_000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 20);
    assert.equal(p.remainingSec, 0);
    assert.equal(p.fraction, 1);
  });

  test("it never runs before the start", () => {
    const p = computePvpProgress(layer(), T, AT - 600_000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 0);
    assert.equal(p.fraction, 0);
  });

  test("a paused clip does not advance", () => {
    // rate 0 with a duration: the clip is loaded and stopped. The bar holds.
    const p = computePvpProgress(layer({ playbackRate: 0 }), T, AT + 5000, 0);
    assert.ok(p);
    assert.equal(p.elapsedSec, 10);
  });

  test("a still has no progress at all", () => {
    assert.equal(computePvpProgress(layer({ state: "still", durationSec: null }), T, AT, 0), null);
  });

  test("an empty layer has no progress at all", () => {
    assert.equal(
      computePvpProgress(layer({ state: "empty", anchorElapsedSec: null, durationSec: null }), T, AT, 0),
      null,
    );
  });

  test("a null or unparseable sampledAt yields no progress, never NaN", () => {
    for (const at of [null, "", "not a date"]) {
      assert.equal(computePvpProgress(layer(), at, AT, 0), null, `sampledAt ${String(at)} produced a reading`);
    }
  });

  test("a zero duration yields no progress, never a divide by zero", () => {
    assert.equal(computePvpProgress(layer({ durationSec: 0 }), T, AT, 0), null);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm test -- --test-name-pattern="computePvpProgress" 2>&1 | tail -20
```

Expected: `Cannot find module './pvp-progress.js'`.

- [ ] **Step 3: Write `renderer/main/pvp-progress.ts`**

```ts
// pvp-progress.ts — where a PVP clip has got to, computed on the client.
//
// The server does NOT push a frame per second. timeElapsed and timeRemaining
// move every poll, so including either in the change comparison would turn a
// 1 Hz poll into a 1 Hz SSE frame to every display. Instead the DTO carries an
// ANCHOR (`anchorElapsedSec` at `sampledAt`) and this file interpolates from it —
// exactly the trade pco-timer.ts makes for the countdown, and for the same
// reason. The server re-anchors on a cue change, on drift past a second, and on
// a 15-second keepalive, so the guess here is never more than a second stale.
//
// PURE, and takes `now` rather than reading a clock, so every case is testable.

import type { PvpLayerDTO } from "@main/types/pvp";

export interface PvpProgress {
  /** Seconds into the clip, clamped to [0, durationSec]. */
  elapsedSec: number;
  /** Seconds left, clamped to [0, durationSec]. */
  remainingSec: number;
  durationSec: number;
  /** 0..1, for the bar. */
  fraction: number;
}

/**
 * Returns null when there is nothing to time — an empty layer, a still image, or
 * a sample whose timestamp will not parse.
 *
 * A still is null rather than 0-of-0 on purpose: PVP reports a still with
 * timeRemaining 0, so a bar drawn for it would sit permanently at either end and
 * read as a clip that had finished.
 */
export function computePvpProgress(
  layer: PvpLayerDTO,
  sampledAt: string | null,
  now: number,
  skewMs: number,
): PvpProgress | null {
  const duration = layer.durationSec;
  if (duration == null || duration <= 0) return null;
  if (layer.anchorElapsedSec == null) return null;

  const anchorMs = Date.parse(sampledAt ?? "");
  if (!Number.isFinite(anchorMs)) return null;

  // The server's clock, not this browser's. A kiosk whose clock is a minute out
  // would otherwise draw a minute of phantom progress on every frame.
  const serverNow = now + skewMs;
  const sinceAnchorSec = (serverNow - anchorMs) / 1000;

  // playbackRate is the multiplier PVP is actually running at, so a paused clip
  // (rate 0) holds where it was rather than creeping forward.
  const raw = layer.anchorElapsedSec + layer.playbackRate * sinceAnchorSec;
  // Clamped, because the anchor can be arbitrarily stale: a display that was
  // asleep through a keepalive must not draw a bar at 400% or a negative one.
  const elapsedSec = Math.min(duration, Math.max(0, raw));

  return {
    elapsedSec,
    remainingSec: duration - elapsedSec,
    durationSec: duration,
    fraction: elapsedSec / duration,
  };
}
```

- [ ] **Step 4: Run the progress tests and watch them pass**

- [ ] **Step 5: PROVE two progress guards**

| Mutation | Test that must go red |
|---|---|
| Drop the `Math.min(duration, Math.max(0, raw))` clamp, return `raw` | "it never runs past the end, however stale the anchor" |
| `const serverNow = now;` (drop `+ skewMs`) | "a slow browser clock is corrected by skew, not believed" |

- [ ] **Step 6: Write the failing row tests, `renderer/main/pvp-layer-row.test.tsx`**

```tsx
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PvpLayerRow } from "./pvp-layer-row.js";
import type { PvpLayerDTO } from "@main/types/pvp";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 10, durationSec: 20,
  ...over,
});

const T = "2026-08-30T12:00:00.000Z";
const AT = Date.parse(T);
const draw = (l: PvpLayerDTO): string =>
  renderToStaticMarkup(<PvpLayerRow layer={l} sampledAt={T} now={AT} skewMs={0} showProgress compact={false} />);

describe("PvpLayerRow", () => {
  test("a playing layer names its media and its cue", () => {
    const html = draw(layer());
    assert.ok(html.includes("loop_a.mp4"), html);
    assert.ok(html.includes("MAIN GRAPHIC"), html);
  });

  test("AN EMPTY LAYER NEVER DRAWS ITS RESIDUAL CUE NAME", () => {
    // THE finding. playingItem never clears, so four idle layers were observed
    // all naming the same cue while showing nothing. A row that drew it would
    // tell an operator five layers were live when one was.
    const html = draw(layer({ state: "empty", mediaName: null, mediaUuid: null, anchorElapsedSec: null, durationSec: null }));
    assert.ok(!html.includes("MAIN GRAPHIC"), `an empty layer drew its stale cue:\n${html}`);
  });

  test("an empty layer says so, rather than rendering blank", () => {
    const html = draw(layer({ state: "empty", mediaName: null, mediaUuid: null, anchorElapsedSec: null, durationSec: null }));
    assert.ok(/Empty/i.test(html), html);
  });

  test("a still draws no progress bar", () => {
    // A still reports timeRemaining 0. A bar for it would sit at an end and read
    // as a clip that had finished.
    const html = draw(layer({ state: "still", mediaName: "still_b.png", durationSec: null }));
    assert.ok(!html.includes("data-pvp-bar"), html);
    assert.ok(html.includes("still_b.png"), html);
  });

  test("a rolling video draws a bar and the time left", () => {
    const html = draw(layer());
    assert.ok(html.includes("data-pvp-bar"), html);
    assert.ok(html.includes("0:10"), html);
  });

  test("hidden, muted and faded each get a badge", () => {
    const html = draw(layer({ hidden: true, muted: true, opacity: 0.5 }));
    assert.ok(/Hidden/i.test(html), html);
    assert.ok(/Muted/i.test(html), html);
    assert.ok(html.includes("50%"), html);
  });

  test("a fully opaque layer gets NO opacity badge", () => {
    // Otherwise every layer on the wall wears a permanent "100%".
    assert.ok(!draw(layer()).includes("100%"), draw(layer()));
  });
});
```

- [ ] **Step 7: Write `renderer/main/pvp-layer-row.tsx`**

```tsx
// pvp-layer-row.tsx — ONE row of the PVP layer list.
//
// The single component both PVP surfaces render, so the residual-cue rule below
// lives in exactly one place. With a component per surface there would be two
// chances to draw a stale cue name on an empty layer, which is the mistake
// CLAUDE.md calls the most expensive recurring one in this repo.

import { fmtDuration } from "./pco-timer";
import { computePvpProgress } from "./pvp-progress";
import type { PvpLayerDTO } from "@main/types/pvp";

export interface PvpLayerRowProps {
  layer: PvpLayerDTO;
  /** From PvpStatusDTO. The anchor every progress reading is measured from. */
  sampledAt: string | null;
  now: number;
  skewMs: number;
  showProgress: boolean;
  /** Home's card is tighter than a wall tile: one line, no bar. */
  compact: boolean;
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1 rounded-sm bg-fg/10 text-fg-muted text-[0.8em] leading-tight shrink-0">{children}</span>
  );
}

export function PvpLayerRow({ layer, sampledAt, now, skewMs, showProgress, compact }: PvpLayerRowProps) {
  const empty = layer.state === "empty";
  const progress = showProgress && !compact ? computePvpProgress(layer, sampledAt, now, skewMs) : null;

  // THE RULE. `lastCueName` is the last cue that TOUCHED this layer and it never
  // clears — four idle layers were observed simultaneously naming the same cue
  // while displaying nothing. It is carried on the DTO because it is the only
  // field that can confirm a trigger action landed, and it is drawn only here,
  // only when the layer actually holds something.
  const cue = empty ? null : layer.lastCueName;

  return (
    <div className="flex flex-col gap-[0.15em] min-w-0" style={{ opacity: empty ? 0.45 : 1 }}>
      <div className="flex items-baseline gap-[0.4em] min-w-0">
        <span className="text-fg-muted shrink-0">{layer.name}</span>
        <span className="truncate min-w-0">{empty ? "Empty" : (layer.mediaName ?? "Playing")}</span>
        {layer.hidden && <Badge>Hidden</Badge>}
        {layer.muted && <Badge>Muted</Badge>}
        {/* Only when it is actually faded. A permanent "100%" on every layer is
            chrome, and the badge row is meant to say what is unusual. */}
        {layer.opacity < 1 && <Badge>{Math.round(layer.opacity * 100)}%</Badge>}
      </div>

      {cue && <div className="text-[0.8em] text-fg-subtle truncate min-w-0">{cue}</div>}

      {progress && (
        <div className="flex items-center gap-[0.4em]">
          <div
            data-pvp-bar
            className="h-[0.18em] flex-1 min-w-0 rounded-full overflow-hidden bg-fg/15"
          >
            <div className="h-full rounded-full bg-fg" style={{ width: `${progress.fraction * 100}%` }} />
          </div>
          <span className="text-[0.8em] text-fg-subtle tabular-nums shrink-0">
            {fmtDuration(progress.remainingSec)}
          </span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run the row tests, then PROVE the residual-cue guard**

```bash
npm test -- --test-name-pattern="PvpLayerRow" 2>&1 | tail -20
```

The mutation, watched red in-session and named in the commit: **`const cue = layer.lastCueName;`** (drop the `empty ?` arm) — "AN EMPTY LAYER NEVER DRAWS ITS RESIDUAL CUE NAME" goes red. Revert.

Second mutation: **`computePvpProgress` called unconditionally in `PvpLayerRow` with a synthesised `durationSec` of 1 for stills** — "a still draws no progress bar" goes red. Revert. (The point is that the null-for-a-still rule lives in `computePvpProgress` and the row trusts it, so both files are covered by one guard.)

- [ ] **Step 9: Add the object type to the config union, `main/types/views.ts`**

```ts
  // ProVideoPlayer layer state (from the PVP integration, `pvp:status` channel).
  //
  // A LIST, not a status slab: PVP is up to eleven layers and the useful question
  // is which of them are showing something. `show` filters, because eleven rows
  // do not fit a wall tile at wall-legible type and two of eleven was the
  // observed steady state.
  //
  // There is no picture option because PVP has no preview, thumbnail or frame
  // endpoint of any kind. Every reading here is a name, a state or a time.
  | {
      type: "pvp-layers";
      /** "with-content" is the default: it turns an eleven-row list into a
       *  two-row one and is the question an operator glancing at a wall is
       *  actually asking. "one" needs `layerName`. */
      show?: "with-content" | "all" | "one";
      /** For `show: "one"`. Matched on the layer's NAME, not its uuid: a uuid is
       *  opaque in an inspector, and a workspace rebuilt from a template has new
       *  uuids for the same layers. */
      layerName?: string | null;
      /** Draw the progress bar and the time remaining under a rolling clip. */
      showProgress?: boolean;
      /** Render nothing at all when no layer matches — a tally light rather than
       *  an empty box. */
      hideWhenEmpty?: boolean;
    }
```

- [ ] **Step 10: Follow the compiler**

`npx tsc --noEmit` and fix each error in turn. `LayoutObjectType` is derived from this union, and `CAPABILITIES`, the palette `ICONS` map and `LAYOUT_OBJECTS` are all `Record<LayoutObjectType, …>`, with `const _never: never = c;` at the end of the render switch. So the compiler names every place:

1. `main/types/object-capabilities.ts` — `"pvp-layers": ["readout"],`. Not `drilldown`: a test asserts `CAPABILITIES` and the `DRILLDOWN` route table agree in both directions, so declaring one without the other fails.
2. `renderer/main/layout-objects.ts` — the registry entry, and `"ProVideoPlayer"` appended to `PALETTE_GROUP_ORDER` after `"YouTube"` (the per-integration groups run OBS, REAPER, Resi, YouTube; PVP joins them):

```ts
  "pvp-layers": {
    label: "ProVideoPlayer layers",
    blurb: "What ProVideoPlayer has on each layer, and how long is left",
    group: "ProVideoPlayer",
    config: () => ({ type: "pvp-layers", show: "with-content", layerName: null, showProgress: true, hideWhenEmpty: false }),
    style: () => CARD({ fontSize: 0.05 }),
    homeSize: "m",
    integration: { id: "pvp", label: "ProVideoPlayer" },
  },
```

The blurb is asserted non-empty, at most 60 characters, sentence case, no trailing full stop, and different from the label. `"What ProVideoPlayer has on each layer, and how long is left"` is 58.

`integration: { id: "pvp", … }` is what dims the palette card until the integration is set up — `useConfiguredIntegrations()` reads it.

3. `renderer/editor/palette.tsx` — `"pvp-layers": LayersIcon,` in `ICONS`, importing `Layers` from lucide. It is the only new icon; `home-pvp` in Task 4 reuses it.
4. `renderer/main/layout-renderer.tsx` — the render case, beside the other component-bodied objects:

```ts
    case "pvp-layers":
      return <PvpObject o={o} config={c} ctx={ctx} />;
```

`IDIOM_TYPES` is **not** joined: this object is a list, and `readout-types.ts:40-53` already records why `charger-battery` and `people-panel` stay out — squeezing a list into caption/value/sub means picking one row and dropping the rest, which is a feature removal wearing a restyle's clothes.

- [ ] **Step 11: Gate the data hook**

In `useLayoutData` in `renderer/main/layout-renderer.tsx`, beside `useReaperState`:

```ts
  const pvp = usePvpState(want(["pvp-layers", "home-pvp"]));
```

and thread `pvp` through the returned object and into `LayoutRenderCtx` (three places: the `return { … }` at `:2435`, the destructure at `:2455`, and the `ctx` literal at `:2524`), plus `pvp: PvpStatusDTO | null;` on the `LayoutRenderCtx` interface at `:56`.

This gate is what makes an unused integration free on a nine-tile wall, and it matters more here than for most: the channel's demand is what decides the poll cadence at the server, so an ungated hook would hold PVP at 1 Hz for a screen showing a clock.

Verify the gate actually works rather than assuming: place a `pvp-layers` object, confirm frames arrive; remove it, reload, and confirm `/api/events` stops carrying `pvp:status` frames beyond the hello burst.

- [ ] **Step 12: Write `renderer/main/pvp-object.tsx`**

```tsx
// pvp-object.tsx — the ProVideoPlayer layer list, at wall scale.
//
// Its own file, like osc-button.tsx: it has a filter, an empty state and a
// per-row composition, which is more than a switch arm should hold.
//
// It shows NO PICTURE, and there is no setting that would. PVP exposes no
// thumbnail, preview or frame endpoint — all 80 documented paths were enumerated
// — so "what is on screen" is answerable here only as a name, a state and a time.

import { PvpLayerRow } from "./pvp-layer-row";
import type { LayoutObjectConfig, LayoutObject } from "@main/types/stage";
import type { PvpLayerDTO } from "@main/types/pvp";
import type { LayoutRenderCtx } from "./layout-renderer";

type Config = Extract<LayoutObjectConfig, { type: "pvp-layers" }>;

/**
 * Which layers this object draws.
 *
 * PURE and exported so the filter is testable without React. "with-content" is
 * decided by `state`, which parseWorkspace derived from the PRESENCE of
 * playingMedia — never from isPlaying, and never from playingItem.
 */
export function visibleLayers(layers: readonly PvpLayerDTO[], c: Config): PvpLayerDTO[] {
  if (c.show === "all") return [...layers];
  if (c.show === "one") {
    const want = (c.layerName ?? "").trim().toLowerCase();
    // An unconfigured "one" shows nothing rather than everything: silently
    // showing all eleven would look like the filter had been ignored.
    if (!want) return [];
    return layers.filter((l) => l.name.trim().toLowerCase() === want);
  }
  return layers.filter((l) => l.state !== "empty");
}

export function PvpObject({
  o,
  config,
  ctx,
}: {
  o: LayoutObject;
  config: Config;
  ctx: LayoutRenderCtx;
}) {
  const c = config;
  const status = ctx.pvp;
  const rows = visibleLayers(status?.layers ?? [], c);

  if (rows.length === 0) {
    if (c.hideWhenEmpty ?? false) return null;
    // Three different nothings, said differently. "—" for every one of them would
    // make an unreachable PVP look identical to an idle one.
    const why = !status?.connected
      ? "ProVideoPlayer offline"
      : c.show === "one"
        ? ((c.layerName ?? "").trim() ? `No layer named ${c.layerName}` : "No layer chosen")
        : "Nothing on screen";
    return <span className="text-fg-subtle opacity-60">{why}</span>;
  }

  return (
    <div className="flex flex-col gap-[0.35em] w-full h-full overflow-hidden">
      {rows.map((l) => (
        <PvpLayerRow
          key={l.uuid}
          layer={l}
          sampledAt={status?.sampledAt ?? null}
          now={ctx.now}
          skewMs={ctx.skewMs}
          showProgress={c.showProgress ?? true}
          compact={false}
        />
      ))}
    </div>
  );
}
```

Add three filter tests to `pvp-layer-row.test.tsx` (same file, they share the fixture shape):

```ts
describe("visibleLayers", () => {
  const layers = parseWorkspace(FIXTURE_JSON);

  test("with-content drops the empty layers, which is the useful default", () => {
    const shown = visibleLayers(layers, { type: "pvp-layers", show: "with-content" });
    assert.deepEqual(shown.map((l) => l.name), ["Graphics", "Lower third"]);
  });

  test("all shows all of them", () => {
    assert.equal(visibleLayers(layers, { type: "pvp-layers", show: "all" }).length, 4);
  });

  test("one with no layer chosen shows NOTHING, not everything", () => {
    // Falling back to all eleven would look like the filter had been ignored.
    assert.deepEqual(visibleLayers(layers, { type: "pvp-layers", show: "one", layerName: "" }), []);
  });

  test("one matches the layer name case-insensitively", () => {
    const shown = visibleLayers(layers, { type: "pvp-layers", show: "one", layerName: "  graphics " });
    assert.deepEqual(shown.map((l) => l.name), ["Graphics"]);
  });
});
```

- [ ] **Step 13: Add the inspector block**

A flat `{c.type === "pvp-layers" && (…)}` block in `renderer/editor/inspector.tsx`, using the existing `Row` / `RowSelect` / `RowText` / `RowSwitch` helpers, beside the `reaper-status` block:

```tsx
      {c.type === "pvp-layers" && (() => {
        const shown = (pvp?.layers ?? []).filter((l) => l.state !== "empty").length;
        const live = !pvp?.connected
          ? "Not connected"
          : `${pvp.layers.length} layers, ${shown} with content`;
        return (
          <>
            <Row label="ProVideoPlayer"><span className="text-caption2 text-fg-muted">{live}</span></Row>
            <RowSelect
              label="Show"
              value={c.show ?? "with-content"}
              options={[
                { value: "with-content", label: "Layers with content" },
                { value: "all", label: "All layers" },
                { value: "one", label: "One layer" },
              ]}
              onChange={(v) => onConfig({ ...c, show: v as "with-content" | "all" | "one" })}
            />
            {(c.show ?? "with-content") === "one" && (
              <RowText
                label="Layer name"
                value={c.layerName ?? ""}
                placeholder={pvp?.layers[0]?.name ?? "Layer name"}
                onChange={(v) => onConfig({ ...c, layerName: v })}
              />
            )}
            <RowSwitch label="Show progress" checked={c.showProgress ?? true} onChange={(v) => onConfig({ ...c, showProgress: v })} />
            <RowSwitch label="Hide when nothing is on screen" checked={c.hideWhenEmpty ?? false} onChange={(v) => onConfig({ ...c, hideWhenEmpty: v })} />
          </>
        );
      })()}
```

with `const pvp = usePvpState();` beside `const reaper = useReaperState();` at the top of the inspector.

The layer-name field is a free text field with the live first layer name as its placeholder, not a select. A select would be populated only while PVP is connected, so an operator building a layout on a laptop away from the machine would find an empty dropdown and no way to type the name they know.

- [ ] **Step 14: Move the counts and the docs row**

- `renderer/main/object-catalog.test.ts:19`: 54 → 55 (Task 4 takes it to 56; if the two tasks are committed together, go straight to 56 — check the suite, do not assume).
- `main/types/object-capabilities.test.ts:20`: 54 → 55, and the message string with it.
- `renderer/main/object-fit.test.ts:34`: 54 → 55; and the test's own name at `:26` says "holds exactly 54 types" — change the words too, or the next reader trusts a lie.
- `renderer/main/object-look.test.ts:60`: 54 → 55, `:61`: 29 → 30 (this object is carded).
- `renderer/main/layout-objects.test.ts` `ADDED_SINCE`: `{ type: "pvp-layers", label: "ProVideoPlayer layers", group: "ProVideoPlayer", after: null }` — `after: null` because it leads its own new group.
- `docs/reference/widgets.md`: a `| **ProVideoPlayer layers** | … |` row. `widget-docs.test.ts` matches the bolded label **verbatim in both directions**, so it must read exactly `ProVideoPlayer layers`.

- [ ] **Step 15: Run the browser overflow sweep**

`renderer/main/object-fit.test.ts:26` carries a comment asking for a browser overflow sweep against a new type before the count is bumped. Do it, do not skip it: place the object on a 1920x1080 canvas at its default tile and at a full-width tile, with `show: "all"` against a workspace of eleven layers, and confirm nothing overflows its box at either. Eleven rows in a small tile is the case this object's `show` filter exists for, and it is the one that will look wrong.

- [ ] **Step 16: Full suite, then commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git commit -m "feat(layout): a ProVideoPlayer layer list that never claims a residual cue is live"
```

The commit body names the four guard mutations from Steps 5 and 8, and confirms the overflow sweep was run.

---

## Task 4: The Home card

**Files:**
- Modify: `main/types/views.ts`
- Modify: `main/types/object-capabilities.ts`
- Modify: `renderer/main/layout-objects.ts`
- Modify: `renderer/editor/palette.tsx`
- Modify: `renderer/app/home/cards.tsx`
- Modify: `renderer/main/object-look.test.ts`
- Modify: `renderer/app/home/home-card-routing.test.ts`
- Modify: `renderer/main/object-catalog.test.ts`
- Modify: `main/types/object-capabilities.test.ts`
- Modify: `renderer/main/object-fit.test.ts`
- Modify: `renderer/main/layout-objects.test.ts`
- Modify: `docs/reference/widgets.md`

There is no separate Home card registry. A Home card is an ordinary layout object whose type begins `home-`, claimed by `isHomeCard` before `LayoutRenderer`'s own switch (`layout-renderer.tsx:689`). Most of the work is shared with Task 3, and the card body is `PvpLayerRow` in compact mode.

**Interfaces:**
- Consumes: Task 3's `PvpLayerRow` and `visibleLayers`; Task 2's `usePvpState`.
- Produces: the `home-pvp` object type and its `HomeCard` case.

- [ ] **Step 1: Add `home-pvp` to the union in `main/types/views.ts`**

```ts
  // ProVideoPlayer, on the operator's own page: what is on screen and how long
  // is left. Always "layers with content" — a Home tile has room for the answer,
  // not for eleven rows of mostly nothing.
  | { type: "home-pvp" }
```

Bare discriminant, like `home-recording-reaper`. The layout object in Task 3 is where the options live; a Home card is a glance, and every option on it is one more thing to set up before it says anything.

- [ ] **Step 2: The spec, `HOST_FRAMED_TYPES`, and `BARE` — all in one edit**

`renderer/main/layout-objects.ts`:

```ts
  "home-pvp": {
    label: "ProVideoPlayer",
    blurb: "What is on screen now, and how long is left",
    group: "ProVideoPlayer",
    config: () => ({ type: "home-pvp" }),
    style: BARE,
    homeSize: "m",
    stylingOnly: true,
    integration: { id: "pvp", label: "ProVideoPlayer" },
  },
```

`homeSize: "m"` rather than `"s"`: the card carries a media name and a time, and the observed media names are long file names. `"s"` is a square, and a square would truncate the one thing the card exists to show. It is in `SIZE_ORDER`, which `home-cards.test.ts:74-79` asserts.

`stylingOnly: true` because there is nothing to configure, matching `home-recording-reaper`.

Then add `"home-pvp"` to `HOST_FRAMED_TYPES` (`layout-objects.ts:135`, 12 → 13) so it is frameless on Home — where the grid draws one tile frame for everything — and framed on a wall. **In the same edit**, add `"home-pvp"` to the `home-*` run of `BARE` in `renderer/main/object-look.test.ts:19-37` (25 → 26). `object-look.test.ts:196-203` asserts those two lists are equal, so they move together or the suite fails; and `:62` asserts the not-carded count equals `BARE.length`, which is then satisfied with no number to bump.

- [ ] **Step 3: Capability, icon, and the two Home registration points**

- `main/types/object-capabilities.ts`: `"home-pvp": ["readout"],`
- `renderer/editor/palette.tsx`: `"home-pvp": LayersIcon,` — the same icon as `pvp-layers`, which is how the OBS and REAPER pairs already read.
- `renderer/app/home/cards.tsx`: `"home-pvp": true,` in `HOME_CARD_TYPES`, **and** the case in the `HomeCard` switch. Both fail to compile if skipped: `HOME_CARD_TYPES` is `Record<HomeCardType, true>` and the switch ends in `const _never: never = type;`. `layout-renderer.tsx` needs no edit — `isHomeCard(c)` at `:689` intercepts before the switch, which is the routing bug `home-card-routing.test.ts` was written for.

- [ ] **Step 4: Write the card body in `renderer/app/home/cards.tsx`**

```tsx
/**
 * ProVideoPlayer, at a glance.
 *
 * Up to three layers with content, compact. `visibleLayers` is the SAME filter
 * the wall object uses and PvpLayerRow is the same row, so the two surfaces
 * cannot disagree about whether a layer is live — which matters here more than
 * usual, because the field that would make them disagree (`playingItem`) never
 * clears and is wrong on four layers out of five at rest.
 *
 * No preview image, and there is no version of this card that has one: PVP
 * exposes no thumbnail or frame endpoint at all.
 */
function PvpCard({ now, skewMs }: { now: number; skewMs: number }) {
  const pvp = usePvpState();
  const rows = visibleLayers(pvp?.layers ?? [], { type: "pvp-layers", show: "with-content" });

  if (!pvp?.connected) return <Stat label="ProVideoPlayer" value="Offline" dim />;
  if (rows.length === 0) return <Stat label="ProVideoPlayer" value="Nothing on screen" dim />;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {/* Three, not all of them. A Home tile is a glance; the wall object is
          where an operator goes to see the whole stack. */}
      {rows.slice(0, 3).map((l) => (
        <PvpLayerRow
          key={l.uuid}
          layer={l}
          sampledAt={pvp.sampledAt}
          now={now}
          skewMs={skewMs}
          showProgress
          compact
        />
      ))}
      {rows.length > 3 && (
        <span className="text-caption2 text-fg-subtle">{rows.length - 3} more</span>
      )}
    </div>
  );
}
```

and the case:

```tsx
      case "home-pvp":
        return <PvpCard now={now} skewMs={skewMs} />;
```

`now` and `skewMs` are already parameters of `HomeCard` (`cards.tsx:626-634`) and already threaded from `home-grid.tsx:187`, so nothing new is plumbed.

`compact` is true, so `PvpLayerRow` draws the name, the media and the badges on one line and no bar. The time remaining is the thing worth having pre-service and it is on the wall object; on a Home tile carrying up to three rows, three bars is a texture rather than a reading.

- [ ] **Step 5: Move the last two counts**

- `renderer/app/home/home-card-routing.test.ts:25`: 12 → 13.
- `renderer/main/object-catalog.test.ts:19`, `main/types/object-capabilities.test.ts:20`, `renderer/main/object-fit.test.ts:34`, `renderer/main/object-look.test.ts:60`: 55 → 56 (or straight to 56 from 54 if Tasks 3 and 4 are one commit — run the suite and read the numbers it reports rather than assuming).
- `renderer/main/object-look.test.ts:61` stays at 30: `home-pvp` is bare.
- `renderer/main/layout-objects.test.ts` `ADDED_SINCE`: `{ type: "home-pvp", label: "ProVideoPlayer", group: "ProVideoPlayer", after: "pvp-layers" }`. The `after` is asserted for real at `:434-450` — the entry must sit immediately after `pvp-layers` in the registry.
- `docs/reference/widgets.md`: a `| **ProVideoPlayer** *(Home)* | … |` row. The bolded capture stops at the closing `**`, so the `*(Home)*` qualifier sits outside it and the label matches exactly — the same shape the existing `**Recording** *(Home)*` row uses.

- [ ] **Step 6: Drive it**

Not "it renders" — drive it:

1. Add the card on Home, confirm it shows real layers from the live PVP.
2. Reload. Confirm it survives, hydrating from the burst rather than waiting for a change (this is what putting `pvp:status` in `HYDRATED_CHANNELS` bought).
3. Clear every PVP layer. Confirm the card reads "Nothing on screen" and **does not** name the residual cue.
4. Stop PVP. Confirm the card reads "Offline", dimmed, rather than freezing on the last thing it saw.
5. Right-click the card. Confirm the settings menu offers only size and visibility — no PVP toggles leaked into `card-toggles.ts`.

- [ ] **Step 7: Full suite, then commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git commit -m "feat(home): what ProVideoPlayer has on screen, on the operator's own page"
```

---

## Task 5: Automation — triggers and conditions

**Files:**
- Modify: `main/services/automation-triggers.ts`
- Modify: `main/services/automation-triggers.test.ts`
- Modify: `main/services/automation-conditions.ts`
- Modify: `main/services/automation-conditions.test.ts`
- Modify: `main/types/automation.ts`
- Modify: `main/services/automation-engine.ts`

**Interfaces:**
- Consumes: Task 1's `PvpLayerDTO`; Task 2's `pvpService` and the `pvp:status` channel (already in `BROADCAST_CHANNELS`).
- Produces: seven `pvp.*` triggers and five `pvp.*` conditions, on top of the `pvp.connected` / `pvp.disconnected` / `pvp.is-connected` trio Task 2 generated.

**No UI work.** The automations tab is entirely spec-driven: the server strips the functions and ships the registry at `GET /api/automation/registry`, and `automation-section.tsx`'s three pickers map it. A trigger, condition or action added to a registry appears in the UI with no renderer change at all. The one exception is a new `optionsFrom` source, and none of these use one — see the decision below.

### One decision, stated: layers are named by NAME, not uuid

Every trigger and condition here takes an optional `layer` param matched on the layer's **name**, case-insensitively, blank meaning "any layer". Not the uuid, even though the uuid is what the DTO keys on and what the actions address.

A uuid is opaque in a rule editor, it is what the operator would have to copy out of an API response, and a workspace rebuilt from a template has new uuids for the same layers — so a uuid-keyed rule would silently stop firing after a workspace rebuild, with nothing to say why. A name is what the operator sees in PVP.

The cost is stated in the docs: **renaming a layer in ProVideoPlayer stops the rule, silently**. That is the same trade `pco.live.advance` already makes for plan item titles, and `docs/automation.md` already says so for that case in exactly those words.

The alternative — a dropdown fed from the live workspace — needs a new `optionsFrom` source, and `optionsFrom` is currently wired for only three of its six declared values (`osc-targets`, `service-types` and `displays` have no entry in `automation-section.tsx`'s `dynamicOptions`, so those selects render empty today). Adding a fourth working source means widening the union in `main/types/automation.ts`, adding a route, and adding a query — three edits for a dropdown that is empty whenever PVP is unreachable, which is exactly when an operator is most likely to be building a rule. A plain string with the live layer names shown in the layout inspector is the smaller, more honest control. **This is a place the plan deliberately does less than it could**, recorded in Self-Review.

- [ ] **Step 1: Write the failing trigger tests, in `main/services/automation-triggers.test.ts`**

```ts
describe("ProVideoPlayer triggers", () => {
  const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
    uuid: "l1", name: "Graphics", index: 0, state: "video",
    mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
    hidden: false, muted: false, opacity: 1, playbackRate: 1,
    anchorElapsedSec: 1, durationSec: 20,
    ...over,
  });
  const snap = (...layers: PvpLayerDTO[]) => ({ connected: true, layers, sampledAt: "2026-08-30T12:00:00.000Z" });
  const fire = (id: string, prev: unknown, next: unknown, params: Record<string, unknown> = {}) =>
    AUTOMATION_TRIGGERS[id].didFire(prev, next, params, Date.now());

  test("a cue starting on a layer fires when the media uuid changes", () => {
    assert.equal(fire("pvp.cue-started", snap(layer()), snap(layer({ mediaUuid: "m2", mediaName: "loop_b.mp4" }))), true);
  });

  test("a cue starting does NOT fire on the same media looping round", () => {
    // The media uuid is unchanged, and a loop is not a new cue. Firing here would
    // run the rule every twenty seconds for the whole of pre-service.
    assert.equal(fire("pvp.cue-started", snap(layer({ anchorElapsedSec: 19 })), snap(layer({ anchorElapsedSec: 0.2 }))), false);
  });

  test("a cue starting fires when a layer goes from empty to holding media", () => {
    const empty = layer({ state: "empty", mediaUuid: null, mediaName: null, anchorElapsedSec: null, durationSec: null });
    assert.equal(fire("pvp.cue-started", snap(empty), snap(layer())), true);
  });

  test("a cue starting on the NAMED layer only", () => {
    const other = layer({ uuid: "l2", name: "Lower third" });
    const moved = { ...other, mediaUuid: "m9" };
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: "Lower third" }), true);
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: "Graphics" }), false);
    // Blank means any layer, so a half-built rule fires rather than never firing.
    assert.equal(fire("pvp.cue-started", snap(layer(), other), snap(layer(), moved), { layer: "" }), true);
  });

  test("a layer clearing fires when playingMedia goes away", () => {
    const empty = layer({ state: "empty", mediaUuid: null, mediaName: null, anchorElapsedSec: null, durationSec: null });
    assert.equal(fire("pvp.layer-cleared", snap(layer()), snap(empty)), true);
    assert.equal(fire("pvp.layer-cleared", snap(empty), snap(layer())), false);
  });

  test("a layer VANISHING from the payload is not a clear", () => {
    // A layer PVP stopped reporting is unknown, not empty. Unknown is not a
    // value — the same rule "an integration vanishing is not a disconnect" makes.
    assert.equal(fire("pvp.layer-cleared", snap(layer()), snap()), false);
  });

  test("playback stopping fires when a rolling layer stops rolling", () => {
    assert.equal(fire("pvp.playback-stopped", snap(layer()), snap(layer({ state: "still", playbackRate: 0 }))), true);
  });

  test("playback stopping does NOT fire because PVP went offline", () => {
    // A dropped connection reports an empty workspace. Treating that as "the clip
    // finished" would fire an end-of-clip rule because a machine went down.
    assert.equal(fire("pvp.playback-stopped", snap(layer()), { connected: false, layers: [], sampledAt: null }), false);
  });

  test("hide, unhide, mute and unmute each fire on their own edge", () => {
    assert.equal(fire("pvp.layer-hidden", snap(layer()), snap(layer({ hidden: true }))), true);
    assert.equal(fire("pvp.layer-hidden", snap(layer({ hidden: true })), snap(layer())), false);
    assert.equal(fire("pvp.layer-unhidden", snap(layer({ hidden: true })), snap(layer())), true);
    assert.equal(fire("pvp.layer-muted", snap(layer()), snap(layer({ muted: true }))), true);
    assert.equal(fire("pvp.layer-unmuted", snap(layer({ muted: true })), snap(layer())), true);
  });

  test("no PVP trigger fires on a null prev", () => {
    // The restart guard. Asserted globally for every trigger elsewhere in this
    // file; named here too because these are the ones that would fire a whole
    // service's worth of rules at once after an update.
    for (const id of Object.keys(AUTOMATION_TRIGGERS).filter((k) => k.startsWith("pvp."))) {
      assert.equal(AUTOMATION_TRIGGERS[id].didFire(null, snap(layer()), {}, Date.now()), false, `${id} fired on a null prev`);
    }
  });

  test("every PVP trigger survives a malformed payload without throwing", () => {
    for (const id of Object.keys(AUTOMATION_TRIGGERS).filter((k) => k.startsWith("pvp."))) {
      for (const junk of [{}, { layers: null }, { layers: "no" }, { layers: [null, 7] }]) {
        assert.doesNotThrow(() => AUTOMATION_TRIGGERS[id].didFire(junk, junk, {}, Date.now()), `${id} threw on ${JSON.stringify(junk)}`);
      }
    }
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npm test -- --test-name-pattern="ProVideoPlayer triggers" 2>&1 | tail -20
```

Expected: `Cannot read properties of undefined (reading 'didFire')` — the ids do not exist yet.

- [ ] **Step 3: Write the triggers in `main/services/automation-triggers.ts`**

Helpers, beside the other `as…` coercions at the top of the file:

```ts
type PvpLayer = {
  uuid?: string;
  name?: string;
  state?: string;
  mediaUuid?: string | null;
  hidden?: boolean;
  muted?: boolean;
  playbackRate?: number;
};
type PvpSnap = { connected?: boolean; layers?: unknown };

const asPvp = (v: unknown): PvpLayer[] => {
  const raw = (v && typeof v === "object" ? (v as PvpSnap).layers : null) ?? null;
  return Array.isArray(raw) ? raw.filter((l): l is PvpLayer => !!l && typeof l === "object") : [];
};

/** PVP is reachable in this snapshot. A dropped connection reports an empty
 *  workspace, and every "it stopped" trigger below refuses to read that as an
 *  event — unreachable is unknown, not stopped. */
const pvpUp = (v: unknown): boolean => (v && typeof v === "object" ? (v as PvpSnap).connected !== false : false);

/** Does this layer match the rule's `layer` param? Blank matches ANY layer, so an
 *  unconfigured rule fires rather than silently never firing. Matched on the
 *  NAME: a uuid is opaque in a rule editor and changes when a workspace is
 *  rebuilt from a template. */
const pvpNamed = (l: PvpLayer, want: unknown): boolean => {
  const w = String(want ?? "").trim().toLowerCase();
  return !w || (l.name ?? "").trim().toLowerCase() === w;
};

/** Pairs of (before, after) for layers present in BOTH snapshots, matched on
 *  uuid. A layer only in one is skipped: a layer that has appeared or vanished is
 *  unknown, not an edge, and reading a vanished layer as "cleared" would fire an
 *  end-of-cue rule because PVP restarted. */
function pvpPairs(prev: unknown, next: unknown): { before: PvpLayer; after: PvpLayer }[] {
  const before = new Map(asPvp(prev).map((l) => [l.uuid, l]));
  const out: { before: PvpLayer; after: PvpLayer }[] = [];
  for (const after of asPvp(next)) {
    const b = before.get(after.uuid);
    if (b) out.push({ before: b, after });
  }
  return out;
}

/**
 * A boolean layer flag flipping one way. Generated rather than written out four
 * times over, because hidden and muted are mechanically identical and only the
 * words differ.
 */
function pvpFlagTriggers(
  key: "hidden" | "muted",
  onLabel: string,
  offLabel: string,
): Record<string, TriggerDef> {
  const LAYER: ParamDef = {
    key: "layer",
    label: "Layer",
    type: "string",
    optional: true,
    help: "The layer's name in ProVideoPlayer. Leave blank for any layer. Renaming the layer in PVP stops the rule.",
  };
  const make = (id: string, label: string, want: boolean): TriggerDef =>
    def({
      id,
      label,
      channel: "pvp:status",
      params: [LAYER],
      didFire: (prev, next, params) => {
        if (prev === null) return false;
        if (!pvpUp(next)) return false;
        return pvpPairs(prev, next).some(
          ({ before, after }) =>
            pvpNamed(after, params.layer) && before[key] !== want && after[key] === want,
        );
      },
    });
  return {
    [`pvp.layer-${onLabel}`]: make(`pvp.layer-${onLabel}`, `A ProVideoPlayer layer is ${onLabel}`, true),
    [`pvp.layer-${offLabel}`]: make(`pvp.layer-${offLabel}`, `A ProVideoPlayer layer is ${offLabel}`, false),
  };
}
```

Then, in `AUTOMATION_TRIGGERS`, spread the generated pair and add the three bespoke ones:

```ts
  ...pvpFlagTriggers("hidden", "hidden", "unhidden"),
  ...pvpFlagTriggers("muted", "muted", "unmuted"),

  "pvp.cue-started": def({
    id: "pvp.cue-started",
    label: "A cue starts on a ProVideoPlayer layer",
    channel: "pvp:status",
    params: [{
      key: "layer", label: "Layer", type: "string", optional: true,
      help: "The layer's name in ProVideoPlayer. Leave blank for any layer. Renaming the layer in PVP stops the rule.",
    }],
    help: "Fires when a layer starts showing DIFFERENT media. The same clip looping round is not a new cue and does not fire.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      if (!pvpUp(next)) return false;
      // The media UUID, not the name: the observed workspace had seven files
      // whose names differed only by a trailing digit, and two cues in different
      // playlists can point at the same file.
      return pvpPairs(prev, next).some(
        ({ before, after }) =>
          pvpNamed(after, params.layer) &&
          (after.mediaUuid ?? null) !== null &&
          (before.mediaUuid ?? null) !== (after.mediaUuid ?? null),
      );
    },
  }),

  "pvp.layer-cleared": def({
    id: "pvp.layer-cleared",
    label: "A ProVideoPlayer layer clears",
    channel: "pvp:status",
    params: [{
      key: "layer", label: "Layer", type: "string", optional: true,
      help: "The layer's name in ProVideoPlayer. Leave blank for any layer. Renaming the layer in PVP stops the rule.",
    }],
    help: "A layer that was showing something now holds nothing. PVP going unreachable does not count — that is unknown, not empty.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      if (!pvpUp(next)) return false;
      return pvpPairs(prev, next).some(
        ({ before, after }) =>
          pvpNamed(after, params.layer) && before.state !== "empty" && after.state === "empty",
      );
    },
  }),

  "pvp.playback-stopped": def({
    id: "pvp.playback-stopped",
    label: "A ProVideoPlayer clip stops rolling",
    channel: "pvp:status",
    params: [{
      key: "layer", label: "Layer", type: "string", optional: true,
      help: "The layer's name in ProVideoPlayer. Leave blank for any layer. Renaming the layer in PVP stops the rule.",
    }],
    // Why this and not "the clip reached its end": timeElapsed and timeRemaining
    // move on every poll, so they are deliberately excluded from the broadcast —
    // otherwise a 1 Hz poll would be a 1 Hz SSE frame to every display. The
    // engine only ever sees broadcast frames, so it cannot watch a countdown
    // cross zero. "Stops rolling" is the same moment on the wall and it IS
    // observable on a frame this design sends.
    help: "A clip that was playing has stopped, ended or been paused. PVP going unreachable does not count.",
    didFire: (prev, next, params) => {
      if (prev === null) return false;
      if (!pvpUp(next)) return false;
      return pvpPairs(prev, next).some(
        ({ before, after }) =>
          pvpNamed(after, params.layer) && (before.playbackRate ?? 0) > 0 && (after.playbackRate ?? 0) === 0,
      );
    },
  }),
```

- [ ] **Step 4: Run the trigger tests and watch them pass**

- [ ] **Step 5: PROVE three trigger guards**

| Mutation | Test that must go red |
|---|---|
| In `pvp.cue-started`, compare `mediaName` instead of `mediaUuid`, and drop the `!== null` check | "a cue starting does NOT fire on the same media looping round" — the loop keeps its name, so this stays green; instead delete the `pvpPairs` uuid match and compare by array INDEX, which makes "a cue starting on the NAMED layer only" go red |
| Delete `if (!pvpUp(next)) return false;` from `pvp.playback-stopped` | "playback stopping does NOT fire because PVP went offline" |
| In `pvpPairs`, emit a pair for layers only in `next` with an empty `before` | "a layer VANISHING from the payload is not a clear" |

The first row is written out in full because the obvious mutation does **not** fail — a looping clip keeps the same media name as well as the same uuid, so the name/uuid distinction is not what that test catches. What it does catch is a diff keyed on position rather than identity, and that is the mutation to run. Say exactly this in the commit: a guard that passes on the bug it was aimed at is the failure mode CLAUDE.md lists four examples of, and the honest response is to name the bug the guard actually catches.

- [ ] **Step 6: Extend `ConditionCtx` and fill it**

`main/types/automation.ts` — one field on `ConditionCtx`:

```ts
  /** ProVideoPlayer's layers as of the last poll, or null when the integration
   *  is off or has never connected. Null and empty are different: null is "we do
   *  not know", and every PVP condition below declines to hold on it. */
  pvpLayers: PvpLayerDTO[] | null;
```

`ConditionCtx` has no optional fields, so this is a compile error until `conditionCtx()` supplies it. That is the point.

`main/services/automation-engine.ts` — in `conditionCtx()`, beside `reaperRecording`:

```ts
      // null, not [], when PVP has never connected. An empty workspace and an
      // integration that is switched off look identical as a list, and "the
      // workspace has nothing on screen" must not hold for a machine we have
      // never spoken to.
      pvpLayers: pvpService.getLatest().connected ? pvpService.getLatest().layers : null,
```

- [ ] **Step 7: Write the failing condition tests, in `main/services/automation-conditions.test.ts`**

```ts
describe("ProVideoPlayer conditions", () => {
  const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
    uuid: "l1", name: "Graphics", index: 0, state: "video",
    mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
    hidden: false, muted: false, opacity: 1, playbackRate: 1,
    anchorElapsedSec: 1, durationSec: 20,
    ...over,
  });
  const ctx = (pvpLayers: PvpLayerDTO[] | null): ConditionCtx => ({ ...BASE_CTX, pvpLayers });
  const holds = (id: string, c: ConditionCtx, params: Record<string, unknown> = {}) =>
    AUTOMATION_CONDITIONS[id].holds(c, params, Date.now());

  test("a named layer has content", () => {
    assert.equal(holds("pvp.layer-has-content", ctx([layer()]), { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-has-content", ctx([layer({ state: "empty" })]), { layer: "Graphics" }), false);
  });

  test("a residual cue name does NOT make an empty layer count as having content", () => {
    // The finding, as a condition. lastCueName survives on an empty layer.
    const stale = layer({ state: "empty", mediaUuid: null, mediaName: null, lastCueName: "MAIN GRAPHIC" });
    assert.equal(holds("pvp.layer-has-content", ctx([stale]), { layer: "Graphics" }), false);
  });

  test("a still image is content, but is NOT playing", () => {
    const still = layer({ state: "still", playbackRate: 0 });
    assert.equal(holds("pvp.layer-has-content", ctx([still]), { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-is-playing", ctx([still]), { layer: "Graphics" }), false);
    assert.equal(holds("pvp.layer-is-playing", ctx([layer()]), { layer: "Graphics" }), true);
  });

  test("hidden and muted read the layer's own flags", () => {
    assert.equal(holds("pvp.layer-is-hidden", ctx([layer({ hidden: true })]), { layer: "Graphics" }), true);
    assert.equal(holds("pvp.layer-is-hidden", ctx([layer()]), { layer: "Graphics" }), false);
    assert.equal(holds("pvp.layer-is-muted", ctx([layer({ muted: true })]), { layer: "Graphics" }), true);
  });

  test("the workspace condition asks about any layer at all", () => {
    assert.equal(holds("pvp.workspace-has-content", ctx([layer({ state: "empty" }), layer({ uuid: "l2" })])), true);
    assert.equal(holds("pvp.workspace-has-content", ctx([layer({ state: "empty" })])), false);
  });

  test("a layer named by a rule that does not exist does not hold", () => {
    // It must not fall back to "any layer": a typo would then qualify a rule
    // against a layer the operator never meant.
    assert.equal(holds("pvp.layer-has-content", ctx([layer()]), { layer: "Typo" }), false);
  });

  test("an UNCONFIGURED layer param does not hold either", () => {
    // Deliberately unlike the triggers, where blank means "any". A condition is a
    // qualifier: "some layer, I did not say which, has content" is the workspace
    // condition, which exists separately and says so by name.
    assert.equal(holds("pvp.layer-has-content", ctx([layer()]), { layer: "" }), false);
  });

  test("NOTHING holds when PVP has never connected", () => {
    // null is "we do not know". An unreachable PVP must not make
    // "the workspace has nothing on screen" true and gate a rule on a fiction.
    for (const id of Object.keys(AUTOMATION_CONDITIONS).filter((k) => k.startsWith("pvp.") && k !== "pvp.is-connected")) {
      assert.equal(AUTOMATION_CONDITIONS[id].holds(ctx(null), { layer: "Graphics" }, Date.now()), false, `${id} held on a null workspace`);
    }
  });
});
```

- [ ] **Step 8: Write the conditions in `main/services/automation-conditions.ts`**

```ts
/**
 * A ProVideoPlayer layer condition.
 *
 * Generated from one predicate because the five differ only in the question and
 * the words, and hand-writing them five times is how one of them ends up reading
 * `playingItem` — the residual field that never clears.
 *
 * Two rules hold for every one of them:
 *
 *  - A null workspace NEVER holds. null means PVP has never connected, and an
 *    unreachable machine must not make "nothing is on screen" true and gate a
 *    rule on a fiction. Unknown is not a value.
 *  - A BLANK layer name does not hold. Deliberately unlike the triggers, where
 *    blank means "any": a condition is a qualifier, and "some layer, I did not
 *    say which" is the workspace condition, which exists separately and says so
 *    in its own label.
 */
function pvpLayerCondition(
  id: string,
  label: string,
  holds: (l: PvpLayerDTO) => boolean,
): ConditionDef {
  return {
    id,
    label,
    params: [{
      key: "layer", label: "Layer", type: "string",
      help: "The layer's name in ProVideoPlayer. Renaming the layer in PVP stops the rule.",
    }],
    holds: (ctx, params) => {
      const layers = ctx.pvpLayers;
      if (!layers) return false;
      const want = String(params.layer ?? "").trim().toLowerCase();
      if (!want) return false;
      const l = layers.find((x) => x.name.trim().toLowerCase() === want);
      return !!l && holds(l);
    },
  };
}
```

and the five entries in `AUTOMATION_CONDITIONS`:

```ts
  "pvp.layer-has-content": pvpLayerCondition(
    "pvp.layer-has-content",
    "A ProVideoPlayer layer has content",
    // The PRESENCE of media, which parseWorkspace derived from the presence of
    // the playingMedia key. Never the cue name: it is residual and four idle
    // layers were observed all still naming the same cue.
    (l) => l.state !== "empty",
  ),
  "pvp.layer-is-playing": pvpLayerCondition(
    "pvp.layer-is-playing",
    "A ProVideoPlayer layer is playing a video",
    // playbackRate, not isPlaying: a still image reports isPlaying true.
    (l) => l.state === "video",
  ),
  "pvp.layer-is-hidden": pvpLayerCondition(
    "pvp.layer-is-hidden",
    "A ProVideoPlayer layer is hidden",
    (l) => l.hidden,
  ),
  "pvp.layer-is-muted": pvpLayerCondition(
    "pvp.layer-is-muted",
    "A ProVideoPlayer layer is muted",
    (l) => l.muted,
  ),

  "pvp.workspace-has-content": {
    id: "pvp.workspace-has-content",
    label: "ProVideoPlayer has something on screen",
    params: [],
    // Deliberately no layer param — this is the "any layer at all" question, and
    // giving it one would duplicate pvp.layer-has-content with a worse label.
    holds: (ctx) => !!ctx.pvpLayers && ctx.pvpLayers.some((l) => l.state !== "empty"),
  },
```

- [ ] **Step 9: Run the condition tests, then PROVE two guards**

| Mutation | Test that must go red |
|---|---|
| `(l) => l.state !== "empty"` → `(l) => !!l.lastCueName` for `pvp.layer-has-content` | "a residual cue name does NOT make an empty layer count as having content" |
| `if (!layers) return false;` → `const layers = ctx.pvpLayers ?? [];` | "NOTHING holds when PVP has never connected" |

- [ ] **Step 10: Confirm the coverage suite is green for the right reasons**

```bash
npm test -- --test-name-pattern="automation coverage" 2>&1 | tail -20
```

All five must pass. In particular `"every registered trigger names a channel that something broadcasts"` proves `"pvp:status"` reached `BROADCAST_CHANNELS` in Task 2, and `"no two entries share an id"` proves the generated `pvpFlagTriggers` keys match the ids they declare — a template-literal key and a hand-written `id` are exactly the pair that can drift.

- [ ] **Step 11: Drive one rule end to end**

Not a unit test — the real engine, on the real server, with simulate on:

1. Build a rule: **when** a cue starts on a ProVideoPlayer layer (blank layer), **then** write a log message.
2. Arm it, leave simulate on.
3. Advance a cue in PVP. Confirm one `simulated` line in the Activity log, at the moment the cue changed, **once** — not once per poll.
4. Let the same clip loop. Confirm **no** further lines: a loop is not a new cue, and the frame the drift check sends for it must not read as one.
5. Close every browser tab, wait a minute, advance a cue again, then reopen. Confirm the rule fired while nothing was watching — that is `addDemandSource` doing its job, and it is the one behaviour a unit test cannot show.

- [ ] **Step 12: Full suite, then commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git commit -m "feat(automation): ProVideoPlayer triggers and conditions, on state that is actually reliable"
```

The commit body names the five guard mutations from Steps 5 and 9, states plainly which mutation the cue-started guard actually catches and which it does not, and records the step-5 loop observation from Step 11.

---

## Task 6: Automation — actions that prove they happened

**Files:**
- Create: `main/services/pvp-actions.ts`
- Create: `main/services/pvp-actions.test.ts`
- Modify: `main/services/automation-actions.ts`

**Interfaces:**
- Consumes: Task 2's `pvpService.command(path, body, verify)` and `pvpService.readLayers()`; Task 1's `PvpLayerDTO`.
- Produces: `PVP_ACTIONS` — a `Record<string, ActionDef>` spread into `AUTOMATION_ACTIONS`; and `pvpDeps`, the test seam.

The registry goes from six action kinds to fourteen, which is the doubling the research predicted and makes PVP **the first integration in this app that drives content rather than only reporting it**.

Two things come free and are worth knowing before writing any of it:

- **No UI work.** `automation-section.tsx` maps `GET /api/automation/registry`; an action added to the registry appears in the picker with its params rendered from its `ParamDef`s. `type: "number"` already routes to the themed `NumberInput`.
- **Every one of these is also a button.** `action-invoke.ts` exposes the same registry to the `action-button` layout object, so an operator gets a tap-to-clear-a-layer button on a console with no extra code. That is a reason to get the failure reporting right, not just the success path: a button that goes green having done nothing is worse than one that does not exist.

### The verify-then-report pattern, stated once

Every action below is one call to `pvpService.command(path, body, verify)`. Nothing posts without a predicate, and nothing returns `ok` on a 200 alone. The reason, restated at the point of use because this is where it would get dropped: **PVP answers every POST with 200 and an empty body whether or not anything happened**, and applies the change a beat later, so neither the response nor an immediate re-read is evidence.

`command()` returns `{ ok, detail }`, `ActionDef.run` returns `ActionResult { ok, detail }`, and the two are the same shape — so an action is a params check, a simulate check, and a `command`. There is no `try`/`catch` in any action below, because `command()` already converts a transport failure into a returned result and CLAUDE.md's rule is that a `catch` either rethrows or returns the failure. A second `catch` around a method that cannot throw would be a `catch` that only logs.

- [ ] **Step 1: Write `main/services/pvp-actions.ts`, with the shared resolution and the two simplest actions**

```ts
// pvp-actions.ts — the automation actions that drive ProVideoPlayer.
//
// EVERY ONE OF THESE VERIFIES. PVP answers a POST with HTTP 200 and an empty
// body whether or not anything happened — no echo of the applied value, no
// confirmation, nothing to read — and it applies the change a BEAT after the 200.
// So neither the response nor an immediate re-read is evidence, and an action that
// reported success on a 200 would be a rule that appears to run, logs "fired", and
// never touches a screen. That is the swallowed failure this repo has a rule
// about, wearing a different costume.
//
// The shape, without exception: resolve the layer, honour simulate, then ONE call
// to pvpService.command(path, body, { what, holds }). `holds` is asked of a fresh
// read of transportState, and a `holds` that says no is a FAILURE returned to the
// operator — never a log line.
//
// No try/catch here. command() converts a transport failure into a returned
// result, so a catch around it could only log, which is forbidden.

import type { ActionDef, ActionResult } from "../types/automation.js";
import type { PvpLayerDTO } from "../types/pvp.js";
import { pvpService } from "./pvp-service.js";

const ok = (detail: string): ActionResult => ({ ok: true, detail });
const fail = (detail: string): ActionResult => ({ ok: false, detail });

/** The two things these actions touch, behind a seam. Tests replace them;
 *  nothing else should. Kept narrow on purpose — the point is to be able to
 *  assert that an action which cannot confirm its write reports a FAILURE. */
export const pvpDeps: {
  readLayers: () => Promise<PvpLayerDTO[]>;
  command: (path: string, body: unknown, verify: { what: string; holds: (layers: readonly PvpLayerDTO[]) => boolean }) => Promise<ActionResult>;
} = {
  readLayers: () => pvpService.readLayers(),
  command: (path, body, verify) => pvpService.command(path, body, verify),
};

const LAYER_PARAM = {
  key: "layer",
  label: "Layer",
  type: "string" as const,
  help: "The layer's name in ProVideoPlayer. Renaming the layer in PVP stops the rule.",
};

/**
 * Turn the rule's layer NAME into the uuid the API addresses.
 *
 * A name in the rule and a uuid on the wire, because those are the right answers
 * to two different questions: a name is what the operator sees in PVP and what
 * survives being typed into a form, and a uuid is what PVP's own endpoints take
 * unambiguously — PVP reads an all-digits path parameter as an INDEX, never a
 * name, so a layer called "2" could not be addressed by name at all.
 *
 * A name that matches nothing is a failure with the names that DO exist in it.
 * "Layer not found" alone would leave an operator guessing at a typo.
 */
async function resolveLayer(params: Record<string, unknown>): Promise<{ layer: PvpLayerDTO } | { error: string }> {
  const want = String(params.layer ?? "").trim().toLowerCase();
  if (!want) return { error: "no layer name configured" };
  let layers: readonly PvpLayerDTO[];
  try {
    layers = await pvpDeps.readLayers();
  } catch (e) {
    // Returned, not logged. The operator's rule did not run and they are owed
    // the reason.
    return { error: `could not read ProVideoPlayer's layers: ${e instanceof Error ? e.message : String(e)}` };
  }
  const layer = layers.find((l) => l.name.trim().toLowerCase() === want);
  if (!layer) {
    return { error: `no layer named "${String(params.layer)}" — PVP has ${layers.map((l) => `"${l.name}"`).join(", ") || "no layers"}` };
  }
  return { layer };
}

/** A layer from a fresh read, by uuid. The verify predicates work on uuid rather
 *  than name so a rename between the write and the read cannot make a failed
 *  action look successful. */
const byUuid = (layers: readonly PvpLayerDTO[], uuid: string): PvpLayerDTO | undefined =>
  layers.find((l) => l.uuid === uuid);

export const PVP_ACTIONS: Record<string, ActionDef> = {
  "pvp.clear-layer": {
    id: "pvp.clear-layer",
    label: "Clear a ProVideoPlayer layer",
    help: "Takes whatever is on that layer off screen. Confirmed by reading PVP's state back — if the layer still holds content, this reports a failure rather than a success.",
    params: [LAYER_PARAM],
    run: async (params, ctx) => {
      const r = await resolveLayer(params);
      if ("error" in r) return fail(r.error);
      if (ctx.simulate) return ok(`would clear layer ${r.layer.name}`);
      return await pvpDeps.command(`/clear/layer/${r.layer.uuid}`, undefined, {
        what: `layer ${r.layer.name} cleared`,
        // The PRESENCE of media is the only reliable has-content signal. Not
        // isPlaying (a still reports true) and not the cue name, which is
        // residual and survives a clear on every layer we have seen.
        holds: (layers) => byUuid(layers, r.layer.uuid)?.state === "empty",
      });
    },
  },

  "pvp.clear-workspace": {
    id: "pvp.clear-workspace",
    label: "Clear every ProVideoPlayer layer",
    // Never tested live, and the description says so: the research declined to
    // fire it because it blanks every screen at once, which is not something to
    // try during a service. It is safe to SHIP untested because it verifies —
    // if it does nothing, the rule reports a failure rather than a success.
    help: "Takes everything off every layer at once. Blanks every screen PVP is driving. Confirmed by reading PVP's state back.",
    params: [],
    run: async (_params, ctx) => {
      if (ctx.simulate) return ok("would clear every layer");
      return await pvpDeps.command("/clear/workspace", undefined, {
        what: "every layer cleared",
        holds: (layers) => layers.length > 0 && layers.every((l) => l.state === "empty"),
      });
    },
  },
};
```

Note the `layers.length > 0` in the workspace verify. A read that came back with no layers at all would otherwise satisfy `every()` vacuously and report success — which is precisely the shape of bug this whole task exists to prevent, arriving through the back door.

- [ ] **Step 2: Add the four flag actions to `PVP_ACTIONS`**

Hide, unhide, mute and unmute. All four were **verified working live** (`POST /hide/layer/4`, `/unhide`, `/mute`, `/unmute` — 200 and confirmed by reading `transportState` back), which is why they can be generated from one factory without hedging.

```ts
/**
 * Hide/unhide and mute/unmute. Four actions, one factory, because they differ
 * only in the endpoint and the words — and four hand-written copies is four
 * chances for one of them to verify the wrong field.
 *
 * All four were confirmed working against a live instance. They still verify:
 * "it worked once" is not "it works", and the whole point of this file is that a
 * 200 from PVP is not evidence.
 */
function flagAction(
  id: string,
  label: string,
  path: "hide" | "unhide" | "mute" | "unmute",
  key: "hidden" | "muted",
  want: boolean,
): ActionDef {
  return {
    id,
    label,
    help: "Confirmed by reading PVP's state back — if the layer did not change, this reports a failure rather than a success.",
    params: [LAYER_PARAM],
    run: async (params, ctx) => {
      const r = await resolveLayer(params);
      if ("error" in r) return fail(r.error);
      if (ctx.simulate) return ok(`would ${path} layer ${r.layer.name}`);
      return await pvpDeps.command(`/${path}/layer/${r.layer.uuid}`, undefined, {
        what: `layer ${r.layer.name} ${path === "hide" ? "hidden" : path === "unhide" ? "shown" : path === "mute" ? "muted" : "unmuted"}`,
        holds: (layers) => byUuid(layers, r.layer.uuid)?.[key] === want,
      });
    },
  };
}
```

and, in `PVP_ACTIONS`:

```ts
  "pvp.hide-layer": flagAction("pvp.hide-layer", "Hide a ProVideoPlayer layer", "hide", "hidden", true),
  "pvp.unhide-layer": flagAction("pvp.unhide-layer", "Unhide a ProVideoPlayer layer", "unhide", "hidden", false),
  "pvp.mute-layer": flagAction("pvp.mute-layer", "Mute a ProVideoPlayer layer", "mute", "muted", true),
  "pvp.unmute-layer": flagAction("pvp.unmute-layer", "Unmute a ProVideoPlayer layer", "unmute", "muted", false),
```

- [ ] **Step 3: Add the opacity action**

```ts
  "pvp.set-layer-opacity": {
    id: "pvp.set-layer-opacity",
    label: "Set a ProVideoPlayer layer's opacity",
    help: "0 is invisible, 100 is fully opaque. Confirmed by reading PVP's state back.",
    params: [
      LAYER_PARAM,
      // Percent, not the 0..1 the API takes: an operator types 50, not 0.5. The
      // themed NumberInput renders this from `type: "number"`, with these bounds.
      { key: "percent", label: "Opacity (%)", type: "number", min: 0, max: 100 },
    ],
    run: async (params, ctx) => {
      const raw = Number(params.percent);
      // Rejected here rather than sent. PVP SILENTLY CLAMPS an out-of-range value
      // to 1 and answers 200, so sending 500 would set the layer fully opaque and
      // report success at "500%" — a wrong action that looks like a right one.
      if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
        return fail(`opacity must be between 0 and 100, not "${String(params.percent)}"`);
      }
      const r = await resolveLayer(params);
      if ("error" in r) return fail(r.error);
      const value = raw / 100;
      if (ctx.simulate) return ok(`would set layer ${r.layer.name} to ${raw}%`);
      return await pvpDeps.command(`/opacity/layer/${r.layer.uuid}`, { value }, {
        what: `layer ${r.layer.name} set to ${raw}%`,
        // A tolerance, not equality: the value crosses JSON and comes back through
        // whatever precision PVP keeps it in, and an exact float compare would
        // report a working action as failed.
        holds: (layers) => {
          const l = byUuid(layers, r.layer.uuid);
          return !!l && Math.abs(l.opacity - value) < 0.01;
        },
      });
    },
  },
```

- [ ] **Step 4: Write the failing action tests, `main/services/pvp-actions.test.ts`**

```ts
import { strict as assert } from "node:assert";
import { describe, test, beforeEach } from "node:test";

import { PVP_ACTIONS, pvpDeps } from "./pvp-actions.js";
import type { PvpLayerDTO } from "../types/pvp.js";
import type { ActionResult } from "../types/automation.js";

const layer = (over: Partial<PvpLayerDTO> = {}): PvpLayerDTO => ({
  uuid: "l1", name: "Graphics", index: 0, state: "video",
  mediaName: "loop_a.mp4", mediaUuid: "m1", lastCueName: "MAIN GRAPHIC",
  hidden: false, muted: false, opacity: 1, playbackRate: 1,
  anchorElapsedSec: 1, durationSec: 20,
  ...over,
});

let posted: { path: string; body: unknown }[] = [];
/** Stands in for pvpService.command: records the post, then answers the verify
 *  predicate against whatever `after` is set to. This is the whole point of the
 *  seam — it lets a test say "PVP answered 200 and nothing changed". */
let after: PvpLayerDTO[] = [layer()];
let readThrows: Error | null = null;

beforeEach(() => {
  posted = [];
  after = [layer()];
  readThrows = null;
  pvpDeps.readLayers = async () => {
    if (readThrows) throw readThrows;
    return [layer()];
  };
  pvpDeps.command = async (path, body, verify): Promise<ActionResult> => {
    posted.push({ path, body });
    return verify.holds(after)
      ? { ok: true, detail: verify.what }
      : { ok: false, detail: `PVP answered 200 but ${verify.what} did not take effect` };
  };
});

const run = (id: string, params: Record<string, unknown>, simulate = false) =>
  PVP_ACTIONS[id].run(params, { simulate });

describe("PVP actions verify rather than trusting a 200", () => {
  test("clearing a layer that DID clear succeeds", async () => {
    after = [layer({ state: "empty", mediaUuid: null, mediaName: null })];
    const r = await run("pvp.clear-layer", { layer: "Graphics" });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(posted.map((p) => p.path), ["/clear/layer/l1"]);
  });

  test("clearing a layer that did NOT clear FAILS, even though PVP said 200", async () => {
    // THE test this whole file exists for. `after` is unchanged: PVP accepted the
    // request and did nothing, exactly as four trigger forms were observed doing.
    after = [layer()];
    const r = await run("pvp.clear-layer", { layer: "Graphics" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /did not take effect/);
  });

  test("a residual cue name does not make a cleared layer look uncleared", async () => {
    // playingItem survives a clear on every layer observed, so a verify that
    // asked about the cue would report a working clear as failed forever.
    after = [layer({ state: "empty", mediaUuid: null, mediaName: null, lastCueName: "MAIN GRAPHIC" })];
    assert.equal((await run("pvp.clear-layer", { layer: "Graphics" })).ok, true);
  });

  test("clearing the workspace requires EVERY layer empty, and an empty read is not success", async () => {
    after = [layer({ state: "empty" }), layer({ uuid: "l2", state: "video" })];
    assert.equal((await run("pvp.clear-workspace", {})).ok, false);
    after = [layer({ state: "empty" }), layer({ uuid: "l2", state: "empty" })];
    assert.equal((await run("pvp.clear-workspace", {})).ok, true);
    // A read that returned nothing satisfies every() vacuously. It must not pass.
    after = [];
    assert.equal((await run("pvp.clear-workspace", {})).ok, false);
  });

  test("hide, unhide, mute and unmute each verify their own field", async () => {
    after = [layer({ hidden: true })];
    assert.equal((await run("pvp.hide-layer", { layer: "Graphics" })).ok, true);
    assert.equal((await run("pvp.mute-layer", { layer: "Graphics" })).ok, false, "hidden must not satisfy muted");
    after = [layer({ muted: true })];
    assert.equal((await run("pvp.mute-layer", { layer: "Graphics" })).ok, true);
    assert.equal((await run("pvp.unmute-layer", { layer: "Graphics" })).ok, false);
    after = [layer()];
    assert.equal((await run("pvp.unhide-layer", { layer: "Graphics" })).ok, true);
    assert.equal((await run("pvp.unmute-layer", { layer: "Graphics" })).ok, true);
  });

  test("opacity is sent as 0..1 and verified with a tolerance", async () => {
    after = [layer({ opacity: 0.5 })];
    const r = await run("pvp.set-layer-opacity", { layer: "Graphics", percent: 50 });
    assert.equal(r.ok, true, r.detail);
    assert.deepEqual(posted[0], { path: "/opacity/layer/l1", body: { value: 0.5 } });
  });

  test("an out-of-range opacity is REFUSED, not sent and clamped", async () => {
    // PVP silently clamps 5 to 1 and answers 200. Sending it would set the layer
    // fully opaque and report success at "500%".
    for (const percent of [500, -1, NaN, "nope"]) {
      const r = await run("pvp.set-layer-opacity", { layer: "Graphics", percent });
      assert.equal(r.ok, false, `${String(percent)} was accepted`);
    }
    assert.deepEqual(posted, [], "an out-of-range opacity reached the wire");
  });

  test("a layer name that matches nothing fails, and lists what does exist", async () => {
    const r = await run("pvp.clear-layer", { layer: "Typo" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /"Graphics"/);
    assert.deepEqual(posted, [], "a POST went out for a layer that does not exist");
  });

  test("a blank layer name fails rather than clearing an arbitrary layer", async () => {
    assert.equal((await run("pvp.clear-layer", { layer: "" })).ok, false);
    assert.deepEqual(posted, []);
  });

  test("a failed READ is a failure, not a success and not a throw", async () => {
    readThrows = new Error("connect ECONNREFUSED");
    const r = await run("pvp.clear-layer", { layer: "Graphics" });
    assert.equal(r.ok, false);
    assert.match(r.detail, /ECONNREFUSED/);
  });

  test("simulate never reaches the wire, for any action", async () => {
    for (const id of Object.keys(PVP_ACTIONS)) {
      await PVP_ACTIONS[id].run({ layer: "Graphics", percent: 50, cue: "MAIN GRAPHIC" }, { simulate: true });
    }
    assert.deepEqual(posted, [], "simulate mode sent a command");
  });

  test("no action throws, whatever it is given", async () => {
    // ActionDef's contract: a failure is a returned result, so one bad provider
    // cannot stop the engine or block the next rule.
    for (const id of Object.keys(PVP_ACTIONS)) {
      for (const params of [{}, { layer: null }, { layer: 7 }, { layer: "Graphics", percent: "x" }]) {
        await assert.doesNotReject(() => PVP_ACTIONS[id].run(params as never, { simulate: false }), `${id} threw on ${JSON.stringify(params)}`);
      }
    }
  });
});
```

- [ ] **Step 5: Run them and watch them pass**

```bash
npm test -- --test-name-pattern="PVP actions verify" 2>&1 | tail -20
```

- [ ] **Step 6: PROVE the four action guards**

| Mutation | Test that must go red |
|---|---|
| In `pvpService.command`, `return { ok: true, detail: verify.what }` immediately after the POST, skipping the verify loop entirely | "clearing a layer that did NOT clear FAILS, even though PVP said 200" |
| In `pvp.clear-layer`'s `holds`, `byUuid(layers, r.layer.uuid)?.lastCueName == null` | "a residual cue name does not make a cleared layer look uncleared" |
| In `pvp.clear-workspace`'s `holds`, drop `layers.length > 0` | "clearing the workspace requires EVERY layer empty, and an empty read is not success" |
| In `pvp.set-layer-opacity`, delete the range check and send `raw / 100` unchecked | "an out-of-range opacity is REFUSED, not sent and clamped" |

The first mutation is the important one and it must be run against the **real `pvpService.command`**, not the test double — temporarily point `pvpDeps.command` at the real method with a stubbed `fetch`. A guard that only ever tests the double proves the double, which is the "a telemetry-parity check matched source text" failure in another form.

- [ ] **Step 7: Register the actions**

`main/services/automation-actions.ts` — import and spread, at the end of the registry:

```ts
import { PVP_ACTIONS } from "./pvp-actions.js";

export const AUTOMATION_ACTIONS: Record<string, ActionDef> = {
  …
  ...PVP_ACTIONS,
};
```

A separate module rather than eight more literals in a file that is currently 198 lines: these share `resolveLayer`, `byUuid` and `flagAction`, and the verify-then-report reasoning is a page of comment that belongs beside the thing it governs.

Confirm the file-level comment at `automation-actions.ts:1-6` is still true after the spread. It says *"No provider throws: a failure is a returned result"* — which is exactly what Step 4's last test pins for these eight.

- [ ] **Step 8: The two trigger actions**

Task 0 is settled (research §4.2): all five addressing forms fire. Two actions ship, and they are deliberately not one.

**`pvp.trigger-cue`** takes a playlist and a cue, both by name, and posts `/trigger/playlist/{playlist}/cue/{cue}`. It cannot say which layer the cue will land on — PVP decides that from the cue — so its verify predicate asks whether **any** layer's last cue is now the one requested.

**`pvp.trigger-cue-on-layer` was specified here and NOT shipped.** Research §4.3 settled the open question against it: PVP ignores the layer argument. An action on that form fires a real cue onto the wrong layer and then reports a failure, which is worse than not offering it. `pvp-actions.test.ts` carries a guard that no action takes both a layer and a cue, so it cannot come back as an obvious-looking convenience.

Both take names rather than uuids, for the reason stated in Task 5. **PVP reads an all-digits path parameter as an INDEX, never a name**, so a playlist or cue literally named "2024" cannot be addressed by name at all; the help text says so.

```ts
const PLAYLIST_PARAM = {
  key: "playlist",
  label: "Playlist",
  type: "string" as const,
  help: "The playlist's name in ProVideoPlayer. A playlist whose name is only digits cannot be used — PVP reads an all-digits value as a position, never a name.",
};
const CUE_PARAM = {
  key: "cue",
  label: "Cue",
  type: "string" as const,
  help: "The cue's name in ProVideoPlayer, exactly as it appears there. A cue whose name is only digits cannot be used — PVP reads an all-digits value as a position, never a name.",
};

/** A path segment PVP will read as a NAME. PVP reads an all-digits parameter as
 *  an index, so "2024" would address the 2024th entry rather than the playlist
 *  called 2024 — refused here rather than sent somewhere unintended. */
function nameSegment(raw: unknown, what: string): { value: string } | { error: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { error: `no ${what} name configured` };
  if (/^\d+$/.test(v)) {
    return { error: `ProVideoPlayer reads an all-digits ${what} name as a position, so "${v}" cannot be addressed by name` };
  }
  return { value: encodeURIComponent(v) };
}

/** After a successful trigger, playingItem holds the cue we asked for. It is
 *  residual everywhere else in this integration and an asset exactly here. */
const cueLanded = (l: PvpLayerDTO | undefined, cue: string): boolean =>
  !!l && (l.lastCueName ?? "").trim().toLowerCase() === cue.trim().toLowerCase();

  "pvp.trigger-cue": {
    id: "pvp.trigger-cue",
    label: "Fire a ProVideoPlayer cue",
    help: "Fires a cue from a playlist. ProVideoPlayer decides which layer it lands on. Confirmed by reading PVP's state back — if no layer picks the cue up, the rule reports a failure rather than a success.",
    params: [PLAYLIST_PARAM, CUE_PARAM],
    run: async (params, ctx) => {
      const playlist = nameSegment(params.playlist, "playlist");
      if ("error" in playlist) return fail(playlist.error);
      const cue = nameSegment(params.cue, "cue");
      if ("error" in cue) return fail(cue.error);
      const cueName = String(params.cue).trim();
      if (ctx.simulate) return ok(`would fire cue "${cueName}"`);
      return await pvpDeps.command(`/trigger/playlist/${playlist.value}/cue/${cue.value}`, undefined, {
        what: `cue "${cueName}" fired`,
        // ANY layer, because this form does not say which one it will land on —
        // PVP decides that from the cue. Asking about a specific layer here would
        // report a working trigger as failed.
        holds: (layers) => layers.some((l) => cueLanded(l, cueName)),
      });
    },
  },
    // pvp.trigger-cue-on-layer was specified here and REMOVED before merge:
    // research §4.3 settled that PVP ignores the layer argument, so the action
    // would fire a real cue onto the wrong layer and then report a failure.
```

and the tests, in the same file:

```ts
  test("firing a cue succeeds when SOME layer picks it up", async () => {
    after = [layer({ lastCueName: "SOMETHING ELSE" })];
    assert.equal((await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" })).ok, false);
    after = [layer({ lastCueName: "MAIN GRAPHIC" })];
    assert.equal((await run("pvp.trigger-cue", { playlist: "PreService", cue: "MAIN GRAPHIC" })).ok, true);
  });

  test("there is NO action that claims to choose a cue's layer", async () => {
    // PVP ignores the layer argument (research §4.3), so the action that took
    // one was removed. This guard stops it returning as a convenience.
    assert.ok(!("pvp.trigger-cue-on-layer" in PVP_ACTIONS));
  });

  test("an all-digits playlist or cue name is REFUSED, not sent as a position", async () => {
    for (const params of [{ playlist: "2024", cue: "MAIN GRAPHIC" }, { playlist: "PreService", cue: "12" }]) {
      const res = await run("pvp.trigger-cue", params);
      assert.equal(res.ok, false, JSON.stringify(params));
      assert.match(res.detail, /position/);
    }
    assert.deepEqual(posted, []);
  });
```

**The one confounder to state in the docs, not hide:** on a layer whose playlist auto-advances, the cue name can change on its own between the POST and the read, so a trigger that did nothing could be confirmed by an advance that would have happened anyway. The verify is therefore strong on a layer that does not auto-advance and merely suggestive on one that does. `docs/integrations/provideoplayer.md` says so, and the action's help does not pretend otherwise. There is no way to close that gap through this API, and claiming otherwise would be the failure this task is built to avoid, one level up.

- [ ] **Step 9: Drive an action against the real thing, off air**

The order `docs/automation.md` already prescribes for a rule against real gear, applied here:

1. Build a rule with **Write a log message** and the `pvp.cue-started` trigger. Arm it. Confirm it fires at the right moment.
2. Swap the action to **Clear a ProVideoPlayer layer**, simulate still on. Confirm the log reads `would clear layer …`, and that **nothing on PVP changed**.
3. Turn simulate off with a harmless target layer. Confirm the layer clears and the log reads `fired`.
4. **Then prove the failure path**, which is the half nothing else will exercise: point the action at a layer name that does not exist and Test-fire it. Confirm the toast and the Activity log both read `failed` with the list of real layer names — not `fired`, not silence.
5. Stop ProVideoPlayer entirely and Test-fire again. Confirm `failed` with a connection message.

Step 4 is the one to do slowly. Every other step tests the happy path, and the happy path is not what this task was written for.

- [ ] **Step 10: Full suite, then commit**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -5
git commit -m "feat(automation): drive ProVideoPlayer, and prove every command landed"
```

The commit body records: the four guard mutations from Step 6 (naming that the first was run against the real `command`, not the double), and that both trigger actions shipped on the settled Task 0 result.

---

## Task 7: Docs

**Files:**
- Create: `docs/integrations/provideoplayer.md`
- Modify: `docs/integrations/README.md`
- Modify: `docs/automation.md`
- Modify: `docs/reference/api.md`

`docs/reference/widgets.md` was already done in Tasks 3 and 4, because `widget-docs.test.ts` would not let those commits be green otherwise.

- [ ] **Step 1: Write `docs/integrations/provideoplayer.md`**

Match `docs/integrations/reaper.md`'s voice and structure exactly: `# <Name> integration`, one paragraph on what it surfaces, `## How it works` (protocol, cadence, secrets), `## Setup` (**In ProVideoPlayer:** / **In Stage:** / **On a layout:**). Concise reference for a stranger on GitHub — not a narrative of how this was built, not a changelog, no before-and-after.

Four things must be in it, because an operator who does not read them will misread the feature:

1. **There is no preview image, and there never will be through this API.** PVP exposes no thumbnail, preview, frame or screenshot endpoint at all. Say it as a plain sentence near the top, not in a footnote.
2. **The cue name is the last cue that touched the layer, not what is playing.** Stage shows it only on layers that actually hold something, for that reason. This explains why the wall widget looks different from PVP's own UI, which is the first question it will raise.
3. **Layers are matched by NAME in rules, so renaming a layer in PVP stops the rule, silently.** Same wording as the existing warning about renaming a PCO plan item.
4. **HTTPS is not supported against a self-signed certificate.** PVP's own documentation uses `curl -k`, which implies one. Say to leave "Use HTTPS Connection" off unless a trusted certificate is installed.

Plus the setup trap the research spent an hour on: **the Network API port is not the port PVP serves its API documentation on.** Every `/api/0/*` path on the documentation port returns 404, and a 404 does not distinguish a wrong path from a disabled API — so probing the wrong port looks exactly like "the API is off".

And, in a short **What is verified, and what is not** section, the state of play as of the pre-flight:

- Which POSTs are confirmed working against a live instance (hide, unhide, mute, unmute, opacity, clear-layer).
- That **every action confirms itself by reading PVP's state back**, because PVP answers 200 to a request it ignored — and that a rule which appears not to have run will say so in the Activity log rather than logging a success.
- That all five cue addressing forms fire, and that the single open question is whether the layer-addressed form's layer argument redirects a cue.
- That the trigger confirmation is strong on a layer that does not auto-advance and only suggestive on one that does.

- [ ] **Step 2: The index row**

`docs/integrations/README.md` — a row in the table, after the REAPER row:

```
| [ProVideoPlayer](provideoplayer.md) | What is on each PVP layer, and control of layers from rules |
```

The "Adding a new integration" section below the table names REAPER as the cleanest end-to-end template. Leave that pointing at REAPER — PVP's file map is larger (it adds automation actions and a second surface), so it is a worse first example, not a better one. But fix the stale line in step 3 of that list, which says the DTO goes in `main/types/stage.ts`: the live DTOs moved into `main/types/live.ts` and are re-exported, and this plan puts PVP's in `main/types/pvp.ts` on the same pattern.

- [ ] **Step 3: The automation tables**

`docs/automation.md` has three tables and all three move.

**Triggers** — seven rows, in the file's existing voice (a fragment, not a sentence):

```
| A cue starts on a ProVideoPlayer layer | a layer starts showing different media. The same clip looping round is not a new cue |
| A ProVideoPlayer layer clears | a layer that was showing something now holds nothing. PVP going unreachable does not count |
| A ProVideoPlayer clip stops rolling | a clip has stopped, ended or been paused |
| A ProVideoPlayer layer is hidden / unhidden | the layer's hidden flag flips |
| A ProVideoPlayer layer is muted / unmuted | the layer's mute flag flips |
```

The generated `ProVideoPlayer connects / disconnects` pair is already covered by the existing *"X connects / disconnects"* row, which says "one pair per integration". Nothing to add.

**Conditions** — the prose paragraph gains the five: *a ProVideoPlayer layer has content*, *is playing a video*, *is hidden*, *is muted*, and *ProVideoPlayer has something on screen*.

**Actions** — eight rows, and the table gains a sentence above it that the rest of the actions do not need:

> ProVideoPlayer answers every command with "OK" whether or not it acted on it, so every ProVideoPlayer action below reads PVP's state back to confirm what it did. A command that was accepted and ignored is recorded as a **failure**, not a success — which is the opposite of what the log would otherwise show.

Then a paragraph in **Triggers** repeating the naming trade, in the same words the plan-item warning uses:

> ProVideoPlayer layers are matched **by name, not by id** — an id is opaque and changes when a workspace is rebuilt from a template. **Renaming the layer in ProVideoPlayer stops the rule**, silently. Nothing else will tell you.

- [ ] **Step 4: The API reference**

`docs/reference/api.md` — `GET /api/pvp/status`, beside the other integration status endpoints. One line, matching their shape.

- [ ] **Step 5: Check nothing else went stale**

```bash
grep -rn "integration" docs/ README.md | grep -iE "fourteen|thirteen|fifteen|twelve|[^0-9]14 |[^0-9]15 "
grep -rn "five action\|six action\|five kinds" docs/
```

Any doc that counts the integrations or the action kinds is now wrong. Fix what it finds — and note that `grep | head` exits 0 whatever grep found, so do not pipe these to `head` and read a clean exit as proof of absence.

- [ ] **Step 6: Commit**

```bash
git commit -m "docs: ProVideoPlayer"
```

---

## Before the PR

- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` — full suite green, and the test count moved by the number of tests this branch added
- [ ] `npm run lint` clean
- [ ] Every exact-count assertion in the Global Constraints table moved to the value the suite reports, not the value this plan predicted. Read the numbers; do not assume the table.
- [ ] Three review passes: correctness, simplification, whole-PR. Fix what they find before opening; if you disagree with a finding, say why — do not silently skip it.
- [ ] **Every guard in this branch proven red in-session against the bug it guards, and each proof named in its commit.** Count them against the branch rather than trusting this line. Two of them are worth re-reading before you claim them: the `emitIfChanged` override (Task 2 Step 3) and the un-verified POST (Task 6 Step 6), which must be run against the real `pvpService.command` and not the test double.
- [ ] The efficiency decision **observed**, not asserted: with a video playing, count `pvp:status` frames on `/api/events` for 30 seconds. Two, not thirty. Record the number in the PR body.
- [ ] The failure path driven: an action against a layer that does not exist reports `failed` in the Activity log, with the real layer names in the detail.
- [ ] No secret anywhere in the diff: `git diff origin/beta... | grep -inE "bearer [a-z0-9]|token.*=.*['\"][a-z0-9]{8}"` returns nothing, and no LAN address: `git diff origin/beta... | grep -nE "192\.168\.|10\.[0-9]+\.|172\.(1[6-9]|2[0-9]|3[01])\."` returns nothing except the placeholder `192.168.1.50` in the descriptor, which matches the OBS and REAPER descriptors already there.
- [ ] No church name, no real service-type id, and no real layer or media name in **code, tests or fixtures**: `git diff origin/beta... -- main/ renderer/ | grep -inE "cornerstone|series graphic|youthkickoff"` returns nothing. Scoped to code on purpose: the research doc under `docs/superpowers/research/` records real observed names as evidence, which is its job, and it is already free of the host address and the token.
- [ ] `grep -rn "pvp" main/services/*.ts renderer/**/*.ts* | grep -i "todo\|fixme"` returns nothing
- [ ] No emojis anywhere in the diff: `git diff origin/beta... | grep -P "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]"` returns nothing
- [ ] No Claude attribution in any commit message or in the PR body

---

## Self-Review

**Spec coverage.** Every element of the operator's ask maps to a task. The **custom layout object** is Task 3, with the filter mode the research argued for (`with-content` as the default, turning eleven rows into two). The **Home tab object** is Task 4, sharing Task 3's row component rather than reimplementing it. The **full suite of automations** is Tasks 5 and 6: seven triggers plus the generated connect/disconnect pair, five conditions plus the generated `is-connected`, and eight actions — taking the action registry from six kinds to fourteen and making PVP the first integration here that drives content rather than only reporting it. The registration chain the brief enumerated is Task 2, item by item, plus two the brief did not list and the code requires: `renderer/components/integrations-panel.tsx`'s `CATEGORY_ORDER`, without which the integration is registered, polling and invisible; and `automation-engine.ts`'s `addDemandSource`, without which the `inDemand` gate is decorative.

**The efficiency decision.** Stated at the top as Decision 1: `timeElapsed` and `timeRemaining` are excluded from the compared payload, the DTO carries an anchor, and the client interpolates — following `live-poller.ts:42`, which excludes `serverNow` for exactly this reason, and `pco-timer.ts`, which is the pure interpolator this plan's `pvp-progress.ts` mirrors. The alternative (accept the frame rate, as REAPER does) is named and the reason it does not transfer is given: one recorder's six scalars is not eleven layers on nine tiles. Two things the brief did not ask for but the code forced: `emitIfChanged`'s shallow `!==` **cannot be used at all** on an array-bearing DTO, so it is overridden; and a media-uuid diff alone cannot see a single clip looping, so a drift re-anchor is part of the decision rather than an optimisation on top of it.

**Deliberately not built, each with a reason:**

- *Any preview image.* Not a choice — PVP has no endpoint for one. Said in the descriptor, in the object's own file comment, and in the docs, so it is a stated limit rather than a discovery.
- *`isPlaying` on the DTO.* A still reports it true. A field whose name says the opposite of what it means is one somebody reads wrongly, and there is no consumer for it that `playbackRate` does not serve better.
- *A "playback reaches its end" trigger.* Replaced by `pvp.playback-stopped`. The countdown it would watch is deliberately not broadcast, so the engine — which only ever sees broadcast frames — cannot see it cross zero. Same moment, observable field.
- *A layer dropdown in the rule editor.* Needs a fourth `optionsFrom` source, and three of the six declared sources are unwired today, so those selects render empty. A dropdown fed from a live workspace is empty exactly when an operator is most likely to be building a rule offline. A string param with the live names shown in the layout inspector is the smaller, more honest control. The cost — a rename silently stops the rule — is in the docs in the same words the PCO plan-item warning uses.
- *Workspace-wide mute and hide.* `clear/workspace` ships because it has a real use and a real verify; `mute/workspace` and `hide/workspace` have neither a compelling rule nor a live test, and three untested workspace-wide actions is two more blast radius than the feature needs.
- *Any per-layer transition, blend mode, effect, preset or target-set action.* All in the research's unverified list, none with an obvious rule behind it, and each needs its own verify predicate against a field this integration does not currently parse. They are additive later; shipping nine unverified actions to look complete is the opposite of what Decision 2 is for.
- *A `pvp-targets.json` store.* Host, port and the HTTPS flag go in `settings.json` via the descriptor; the token goes in `secrets.bin`. So no new `DataStore`, and `EXPECTED_CONFIG` does not move. **This contradicts the brief's instruction to add a store to `EXPECTED_CONFIG`** — the instruction is right as a rule and wrong for this integration, because REAPER's identical shape adds no store either. If a future change gives PVP a target list, the rule applies in full and in the same commit.
- *A `hideWhenIdle` / `fillWhenRecording` toggle on either object.* Those key names are claimed by `card-toggles.ts`'s exhaustive record; reusing one to inherit a free Home toggle would put two meanings behind one word. `hideWhenEmpty` and `showProgress` instead.

**Where the research's unverified list forced a choice.** Nine, each resolved rather than left open:

1. *Whether any trigger form works.* → **Settled: all five fire** (research §4.2). The earlier "four are no-ops" reading was a measurement error — reads taken inside the same second as the POST, against a playlist that auto-advances. `pvp.trigger-cue` ships. What is still open is narrower: whether the LAYER ARGUMENT of the layer-addressed form redirects a cue. That form ships as its own action whose verify asks about that layer specifically, so an ignored argument reports a failure.
2. *PVP's apply latency after a POST.* → Never measured, so no fixed sleep. The verifier re-reads four times at 150 ms and takes the first confirming read.
3. *`/clear/layer` against a layer holding content.* → Still unobserved; only the empty case was ever tested. Ships anyway, because it verifies: a clear that does nothing reports a failure, not a success. Said in the docs rather than implied.
4. *`isHidden`, `isMuted`, `opacity < 1`.* → Never seen live on a real workspace, so they are **synthesised into the fixture** (layer 4). The renderer branch that draws those badges is exercised by something, and the docs say the live read-back is unobserved. The POSTs that set them were verified live by the research; only the parse of the resulting state is untested against a real instance.
5. *Authentication.* → `Require Authentication` was off, so the `Bearer` path is unobserved. Built anyway, because the alternative is an integration that cannot be used on a secured instance; a 401/403 gets its own message rather than a generic HTTP error. Recorded as building without verification.
6. *HTTPS and self-signed certificates.* → **Not solved, and deliberately not worked around.** The checkbox is offered so a trusted certificate works, and a TLS failure produces an explicit message naming the likely cause. No "disable certificate verification" toggle: that is a security hole in a public repo, added for a path nobody has run.
7. *Workspace-wide POSTs.* → `clear/workspace` ships verified; the other two do not ship. See above.
8. *Behaviour when no workspace is open.* → Unknown whether PVP returns an empty `data[]` or an error. `parseWorkspace` returns `[]` for both, and the object's empty state distinguishes offline from idle, so both answers render correctly without knowing which one happens.
9. *Deep playlist nesting, `isScrubbing`, negative or fractional `playbackRate`, multi-machine.* → None is read. Nesting matters only to a playlist browser this plan does not build; `isScrubbing` has no consumer; `playbackRate` is used as a multiplier and as `> 0`, both of which are correct for any value including a negative one; slave-machine state is not surfaced because nothing is known about whether it is even reported.

**Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries the code. Three places say "find that line" and each names the file and a neighbouring symbol because the line number will have drifted: the `stores.ts`-style registration in `automation-engine.ts`'s demand block, the `CATEGORY_ORDER` entry in `integrations-panel.tsx`, and the `ADDED_SINCE` insertion point. The one placeholder this plan originally carried — `PATH_FROM_TASK_0` in Task 6 Step 8 — has been resolved: Task 0 is settled and the two trigger actions carry their real paths.

**Type consistency.** `PvpLayerDTO` flows unchanged from `parseWorkspace` through `PvpStatusDTO` to both surfaces, both automation registries and every verify predicate. `computePvpProgress` takes `sampledAt: string | null` because that is `PvpStatusDTO.sampledAt`'s type. `anchorDriftSec` takes `number | null` on both elapsed arguments because that is `anchorElapsedSec`'s type. `visibleLayers` takes the same `Config` the object body does, so the Home card in Task 4 calls it with a synthetic `{ type: "pvp-layers", show: "with-content" }` that type-checks. `pvpDeps.command`'s signature matches `pvpService.command` exactly, which is what makes the Task 6 Step 6 mutation — pointing the seam at the real method — possible.

**Three risks this plan does not remove.**

*~~The layer argument may be ignored.~~* **Settled: it is** (research §4.3), and the action built on it was removed rather than shipped. An operator cannot choose a cue's layer from Stage, because ProVideoPlayer's API does not offer it — that is set in PVP. What remains genuinely unverified is narrower and stated in the docs: clearing a layer that holds content, the workspace-wide clear, and reading a hidden/muted/faded layer back.

*A layer rename silently stops a rule.* Accepted, documented, and identical to the trade `pco.live.advance` already makes. There is no id in this system that both survives a workspace rebuild and is typable into a form.

*Two polling integrations still gate on `hasSubscribers`.* `reaper-service.ts:115` and `propresenter-service.ts:320`, against four that use `inDemand`. Neither is broken **today** — neither has a trigger that reads its own channel, so there is nothing for the gate to disable — but both are one trigger away from the bug `integration-base.ts:114-127` documents. **Reported, not fixed here:** changing REAPER's poll cadence is a behaviour change to a different integration, it belongs in its own commit with its own proof, and smuggling it into a PR about ProVideoPlayer is how a reviewer stops being able to tell what a PR does. Henry's call whether it is worth its own change.
