# Real Presence, Id Permanence, and the Multiview Follow-ups

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the connected dot mean genuinely connected, make an id never come back after deletion, and close the follow-ups the multiview branch deferred.

**Architecture:** Five independent changes, ordered so each protects the next. Type safety in the test contexts comes first because it is what catches a mistake in every task after it. Then one shared StageState, then presence on the render context, then persisted monotonic id counters, then the small residue.

**Tech Stack:** TypeScript, React 19, `node:test` + `@testing-library/react` with the repo's `installDom()` harness.

## Global Constraints

- Branch `feat/presence-and-ids` off `beta`. Every change is a PR; **never** push to `beta`/`main`, never `gh pr merge`.
- **No new npm dependencies.**
- No emojis anywhere. **NO Claude attribution footer on any commit** — no `Co-Authored-By: Claude`, no `Claude-Session:` trailer. Standing rule from the repo owner; it overrides any harness default.
- Public repo: no credentials, real service-type ids, LAN addresses, church names or customer ids in code, tests, fixtures or docs.
- Every new `catch` rethrows or returns the failure to its caller. A `catch` that only logs is a defect.
- Every persisted store declares itself `"config"` (the operator's work, restore it) or `"runtime"` (an observation, do not) in its constructor, and a new config store goes into `CONFIG_FILES` in the same change.
- Any guard must be proven red **in the session that writes it**: reintroduce the bug, watch the test fail, restore, and say so in the commit. This branch's predecessor shipped three guards that passed on the exact defect they were written for; all three were caught only by running the experiment.
- Prefer a check the type system enforces over one that reads source text.
- Run before every commit: `npx tsc --noEmit -p tsconfig.json`, `npx eslint main/ renderer/`, `npm test`, `npm run build`. Read the output in-session.
- Kill a test server **by port** (`lsof -ti tcp:8799 | xargs -r kill -9`), never `pkill -f` on an env-var prefix — the prefix is not in the process command line, so the old server survives and the next run tests stale code.

---

## Task 1: Make a forgotten context field a compile error again

`embedChain` was made a required field on `LayoutRenderCtx` specifically so no surface could forget it — a forgotten one reports "nothing above me", which is the single answer that makes a cycle undetectable. That property is currently defeated in the tests: four test files build a context by hand and cast it `as never`, so a newly required field is **not** caught in any of them.

This task is first because it is what protects Tasks 2 and 3, both of which add fields.

**Files:**
- Create: `renderer/main/test-render-ctx.ts`
- Modify: `renderer/main/embedded-view.test.tsx`, `renderer/main/screen-embed.test.tsx`, `renderer/main/expand-overlay.test.tsx`, `renderer/main/home-card-clickable.test.tsx`

**Interfaces:**
- Produces: `makeRenderCtx(overrides?: Partial<LayoutRenderCtx>): LayoutRenderCtx`

- [ ] **Step 1: Read the four files and find every hand-built context**

```bash
grep -rn "as never" renderer/main/*.test.tsx
```

Each has a `ctxWith(...)` or similar local helper returning a context literal cast `as never`. Read all four before writing anything — they differ in which fields they set.

- [ ] **Step 2: Write the shared builder, typed**

Create `renderer/main/test-render-ctx.ts`:

```ts
// A LayoutRenderCtx for a test, TYPED — which is the whole point of the file.
//
// Four test files each built this by hand and cast it `as never`. That cast
// silently defeated the property the context was designed around: `embedChain`
// is a REQUIRED field precisely so a surface cannot forget it, because a
// forgotten one reports "nothing above me" and makes a cycle undetectable. With
// the cast in place, adding a required field breaks no test, and the four hand-
// built contexts drift out of shape without anybody being told.
//
// So this returns a real `LayoutRenderCtx`, with no cast. Add a required field
// to the interface and this file stops compiling — which is the notification.

import type { LayoutRenderCtx } from "./layout-renderer";

/** Every field at a quiet default; override only what a test is about. */
export function makeRenderCtx(overrides: Partial<LayoutRenderCtx> = {}): LayoutRenderCtx {
  return {
    state: {
      outputs: [],
      views: [],
      captionChannelColors: {},
      slotsByView: {},
      slotsByLayoutObject: {},
    } as LayoutRenderCtx["state"],
    propresenter: null,
    propInstances: null,
    pcoLive: null,
    planItems: null,
    transcript: [],
    spl: null,
    obs: null,
    reaper: null,
    resi: null,
    youtube: null,
    osc: null,
    peopleCount: null,
    serviceLow: null,
    serviceAttendance: null,
    servicePeak: null,
    servicePeakAttendance: null,
    baptism: null,
    serviceTimeline: null,
    integrations: [],
    integrationLabels: {},
    wireless: [],
    now: 0,
    skewMs: 0,
    ndiSource: null,
    H: 1080,
    interactive: false,
    placed: undefined,
    home: false,
    embedChain: [],
    ...overrides,
  };
}
```

The field list above is written from the interface as it stands. Read `LayoutRenderCtx` in `renderer/main/layout-renderer.tsx` and make this match it exactly — if a field's type does not accept the default here, use one that compiles rather than a cast. **The one thing you must not do is reintroduce `as never` or `as unknown as` to make it compile.** If a field genuinely cannot be defaulted, say so in your report.

- [ ] **Step 3: Point all four test files at it**

Replace each local `ctxWith(...)` helper with `makeRenderCtx({ ... })`, passing only the fields that test actually varies. Delete the local helpers and the `as never` casts.

- [ ] **Step 4: Run the four files and the full suite**

```bash
npx tsx --test renderer/main/embedded-view.test.tsx renderer/main/screen-embed.test.tsx renderer/main/expand-overlay.test.tsx renderer/main/home-card-clickable.test.tsx
npm test
```
Expected: all green, same counts as before. This task changes no behaviour.

- [ ] **Step 5: PROVE the property is restored**

Add a required field to `LayoutRenderCtx` temporarily:

```ts
  /** TEMPORARY — proving the builder catches a new required field. */
  provingGround: string;
```

Run `npx tsc --noEmit -p tsconfig.json`.

Expected: it FAILS, naming `renderer/main/test-render-ctx.ts`. Before this task it would have compiled clean, because the casts hid it.

Remove the temporary field, re-run tsc clean. Report the exact error you saw.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/test-render-ctx.ts renderer/main/*.test.tsx
git commit -m "test(layout): a forgotten context field is a compile error again

Four test files built a LayoutRenderCtx by hand and cast it \`as never\`, which
defeated the property the context was designed around: embedChain is required
so that no surface can forget it, and a forgotten one reports \"nothing above
me\" -- the one answer that makes a cycle undetectable.

One typed builder, no cast. Adding a required field now stops this file
compiling, which is the notification.

Proven: adding a temporary required field fails tsc naming the builder; before
this it compiled clean."
```

---

## Task 2: One StageState, not one per component

`useStageState` has no shared cache. Every instance fires its own `stage:getState` on mount, keeps its own copy of the whole StageState, and re-renders on every broadcast. A nine-tile producer wall is nine hydrate requests and nine full copies re-rendered per broadcast, on hardware that is often a Raspberry Pi.

This is not a multiview bug — multiview only multiplied an app-wide one.

**Files:**
- Modify: `renderer/main/use-stage-state.ts`
- Create: `renderer/main/use-stage-state.test.tsx`

**Interfaces:**
- `useStageState()` keeps its exact current signature and return shape. Only its internals change. Every existing caller must keep working untouched.

- [ ] **Step 1: Write the failing test**

Create `renderer/main/use-stage-state.test.tsx`, using the harness pattern from `renderer/main/embedded-view.test.tsx` (read it first — `installDom()`, the `EventSource`/`fetch` stubs, `act()`, flushing promises before teardown):

```tsx
// Mounting the hook N times must cost ONE hydrate, not N.
//
// A nine-tile producer wall mounted nine copies of this hook, each fetching the
// whole StageState and keeping its own copy to re-render on every broadcast.
// Nothing was broken by it, which is why it survived — it is a cost that only
// shows up as a slow Pi.

describe("the state is fetched once for everyone", () => {
  test("three mounts make ONE request", async () => {
    // Not "fewer than three" — exactly one. A floor would go on passing if a
    // fourth consumer added its own fetch, which is how this started.
    requests.length = 0;
    render(React.createElement(ThreeConsumers));
    await settle();
    const hydrates = requests.filter((u) => u.includes("stage") || u.includes("state"));
    assert.equal(hydrates.length, 1, `hydrated ${hydrates.length} times for 3 consumers`);
  });

  test("a later mount gets the state already held, without refetching", async () => {
    requests.length = 0;
    const first = render(React.createElement(OneConsumer));
    await settle();
    const after = requests.length;
    render(React.createElement(OneConsumer));
    await settle();
    assert.equal(requests.length, after, "a second consumer refetched what was already in hand");
    first.unmount();
  });

  test("every consumer sees a broadcast", async () => {
    // The point of sharing is that it stays correct. One consumer updating
    // while another shows stale state is worse than the duplicate fetches.
    render(React.createElement(ThreeConsumers));
    await settle();
    act(() => { emitStateChanged({ ...BASE, appName: "Changed" }); });
    for (const node of screen.getAllByTestId("app-name")) {
      assert.equal(node.textContent, "Changed", "a consumer missed the broadcast");
    }
  });

  test("unmounting one consumer does not blind the others", async () => {
    const a = render(React.createElement(OneConsumer));
    const b = render(React.createElement(OneConsumer));
    await settle();
    a.unmount();
    act(() => { emitStateChanged({ ...BASE, appName: "Still live" }); });
    assert.equal(screen.getByTestId("app-name").textContent, "Still live");
    b.unmount();
  });
});
```

Write `ThreeConsumers`, `OneConsumer`, `emitStateChanged`, `BASE`, `requests` and `settle` in that file. `requests` records urls from the `fetch` stub; `emitStateChanged` invokes whatever `onNotification("stage:state-changed", …)` registered. Read `renderer/lib/api.ts` to see how `onNotification` stores handlers so the emitter reaches them.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/main/use-stage-state.test.tsx`
Expected: FAIL on "three mounts make ONE request" — it will report 3.

- [ ] **Step 3: Add a module-level shared cache**

Rewrite the internals of `useStageState` so one module-level store serves every consumer: a single in-flight hydrate promise, a single `onNotification` subscription, and a set of subscribers notified on change. `useSyncExternalStore` is the idiomatic React 19 shape for this and avoids the tearing a `useState`-per-consumer design allows.

Keep these properties, each of which exists for a reason:
- `setDisplayHourCycle` is called on hydrate AND on every broadcast — the comment says it is set here because every surface hydrates through this hook, so there is exactly one place to keep in sync. That must remain true with a shared store.
- The error path still reports; a failed hydrate must not leave every consumer silently blank forever.
- `isLoading` is true until the first answer, for every consumer including one that mounts later.

Write a docblock saying why the cache is module-level and what would break if a consumer kept its own copy.

- [ ] **Step 4: Run the tests**

Run the new file: expect 4 passing.
Run `npm test`: expect the full suite green. `useStageState` has many callers; a failure here is a real regression, not a test to update.

- [ ] **Step 5: Prove the guard**

Revert to a per-consumer fetch (give each consumer its own `useEffect` hydrate again) and run the new test file.
Expected: FAIL on "three mounts make ONE request", reporting 3.
Restore, re-run green. Report the exact numbers you saw.

- [ ] **Step 6: Drive it**

```bash
npm run build
SCRATCH=$(mktemp -d); STAGE_UTILITY_DATA="$SCRATCH" STAGE_UTILITY_PORT=8799 npx tsx server.ts &
```
Open the operator shell, then a custom view with several Embedded screen tiles. In DevTools' network panel, confirm ONE `stage:getState`-equivalent request on load rather than one per tile. Confirm the page still updates when state changes. Kill by port.

- [ ] **Step 7: Commit**

```bash
git add renderer/main/use-stage-state.ts renderer/main/use-stage-state.test.tsx
git commit -m "perf(state): one StageState for every consumer, not one each

useStageState had no shared cache: every instance fetched the whole state on
mount, kept its own copy, and re-rendered on every broadcast. A nine-tile
producer wall was nine hydrates and nine full copies per broadcast, on hardware
that is often a Pi.

App-wide, not a multiview bug -- multiview only multiplied it.

Proven: reverting to a per-consumer fetch makes three mounts issue three
hydrates and fails the guard."
```

---

## Task 3: A connected dot that means connected

`display-presence.ts` already tracks real connections — the kiosk POSTs a heartbeat on a timer and a `sendBeacon` on unload, an output lapses after a 90s TTL, and the connected set broadcasts on `displays:presence` only when it changes. Settings → Displays already lights a real dot from it.

Home and the multiview tiles do not use it. They call `onlineFromState`, which is `outputs.filter(o => o.viewId)` — **routed**, not connected. A screen that is routed and unplugged reads as online for ever.

The recorded reason for the fake is in `renderer/app/home/cards.tsx`: "an object on a wall display has no business subscribing to presence". That objection is answerable — `useLayoutData` already gates every channel on the object types actually present (`const obs = useObsState(want(["obs-status"]))`), so presence subscribes only where something draws it.

**Files:**
- Create: `renderer/main/use-display-presence.ts`
- Modify: `renderer/main/layout-renderer.tsx`, `renderer/app/home/cards.tsx`, `renderer/app/home/home-grid.tsx`, `renderer/app/home/readiness.ts` (and its callers), `renderer/editor/layout-editor.tsx`
- Create: `renderer/main/display-presence-wiring.test.tsx`

**Interfaces:**
- Consumes: `makeRenderCtx` (Task 1) for test contexts.
- Produces: `useDisplayPresence(enabled: boolean): string[]`, and a new REQUIRED field `LayoutRenderCtx.onlineOutputIds: readonly string[]`.

- [ ] **Step 1: Write the hook**

Create `renderer/main/use-display-presence.ts`:

```ts
// Which screens actually have a browser attached.
//
// The server has known this all along: display-presence.ts tracks a heartbeat
// per output with a 90s TTL and a sendBeacon on unload, and broadcasts the
// connected set on "displays:presence" only when it changes. Settings ->
// Displays has been lighting a real dot from it.
//
// Home and the multiview tiles used `outputs.filter(o => o.viewId)` instead,
// which is ROUTED, not connected — so a screen that is routed and unplugged read
// as online for ever. On a producer wall that is the worst possible lie: the one
// tile you need to notice is the one that looks fine.
//
// `enabled` is how a wall display avoids subscribing to something it does not
// draw, which was the objection that kept the fake in place. It follows the same
// shape as every other channel in useLayoutData: `useObsState(want([...]))`.

import { useEffect, useState } from "react";
import { invoke, onNotification } from "../lib/api";

const EMPTY: string[] = [];

export function useDisplayPresence(enabled: boolean): string[] {
  const [connected, setConnected] = useState<string[]>(EMPTY);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // The SSE hello burst carries a presence snapshot, but a consumer that
    // mounts after the stream opened would otherwise wait for the next CHANGE —
    // and presence broadcasts only on change, so a stable room means no
    // broadcast at all. Asking once on mount is what stops a quiet building
    // rendering every dot dark.
    invoke<{ connected?: string[] }>("displays:getPresence")
      .then((p) => { if (alive) setConnected(p?.connected ?? EMPTY); })
      // Not a toast: presence is ambient, and a failed read on a page load is
      // not something an operator can act on. The dots stay dark, which is the
      // honest reading of "we do not know".
      .catch(() => { if (alive) setConnected(EMPTY); });

    const off = onNotification("displays:presence", (p: unknown) => {
      if (alive) setConnected((p as { connected?: string[] } | null)?.connected ?? EMPTY);
    });
    return () => { alive = false; off(); };
  }, [enabled]);

  return enabled ? connected : EMPTY;
}
```

- [ ] **Step 2: Add the read endpoint if it does not exist**

The hook calls `displays:getPresence`. Check `renderer/lib/api.ts` and the route modules: if there is no such channel and path, add both — the channel in `api.ts` and a `GET` route returning `presenceSnapshot()` from `main/services/display-presence.ts`.

Two guards enforce this pairing and will fail if you add one without the other: `renderer/lib/api-channels.test.ts` fails on a channel nothing dispatches, and `main/services/routes/route-coverage.test.ts` fails on a path no module serves. Do not add the channel before its caller exists.

If a suitable endpoint already exists, use it and say so in your report.

- [ ] **Step 3: Put presence on the render context**

Add to `LayoutRenderCtx`, as a REQUIRED field:

```ts
  /**
   * Screens with a browser actually attached, from the `displays:presence`
   * heartbeat — not screens that merely have a view routed.
   *
   * Required, like `embedChain` and `home`, so a surface cannot quietly report
   * an empty set. Empty is a legitimate answer (nothing is on); "I forgot to
   * pass it" must not be indistinguishable from it.
   */
  onlineOutputIds: readonly string[];
```

Then supply it at every construction site. `tsc` will name them — Task 1 restored that property, so the four test contexts are named too. In `useLayoutData`, gate the subscription the way the neighbours are gated:

```ts
  const onlineOutputIds = useDisplayPresence(want(["screen-embed", "home-readiness", "home-screens"]));
```

Read the surrounding `want([...])` calls and match their shape. Include every object type that actually draws presence — grep for `onlineOutputIds` and `onlineFromState` to find them all.

- [ ] **Step 4: Delete the fake and rewire its callers**

Remove `onlineFromState` from `renderer/app/home/cards.tsx` entirely, along with the docblock explaining why the presence hook was deleted — it is no longer true. Every caller reads `ctx.onlineOutputIds` (or the prop fed from it) instead.

Update `renderer/app/home/readiness.ts`'s "Screens online" check so its `detail` copy is accurate for real presence: a screen that is routed but not connected must now read as not connected, which is the whole point.

The screen tile's status dot and its aria-label in `renderer/main/layout-renderer.tsx` change meaning back to genuine connectedness. Update the label, the inspector hint in `renderer/editor/inspector.tsx`, and `docs/reference/layout-editor.md` together — three places describe this dot and they must agree. Grep for the current wording ("routed", "not blacked out") and fix every instance.

- [ ] **Step 5: Write the guard**

Create `renderer/main/display-presence-wiring.test.tsx`, using `makeRenderCtx` from Task 1:

```tsx
describe("the dot means connected, not merely routed", () => {
  test("a routed screen with NO heartbeat reads as not connected", () => {
    // The exact bug: `outputs.filter(o => o.viewId)` calls this screen online
    // for ever. On a producer wall it is the worst possible lie — the one tile
    // you need to notice is the one that looks fine.
    const ctx = makeRenderCtx({
      state: { outputs: [{ id: "out-1", name: "Left", viewId: "v-1" }], views: [{ id: "v-1", name: "V", kind: "slots" }] } as never,
      onlineOutputIds: [],
    });
    // render the screen tile through ObjectContent and assert the dot's
    // aria-label reports NOT connected.
  });

  test("a routed screen WITH a heartbeat reads as connected", () => {
    // same fixture, onlineOutputIds: ["out-1"], opposite assertion
  });

  test("an UNROUTED screen that is connected still reports its heartbeat", () => {
    // routed and connected are now independent facts; the tile must not
    // conflate them again.
  });
});
```

Fill in the render and assertions following `renderer/main/screen-embed.test.tsx`, which already renders this object.

- [ ] **Step 6: Prove it red**

Reintroduce the fake: make the context field default to `outputs.filter(o => o.viewId)` at a call site, or point the dot back at that expression.
Expected: "a routed screen with NO heartbeat reads as not connected" FAILS.
Restore, re-run green. Report the exact failing test name.

- [ ] **Step 7: Drive it for real**

Build and run a server on 8799 against a scratch data dir. Create two screens. Open one in a second browser tab so it heartbeats; leave the other closed. On a producer wall in the operator shell, confirm the open one's dot is connected and the closed one's is not — **then close the tab and confirm its dot goes dark**, which is the behaviour the fake could never produce. Kill by port.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(displays): the connected dot means a browser is attached

display-presence.ts has tracked real connections all along -- a heartbeat per
output, a 90s TTL, a sendBeacon on unload, broadcast on change. Settings ->
Displays was already lighting a real dot from it. Home and the multiview tiles
used \`outputs.filter(o => o.viewId)\` instead, which is ROUTED, not connected:
a screen that is routed and unplugged read as online for ever.

On a producer wall that is the worst available lie -- the one tile you need to
notice is the one that looks fine.

The objection that kept the fake (\"an object on a wall has no business
subscribing to presence\") is answered the way every other channel answers it:
gated on the object types actually present, exactly like useObsState.

Proven: pointing the dot back at the routed-set expression fails the
no-heartbeat test."
```

---

## Task 4: An id never comes back

`nextViewId()` and `nextOutputId()` both allocate `Math.max(existing) + 1`. Delete the highest-numbered view or display, create another, and it takes the dead one's id.

That matters because ids are treated as permanent everywhere else. `Output.id`'s own docblock says so: "Permanent. Never rewritten after creation — slots.json and every other store is keyed by this, and Pis/bookmarks/QR codes point at `/<id>`." So a recreated display can silently inherit a deleted one's mic slots, and a bookmark or QR code aimed at the old screen now opens a different one. A `view-embed` pointing at a deleted view rebinds to an unrelated new one.

**Files:**
- Modify: `main/services/stage-controller.ts` (`nextViewId`, `nextOutputId`), `main/services/settings-store.ts`
- Create: `main/services/id-allocator.ts`, `main/services/id-allocator.test.ts`

**Interfaces:**
- Produces: `nextId(prefix: string, existingIds: readonly string[], floor: number): { id: string; nextFloor: number }`

- [ ] **Step 1: Write the failing test**

Create `main/services/id-allocator.test.ts`:

```ts
// An id, once used, is never issued again.
//
// Both allocators were `max(existing) + 1`, so deleting the highest-numbered
// view or display and creating another handed out the dead one's id. Ids are
// treated as permanent everywhere else: slots.json is keyed by output id, and
// Pis, bookmarks and QR codes point at `/<id>`. So a recreated display silently
// inherited a deleted one's mic slots, and a bookmark aimed at one screen opened
// another.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextId } from "./id-allocator.js";

describe("an id is never reissued", () => {
  it("counts up from the floor", () => {
    const r = nextId("view", ["view-1", "view-2"], 3);
    assert.equal(r.id, "view-3");
    assert.equal(r.nextFloor, 4);
  });

  it("DOES NOT REUSE the id of a deleted item", () => {
    // The bug, stated as the test that catches it. views 1,2,3 exist; 3 is
    // deleted; the floor remembers 4. max(existing)+1 would answer "view-3".
    const r = nextId("view", ["view-1", "view-2"], 4);
    assert.equal(r.id, "view-4", "a deleted id was handed out again");
  });

  it("never collides with an existing id, even if the floor is stale", () => {
    // A restored backup can carry a floor lower than the ids in it. Answering
    // an id that already exists would be worse than reuse: two live things
    // sharing a key.
    const r = nextId("view", ["view-1", "view-2", "view-9"], 3);
    assert.ok(!["view-1", "view-2", "view-9"].includes(r.id), `collided: ${r.id}`);
    assert.equal(r.id, "view-10");
  });

  it("starts at the floor when nothing exists yet", () => {
    assert.equal(nextId("display", [], 2).id, "display-2");
  });

  it("ignores ids that are not numbered", () => {
    // "home" is a real view id in this app and parses to NaN.
    const r = nextId("view", ["home", "view-4"], 1);
    assert.equal(r.id, "view-5");
  });

  it("advances the floor past what it issued", () => {
    const first = nextId("view", [], 1);
    const second = nextId("view", [`view-${1}`], first.nextFloor);
    assert.notEqual(first.id, second.id);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test main/services/id-allocator.test.ts`
Expected: FAIL — `Cannot find module './id-allocator.js'`.

- [ ] **Step 3: Write the allocator**

Create `main/services/id-allocator.ts`:

```ts
// Hands out an id that has never been used before.
//
// PURE, so the rule is testable without a store: the caller owns persistence and
// passes the floor in, and gets the next floor back to save.
//
// Two independent inputs, because either alone is wrong:
//
//   THE FLOOR is a persisted high-water mark. It is what stops a deleted id
//   coming back — `max(existing) + 1` cannot know about something that is gone.
//
//   THE EXISTING IDS are the collision check. A floor can be STALE — a restored
//   backup carries a counter written before the ids in it — and issuing an id
//   that already exists is worse than reuse: two live things sharing a key that
//   slots.json, bookmarks and QR codes all treat as unique.

export function nextId(
  prefix: string,
  existingIds: readonly string[],
  floor: number,
): { id: string; nextFloor: number } {
  const used = new Set(existingIds);
  const highest = existingIds
    .map((id) => parseInt(id.slice(prefix.length + 1), 10))
    .filter((n) => Number.isFinite(n));
  let n = Math.max(floor, highest.length > 0 ? Math.max(...highest) + 1 : 1);
  while (used.has(`${prefix}-${n}`)) n++;
  return { id: `${prefix}-${n}`, nextFloor: n + 1 };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test main/services/id-allocator.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Persist the floors and use them**

Add to `SettingsData` in `main/services/settings-store.ts`:

```ts
  /**
   * High-water marks for id allocation — the next number each kind may use.
   *
   * Persisted because a deleted item leaves no trace in the live list, and
   * `max(existing) + 1` therefore hands its id to the next thing created. Ids
   * are permanent by contract: slots.json is keyed by output id, and Pis,
   * bookmarks and QR codes point at `/<id>`.
   *
   * Absent means "not recorded yet", and the allocator falls back to the
   * collision check alone — so an install that upgrades into this keeps working
   * and starts recording from its current maximum.
   */
  idFloors?: { view?: number; output?: number };
```

Default it in `DEFAULT_SETTINGS` as `{}`.

Then rewrite both allocators in `main/services/stage-controller.ts` to call `nextId`, read the floor from settings, and persist `nextFloor`. `nextOutputId` currently starts at 2 because `display-1` is reserved as the primary output — preserve that (pass a floor of at least 2). Both are currently synchronous and their callers may not await; if persisting the floor makes them async, follow the call chain and fix it properly rather than fire-and-forgetting the write — a floor that did not reach disk is the bug all over again after a restart.

- [ ] **Step 6: Write the end-to-end guard**

Add to `main/services/id-allocator.test.ts` (or a new file if the store setup needs its own module scope, following `main/services/checklist-ticks-store.test.ts`'s pattern with `STAGE_UTILITY_DATA` in a temp dir):

```ts
describe("through the real store", () => {
  it("does not reissue a deleted view's id ACROSS A RESTART", async () => {
    // The floor is only worth having if it survives. Create, delete, reload the
    // store from disk, create again — the id must not come back.
  });
});
```

Write it against the real `settingsStore` and a temp `STAGE_UTILITY_DATA`. Note that `DataStore.load()` returns a warm in-memory cache, so re-reading requires a fresh module or a genuine reload — `main/services/checklist-ticks-store.test.ts` documents this trap; read it before writing the test, and assert against the FILE if that is what it takes to prove persistence.

- [ ] **Step 7: Prove it red**

Revert `nextViewId` to `Math.max(...nums) + 1`.
Expected: the "DOES NOT REUSE" test and the across-a-restart test both FAIL.
Restore, re-run green. Report both failing test names.

- [ ] **Step 8: Drive it**

Build, run a server on 8799 against a scratch data dir. Create three views, delete the third, create another — confirm it is `view-4`, not `view-3`. Restart the server and repeat — confirm the floor survived. Do the same for displays. Kill by port.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "fix(ids): an id is never handed out twice

nextViewId and nextOutputId allocated max(existing) + 1, so deleting the
highest-numbered view or display and creating another took the dead one's id.
Ids are permanent by contract everywhere else -- slots.json is keyed by output
id, and Pis, bookmarks and QR codes point at /<id> -- so a recreated display
silently inherited a deleted one's mic slots.

A persisted high-water mark stops reuse; the collision check stops a stale
floor from a restored backup issuing an id that already exists. Either alone is
wrong.

Proven: reverting to max+1 fails both the unit guard and the across-a-restart
guard."
```

---

## Task 5: The residue

Four small things the multiview branch deferred, fixed together.

**Files:**
- Modify: `renderer/main/expand-overlay.tsx`, `main/services/view-refs.ts`, `renderer/settings/sections/import-layout.tsx`, `renderer/editor/inspector.tsx`

- [ ] **Step 1: One Escape closes one level**

Nesting an expanded tile inside an expanded tile leaves two `document` keydown listeners, so Escape collapses the whole stack instead of the innermost panel.

Fix it so Escape closes exactly one level. A module-level stack of open panels, where only the topmost handles the key, is the straightforward shape; the alternative is stopping propagation at the panel that handles it. Choose one and say why in a comment.

Write a test that opens two nested panels, presses Escape once, and asserts the inner one closed and the outer one is still open. Prove it red by removing the fix.

- [ ] **Step 2: A screen tile's rebind row says which screen**

`main/services/view-refs.ts` pushes the literal label `"Screen"` for every screen tile, so an imported wall's rebind work list is N identical rows distinguished only by a raw output id.

Give each row something a person can act on. The tile has no name field of its own, so the object id is the fallback the reviewer suggested; if the output's name is reachable at that point, prefer it. Read how `wireless` builds its label (`c.label`) and follow that shape.

- [ ] **Step 3: Correct the import copy**

`renderer/settings/sections/import-layout.tsx` says an unresolved reference will "render as unconfigured". A screen tile renders "That screen no longer exists", which is not the same thing. Make the copy true for both cases, or say each case separately.

- [ ] **Step 4: Complete the dot's hint**

`renderer/editor/inspector.tsx`'s hint enumerates when the dot is dark but omits the case where the routed view itself was deleted.

**Note:** Task 3 changes what this dot MEANS. Do this step after Task 3 lands and describe the post-Task-3 behaviour — a dot driven by a real heartbeat. Do not describe the routed-set behaviour, which will no longer exist.

- [ ] **Step 5: Verify and commit**

Run `npx tsc --noEmit -p tsconfig.json`, `npx eslint main/ renderer/`, `npm test`, `npm run build` — all clean.

```bash
git add -A
git commit -m "fix(layout): Escape closes one panel, and three copy corrections

Nested expanded tiles left two document keydown listeners, so one Escape
collapsed the whole stack. An imported wall's rebind rows all read \"Screen\".
The import copy promised \"renders as unconfigured\" for a state that renders
something else. The dot's hint omitted a case.

Proven: removing the stack fix makes one Escape close both panels."
```

---

## Self-Review

**Coverage.** Real presence — Task 3, using the service that already exists and answering the recorded objection rather than ignoring it. Monotonic counter — Task 4, with the collision check that a counter alone does not give. The deferred minors — Task 5. The `as never` caveat — Task 1, first, because it protects Tasks 2 and 3. The efficiency follow-up — Task 2, fixed at its app-wide root rather than papered over per tile.

**Ordering.** Task 1 must precede Tasks 2 and 3, both of which add or change context fields; without it a mistake in either is invisible to the type checker in four test files. Task 5 Step 4 must follow Task 3, and says so.

**Placeholders.** Tasks 1, 4 carry complete code. Tasks 2, 3, 5 carry complete test skeletons and full docblocks but leave some fixture wiring to the implementer, because the harness details (how `onNotification` stores handlers, exactly how `ObjectContent` is rendered in a test) are already established in existing files that the plan names — copying them here would duplicate a moving target rather than a stable one. Each such step names the specific file to read.

**Type consistency.** `makeRenderCtx` (Task 1) is used by Tasks 3 and 5. `useDisplayPresence(enabled: boolean): string[]` and the required `onlineOutputIds` are defined in Task 3 and referenced nowhere earlier. `nextId(prefix, existingIds, floor)` is defined in Task 4 and used only there.

**Known risk.** Task 4 may make the id allocators async. The plan says to follow the call chain and fix it properly rather than fire-and-forget the write, because a floor that did not reach disk reproduces the original bug after a restart. If that chain turns out to reach far more callers than expected, the implementer should report it rather than either fire-and-forgetting or half-converting.
