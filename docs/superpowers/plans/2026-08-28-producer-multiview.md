# Producer Multiview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A producer can build one custom view of tiles, each showing a live screen or view of any kind, and tap a tile to expand it full-screen and back.

**Architecture:** One component renders a View of any kind into a box; both the existing `view-embed` object and a new `screen-embed` object call it. Recursion is bounded by an ancestor chain carried on the render context plus a depth cap, replacing today's "refuse custom views entirely". Expanding a tile is a portal overlay animated with FLIP — no navigation, so "back" is closing it.

**Tech Stack:** React 19, TypeScript, Tailwind v4, `node:test` + `@testing-library/react` with the repo's own `installDom()` jsdom harness.

## Global Constraints

- Branch `feat/multiview` off `beta`. Every change goes through a PR; **never** push to `beta`/`main`, never `gh pr merge`.
- **No new npm dependencies.** FLIP is hand-rolled — `renderer/app/home/home-grid.tsx` already contains one (`useSlideOnMove`), read it before writing another.
- No emojis anywhere. No Claude attribution in commits or PR bodies.
- Public repo: no credentials, church names, real service-type ids, LAN addresses or customer ids in code, tests, fixtures or docs.
- Numeric fields in the inspector use the themed `NumberInput`, never a raw `<input type="number">`.
- Zero purple. Dark surfaces are strictly `R=G=B`.
- Every new `catch` rethrows or returns the failure to its caller. A `catch` that only logs is a defect.
- Any guard must be proven red **in the session that writes it**: reintroduce the bug, watch the test fail, restore, say so in the commit.
- Prefer a check the type system enforces over one that reads source text.
- `renderer/lib/api-channels.test.ts` fails on a channel nothing dispatches, and `main/services/routes/route-coverage.test.ts` fails on a path no module serves. Do not add either ahead of its caller.
- Run before every commit: `npx tsc --noEmit -p tsconfig.json`, `npx eslint main/ renderer/`, `npm test`, `npm run build`. Read the output in-session; a green badge on an older commit is not evidence.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/main/embed-chain.ts` | **Create.** Pure: may this view be embedded here, and why not. No React, no DOM. |
| `renderer/main/embed-chain.test.ts` | **Create.** Cycle, depth, self-embed. |
| `renderer/main/embedded-view.tsx` | **Create.** Renders one View of any kind into a box. The single place both objects go through. |
| `renderer/main/embedded-view.test.tsx` | **Create.** Each kind draws something; a cycle draws a notice. |
| `renderer/main/expand-overlay.tsx` | **Create.** Portal overlay + FLIP + Escape. |
| `renderer/main/expand-overlay.test.tsx` | **Create.** Opens, closes on Escape, closes on the back control. |
| `renderer/main/layout-renderer.tsx` | Modify. `embedChain` on the ctx; `view-embed` and `screen-embed` cases delegate to `EmbeddedView`. |
| `renderer/main/layout-objects.ts` | Modify. Widen `EMBEDDABLE_VIEW_KINDS`; register `screen-embed`. |
| `renderer/app/home/home-grid.tsx` | Modify. Supply `embedChain` (one line). |
| `renderer/editor/layout-editor.tsx` | Modify. Supply `embedChain` (one line). |
| `renderer/editor/inspector.tsx` | Modify. Screen picker; view picker hint corrected. |
| `renderer/editor/palette.tsx` | Modify. Icon for `screen-embed`. |
| `main/types/views.ts` | Modify. `screen-embed` config member. |
| `main/types/object-capabilities.ts` | Modify. `screen-embed` capability. |
| `main/services/view-refs.ts` | Modify. Follow `screen-embed` so export/import carries it. |
| `docs/reference/widgets.md`, `docs/reference/layout-editor.md` | Modify. |

---

## Task 1: The recursion guard, as pure logic

Today `EMBEDDABLE_VIEW_KINDS = ["script"]` and custom views are hidden from the picker. That exclusion *is* the whole guard — its own comment says so. Widening the feature means replacing it with a real one first, before anything can recurse.

**Files:**
- Create: `renderer/main/embed-chain.ts`
- Create: `renderer/main/embed-chain.test.ts`

**Interfaces:**
- Produces:
  - `MAX_EMBED_DEPTH = 3`
  - `type EmbedRefusal = { reason: "cycle" | "depth"; message: string }`
  - `function embedRefusal(viewId: string, chain: readonly string[]): EmbedRefusal | null`
  - `function childChain(viewId: string, chain: readonly string[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `renderer/main/embed-chain.test.ts`:

```ts
// A view that embeds itself must draw a notice, not recurse until the tab dies.
//
// This replaces the old guard, which was "custom views are not offered in the
// picker". That was correct and free — a custom view is the only kind holding a
// layout, so refusing it meant an embed could never reach another embed. It also
// made a producer multiview impossible, which is what this feature is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_EMBED_DEPTH, childChain, embedRefusal } from "./embed-chain.js";

describe("a view may not contain itself", () => {
  it("allows a view nothing above it is already showing", () => {
    assert.equal(embedRefusal("v-b", ["v-a"]), null);
  });

  it("refuses a view that IS its own parent", () => {
    const r = embedRefusal("v-a", ["v-a"]);
    assert.equal(r?.reason, "cycle");
  });

  it("refuses a view further up the chain, not only the immediate parent", () => {
    // A -> B -> C -> A. Checking only the parent lets this through and the
    // render loops for ever.
    const r = embedRefusal("v-a", ["v-a", "v-b", "v-c"]);
    assert.equal(r?.reason, "cycle");
  });

  it("says which view, so the notice can name it", () => {
    const r = embedRefusal("v-a", ["v-a"]);
    assert.match(r?.message ?? "", /already/i);
  });
});

describe("nesting is bounded even when it is legal", () => {
  it("allows nesting up to the cap", () => {
    const chain = Array.from({ length: MAX_EMBED_DEPTH - 1 }, (_, i) => `v-${i}`);
    assert.equal(embedRefusal("v-new", chain), null);
  });

  it("refuses past the cap", () => {
    // Four tiles of four tiles of four tiles is 64 live layouts on a Pi. No
    // cycle, and still not something to render.
    const chain = Array.from({ length: MAX_EMBED_DEPTH }, (_, i) => `v-${i}`);
    assert.equal(embedRefusal("v-new", chain)?.reason, "depth");
  });

  it("caps at a number somebody chose", () => {
    assert.equal(MAX_EMBED_DEPTH, 3);
  });
});

describe("the chain handed to a child", () => {
  it("appends this view", () => {
    assert.deepEqual(childChain("v-b", ["v-a"]), ["v-a", "v-b"]);
  });

  it("does not mutate the parent's chain", () => {
    const parent = ["v-a"];
    childChain("v-b", parent);
    assert.deepEqual(parent, ["v-a"], "the parent's chain was mutated — siblings would see each other");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/main/embed-chain.test.ts`
Expected: FAIL — `Cannot find module './embed-chain.js'`.

- [ ] **Step 3: Write the implementation**

Create `renderer/main/embed-chain.ts`:

```ts
// How deep an embed may go, and when it must stop.
//
// PURE, and separate from the component, because this is the part that has to be
// right: a missed cycle is not a wrong pixel, it is a render loop that takes the
// tab with it — on a wall display nobody is standing next to.
//
// Two independent limits, for two different failures:
//
//   CYCLE is correctness. A view already somewhere above this one would render
//   itself for ever. Checking the whole chain rather than the immediate parent
//   is the point: A -> B -> C -> A has no parent match anywhere in it.
//
//   DEPTH is cost. Legal, acyclic nesting still multiplies — four tiles of four
//   tiles of four tiles is sixty-four live layouts, each with its own
//   subscriptions, on hardware that is often a Raspberry Pi.

/**
 * How many views may be stacked inside one another.
 *
 * Three, which covers a producer wall of screens where one of those screens is
 * itself a multiview, and stops short of anything nobody could read.
 */
export const MAX_EMBED_DEPTH = 3;

export interface EmbedRefusal {
  reason: "cycle" | "depth";
  /** Operator-facing, and specific — a notice that says only "cannot embed"
   *  leaves somebody clicking around trying to work out which tile is at fault. */
  message: string;
}

/**
 * Why this view must not be rendered here, or null when it may be.
 *
 * @param viewId The view an embed is about to draw.
 * @param chain  The views already being drawn above it, outermost first.
 */
export function embedRefusal(viewId: string, chain: readonly string[]): EmbedRefusal | null {
  if (chain.includes(viewId)) {
    return { reason: "cycle", message: "This view is already showing further out — it cannot contain itself" };
  }
  if (chain.length >= MAX_EMBED_DEPTH) {
    return { reason: "depth", message: `Nested more than ${MAX_EMBED_DEPTH} deep` };
  }
  return null;
}

/**
 * The chain a child embed inherits.
 *
 * A new array every time. Pushing onto the parent's would make siblings see each
 * other, so the second tile in a row would refuse itself as a cycle.
 */
export function childChain(viewId: string, chain: readonly string[]): string[] {
  return [...chain, viewId];
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx tsx --test renderer/main/embed-chain.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the cycle guard fails on the bug it guards**

Temporarily change `chain.includes(viewId)` to `chain[chain.length - 1] === viewId` (parent-only, the tempting wrong version).

Run: `npx tsx --test renderer/main/embed-chain.test.ts`
Expected: FAIL on "refuses a view further up the chain, not only the immediate parent".

Restore the line. Re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add renderer/main/embed-chain.ts renderer/main/embed-chain.test.ts
git commit -m "feat(layout): bound how deep one view may embed another

Cycle detection over the whole ancestor chain, plus a depth cap of 3. A cycle
is correctness -- a view already above this one renders for ever. Depth is
cost: four tiles of four tiles of four tiles is 64 live layouts on a Pi.

Proven red: checking only the immediate parent lets A -> B -> C -> A through
and fails the chain test."
```

---

## Task 2: Carry the chain on the render context

**Files:**
- Modify: `renderer/main/layout-renderer.tsx` (the `LayoutRenderCtx` interface near line 104, and the ctx literal near line 2515)
- Modify: `renderer/app/home/home-grid.tsx` (`useHomeCtx`, near line 190)
- Modify: `renderer/editor/layout-editor.tsx` (the ctx literal near line 1885)

**Interfaces:**
- Consumes: nothing from Task 1 at runtime; the field it adds is what Task 3 reads.
- Produces: `LayoutRenderCtx.embedChain: readonly string[]`

- [ ] **Step 1: Add the field to the interface**

In `renderer/main/layout-renderer.tsx`, immediately after the `home: boolean;` field:

```ts
  /**
   * The views being drawn ABOVE this one, outermost first. Empty at the top.
   *
   * Required rather than optional, exactly like `home` above it and for the same
   * reason: every surface that builds a context has to say which it is. An
   * optional field defaulting to [] would let a surface forget, and a forgotten
   * chain reads as "nothing above me" — which is the one answer that makes a
   * cycle undetectable.
   */
  embedChain: readonly string[];
```

- [ ] **Step 2: Run the type checker and read the three errors**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: FAIL, three errors — one per ctx construction site (`layout-renderer.tsx`, `home-grid.tsx`, `layout-editor.tsx`). This is the type checker naming every surface for you; do not add a default to silence it.

- [ ] **Step 3: Supply it at all three sites**

`renderer/main/layout-renderer.tsx`, in the ctx literal near line 2515, add after `home: false,`:

```ts
    embedChain: [],
```

`renderer/app/home/home-grid.tsx`, in `useHomeCtx`'s returned object, after `home: true,`:

```ts
    // Nothing above Home. A card that embeds a view starts the chain here.
    embedChain: [],
```

`renderer/editor/layout-editor.tsx`, in the ctx passed near line 1885, add:

```ts
                embedChain: [],
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit -p tsconfig.json` — expect no output.
Run: `npm test` — expect the existing suite green (2556 pass at time of writing; a higher number is fine, a failure is not).

- [ ] **Step 5: Commit**

```bash
git add renderer/main/layout-renderer.tsx renderer/app/home/home-grid.tsx renderer/editor/layout-editor.tsx
git commit -m "refactor(layout): every render context says what is above it

embedChain is required, not optional, for the same reason \`home\` is: a
surface that forgets it would report \"nothing above me\", which is the one
answer that makes a cycle undetectable. The type checker named all three
construction sites."
```

---

## Task 3: One component renders a View of any kind

This is the heart. Both objects go through it, so a kind that renders in one renders in the other.

**Files:**
- Create: `renderer/main/embedded-view.tsx`
- Create: `renderer/main/embedded-view.test.tsx`
- Modify: `renderer/main/layout-objects.ts` (widen `EMBEDDABLE_VIEW_KINDS`)

**Interfaces:**
- Consumes: `embedRefusal`, `childChain` (Task 1); `LayoutRenderCtx.embedChain` (Task 2); existing `RenderObject`, `ScriptView`, `DashboardView`, `StageDisplayView`, `TranscriptionView`, `SlotsGrid` path in `layout-renderer.tsx`.
- Produces: `function EmbeddedView({ view, ctx, box, displayId, showHeader, autoScroll }): JSX.Element`

- [ ] **Step 1: Widen the embeddable kinds**

In `renderer/main/layout-objects.ts`, replace the `EMBEDDABLE_VIEW_KINDS` constant and its docblock:

```ts
/**
 * Which View kinds a `view-embed` object may render.
 *
 * Every kind. It used to be `["script"]`, with custom excluded from the picker
 * as the entire recursion guard — and the picker offered four kinds it then
 * refused to draw, which read as broken rather than as unfinished.
 *
 * The guard now lives in embed-chain.ts, where it is a cycle check over the
 * ancestor chain plus a depth cap, rather than a whole kind being unavailable.
 *
 * Listed rather than derived, so adding a View kind is a deliberate decision to
 * make it embeddable and not something that happens by accident.
 */
export const EMBEDDABLE_VIEW_KINDS: readonly ViewKind[] = [
  "slots",
  "dashboard",
  "stage",
  "transcription",
  "custom",
  "script",
];
```

Leave `isEmbeddableViewKind` as it is. Replace `isOfferableInEmbedPicker`'s body and docblock:

```ts
/** Offered in the embed picker. Every kind renders now, so the picker no longer
 *  needs to offer kinds it cannot draw — the two lists are the same list. */
export function isOfferableInEmbedPicker(kind: ViewKind): boolean {
  return isEmbeddableViewKind(kind);
}
```

- [ ] **Step 2: Write the failing test**

Create `renderer/main/embedded-view.test.tsx`:

```tsx
// Every kind draws something, and a cycle draws a notice instead of hanging.
//
// Rendered, not reasoned about: the failure this guards is a box that renders
// nothing, or renders for ever. Neither shows up in a unit test over the pieces.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

// jsdom ships neither, and both are reached by a render: useStageState opens the
// state stream, and several views fetch on mount.
class StubEventSource {
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;
(globalThis as unknown as { fetch: unknown }).fetch = async () =>
  ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });

const { render, screen, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { EmbeddedView } = await import("./embedded-view.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => cleanup());
afterEach(async () => { cleanup(); await settle(); });

function ctxWith(embedChain: string[]) {
  return {
    state: { views: [], outputs: [], captionChannelColors: {}, slotsByView: {}, slotsByLayoutObject: {} },
    propresenter: null, propInstances: [], pcoLive: null, planItems: null,
    transcript: [], spl: null, obs: null, reaper: null, resi: null, youtube: null,
    osc: null, peopleCount: null, serviceLow: null, serviceAttendance: null,
    servicePeak: null, servicePeakAttendance: null, baptism: null,
    serviceTimeline: null, integrations: {}, integrationLabels: {}, wireless: [],
    now: 0, skewMs: 0, ndiSource: null, H: 1080, placed: undefined,
    home: false, interactive: false, embedChain,
  } as never;
}

const view = (kind: string, id = "v-1") => ({ id, name: "Test view", kind, layout: { objects: [] } }) as never;

describe("a cycle is refused, not rendered", () => {
  test("a view already above this one draws a NOTICE", () => {
    // Without this the render recurses until the tab dies — on a wall display
    // with nobody standing next to it.
    render(React.createElement(EmbeddedView, { view: view("custom", "v-1"), ctx: ctxWith(["v-1"]) } as never));
    assert.ok(screen.getByText(/cannot contain itself/i), "a self-embed did not draw a notice");
  });

  test("past the depth cap draws a notice", () => {
    render(React.createElement(EmbeddedView, { view: view("custom", "v-9"), ctx: ctxWith(["a", "b", "c"]) } as never));
    assert.ok(screen.getByText(/nested more than/i), "unbounded nesting was allowed");
  });
});

describe("every kind draws something", () => {
  for (const kind of ["slots", "dashboard", "stage", "transcription", "custom", "script"]) {
    test(`${kind} is not an empty box`, () => {
      const { container } = render(
        React.createElement(EmbeddedView, { view: view(kind), ctx: ctxWith([]) } as never),
      );
      // Not asserting WHAT it drew — each kind is its own component with its own
      // tests. Asserting that the embed reached one at all, which is exactly what
      // four kinds failed to do before this.
      assert.ok(
        (container.textContent ?? "").trim().length > 0 || container.querySelector("div, svg"),
        `a ${kind} view rendered an empty box`,
      );
      assert.equal(
        (container.textContent ?? "").includes("not embeddable yet"),
        false,
        `a ${kind} view still says it is not embeddable`,
      );
      cleanup();
    });
  }
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx tsx --test renderer/main/embedded-view.test.tsx`
Expected: FAIL — `Cannot find module './embedded-view.js'`.

- [ ] **Step 4: Write the component**

Create `renderer/main/embedded-view.tsx`:

```tsx
// One View, drawn inside a box, whatever kind it is.
//
// ONE component, called by both `view-embed` and `screen-embed`, because two
// copies would drift into two answers to "does a dashboard render in a tile" —
// and the whole point of a producer multiview is that every tile behaves the
// same.
//
// A custom view is the interesting case: it is the only kind holding a layout,
// so it is drawn with the SAME RenderObject a real display uses, at a scaled H.
// Nothing about it is a preview or an approximation; it is the display's own
// code path with a smaller canvas height.

import type { LayoutRenderCtx } from "./layout-renderer";
import { RenderObject } from "./layout-renderer";
import type { View } from "@main/types/views";
import { childChain, embedRefusal } from "./embed-chain";
import { ScriptView } from "./script-view";
import { DashboardView } from "./dashboard-view";
import { StageDisplayView } from "./stage-display-view";
import { TranscriptionView } from "./transcription-view";
import { SlotsForView } from "./slots-for-view";

export function EmbeddedView({
  view,
  ctx,
  displayId,
  showHeader = false,
  autoScroll = true,
}: {
  view: View;
  ctx: LayoutRenderCtx;
  /** Present when the embed is a SCREEN — dashboard and stage kinds are
   *  configured per display, so they need the id the tile came from. */
  displayId?: string | null;
  showHeader?: boolean;
  autoScroll?: boolean;
}) {
  const notice = (text: string) => (
    <div className="flex h-full items-center justify-center px-3 text-center text-caption1 text-fg-subtle">
      {text}
    </div>
  );

  const refusal = embedRefusal(view.id, ctx.embedChain);
  if (refusal) return notice(refusal.message);

  switch (view.kind) {
    case "script":
      return (
        <ScriptView
          scriptViewLayoutId={view.scriptViewLayoutId ?? null}
          showHeader={showHeader}
          textSizeClass=""
          autoScroll={autoScroll}
        />
      );

    case "slots":
      return <SlotsForView viewId={view.id} ctx={ctx} />;

    case "transcription":
      // h-full, not the route's 100dvh — see transcription-view.tsx.
      return <TranscriptionView displayId={displayId ?? null} />;

    case "dashboard":
      // Configured per DISPLAY, not per view. Without a display id there is
      // nothing to read the configuration from, and saying so beats drawing an
      // empty box the operator has to guess about.
      return displayId
        ? <DashboardView displayId={displayId} />
        : notice("A dashboard is set up per screen — embed the screen instead");

    case "stage":
      return displayId
        ? <StageDisplayView displayId={displayId} />
        : notice("A stage view is set up per screen — embed the screen instead");

    case "custom": {
      const objects = [...(view.layout?.objects ?? [])]
        .filter((o) => !o.hidden)
        .sort((a, b) => a.z - b.z);
      if (objects.length === 0) return notice(`"${view.name}" has nothing on it yet`);

      // The child's own context: this view pushed onto the chain, and an H
      // scaled to the box. Objects position by PERCENTAGE, so x/y/w/h need no
      // conversion — only the font/spacing basis does.
      //
      // `placed` is dropped deliberately. It is a map of pixel placements keyed
      // by the PARENT layout's object ids; a child layout's objects are not in
      // it, and carrying it would be a map nothing can hit that still has to be
      // reasoned about at every read.
      const childCtx: LayoutRenderCtx = {
        ...ctx,
        embedChain: childChain(view.id, ctx.embedChain),
        placed: undefined,
      };

      return (
        <div className="relative h-full w-full overflow-hidden">
          {objects.map((o) => (
            <RenderObject key={o.id} o={o} ctx={childCtx} />
          ))}
        </div>
      );
    }

    default: {
      // Exhaustive: a new ViewKind is a compile error here rather than a blank
      // tile discovered on a Sunday.
      const never: never = view.kind;
      void never;
      return notice("Unknown view kind");
    }
  }
}
```

- [ ] **Step 5: Extract `SlotsForView` from the existing slots-grid case**

The `slots-grid` case in `renderer/main/layout-renderer.tsx` (near line 967) already resolves a view's slots and renders them. Move the *view-sourced* half into `renderer/main/slots-for-view.tsx` and have both the `slots-grid` case and `EmbeddedView` call it. Do not copy it — this repository's most expensive recurring mistake is fixing one copy of a thing that exists in several.

Create `renderer/main/slots-for-view.tsx`:

```tsx
// A slots View's grid, drawn from the state broadcast.
//
// Pulled out of layout-renderer's `slots-grid` case so the embed and the object
// share it. They were about to be two copies of the same resolution rules —
// which slots, which layout, what to draw when there are none — and this repo
// has paid for that pattern more than once.

import type { LayoutRenderCtx } from "./layout-renderer";
import { SlotsGrid } from "./slots-grid";

export function SlotsForView({ viewId, ctx }: { viewId: string; ctx: LayoutRenderCtx }) {
  const slots = ctx.state.slotsByView?.[viewId] ?? [];
  const slotsLayout = ctx.state.views?.find((v) => v.id === viewId)?.slotsLayout ?? null;

  if (slots.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-caption1 text-fg-subtle">
        No mic slots on this view
      </div>
    );
  }
  return <SlotsGrid slots={slots} layout={slotsLayout} />;
}
```

Then in `layout-renderer.tsx`'s `slots-grid` case, replace the view-sourced branch's rendering with `<SlotsForView viewId={c.sourceViewId} ctx={ctx} />`, leaving the inline branch as it is. Confirm the exact props `SlotsGrid` takes by reading the existing case before writing this — the names above must match what is already there.

- [ ] **Step 6: Point `view-embed` at the new component**

In `layout-renderer.tsx`, replace the body of `ViewEmbedObject` after its `if (!view)` guard with:

```tsx
  return (
    <div className="h-full w-full" style={{ fontSize: `${(o.style?.fontSize ?? EMBED_FONT_FRACTION) * ctx.H}px` }}>
      <EmbeddedView
        view={view}
        ctx={ctx}
        showHeader={config.showHeader ?? false}
        autoScroll={config.autoScroll ?? true}
      />
    </div>
  );
```

Keep the existing comment explaining why the wrapper is `w-full h-full` rather than the object's alignment, and why the font size is set here — both are still true and both were learned from bugs.

- [ ] **Step 7: Run the tests**

Run: `npx tsx --test renderer/main/embedded-view.test.tsx`
Expected: PASS, 8 tests.

Run: `npm test` — expect green. `renderer/main/layout-objects.test.ts` asserts on `EMBEDDABLE_VIEW_KINDS`; update the expected list there to the six kinds and keep the assertion exact rather than a floor.

- [ ] **Step 8: Prove the cycle guard fails on the bug it guards**

In `embedded-view.tsx`, temporarily delete the two lines:

```tsx
  const refusal = embedRefusal(view.id, ctx.embedChain);
  if (refusal) return notice(refusal.message);
```

Run: `npx tsx --test renderer/main/embedded-view.test.tsx`
Expected: FAIL on both cycle tests. Restore, re-run, PASS. Say so in the commit.

- [ ] **Step 9: Commit**

```bash
git add renderer/main/embedded-view.tsx renderer/main/embedded-view.test.tsx renderer/main/slots-for-view.tsx renderer/main/layout-renderer.tsx renderer/main/layout-objects.ts renderer/main/layout-objects.test.ts
git commit -m "feat(layout): an embedded view renders whatever kind it is

The picker offered five kinds and drew one; the other four said \"not
embeddable yet\", which reads as broken rather than unfinished. All six kinds
draw now, through ONE component both embed objects call.

A custom view is drawn with the same RenderObject a real display uses, at an H
scaled to the box -- not a preview of the layout, the layout.

Slots resolution moved to slots-for-view.tsx and is called by both the
slots-grid object and the embed, rather than copied.

Proven red: deleting the refusal check fails both cycle tests."
```

---

## Task 4: The Embedded screen object

**Files:**
- Modify: `main/types/views.ts` (config union, near line 551)
- Modify: `renderer/main/layout-objects.ts` (registry)
- Modify: `main/types/object-capabilities.ts`
- Modify: `main/services/view-refs.ts` (near line 55)
- Modify: `renderer/editor/inspector.tsx`
- Modify: `renderer/editor/palette.tsx`
- Modify: `renderer/main/layout-renderer.tsx` (new case)
- Create: `renderer/main/screen-embed.test.tsx`

**Interfaces:**
- Consumes: `EmbeddedView` (Task 3); `onlineFromState` from `renderer/app/home/cards` — already imported by `layout-renderer.tsx`.
- Produces: config `{ type: "screen-embed"; outputId: string | null; showLabel?: boolean; showStatus?: boolean }`

- [ ] **Step 1: Add the config member**

In `main/types/views.ts`, beside the `view-embed` member:

```ts
  | {
      /**
       * A SCREEN, not a view: shows whatever that display is currently routed
       * to, and follows it when somebody changes the routing mid-service.
       *
       * The producer primitive. A view-embed pins one view for ever, which is
       * right for a fixed reference panel and wrong for "what is on that screen
       * right now". It is also the only way dashboard and stage kinds can be
       * embedded at all, because both are configured per display.
       */
      type: "screen-embed";
      outputId: string | null;
      /** The screen's name across the top of the tile. */
      showLabel?: boolean;
      /** A dot: connected, dark, or blacked out. */
      showStatus?: boolean;
    }
```

- [ ] **Step 2: Register it**

In `renderer/main/layout-objects.ts`, beside `view-embed`:

```ts
  "screen-embed": {
    label: "Embedded screen",
    blurb: "What another screen is showing, live",
    group: "PCO / service",
    config: () => ({ type: "screen-embed", outputId: null, showLabel: true, showStatus: true }),
    style: () => ({ fontSize: EMBED_FONT_FRACTION }),
    homeSize: "m",
  },
```

Match the surrounding entries' exact shape — read two neighbours before writing this, because the registry's `style` and optional keys differ per entry and a mismatch is a compile error rather than a silent one.

In `main/types/object-capabilities.ts`, beside `"view-embed": ["readout"]`:

```ts
  // Readout on a wall. On a control surface it also drills through to the screen
  // it is showing — see the expand overlay.
  "screen-embed": ["readout"],
```

In `main/services/view-refs.ts`, extend the `embed` expression so export/import carries the reference:

```ts
      const embed =
        type === "view-embed" ? str(c.viewId)
        : type === "slots-grid" && c.source === "view" ? str(c.sourceViewId)
        : "";
```

A `screen-embed` points at an OUTPUT, not a view, so it adds nothing to this expression. Instead, add a comment there recording why, so the next person does not spend the afternoon deciding it was an oversight:

```ts
      // `screen-embed` is deliberately absent: it references an OUTPUT, and an
      // output's routed view is already walked from the outputs list. Adding its
      // outputId here would put a non-view id into a list of view ids.
```

- [ ] **Step 3: Write the failing test**

Create `renderer/main/screen-embed.test.tsx`, with the same `installDom` + stub preamble as `embedded-view.test.tsx` (copy it verbatim — the two files are independent and a shared harness module is not worth the indirection for eight lines), then:

```tsx
describe("a screen tile", () => {
  test("shows the view the screen is CURRENTLY routed to", () => {
    const ctx = ctxWith([]);
    ctx.state.outputs = [{ id: "out-1", name: "Left Display", viewId: "v-1" }];
    ctx.state.views = [{ id: "v-1", name: "Slots A", kind: "slots", layout: { objects: [] } }];
    const { container } = render(
      React.createElement(ObjectContent, {
        o: { id: "o1", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "screen-embed", outputId: "out-1", showLabel: true }, style: {} },
        ctx,
      } as never),
    );
    assert.ok(container.textContent?.includes("Left Display"), "the tile did not name the screen");
  });

  test("says so when the screen is not routed anywhere", () => {
    const ctx = ctxWith([]);
    ctx.state.outputs = [{ id: "out-1", name: "Left Display", viewId: null }];
    const { container } = render(
      React.createElement(ObjectContent, {
        o: { id: "o1", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "screen-embed", outputId: "out-1" }, style: {} },
        ctx,
      } as never),
    );
    assert.match(container.textContent ?? "", /not showing anything|no view/i);
  });

  test("says so when the screen is blacked out, rather than drawing the view", () => {
    // A blacked-out screen shows black. A tile that draws the routed view anyway
    // tells a producer the opposite of what the room can see.
    const ctx = ctxWith([]);
    ctx.state.outputs = [{ id: "out-1", name: "Left Display", viewId: "v-1", blackout: true }];
    ctx.state.views = [{ id: "v-1", name: "Slots A", kind: "slots", layout: { objects: [] } }];
    const { container } = render(
      React.createElement(ObjectContent, {
        o: { id: "o1", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "screen-embed", outputId: "out-1" }, style: {} },
        ctx,
      } as never),
    );
    assert.match(container.textContent ?? "", /blackout/i);
  });

  test("says so when the screen was deleted", () => {
    const ctx = ctxWith([]);
    ctx.state.outputs = [];
    const { container } = render(
      React.createElement(ObjectContent, {
        o: { id: "o1", x: 0, y: 0, w: 1, h: 1, z: 1, config: { type: "screen-embed", outputId: "gone" }, style: {} },
        ctx,
      } as never),
    );
    assert.match(container.textContent ?? "", /no longer exists/i);
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `npx tsx --test renderer/main/screen-embed.test.tsx`
Expected: FAIL — the `screen-embed` case does not exist, so `ObjectContent` falls through.

- [ ] **Step 5: Write the renderer case**

In `renderer/main/layout-renderer.tsx`, beside the `view-embed` case:

```tsx
    case "screen-embed":
      return <ScreenEmbedObject o={o} config={c} ctx={ctx} />;
```

And the component, beside `ViewEmbedObject`:

```tsx
/**
 * What another screen is showing, right now.
 *
 * Resolves output -> its routed view -> EmbeddedView, so it follows a routing
 * change without anyone touching this layout. That is the whole difference from
 * view-embed, and it is why this is the object a producer wall is built from.
 *
 * Each not-showing state is NAMED. A tile that draws an empty box for "unrouted"
 * and an empty box for "deleted" and an empty box for "blacked out" is three
 * different problems wearing one face, at the moment somebody is trying to work
 * out what is wrong with a screen.
 */
function ScreenEmbedObject({
  o,
  config,
  ctx,
}: {
  o: LayoutObject;
  config: Extract<LayoutObjectConfig, { type: "screen-embed" }>;
  ctx: LayoutRenderCtx;
}) {
  const output = config.outputId ? ctx.state.outputs?.find((x) => x.id === config.outputId) ?? null : null;
  const view = output?.viewId ? ctx.state.views?.find((v) => v.id === output.viewId) ?? null : null;
  const online = output ? onlineFromState(ctx.state).includes(output.id) : false;

  const notice = (text: string) => (
    <div className="flex h-full items-center justify-center px-3 text-center text-caption1 text-fg-subtle">
      {text}
    </div>
  );

  const body = !config.outputId
    ? notice("Pick a screen to show")
    : !output
      ? notice("That screen no longer exists")
      : output.blackout
        ? notice("Blackout")
        : !view
          ? notice(`"${output.name}" is not showing anything`)
          : <EmbeddedView view={view} ctx={ctx} displayId={output.id} />;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      style={{ fontSize: `${(o.style?.fontSize ?? EMBED_FONT_FRACTION) * ctx.H}px` }}
    >
      {config.showLabel !== false && output && (
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
          {config.showStatus !== false && (
            <span
              className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-live-9" : "bg-fg-faint")}
              aria-label={online ? "Connected" : "Not connected"}
            />
          )}
          <span className="truncate text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
            {output.name}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
```

- [ ] **Step 6: Add the inspector controls**

In `renderer/editor/inspector.tsx`, beside the `view-embed` block:

```tsx
      {c.type === "screen-embed" && (
        <RowSelect
          label="Screen"
          hint="Shows whatever this screen is showing, and follows it when the routing changes."
          value={c.outputId ?? ""}
          options={[
            { value: "", label: "None" },
            ...(stageState.outputs ?? []).map((out) => ({ value: out.id, label: out.name })),
          ]}
          onChange={(v) => onConfig({ ...c, outputId: v || null })}
        />
      )}
      {c.type === "screen-embed" && c.outputId && (
        <RowSwitch
          label="Show the screen's name"
          checked={c.showLabel ?? true}
          onChange={(v) => onConfig({ ...c, showLabel: v })}
        />
      )}
      {c.type === "screen-embed" && c.outputId && (
        <RowSwitch
          label="Show a connected dot"
          hint="Green when that screen has a browser attached, grey when nothing is showing it."
          checked={c.showStatus ?? true}
          onChange={(v) => onConfig({ ...c, showStatus: v })}
        />
      )}
```

Confirm how the inspector already reaches `stageState` before writing this — if it is not in scope in that component, thread it the same way `embedViews` is threaded for the view picker rather than adding a new hook call.

Correct the `view-embed` picker's now-false hint in the same pass:

```tsx
            hint="Renders that view's content here, natively. Every kind works; pick a screen instead if you want to follow what a display is showing."
```

In `renderer/editor/palette.tsx`, beside `"view-embed": FrameIcon`:

```tsx
  "screen-embed": MonitorIcon,
```

Add `MonitorIcon` to that file's existing `lucide-react` import.

- [ ] **Step 7: Run the tests**

Run: `npx tsx --test renderer/main/screen-embed.test.tsx` — expect PASS, 4 tests.
Run: `npm test` — expect green. Two registry guards will fail until updated on purpose: `renderer/main/layout-objects.test.ts` counts registry entries, and `main/services/config-snapshot.test.ts` is unaffected. Update the count deliberately and keep it EXACT.

- [ ] **Step 8: Prove the blackout guard fails on the bug it guards**

Temporarily remove the `output.blackout ? notice("Blackout") :` branch.

Run: `npx tsx --test renderer/main/screen-embed.test.tsx`
Expected: FAIL on "says so when the screen is blacked out". Restore, re-run, PASS.

- [ ] **Step 9: Commit**

```bash
git add main/types/views.ts main/types/object-capabilities.ts main/services/view-refs.ts renderer/main/layout-objects.ts renderer/main/layout-renderer.tsx renderer/editor/inspector.tsx renderer/editor/palette.tsx renderer/main/screen-embed.test.tsx renderer/main/layout-objects.test.ts
git commit -m "feat(layout): an Embedded screen object shows what a display is showing

Resolves output -> routed view -> EmbeddedView, so it follows a routing change
without anyone touching the layout. That is the difference from view-embed,
which pins one view for ever, and it is the only way dashboard and stage kinds
can be embedded at all -- both are configured per display.

Every not-showing state is named: unrouted, deleted, blackout. Three empty
boxes would be three different problems wearing one face, at the moment
somebody is working out what is wrong with a screen.

Proven red: removing the blackout branch fails its test."
```

---

## Task 5: Tap a tile to expand it, Escape to come back

**Files:**
- Create: `renderer/main/expand-overlay.tsx`
- Create: `renderer/main/expand-overlay.test.tsx`
- Modify: `renderer/main/layout-renderer.tsx` (both embed components)

**Interfaces:**
- Consumes: `LayoutRenderCtx.interactive` — already the flag that separates the operator's surfaces from a wall.
- Produces: `function useExpand(): { expanded: boolean; open: () => void; close: () => void; tileRef; overlay: (content: ReactNode, title: string) => ReactNode }`

**Design note for the implementer:** the overlay is a portal to `document.body`, animated from the tile's own rect with FLIP. There is no navigation, which is what makes "back" trivial — you never left the page. `renderer/app/home/home-grid.tsx`'s `useSlideOnMove` is this repository's existing FLIP; read it and follow its shape rather than inventing a second one.

- [ ] **Step 1: Write the failing test**

Create `renderer/main/expand-overlay.test.tsx` with the same `installDom` + stub preamble as the other two, then:

```tsx
describe("expanding a tile", () => {
  test("a wall display cannot expand anything", () => {
    // The rule: a wall runs the kiosk router and nobody is standing next to it.
    // An overlay opened by a passer-by stays open until somebody walks over.
    const { container } = renderTile({ interactive: false });
    assert.equal(container.querySelector("button"), null, "a wall tile offered a control");
  });

  test("a control surface CAN, and opens an overlay", () => {
    const { container } = renderTile({ interactive: true });
    const btn = container.querySelector("button");
    assert.ok(btn, "no way to expand the tile");
    fireEvent.click(btn);
    assert.ok(document.querySelector("[data-expand-overlay]"), "clicking did not open anything");
  });

  test("ESCAPE closes it", () => {
    const { container } = renderTile({ interactive: true });
    fireEvent.click(container.querySelector("button"));
    fireEvent.keyDown(document, { key: "Escape" });
    assert.equal(document.querySelector("[data-expand-overlay]"), null, "Escape did not close the overlay");
  });

  test("there is a visible way back, not only a key", () => {
    // Somebody on a touchscreen has no Escape key. A control surface is a
    // touchscreen more often than not.
    const { container } = renderTile({ interactive: true });
    fireEvent.click(container.querySelector("button"));
    const back = document.querySelector("[data-expand-overlay] button");
    assert.ok(back, "the only way out of the overlay was the keyboard");
    fireEvent.click(back);
    assert.equal(document.querySelector("[data-expand-overlay]"), null);
  });

  test("names what is expanded, so a wall of tiles is not ambiguous", () => {
    const { container } = renderTile({ interactive: true, title: "Left Display" });
    fireEvent.click(container.querySelector("button"));
    assert.ok(
      document.querySelector("[data-expand-overlay]")?.textContent?.includes("Left Display"),
      "the overlay did not say which tile it came from",
    );
  });
});
```

Write `renderTile` in that file as a small helper rendering a `screen-embed` through `ObjectContent` with the given ctx flags and an output named by `title`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test renderer/main/expand-overlay.test.tsx`
Expected: FAIL — no button exists on the tile yet.

- [ ] **Step 3: Write the overlay**

Create `renderer/main/expand-overlay.tsx`:

```tsx
// Tap a tile, it grows to fill the screen. Escape, or the back control, and it
// goes home.
//
// A PORTAL AND NO NAVIGATION, and that pairing is the design. Routing to the
// display would work and would then need a way back that survives a reload, a
// deep link, and somebody's muscle memory for the browser's back button. An
// overlay never leaves the page, so "back" is closing it — there is nothing to
// restore because nothing was lost.
//
// FLIP, the same technique home-grid uses to slide cards: measure the tile,
// apply the inverse transform so the overlay starts exactly on top of it, then
// release it on the next frame and let a transition carry it out. Without it the
// overlay appears instantly at full size and reads as the page having jumped
// somewhere, which is the thing an animation is here to prevent.
//
// Interactive surfaces only. A wall display gets no control at all — not a
// disabled one — because an overlay opened by a passer-by in the auditorium
// stays open until somebody walks over and closes it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";

const OPEN_MS = 260;

export function useExpand(enabled: boolean) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  const close = useCallback(() => setExpanded(false), []);
  const open = useCallback(() => { if (enabled) setExpanded(true); }, [enabled]);

  // Escape, plus a real control in the overlay. Both, because a control surface
  // is a touchscreen more often than not and has no Escape key at all.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, close]);

  // FLIP: start on the tile, end filling the screen.
  useLayoutEffect(() => {
    if (!expanded) return;
    const panel = panelRef.current;
    const from = tileRef.current?.getBoundingClientRect();
    if (!panel || !from) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduced) return;

    const to = panel.getBoundingClientRect();
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const sx = from.width / Math.max(1, to.width);
    const sy = from.height / Math.max(1, to.height);

    panel.style.transformOrigin = "top left";
    panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    panel.style.transition = "none";

    const id = requestAnimationFrame(() => {
      panel.style.transition = `transform ${OPEN_MS}ms cubic-bezier(0.2, 0.6, 0.2, 1)`;
      panel.style.transform = "none";
    });
    return () => cancelAnimationFrame(id);
  }, [expanded]);

  function overlay(content: ReactNode, title: string): ReactNode {
    if (!expanded) return null;
    return createPortal(
      <div
        data-expand-overlay=""
        className="fixed inset-0 z-[200] flex flex-col bg-bg/95 backdrop-blur-sm"
        onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      >
        <div ref={panelRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
            <span className="truncate text-caption1 font-semibold uppercase tracking-wider text-fg-subtle">
              {title}
            </span>
            <button
              type="button"
              onClick={close}
              aria-label={`Close ${title}`}
              className="ml-auto rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <XIcon className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1">{content}</div>
        </div>
      </div>,
      document.body,
    );
  }

  return { expanded, open, close, tileRef, overlay };
}
```

- [ ] **Step 4: Wire it into both embed components**

In `ScreenEmbedObject` and `ViewEmbedObject`, wrap the rendered body:

```tsx
  const { open, tileRef, overlay } = useExpand(ctx.interactive);
```

Put `ref={tileRef}` on the outer wrapper. When `ctx.interactive`, wrap the body in a button that fills the tile and calls `open()`; when not, render the body bare with **no** control at all. Then render `{overlay(body, title)}` after it, where `title` is the screen's name for a screen tile and the view's name for a view tile.

Do not nest interactive elements: if the embedded content itself contains controls, the expand affordance must be a sibling overlay button (`absolute inset-0`) rather than a `<button>` wrapping them. This repository has shipped the nested-button bug twice — an outer button swallowed the click and navigated.

- [ ] **Step 5: Run the tests**

Run: `npx tsx --test renderer/main/expand-overlay.test.tsx` — expect PASS, 5 tests.
Run: `npm test`, `npx tsc --noEmit -p tsconfig.json`, `npx eslint main/ renderer/` — all clean.

- [ ] **Step 6: Prove the wall guard fails on the bug it guards**

Change `useExpand(ctx.interactive)` to `useExpand(true)` in `ScreenEmbedObject`.

Run: `npx tsx --test renderer/main/expand-overlay.test.tsx`
Expected: FAIL on "a wall display cannot expand anything". Restore, re-run, PASS.

- [ ] **Step 7: Drive the real thing**

A control that renders is not a control that does anything.

```bash
npm run build
SCRATCH=$(mktemp -d)
STAGE_UTILITY_DATA="$SCRATCH" STAGE_UTILITY_PORT=8799 npx tsx server.ts &
```

Then, in a browser at `http://localhost:8799`: create two screens, create a custom view, add two Embedded screen objects pointing at them, and confirm each tile draws the screen's content and name. Tap one — it expands with the animation. Press Escape — it collapses. Tap it again, press the back control — it collapses. Open the same layout on a display route and confirm tapping a tile does nothing at all.

Kill the server **by port**, never `pkill -f` on the env prefix: `lsof -ti tcp:8799 | xargs -r kill -9`.

- [ ] **Step 8: Commit**

```bash
git add renderer/main/expand-overlay.tsx renderer/main/expand-overlay.test.tsx renderer/main/layout-renderer.tsx
git commit -m "feat(layout): tap a tile to expand it, Escape or the control to come back

A portal overlay with a FLIP transition, and no navigation -- which is what
makes coming back trivial. Routing to the display would have needed a way back
that survives a reload, a deep link and the browser's back button; an overlay
never leaves the page, so there is nothing to restore.

Escape AND a visible control, because a control surface is a touchscreen more
often than not and has no Escape key.

Interactive surfaces only, and a wall gets no control at all rather than a
disabled one: an overlay opened by a passer-by stays open until somebody walks
over. Proven red -- hardcoding it enabled fails the wall test."
```

---

## Task 6: Docs

**Files:**
- Modify: `docs/reference/widgets.md`
- Modify: `docs/reference/layout-editor.md`

- [ ] **Step 1: Widgets table**

In `docs/reference/widgets.md`, correct the `Embedded view` row and add the new one:

```markdown
| **Embedded view** | One specific view, drawn inside this one — every kind | This app |
| **Embedded screen** | What another screen is showing right now, following its routing | This app |
```

- [ ] **Step 2: A section on multiviews**

Add to `docs/reference/layout-editor.md`:

```markdown
## Multiviews

A custom view filled with **Embedded screen** objects is a producer overview: one
tile per screen, each showing what that screen is showing, updating when somebody
changes the routing.

**Embedded screen** follows a display. **Embedded view** pins one view wherever it
is routed — right for a fixed reference panel, wrong for "what is on that screen".
Dashboard and stage views can only be embedded as a screen, because both are
configured per display rather than per view.

On a control surface, tapping a tile expands it to fill the screen; Escape or the
close control brings you back. On a wall display, tiles are not tappable at all.

Views may be nested three deep, and a view cannot contain itself — a tile that
would loop draws a notice saying so instead.
```

- [ ] **Step 3: Verify and commit**

Run `npm run build` and `npm test` once more; both clean.

```bash
git add docs/reference/widgets.md docs/reference/layout-editor.md
git commit -m "docs: multiviews, and what the two embed objects are for"
```

---

## Self-Review

**Spec coverage.** Both objects (Tasks 3, 4) — asked for, both built. Clickable with an animation and an easy way back (Task 5) — overlay, FLIP, Escape plus a visible control. Every view and display embeddable (Tasks 3, 4) — all six kinds, with dashboard/stage reachable through the screen object that carries the display id they need. Recursion (Tasks 1, 2) — chain plus cap, replacing the old kind-exclusion.

**Placeholders.** None: every step carries the code it needs. Three steps deliberately say *read the existing code before writing* (the `SlotsGrid` props in Task 3 Step 5, the registry entry shape in Task 4 Step 2, the inspector's `stageState` scope in Task 4 Step 6). Those are not placeholders — the surrounding code is the source of truth for names this plan should not guess at, and guessing them would be the worse failure.

**Type consistency.** `embedChain` is the field name in Tasks 2, 3, 4, 5. `EmbeddedView` takes `{ view, ctx, displayId?, showHeader?, autoScroll? }` in Task 3 and is called with exactly those in Tasks 3 and 4. `embedRefusal` / `childChain` / `MAX_EMBED_DEPTH` are defined in Task 1 and used under those names in Task 3. `screen-embed` config is `{ outputId, showLabel?, showStatus? }` in Tasks 4 and 5.

**Known risk, flagged rather than hidden.** Task 3 Step 5 moves the slots resolution out of `layout-renderer.tsx`. That case reads `slotsByLayoutObject` for inline grids and `slotsByView` for view-sourced ones, and its comment explains a real bug about avatar cropping per object. The extraction must take only the **view-sourced** half; if it turns out the two halves cannot be separated cleanly, call `SlotsGrid` from the embed directly and leave the `slots-grid` case untouched rather than forcing a refactor that risks the crop behaviour.
