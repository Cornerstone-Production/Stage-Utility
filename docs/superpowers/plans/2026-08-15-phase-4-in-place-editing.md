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

## Task 4: Consoles default to fill

**Files:** create `renderer/editor/console-fit.ts`; modify the renderer's fit resolution.

- [ ] **Step 1: Write the failing test:**

```ts
test("a console fills the window", () => {
  // A 16:9 design pillar-boxed into a laptop window wastes most of the screen.
  assert.equal(fitFor({ surface: "console" }, undefined), "fill");
});

test("a display letterboxes, honouring the design", () => {
  // A wall screen has a known aspect; the design should be honoured exactly.
  assert.equal(fitFor({ surface: "display" }, undefined), "contain");
});

test("an explicit fit on the layout always wins", () => {
  // The operator set it deliberately; a default must not override a choice.
  assert.equal(fitFor({ surface: "console" }, "contain"), "contain");
  assert.equal(fitFor({ surface: "display" }, "fill"), "fill");
});
```

- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement** and wire into the renderer's canvas fit.
- [ ] **Step 4: Prove it** — invert the two defaults, watch both go red, restore.
- [ ] **Step 5: Human check** — open a console in a laptop-shaped window and confirm it uses the full area; open a display and confirm it still letterboxes.
- [ ] **Step 6: Commit** — `feat(editor): consoles fill the window, displays letterbox`

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
| An explicit `fit` set on a layout | Honoured | **Carried.** A default never overrides a deliberate choice. |
| Editing on a panel | n/a | **Deliberately absent**, as in Phase 3: a panel pinned to a wall must not be rearrangeable by whoever stands at it. |
| Editing on a wall display | n/a | **Deliberately absent.** Task 5 tests the absence rather than assuming it. |

---

## Self-review

**Spec coverage.** Section 5's relocation → Task 1; the split → Task 2; edit mode
on a console route → Task 3; conflict detection reused → parity inventory, and
Task 2 must not touch it; chrome never mounting on display/panel → Task 5;
console sizing → Task 4.

**Type consistency.** `canEditInPlace` (Task 3) and `fitFor` (Task 4) are used by
those names in their tests and nowhere else yet. `layoutEditingLive` and
`capabilityLive` come from Phase 3's `render-context.ts` and are reused rather
than reimplemented.

**Deliberately not here.** Section 6 — resize behaviours across all 38 object
types, live reflow during drag, snapping and alignment guides, the default-look
styling pass, motion tokens. That is Phase 5, and the design doc separates them
for a reason: Phase 4 puts the existing editor where it belongs, Phase 5 makes it
feel right. Mixing them would mean reviewing a move and a redesign as one diff.

**Known risk.** Task 2 is the dangerous one. 3,333 lines is enough that a
mechanical extraction can drop a callback and only fail on an interaction nobody
retested. Hence: extract in small commits, write the inventory before starting,
and drive every item on it in Step 6 rather than trusting the type checker.
