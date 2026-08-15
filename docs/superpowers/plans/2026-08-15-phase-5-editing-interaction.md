# Phase 5 — Editing interaction and object polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the layout editor feel like a design tool rather than a form that
happens to draw rectangles — and make every one of the 38 object types survive
any shape it is given.

**Architecture:** Four independent pieces, each landing on its own. Alignment is
a new pure module beside `layout-geometry.ts`, on the same fractions-in,
fractions-out contract. The responsive preview reuses `resolveLayout` unchanged —
the editor and the kiosk must never disagree about where anything lands, so the
preview calls the same function the display does. The resize audit is a test
first and a pile of small fixes second. Motion is tokens plus a sweep.

**Tech Stack:** React, existing dnd-free pointer handlers, `node:test` + jsdom.

## Global Constraints

- No emojis anywhere: UI, code, comments, commit messages, PR bodies.
- Every guard ships with proof: reintroduce the bug, watch the test go red, say
  so in the commit.
- A repeated pattern is fixed everywhere at once; the commit says how many
  instances were found and how many changed.
- No feature is removed without a stated reason or a named replacement. The
  parity inventory at the end of this plan is part of the deliverable.
- New `catch` blocks rethrow or return the failure. None may only log.
- Numeric fields use the themed `NumberInput`, never raw `<input type="number">`.
- Dark surfaces stay strictly R=G=B neutral. No purple, no blue-biased darks.
- Docs are updated in the same PR as the code that changes them.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/editor/alignment.ts` (new) | Pure snapping: dragged rect + siblings → snapped rect + guides to draw |
| `renderer/editor/alignment.test.ts` (new) | Snap maths, including the cases grid snap gets wrong |
| `renderer/editor/alignment-guides.tsx` (new) | Draws the guide lines and equal-gap badges over the canvas |
| `renderer/editor/preview-shape.tsx` (new) | The shape switcher and its read-only resolved canvas |
| `renderer/editor/layout-editor.tsx` | Wires alignment into the drag path; hosts the shape switcher |
| `renderer/editor/inspector.tsx` | "Reset to default look" action |
| `renderer/main/layout-objects.ts` | The `defaultStyle` pass across 38 types |
| `renderer/main/object-resize.test.tsx` (new) | Every type rendered at extreme shapes |
| `renderer/styles/motion.css` (new) | Duration and easing tokens |
| `docs/reference/layout-editor.md` | Documents snapping, preview shapes, reset |

---

### Task 1: Alignment snapping and guides

Grid snap already exists (`snapRectToGrid`, a 96-cell square grid) and stays. It
answers "line this up with the grid". It cannot answer "line this up with *that*
object", which is what an operator actually wants when a row of tiles must share
a top edge.

**Files:**
- Create: `renderer/editor/alignment.ts`, `renderer/editor/alignment.test.ts`,
  `renderer/editor/alignment-guides.tsx`
- Modify: `renderer/editor/layout-editor.tsx` (drag path)

**Interfaces:**

```ts
export interface Guide {
  axis: "x" | "y";
  /** Canvas-space fraction where the line is drawn. */
  at: number;
  /** Rects that share this line, so the guide spans only them. */
  span: { from: number; to: number };
  kind: "edge" | "center" | "gap";
}

export interface AlignResult {
  rect: FracRect;
  guides: Guide[];
}

/**
 * Snap `moving` to its siblings and the canvas.
 *
 * `tolerancePx` is converted to fractions per axis by the caller's box size, so
 * the pull is the same visual distance whatever the canvas shape.
 */
export function alignRect(
  moving: FracRect,
  siblings: readonly FracRect[],
  box: { w: number; h: number },
  tolerancePx: number,
  resizing: boolean,
): AlignResult;
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { alignRect } from "./alignment.js";

const BOX = { w: 1920, h: 1080 };
const TOL = 8;

describe("alignment snapping", () => {
  test("a left edge within tolerance snaps to a sibling's left edge", () => {
    const sib = { x: 0.2, y: 0.1, w: 0.2, h: 0.2 };
    const moving = { x: 0.2 + 3 / BOX.w, y: 0.5, w: 0.2, h: 0.2 };
    const { rect, guides } = alignRect(moving, [sib], BOX, TOL, false);
    assert.equal(rect.x, 0.2, "snapped to the sibling's left edge");
    assert.ok(guides.some((g) => g.axis === "x" && g.kind === "edge"));
  });

  test("centres snap to centres", () => {
    const sib = { x: 0.4, y: 0.1, w: 0.2, h: 0.2 };   // centre 0.5
    const moving = { x: 0.35 + 2 / BOX.w, y: 0.6, w: 0.3, h: 0.2 }; // centre ~0.5
    const { rect } = alignRect(moving, [sib], BOX, TOL, false);
    assert.ok(Math.abs(rect.x + rect.w / 2 - 0.5) < 1e-9, "centres aligned");
  });

  test("beyond tolerance nothing moves and no guide is drawn", () => {
    const sib = { x: 0.2, y: 0.1, w: 0.2, h: 0.2 };
    const moving = { x: 0.4, y: 0.5, w: 0.2, h: 0.2 };
    const { rect, guides } = alignRect(moving, [sib], BOX, TOL, false);
    assert.deepEqual(rect, moving, "an object far from anything must not jump");
    assert.equal(guides.length, 0);
  });

  test("snapping is symmetric in pixels, not fractions", () => {
    // 8px is 8px on both axes. A fraction tolerance would make the pull on a
    // 1080-tall canvas nearly twice as strong vertically as horizontally.
    const sib = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    const nearX = { x: 0.5 + 6 / BOX.w, y: 0.2, w: 0.1, h: 0.1 };
    const nearY = { x: 0.2, y: 0.5 + 6 / BOX.h, w: 0.1, h: 0.1 };
    assert.equal(alignRect(nearX, [sib], BOX, TOL, false).rect.x, 0.5);
    assert.equal(alignRect(nearY, [sib], BOX, TOL, false).rect.y, 0.5);
  });

  test("resizing snaps the dragged edge, never the anchored one", () => {
    // The bug this guards: snapping the whole rect during a resize drags the
    // opposite edge along, so the object creeps instead of growing.
    const sib = { x: 0.6, y: 0.1, w: 0.2, h: 0.2 };
    const moving = { x: 0.2, y: 0.1, w: 0.4 + 3 / BOX.w, h: 0.2 };
    const { rect } = alignRect(moving, [sib], BOX, TOL, true);
    assert.equal(rect.x, 0.2, "the left edge must not move while resizing east");
    assert.ok(Math.abs(rect.x + rect.w - 0.6) < 1e-9, "the right edge snapped");
  });

  test("equal gaps between three objects are detected", () => {
    const a = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
    const b = { x: 0.3, y: 0.1, w: 0.1, h: 0.1 };   // gap 0.1
    const moving = { x: 0.5 + 2 / BOX.w, y: 0.1, w: 0.1, h: 0.1 };
    const { rect, guides } = alignRect(moving, [a, b], BOX, TOL, false);
    assert.ok(Math.abs(rect.x - 0.5) < 1e-9, "third object lands on an equal gap");
    assert.ok(guides.some((g) => g.kind === "gap"));
  });
});
```

- [ ] **Step 2: Run and watch every one fail**

Run: `npx tsx --test renderer/editor/alignment.test.ts`
Expected: FAIL, "alignRect is not a function".

- [ ] **Step 3: Implement `alignment.ts`**

Candidate lines per axis: each sibling's near edge, far edge and centre, plus the
canvas's 0, 0.5 and 1. Pick the single closest candidate within tolerance per
axis. During a resize, only the edges the handle moves are candidates, and the
result is rebuilt from the anchored edge — never by translating the rect.

Equal-gap: for the moving rect's axis, sort siblings, measure existing gaps, and
offer positions that repeat the most common gap.

- [ ] **Step 4: Run the tests, all green**

- [ ] **Step 5: Prove the guards**

Break `alignRect` so resizing snaps the whole rect (translate instead of rebuild)
and confirm the resize test goes red. Change the tolerance to fractions and
confirm the symmetry test goes red. Restore both. Record in the commit.

- [ ] **Step 6: Draw the guides**

`alignment-guides.tsx` renders each `Guide` as a 1px line spanning only the
objects that share it, plus a small badge on `gap` guides. Lines use the accent
token at low alpha; they are decoration and take no pointer events.

- [ ] **Step 7: Wire into the drag path**

In `layout-editor.tsx`, alignment runs after grid snap when the grid is on, and
alone when it is off — grid first, then alignment refines. Holding a modifier
suppresses both, so an operator can always place something exactly.

- [ ] **Step 8: Drive it in a browser**

Two objects on a real canvas, dragged near each other. Confirm the guide appears,
the object snaps, the modifier suppresses it, and a resize grows rather than
creeps. Screenshot each.

- [ ] **Step 9: Commit**

---

### Task 2: Preview shapes

Phase 4 built the responsive model and Phase 4's inspector configures it, but the
only way to see the result is to open the display and resize the window. The
editor should answer "what does this look like on the panel" without leaving it.

The design doc calls this "live reflow during drag". Reflow during a drag is the
wrong shape for the problem: objects are absolutely placed, so dragging one does
not move the others, and the thing an operator cannot currently see is the
*other viewport*, not the other objects. This task delivers that instead. See
the parity inventory.

**Files:**
- Create: `renderer/editor/preview-shape.tsx`
- Modify: `renderer/editor/layout-editor.tsx`

- [ ] **Step 1: The switcher**

Four shapes beside the existing fit control: **Design** (the canvas as authored,
the only editable one), **Panel** (1024x768), **Phone** (390x844), **Ultrawide**
(3840x1080). Design is selected by default and nothing changes for an operator
who never touches it.

- [ ] **Step 2: Render the preview through `resolveLayout`**

The non-Design shapes render the same `LayoutRenderer` path the kiosk uses, at
that viewport, read-only — no overlay, no handles, no drag. It must call
`resolveLayout`, not reimplement placement.

- [ ] **Step 3: Guard that it is the same function**

```ts
test("the preview places objects exactly where the display does", () => {
  const vp = { w: 390, h: 844 };
  const fromEditor = previewPlacements(LAYOUT, vp);
  const fromDisplay = resolveLayout(LAYOUT.objects, LAYOUT.canvas, vp);
  assert.deepEqual(fromEditor, fromDisplay,
    "editor and kiosk must never disagree about where an object lands");
});
```

Prove it: make the preview add 1px of padding and watch this go red.

- [ ] **Step 4: Show what stacking will do**

At Phone, `shouldStack` returns true for most designs. Label the preview so the
operator knows the rearrangement is deliberate, not a bug: a caption reading
"Stacked into one column — this shape is too different from the design to keep
the arrangement."

- [ ] **Step 5: Browser check, screenshot each of the four shapes**

- [ ] **Step 6: Commit**

---

### Task 3: Every object type survives any shape

38 types. Some have never been rendered at 40px tall.

**Files:**
- Create: `renderer/main/object-resize.test.tsx`
- Modify: whichever object renderers the test finds broken

- [ ] **Step 1: Write the sweep**

```tsx
// Enumerated from the capability registry, so a new type joins this sweep by
// existing. A hand-written list would go stale the first time someone adds an
// object and does not think about resizing.
const TYPES = Object.keys(OBJECT_CAPABILITIES) as LayoutObjectType[];

const SHAPES = [
  { w: 40,   h: 40,   label: "tiny" },
  { w: 1000, h: 40,   label: "a sliver" },
  { w: 40,   h: 1000, label: "a column" },
  { w: 3840, h: 2160, label: "4K" },
];

for (const type of TYPES) {
  for (const shape of SHAPES) {
    test(`${type} at ${shape.label}`, () => {
      const el = renderObject(type, shape);
      assert.ok(!hasOverflow(el), `${type} overflows its box at ${shape.label}`);
      assert.ok(!hasNaNStyle(el), `${type} computed a NaN style at ${shape.label}`);
      assert.ok(isReadable(el), `${type} rendered nothing legible at ${shape.label}`);
    });
  }
}
```

- [ ] **Step 2: Assert the count, exactly**

```ts
test("the sweep covers every type", () => {
  // An exact count, not a floor. A floor with slack is how three config stores
  // went missing from every backup with the suite green.
  assert.equal(TYPES.length, 38);
});
```

- [ ] **Step 3: Run it and record the failures**

Expected: a list. Write it into the task notes before fixing anything, so the
commit can say how many were broken and how many were fixed.

- [ ] **Step 4: Fix them**

Group by cause rather than by type — if six objects clip because they all assume
a two-line label fits, that is one fix in a shared component, not six.

- [ ] **Step 5: Re-run, all green, and prove one guard**

Reintroduce the most representative clipping bug and watch its test go red.

- [ ] **Step 6: Commit, saying how many were found and fixed**

---

### Task 4: Default look, and getting back to it

**Files:**
- Modify: `renderer/main/layout-objects.ts` (`defaultStyle`),
  `renderer/editor/inspector.tsx`

- [ ] **Step 1: Audit `defaultStyle` for all 38 types**

A freshly added object should look finished. Record every type whose default is
unstyled or wrong before changing any of them.

- [ ] **Step 2: Add "Reset to default look"**

In the inspector's style section. It clears the object's `style` back to
`defaultStyle(type)` and leaves geometry, config and responsive settings alone.

- [ ] **Step 3: Guard that it resets style only**

```ts
test("reset restores the look without moving or reconfiguring the object", () => {
  const o = { ...OBJ, x: 0.3, style: { color: "#ff0000" },
              config: { type: "clock", showSeconds: false },
              anchor: { x: "right" }, keepAspect: true };
  const r = resetLook(o);
  assert.deepEqual(r.style, defaultStyle("clock"));
  assert.equal(r.x, 0.3, "geometry untouched");
  assert.equal(r.config.showSeconds, false, "configuration untouched");
  assert.deepEqual(r.anchor, { x: "right" }, "responsive settings untouched");
  assert.equal(r.keepAspect, true);
});
```

Prove it: make `resetLook` spread over the whole object and watch this go red.

- [ ] **Step 4: Confirm it is undoable**

Reset is destructive to hand-tuned styling. Verify it lands in the editor's
existing undo stack; if it does not, that is part of this task.

- [ ] **Step 5: Commit**

---

### Task 5: Motion tokens

**Files:**
- Create: `renderer/styles/motion.css`
- Modify: the interactions this redesign added

- [ ] **Step 1: Define the tokens**

Three durations (instant/quick/settled) and two easings. Nothing else — a
motion system with nine durations is a motion system nobody uses consistently.

- [ ] **Step 2: Apply them**

Rail hover, screen-card hover, the preview expand overlay, dialogs, toasts,
guide lines. Motion conveys state; it never decorates.

- [ ] **Step 3: `motion-reduce` throughout**

- [ ] **Step 4: Guard that every transition uses a token**

A scan that walks the tree and matches on the *declaration*, not on prose:
`transition-duration` with a literal value rather than `var(--motion-*)` fails.
Prove it by hard-coding `180ms` somewhere and watching it go red.

- [ ] **Step 5: Commit**

---

## Feature parity inventory

Nothing in this phase removes an operator-facing capability.

| Existing behaviour | After Phase 5 | Note |
|---|---|---|
| 96-cell square grid snap | Unchanged | Alignment refines it; both can be on |
| Snap all / snap-to-grid actions | Unchanged | Untouched by this phase |
| Free placement with the grid off | Unchanged | Alignment also suppressible by modifier |
| Hand-tuned object styling | Unchanged | Reset is an explicit action, never automatic |
| Letterbox / Responsive fit | Unchanged | Preview shapes are read-only and change nothing stored |
| Editing at the design shape | Unchanged | Only Design is editable; the others are previews |

**Deliberately not built:** reflow of sibling objects during a drag, named in the
design doc as "live reflow during drag". Objects are absolutely placed, so
dragging one does not move the others — there is nothing to reflow. The problem
it was reaching for, seeing the layout at another shape without leaving the
editor, is Task 2. Stated here rather than dropped silently.

## Open questions for the maintainer

1. **Stacking threshold.** 2560x800 currently stacks. Carried over from Phase 4
   and still unresolved; the preview in Task 2 makes it visible, which may be
   enough to settle it either way.
2. **Min/max height.** Phase 4 exposes width clamps only. Adding height is
   cheap; leaving it out keeps the inspector shorter.
