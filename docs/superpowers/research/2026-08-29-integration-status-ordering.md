# Integration status ordering: the read that overwrote a newer push

2026-08-29 · branch `fix/integration-status-ordering`, off `feat/multiview`

## The bug

Every integration status hook did two things on mount: read the current value
once, and subscribe to an SSE channel that broadcasts **only on change**. The two
race. When a push landed before the read resolved, the read's `setState` ran last
and put the older value back — and nothing corrects it, because the next frame
does not arrive until something else changes. On a quiet weekday that is hours of
a wrong recording light.

OBS (`renderer/main/use-obs-state.ts`) is where it was noticed. The shape was in
**seven** hooks, not the five the task assumed.

## Scope: seven channels, not five

Every `StatusIntegration` subclass publishes a change-driven snapshot and has a
renderer hook with the racing shape:

| Channel | Service | Hook | Read by Companion |
|---|---|---|---|
| `obs:status` | `obs-service.ts` | `use-obs-state.ts` | yes (new branch) |
| `reaper:status` | `reaper-service.ts` | `use-reaper-state.ts` | yes (new branch) |
| `resi:status` | `resi-service.ts` | `use-stream-state.ts` | yes (new branch) |
| `youtube:status` | `youtube-service.ts` | `use-stream-state.ts` | yes (new branch) |
| `spl:metrics` | `smaart-service.ts` | `use-spl-state.ts` | no — explicitly filtered out |
| `people:count` | `sensource-service.ts` | `use-people-count-state.ts` | yes |
| `propresenter:status` | `propresenter-service.ts` | `use-dashboard-state.ts` | yes |

`integrations:state-changed` is **not** in scope and was never touched: it carries
`IntegrationState[]` — id, enabled, connection, message, masked config — for the
settings panel, and never reports whether OBS is rolling.

### Same shape, deliberately left alone

`stage:state-changed` (`use-stage-state.ts`) and `pco:live` (`use-dashboard-state.ts`)
have the identical hydrate-then-subscribe race, but neither comes from a
`StatusIntegration` — they are the stage controller and the live controller. Both
are read by the Companion module. Fixing them means the same `rev` mechanism in two
more subsystems, and it is a separate change with its own blast radius. Noted, not
done.

`wireless:connections-changed` is not affected: its hook re-reads on every push
(`onNotification(..., () => load())`) rather than applying the pushed payload, so
there is no read-versus-push ordering to get wrong.

## The fix

A monotonic `rev`, bumped **only when a frame actually goes out**, carried by both
halves so the client can order them.

Server (`main/services/integration-base.ts`):

- `private rev` on `StatusIntegration`, with `stamped()` and `bumpRev()`.
- `emit()` bumps and broadcasts `this.stamped(snapshot)`.
- `getLatest()` returns `this.stamped(this.last)` — every hydrate route and the
  SSE hello burst answer from it, so the read carries the same counter.

Deliberately **not** stored on `this.last`. `emitIfChanged()` compares every key
of the DTO, so a rev inside the snapshot would differ on every comparison and turn
every change-driven channel into an unconditional one — a 2 Hz ProPresenter poll
re-rendering every dashboard in the building, forever, with nothing looking broken.

Three services override `emit()` and broadcast for themselves, so the base's stamp
does not reach them; each bumps and stamps at its own broadcast, past its own
change test: `smaart-service.ts`, `propresenter-service.ts`, `sensource-service.ts`.
This is the "fixed in one of four copies" shape this repo keeps paying for, so a
guard counts them.

Client (`renderer/main/use-status-channel.ts`, new): one hook replacing seven
copies of the racing shape. Pushes always apply; the read applies unless it is
**strictly older** than a push already applied.

### Why not "ignore the read once a push has arrived"

Because a push always arrives. `renderer/lib/api.ts` caches the last frame of each
hydrated channel and replays it to every late subscriber in a microtask, so a
component mounting into an already-open stream is handed the **connect-time** value
immediately — exactly the stale value the read exists to correct. That flag trades
a rare race for a guaranteed regression on every mount after the first. Verified in
`api.ts` (`lastPayload`, `queueMicrotask(() => cb(cached))`), and pinned by a test:
under the naive design, four of the five renderer guards go red.

### Why "not older" rather than "strictly newer"

Smaart keeps `this.last` current between throttled broadcasts, so at an equal rev
the read can legitimately be the fresher of the two. Dropping equal-rev reads would
have made the SPL readout stale by up to one throttle interval on every mount.

## Backward compatibility

Additive only. For each payload: **one optional field `rev?: number` was added, via
`RevisionedStatus` in `main/types/live.ts`. No existing field was renamed, removed,
retyped or restructured.**

`ObsStatusDTO`, `ReaperStatusDTO`, `StreamStatusDTO` (Resi + YouTube),
`SplMetricsDTO`, `PeopleCountDTO`, `ProPresenterStatusDTO`.

Verified against the Bitfocus Companion module's own source (read-only clone,
branch `feat/integration-status`), not against a summary of it:

- `src/sse.ts` — subscribes to `server:hello`, `stage:state-changed`, `pco:live`,
  `propresenter:status`, `prodcom:transcript`, `wireless:connections-changed`,
  `people:count`, `obs:status`, `reaper:status`, `resi:status`, `youtube:status`.
- `src/main.ts` — every handler is `data as SomeDTO` on `JSON.parse` output. No
  schema validation, no key whitelist, no rejection of unknown fields. An added
  field is stored and never read.
- `src/state.ts` — holds one nullable DTO per channel.
- `src/variables.ts` / `src/feedbacks.ts` — read only named fields:
  OBS `connected, recording, streaming, virtualCam, recordTimecode`;
  REAPER `connected, recording, positionString`;
  Resi/YouTube `connected, live, startedAt, detail`;
  ProPresenter `connected, currentItem, nextItem, slideIndex, slideCount`;
  people `connected, updatedAt, total.attendance, total.occupancy, zones[].id/name/attendance/occupancy`.

None of those fields is affected. The module's local DTO mirrors are narrower than
the app's (it omits `recordPaused`, `playing`, `positionSeconds`, several
ProPresenter extras) — further evidence that unread fields are already routine.

One claim could **not** be confirmed: the module repository contains no test files
at all and no mention of `rev` anywhere in its source, so the assertion that it was
"explicitly tested against synthetic payloads carrying an unknown `rev`" is not
supported by its code. Safety rests on the unvalidated casts above, which is a
stronger guarantee than a test anyway.

## Guards, each proven red

Reverting the fix, in each of the four ways it can be got wrong:

**Unordered apply** (drop the rev comparison in the hook) →
`a push that lands before the read resolves is not overwritten by it` fails.

**The rejected naive flag** (ignore the read once any push arrived) → four fail:
`a read that is newer than the push still applies`,
`an equal rev lets the read apply — Smaart's snapshot outruns its throttle`,
`mounting into an already-open stream: the read beats the replayed hello burst`,
`a payload with no rev behaves exactly as before the fix`.

**Rev stored inside `this.last`** (the silent one) → five fail, including
`the version does not leak into the change comparison` and
`all seven integrations stamp their hydrate read`.

**Rev bumped on a skipped frame** →
`an unchanged snapshot neither broadcasts nor advances the version` and
`a real change after a run of unchanged frames advances by exactly one` fail.

**One service forgetting to stamp** (SenSource reverted) →
`every broadcast on an integration's own channel is stamped` fails.

The renderer guard drives the **real** `renderer/lib/api.ts` over a fake
EventSource rather than a stub of the API module — a stub would not have the replay
cache, and the mount-into-open-stream test would then prove nothing.

## Checks

`npx tsc --noEmit`, `npx eslint main/ renderer/`, `npm run build` — all clean.

`npm test`: 2627 tests, 2617 pass, 10 fail. All ten failures are pre-existing in
`main/services/app-root.test.ts` and are environmental to this worktree, which has
no `node_modules` of its own — that test spawns a subprocess against a
worktree-relative `node_modules/tsx/dist/loader.mjs` that does not exist here.
Baseline on this branch with the change stashed: 2615 tests, 2605 pass, the same
ten failures. Net: +12 tests, +12 passing, no new failures.
