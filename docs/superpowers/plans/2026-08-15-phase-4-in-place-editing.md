# Phase 4 — In-place editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Edit a console where it lives — the console renders normally and the editing chrome overlays it — instead of opening a separate editor page.

**Architecture:** Mostly decomposition. Object rendering has never been duplicated: `layout-editor.tsx` already imports `ObjectContent`, `boxStyle`, `useLayoutData` and `LayoutRenderCtx` from `layout-renderer.tsx`, so WYSIWYG is already true and this is a smaller change than 3,333 lines suggests. That file splits into canvas, palette, inspector and toolbar; the only genuinely new piece is mounting edit mode over a live console route.

**Tech Stack:** TypeScript, React 19, TanStack Router, dnd-kit, node:test.

## Dependency

Branches off **Phase 3** (#261). Task 3 mounts edit mode on a console route, and
consoles only exist from Phase 3; Task 5 reads `View.surface` and `Output.mode`
to decide where chrome may mount. Do not start before #261 merges to `beta`.

## Global Constraints

- **No feature is dropped without a stated reason or a named replacement.** This
  phase ships a feature parity inventory (below). The editor is 3,333 lines of
  accumulated behaviour — marquee select, multi-select, clipboard, nudge,
  alignment, layer reorder, container nesting, canvas presets. A split that
  loses one of these is a regression however clean the result looks.
- **A guard must fail on the bug it guards.** Delete the guard or reintroduce
  the bug and watch it go red in-session; say so in the commit.
- **Prefer a check the type system enforces, or one that runs the real code
  path**, over one that reads source text.
- **A new `catch` either rethrows or returns the failure to its caller.**
- **No emojis** anywhere: UI, code, comments, commit messages, PR bodies.
- **Fix a repeated pattern everywhere at once**; say in the commit how many were
  found and how many changed.
- Numeric fields use the themed `NumberInput`, never a raw `<input type="number">`.
- **A pure move is a pure move.** Task 1 and Task 2 must not change behaviour.
  Any behaviour change belongs in a later task where it can be reviewed as one.

---

## File structure

`renderer/settings/sections/layout-editor.tsx` (3,333 lines) becomes:

| File | Responsibility |
|---|---|
| `renderer/editor/layout-editor.tsx` | The shell: state, save/conflict handling, composition. The public `LayoutEditor` stays this name and keeps its props. |
| `renderer/editor/editor-canvas.tsx` | Canvas, drag/resize/marquee, drop targets, overlay nodes. |
| `renderer/editor/inspector.tsx` | The right-hand panel and its per-type config editors. |
| `renderer/editor/inspector-rows.tsx` | `Row`, `RowSwitch`, `RowText`, `RowNumber`, `RowToggle`, `RowSelect`, `NumberField`, `PixelField` — shared form primitives. |
| `renderer/editor/palette.tsx` | The object palette and its grouping. |
| `renderer/editor/layout-templates.ts` | `dashboardTemplate`, `confidenceMonitorTemplate`, canvas presets. |
| `renderer/editor/edit-mode.tsx` | **New.** Mounts the editing chrome over a live console route. |
| `renderer/editor/console-fit.ts` | **New.** Which fit a surface uses, as one testable decision. |

The directory is `renderer/editor/`, not `renderer/settings/sections/`: it was
only ever there because that was its bundle, and settings no longer is one.

---

## Task 1: Move the editor, unchanged

**Files:** move `renderer/settings/sections/layout-editor.tsx` → `renderer/editor/layout-editor.tsx`; update 2 importers.

**Interfaces:**
- Produces: the same exports at a new path — `LayoutEditor`, `dashboardTemplate`, `confidenceMonitorTemplate`, `reorderLayerScope`.

- [ ] **Step 1: Find every importer.** `grep -rn "layout-editor" renderer/` — expect `view-detail.tsx` and `new-view-dialog.tsx`. Say the count in the commit.

- [ ] **Step 2: `git mv`** the file, then update those imports. Nothing else changes: not a line of the body.

- [ ] **Step 3: Prove it is a pure move.**

```bash
git show HEAD:renderer/settings/sections/layout-editor.tsx > /tmp/before.tsx
diff /tmp/before.tsx renderer/editor/layout-editor.tsx && echo "IDENTICAL"
```

Expected: `IDENTICAL`. If it prints anything else, something was changed that
was not meant to be — revert and redo. A move that quietly edits is a move
nobody can review.

- [ ] **Step 4:** `npm run type-check`, `npm run lint`, `npm test`. Read the output.

- [ ] **Step 5: Commit** — `refactor(editor): move the layout editor into its own directory`

---

## Task 2: Split the editor

**Files:** create the five files above from `layout-editor.tsx`.

**Interfaces:**
- `EditorCanvas` consumes: `objects`, `selection`, `onChange`, `ctx: LayoutRenderCtx`, and the drag/resize callbacks it already takes internally.
- `Inspector` consumes: the selected object(s) and `onConfig`/`onStyle` callbacks.
- Everything the shell already passes internally stays the same shape — this is extraction, not redesign.

Splitting a 3,333-line file is where behaviour goes missing quietly. The
protection is a parity list written BEFORE the split and checked after.

- [ ] **Step 1: Write the behaviour inventory first**, in `renderer/editor/README.md`, by reading the file — not from memory:

```
marquee select, shift-add to selection, multi-select drag, multi-select align,
clipboard copy/paste with fresh ids, delete, nudge (arrow keys, shift = coarse),
layer reorder within scope, container nesting to MAX_DEPTH, drop-into-container,
canvas presets, style presets, per-type config editors, hide-unconfigured toggle,
lock, hidden, elevation, conflict-detected save
```

- [ ] **Step 2: Extract in the order that minimises churn** — templates, then
  inspector rows, then palette, then inspector, then canvas. Each extraction is
  its own commit, and each one ends with type-check + lint + tests green.

- [ ] **Step 3: After each extraction, diff the behaviour list.** Anything that
  moved must still be reachable from the shell. This is the parity inventory
  doing its job mid-task rather than at the end.

- [ ] **Step 4: Write the guard.** A test that the shell still composes every
  part, so a future extraction cannot orphan one:

```ts
// The split is the risk: an extracted part that nothing renders is a feature
// that silently left. This is the same orphan shape wired.test.ts already
// guards for handlers, applied to the editor's own pieces.
const PARTS = ["EditorCanvas", "Inspector", "Palette", "EditorToolbar"];
for (const part of PARTS) {
  test(`${part} is rendered by the editor shell`, () => {
    assert.match(shellSource, new RegExp(`<${part}\\b`), `${part} is imported but never rendered`);
  });
}
```

- [ ] **Step 5: Prove it** — delete one `<Inspector …/>` from the shell, watch that test go red, restore.

- [ ] **Step 6: Human check.** Open the editor on a real custom view and exercise every line of the inventory. A control that renders is not a control that does anything.

- [ ] **Step 7: Commit** each extraction separately.

---

## Task 3: Edit mode on a console route

**Files:** create `renderer/editor/edit-mode.tsx`; modify the console route.

**Interfaces:**
- Consumes: `LayoutEditor`'s parts, `viewSurface`, `outputMode`, `capabilityLive`.
- Produces: `<EditMode view={…} onExit={…}>` wrapping a live console.

The only genuinely new piece. The console renders normally; the chrome overlays.

- [ ] **Step 1: Write the failing test** — the decision, not the markup:

```ts
test("edit mode is available on a console in the shell", () => {
  assert.equal(canEditInPlace({ surface: "console" }, "shell"), true);
});

test("edit mode is NOT available on a panel", () => {
  // A panel is pinned to a wall. Whoever is standing at it must not be able to
  // rearrange it.
  assert.equal(canEditInPlace({ surface: "console" }, "panel"), false);
});

test("edit mode is NOT available on a wall display", () => {
  assert.equal(canEditInPlace({ surface: "display" }, "display"), false);
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** `layoutEditingLive(ctx)` already exists from Phase 3 — reuse it rather than writing a second rule. `canEditInPlace` is that plus "the view is a console".

- [ ] **Step 4: Mount the chrome.** Editing state lives in the route, not the URL: entering edit mode must not create a history entry, because Back should leave the console rather than step through edit toggles.

- [ ] **Step 5: Prove the gate.** Make `canEditInPlace` return true unconditionally, watch the panel and display tests go red, restore.

- [ ] **Step 6: Drive the real server.** Open a console in the shell, enter edit mode, move an object, save, and confirm the change is on the panel showing that view. Then open the same view as a panel and confirm no chrome appears at all — not merely that the buttons are disabled.

- [ ] **Step 7: Commit** — `feat(editor): edit a console where it lives`

---

## Task 4: A responsive fit, replacing `fill`

**Files:** create `renderer/main/responsive-layout.ts`; modify `main/types/views.ts`,
`renderer/main/layout-renderer.tsx`, the editor's canvas controls and inspector.

**Interfaces:**
- Produces: `resolveLayout(objects, canvas, viewport): PlacedObject[]` — pure, the whole decision in one testable function.
- Produces: `fitFor(view, explicit): "contain" | "responsive"`.

### Why this replaces `fill` rather than joining it

`fill` is not a transform stretch — objects are fractional and fonts are
fractions of the live window height, so **text already does not distort**. What
breaks is everything else: a square tile becomes a wide rectangle, a row of
three across becomes three slivers on a tall window, and a layout built on a
laptop is unusable on a phone. Proportional reflow is the whole of its
responsiveness, and that is not enough.

Nothing in the real config uses `fill` today — every layout is `contain` — so
replacing it costs no migration. A stored `fit: "fill"` still parses and is read
as `responsive`, for any install that did set it.

### The model

Four mechanisms, smallest first. Each is independently useful, and the first
alone already beats `fill`.

1. **Anchors.** Each object may pin edges: `left`, `right`, `top`, `bottom`, or
   `center` per axis. Unpinned edges stay proportional, which is exactly today's
   behaviour — so the default is a no-op and an untouched layout renders as it
   does now. An object pinned right stays the same distance from the right edge
   instead of drifting.

2. **Keep aspect.** An object may declare its box keeps the design's aspect,
   scaling uniformly inside the space it is given rather than stretching. Right
   for logos, slide thumbnails, NDI video and anything with a natural shape.

3. **Size clamps.** Optional min/max in real pixels, so a control cannot shrink
   below a tappable size on a small window nor balloon on a 4K wall.

4. **Stacking.** When the viewport deviates far enough from the design shape —
   or is genuinely narrow — top-level objects reflow into a single column in
   reading order (top-to-bottom, then left-to-right). This is the part that makes
   a console built on a laptop usable on a phone, and it is the only mechanism
   that changes the arrangement rather than the arithmetic.

- [ ] **Step 1: Write the failing tests.** Pure function, so the whole model is
  testable without rendering:

```ts
const CANVAS = { width: 1920, height: 1080 };
const obj = (over) => ({ id: "o", x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 0, config: { type: "text" }, ...over });

describe("responsive layout", () => {
  test("with no anchors it is exactly proportional — today's behaviour", () => {
    // The default must be a no-op, or every existing layout changes on upgrade.
    const [p] = resolveLayout([obj({})], CANVAS, { w: 1920, h: 1080 });
    assert.deepEqual([p.left, p.top, p.width, p.height], [192, 108, 384, 216]);
  });

  test("an object pinned right keeps its distance from the right edge", () => {
    const o = obj({ x: 0.7, w: 0.2, anchor: { x: "right" } });
    // design: right edge sits 0.1 * 1920 = 192px from the right
    const [p] = resolveLayout([o], CANVAS, { w: 1200, h: 1080 });
    assert.equal(Math.round(1200 - (p.left + p.width)), 192);
  });

  test("keepAspect scales uniformly instead of stretching", () => {
    const o = obj({ w: 0.2, h: 0.2, keepAspect: true });   // square in a 16:9 design
    const [p] = resolveLayout([o], CANVAS, { w: 3840, h: 1080 });
    assert.equal(Math.round(p.width), Math.round(p.height), "a square must stay square");
  });

  test("a size clamp stops a control shrinking below tappable", () => {
    const o = obj({ w: 0.1, minPx: { w: 44 } });
    const [p] = resolveLayout([o], CANVAS, { w: 320, h: 800 });
    assert.ok(p.width >= 44);
  });

  test("a narrow window stacks top-level objects into a column", () => {
    const a = obj({ id: "a", x: 0.05, y: 0.1, w: 0.4, h: 0.3 });
    const b = obj({ id: "b", x: 0.55, y: 0.1, w: 0.4, h: 0.3 });
    const placed = resolveLayout([a, b], CANVAS, { w: 390, h: 844 });
    assert.equal(placed[0].left, placed[1].left, "stacked objects share a left edge");
    assert.ok(placed[1].top >= placed[0].top + placed[0].height, "and do not overlap");
  });

  test("stacking order is reading order, not z order", () => {
    // z is paint order and says nothing about what should come first when read.
    const top = obj({ id: "top", y: 0.05, z: 9 });
    const bottom = obj({ id: "bottom", y: 0.6, z: 1 });
    const placed = resolveLayout([bottom, top], CANVAS, { w: 390, h: 844 });
    assert.deepEqual(placed.map((p) => p.id), ["top", "bottom"]);
  });

  test("a near-design viewport does NOT stack", () => {
    // Stacking is for genuinely different shapes. Triggering it on a slightly
    // narrow laptop would rearrange a layout the operator just built.
    const placed = resolveLayout([obj({ x: 0.05 }), obj({ id: "b", x: 0.55 })], CANVAS, { w: 1600, h: 1000 });
    assert.notEqual(placed[0].left, placed[1].left);
  });

  test("children of a container are placed within it, not the viewport", () => {
    // Nesting already exists; responsive must not flatten it.
    const parent = obj({ id: "p", x: 0.5, y: 0, w: 0.5, h: 1, config: { type: "container" },
      children: [obj({ id: "c", x: 0, y: 0, w: 1, h: 0.5 })] });
    const placed = resolveLayout([parent], CANVAS, { w: 1920, h: 1080 });
    const child = placed.find((p) => p.id === "c")!;
    assert.ok(child.left >= 960, "a child must stay inside its container");
  });
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `resolveLayout`.** Pure and viewport-in/pixels-out, so
  the editor and the kiosk cannot disagree about where anything goes.

- [ ] **Step 4: Schema.** `anchor`, `keepAspect`, `minPx`, `maxPx` are all
  OPTIONAL on `LayoutObject`, read through accessors that default to today's
  behaviour — the same pattern as Phase 3's `surface`, and for the same reason:
  an existing `views.json` must parse and render identically.

- [ ] **Step 5: `fit`.** `"fill"` is accepted on read and mapped to
  `"responsive"`; the editor offers Letterbox and Responsive. Say in the commit
  how many stored layouts used `fill` (zero in the real config, checked).

- [ ] **Step 6: Prove each mechanism.** Four separate proofs: neutralise anchors,
  `keepAspect`, clamps and stacking in turn, and watch the matching tests go red.

- [ ] **Step 7: The default is a no-op — prove it on real data.** Render every
  custom view in the real config at its design size with responsive on, and
  assert every object lands within a pixel of where `contain` puts it. A
  responsive mode that quietly moves existing layouts is a regression whatever
  it does at other sizes.

- [ ] **Step 8: Human check at real sizes.** 1440x900, 1920x1080, 390x844 and a
  deliberately silly 3840x600. Drive it, look at it.

- [ ] **Step 9: Commit** — `feat(layout): a responsive fit for consoles`

---

## Task 4b: Anchors and clamps in the inspector

**Files:** `renderer/editor/inspector.tsx`, `renderer/editor/inspector-rows.tsx`

A model nothing can configure is a model nobody uses — the third orphan of this
redesign would be a mechanism with no UI.

- [ ] **Step 1: Anchor control.** A nine-cell pin grid (the familiar
  springs-and-struts control), not two dropdowns: which edges are pinned is
  spatial information and reads faster as a picture.

- [ ] **Step 2: Keep-aspect toggle and min/max fields.** Numeric fields use the
  themed `NumberInput`, never a raw `<input type="number">`.

- [ ] **Step 3: A preview-shape control** in the editor toolbar, so a layout can
  be checked at phone/laptop/wall shapes without leaving it. This is what makes
  the model usable rather than theoretical.

- [ ] **Step 4: Guard.** Extend the editor composition test so an anchor control
  that stops being rendered fails.

- [ ] **Step 5: Human check** — set an anchor, switch preview shape, watch it
  hold. Then save and confirm the real screen agrees with the preview.

- [ ] **Step 6: Commit** — `feat(editor): configure anchors, aspect and size limits`

---

## Task 5: Chrome never mounts where it must not

**Files:** test only, plus whatever the test finds.

The design doc states this as a hard rule, so it gets a test that runs the real
render rather than reading source.

- [ ] **Step 1: Write the test** — render a layout in each context and assert the chrome's absence:

```tsx
test("no editing chrome on a display Output", () => {
  const { queryByRole } = render(<StageView … outputMode="display" />);
  assert.equal(queryByRole("toolbar", { name: /editor/i }), null);
  assert.equal(queryByRole("button", { name: /add object/i }), null);
});
```

- [ ] **Step 2: Run it. If it passes immediately, make it fail** by mounting the chrome unconditionally, confirm it goes red, and restore — otherwise it is a test that has never demonstrated it can fail.

- [ ] **Step 3: Commit** — `test(editor): editing chrome cannot reach a wall screen`

---

## Task 6: Whole-branch verification and PR

- [ ] **Step 1:** type-check, lint, full suite. Read the output in-session.
- [ ] **Step 2:** Build, then verify `built == served` asset hash before browser-testing.
- [ ] **Step 3:** Three review passes — correctness, simplification, whole-PR.
- [ ] **Step 4:** Re-run the parity inventory and mark each row verified against the running app.
- [ ] **Step 5:** Browser-verify at 1440px and 390px.
- [ ] **Step 6:** Open the PR. Do not merge it.

---

## Feature parity inventory

| Feature | Today | Disposition |
|---|---|---|
| Editor at `/screens/:id/edit` | A full-page route | **Carried.** In-place editing is an addition, not a replacement: a full page is still the right place to build a display's layout, which has no console to overlay. |
| Every editing behaviour (marquee, multi-select, clipboard, nudge, align, layers, nesting, presets) | One 3,333-line file | **Carried, split.** Task 2 writes the inventory before splitting and checks it after; the composition guard stops a part being orphaned later. |
| WYSIWYG | Editor imports the renderer's object components | **Carried unchanged.** Never duplicated, so nothing to preserve deliberately. |
| Conflict detection (`View.rev`) | Editor returns the revision it opened | **Carried unchanged.** Reused as-is; a save built on a layout someone else replaced is still detected. |
| `fit: "contain"` on displays | Default for every view | **Carried.** Still the default for displays; only consoles change. |
| `fit: "fill"` | Proportional reflow, no letterbox | **Replaced by `responsive`.** Proportional reflow was the whole of its responsiveness: a square tile became a wide rectangle and a row of three became three slivers on a tall window. `fill` is still accepted on read and maps to `responsive`. Nothing in the real config used it. |
| Every existing layout's arrangement | Fractional, proportional | **Carried, byte-for-byte.** Anchors, keep-aspect and clamps are all optional and default to today's behaviour, and Task 4 Step 7 asserts every object in the real config lands within a pixel of where it does now. |
| An explicit `fit` set on a layout | Honoured | **Carried.** A default never overrides a deliberate choice. |
| Editing on a panel | n/a | **Deliberately absent**, as in Phase 3: a panel pinned to a wall must not be rearrangeable by whoever stands at it. |
| Editing on a wall display | n/a | **Deliberately absent.** Task 5 tests the absence rather than assuming it. |

---

## Self-review

**Spec coverage.** Section 5's relocation → Task 1; the split → Task 2; edit mode
on a console route → Task 3; conflict detection reused → parity inventory, and
Task 2 must not touch it; chrome never mounting on display/panel → Task 5;
console sizing → Tasks 4 and 4b.

**Type consistency.** `canEditInPlace` (Task 3) and `fitFor` (Task 4) are used by
those names in their tests and nowhere else yet. `layoutEditingLive` and
`capabilityLive` come from Phase 3's `render-context.ts` and are reused rather
than reimplemented.

**Deliberately not here.** Section 6 — resize behaviours across all 38 object
types, live reflow during drag, snapping and alignment guides, the default-look
styling pass, motion tokens. That is Phase 5, and the design doc separates them
for a reason: Phase 4 puts the existing editor where it belongs, Phase 5 makes it
feel right. Mixing them would mean reviewing a move and a redesign as one diff.

**Scope note.** Task 4 grew: a genuinely responsive fit is anchors, aspect
preservation, size clamps and stacking, plus the UI to configure them — schema,
renderer and editor. It is bigger than the "consoles default to fill" it
replaces, and is split into 4 and 4b so the model and its UI can be reviewed
separately. Said plainly because a task that quietly triples is how a phase
stops being reviewable.

**Known risk.** Task 2 is the dangerous one. 3,333 lines is enough that a
mechanical extraction can drop a callback and only fail on an interaction nobody
retested. Hence: extract in small commits, write the inventory before starting,
and drive every item on it in Step 6 rather than trusting the type checker.
