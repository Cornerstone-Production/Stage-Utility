# Phase 7 — Editor fixes, Home in its own tab, and widget variants

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.
> Steps use checkbox (`- [ ]`) syntax.
>
> **This document is the resume point.** If context was lost mid-phase, read
> "Where we are" first, then the task with the first unchecked step.

---

## Where we are (2026-08-16)

**Branch:** `feat/phase-6` — Phases 5 and 6 are stacked on it, unmerged.
**Dev server:** port 8799, running against the LIVE config `~/.stage-utility`.
Rebuild and restart it after each task so the maintainer can review.

| PR | What | State |
|---|---|---|
| #267 | Phase 5 — editing interaction and object polish | open |
| #268 | Phase 6 plan | open |
| #269 | destructive actions red, not amber | open |

**Phase 6 shipped:** object blurbs for all 43 types, the widget palette with
drag-to-place, draw-to-create (Shift gesture pending — see Task 2), the layout
lock, Home's cards as objects, Home seeded as a View.

**Phase 6 was partly reverted (1a21e7e).** The style and config culls are undone;
every control is back and `boxStyle` honours the style fields again. Kept: text
sizes itself to its box and grows as well as shrinks.

**Why the revert matters for this phase:** the cull was right in principle and
wrong in sequence. A knob may only be removed once the widget is good enough not
to need it — which is what Task 6 (variants) exists to make true. Nothing is
culled again until its widget has variants.

---

## The decision this phase rests on

Two things get called "customisation" and they are not the same:

| | What it is | Verdict |
|---|---|---|
| **Composition** | What is on the screen and where. A 32:9 wall, twelve mic slots, a specific arrangement | **The cornerstone. Never reduced.** |
| **Presentation** | How one widget renders inside its own box — weight, fill, radius, elevation | **Replaced by designed variants, one widget at a time.** |

MxU has neither and gets away with it because their widgets are excellent and
purpose-built. Stage Utility keeps composition and buys MxU-quality presentation
by making it designed rather than assembled.

**Settled with the maintainer:** widgets are made as rich and as designed as
possible, and **one widget set is used everywhere** — Home, consoles and stage
displays draw from the same set. A clock is a clock wherever it appears.

---

## Global Constraints

- No emojis anywhere.
- Every guard ships with proof: reintroduce the bug, watch it go red, say so.
- **Nothing existing changes behaviour unless the task says so.** The Add-object
  dropdown's contents, dragging, resizing and marquee all keep working.
- **No knob is removed until its widget has variants.** The Phase 6 revert is the
  standing reminder of what happens otherwise.
- New `catch` blocks rethrow or return the failure.
- Dark surfaces stay strictly R=G=B neutral. No purple.
- Motion uses the Phase 5 tokens; no literal durations.
- Docs updated in the same PR.

---

### Task 1: The canvas menu opens on right-click only

**Bug:** left-click on the canvas opens the add-widget context menu. It should be
right-click only; left-click selects or clears the selection as it always did.

**Files:** `renderer/editor/layout-editor.tsx`

- [ ] **Step 1:** Reproduce in a browser and note which handler fires.
- [ ] **Step 2:** Write the failing guard — the menu opens from `onContextMenu`
      and from no pointer-down path.

```ts
test("the canvas menu is bound to contextmenu, not to a click", () => {
  // The bug: a left-click path that also opens the menu means every attempt to
  // deselect pops a menu instead.
  assert.match(SRC, /onContextMenu=\{[^}]*openContextMenu/);
  assert.ok(!/onClick=\{[^}]*openContextMenu/.test(SRC));
  assert.ok(!/onPointerDown=\{[^}]*openContextMenu/.test(SRC));
});
```

- [ ] **Step 3:** Fix. **Step 4:** Prove the guard. **Step 5:** Browser check —
      left-click clears the selection, right-click opens the menu.
- [ ] **Step 6:** Commit.

---

### Task 2: Shift-drag draws; the Draw button goes

**Files:** `renderer/editor/layout-editor.tsx`

Draw mode currently needs a toolbar toggle. Shift is used for additive selection
on an OBJECT; on empty canvas it means nothing, so it is free there.

- [ ] **Step 1:** Guard first.

```ts
test("shift-drag on empty canvas draws; a plain drag still marquees", () => {
  // Both must remain true. Taking the plain drag would break marquee selection,
  // which this phase does not change.
  assert.match(SRC, /e\.shiftKey/, "the draw path keys off shift");
  assert.match(SRC, /setMarquee/, "the marquee path survives");
});
```

- [ ] **Step 2:** Route draw mode off `e.shiftKey` at pointer-down instead of the
      `drawMode` state. Remove the toolbar button and the state.
- [ ] **Step 3:** Prove — remove the shiftKey check, watch it go red.
- [ ] **Step 4:** Browser: shift-drag draws and opens the picker; plain drag
      marquees; shift-click on an object still extends the selection.
- [ ] **Step 5:** Commit.

---

### Task 3: One "Add object" button, three buttons gone

**Files:** `renderer/editor/layout-editor.tsx`

Today the toolbar carries an Add-object **dropdown**, a **Widgets** toggle and a
**filter** icon — three controls for one job.

Becomes: a single **Add object** button that opens the palette panel. The palette
is hidden until asked for. The dropdown, the Widgets toggle and the filter icon
all go; the filter's hide-unconfigured behaviour moves into the palette itself as
a small control in its header.

- [ ] **Step 1:** Guard that nothing is lost.

```ts
test("every type the dropdown offered is still reachable from the palette", () => {
  // The dropdown is gone; the SET it offered must not shrink with it.
  assert.deepEqual(paletteTypes().sort(), dropdownTypesBefore().sort());
});

test("hide-unconfigured survived the filter icon's removal", () => {
  assert.match(PALETTE_SRC, /hideUnconfigured|dimmed/);
});
```

- [ ] **Step 2:** Build. **Step 3:** Prove. **Step 4:** Browser: the button opens
      the palette, drag still places, the hide-unconfigured control still works.
- [ ] **Step 5:** Commit.

---

### Task 4: The right panel is resizable

**Files:** `renderer/editor/layout-editor.tsx`, and whatever the left rail uses

The left sidebar can already be dragged. The inspector cannot, and it is the panel
that most needs the room.

- [ ] **Step 1:** Find how the rail does it and REUSE that, rather than writing a
      second resizer. If it is not reusable, extract it so there is one.
- [ ] **Step 2:** Width persists per session, clamped to a usable range.
- [ ] **Step 3:** Guard: one resizer implementation, used twice.

```ts
test("there is one resize implementation, not two", () => {
  const defs = ALL_SRC.match(/function useResizablePanel\b/g) ?? [];
  assert.equal(defs.length, 1);
});
```

- [ ] **Step 4:** Prove. **Step 5:** Browser: drag the divider, reload, width holds.
- [ ] **Step 6:** Commit.

---

### Task 5: Screens in the rail returns to the grid

**Bug:** clicking **Screens** in the rail while editing a layout leaves you in the
editor. It should return to the grid of screens.

**Files:** `renderer/app/rail.tsx` or `destinations.tsx`

Likely cause: the rail marks a destination active by path PREFIX, so
`/screens/<id>/edit` is already "on" Screens and the link is a no-op to the
router. The fix is for the rail's Screens link to target `/screens` exactly.

- [ ] **Step 1:** Confirm the cause in a browser before changing anything.
- [ ] **Step 2:** Guard.

```ts
test("a rail link navigates to its own path, even from a child route", () => {
  // The bug: from /screens/x/edit, clicking Screens did nothing because the
  // link was already considered active.
  assert.equal(railTarget("/screens", "/screens/view-2/edit"), "/screens");
});
```

- [ ] **Step 3:** Fix. **Step 4:** Prove. **Step 5:** Browser: from the editor,
      click Screens, land on the grid. Check the same from Patch and ScriptView.
- [ ] **Step 6:** Commit.

---

### Task 6: Home edits in its own tab

**Files:** `renderer/app/home/*`, `main/services/home-view.ts`

Phase 6 made Home a View and sent you to `/screens/home/edit` to change it. Wrong
model: **Home does not need a canvas.** Nobody places pixels on a home dashboard —
it is a stack of cards you either want or you do not.

Home becomes:

- An **Edit** toggle in the tab itself. No redirect, no canvas, no inspector.
- In edit mode: each card gets a **show/hide** toggle and a **drag handle** to
  reorder. That is the whole editor.
- Home stops appearing in the Screens list — it is not a screen.
- The widgets are the SAME set as everywhere else (the settled decision), so a
  card added to Home is the same component a stage display would use.

- [ ] **Step 1:** Decide the storage. Home keeps a View record (it already exists
      and holds the object list), but its geometry is ignored — order and presence
      are what Home reads. Write this down in the file, because a layout whose x/y
      is meaningless will otherwise confuse the next person.
- [ ] **Step 2:** The in-tab editor: toggles and reordering only.
- [ ] **Step 3:** Guard.

```ts
test("Home does not appear in the Screens list", () => {
  assert.ok(!screensListViews().some((v) => v.id === HOME_VIEW_ID));
});

test("hiding a card is remembered, and it stays hidden across a restart", () => {
  // Same property as the Phase 6 seeding guard: what the operator removed
  // must not come back.
});

test("Home's widgets come from the shared registry", () => {
  // One widget set everywhere. A Home-only card would be the beginning of two.
  for (const t of homeCardTypes()) assert.ok(t in LAYOUT_OBJECTS);
});
```

- [ ] **Step 4:** Prove each. **Step 5:** Browser: toggle a card off, reorder,
      reload, restart the server. **Step 6:** Commit.

---

### Task 7: Widget variants — the long one

**Not part of the fixes.** Start only when Tasks 1-6 are merged and reviewed.

Each widget gets a small set of **named variants that answer different jobs**, not
cosmetic skins. A clock is three widgets sharing a name:

| Variant | Job |
|---|---|
| Big time | Read at thirty feet from a stage |
| Time + label | One tile in a dashboard grid |
| Time + date | A lobby screen |

Three designed choices replace ~8 style knobs and produce a better result,
because each was designed rather than assembled.

**Sequencing, deliberately incremental:**

- [ ] Do the **ten widgets actually in use** first, one commit each. Find them by
      reading the real config, not by guessing.
- [ ] A widget's style section shrinks **only after** it has variants, and shrinks
      to a variant picker — never to nothing.
- [ ] Stop whenever it stops being an improvement. This is a per-widget judgement,
      not a migration.

**The standing rule, learned the expensive way:** the knobs come out after the
replacement exists, never before. Auto-sizing then `fontSize` worked. The other
fifteen fields, removed first, had to be reverted.

---

## Feature parity inventory

| Today | After | Note |
|---|---|---|
| Add-object dropdown | **Replaced** | Add object button opens the palette; same set |
| Widgets toggle | **Removed** | The Add object button does this |
| Filter icon | **Replaced** | Hide-unconfigured moves into the palette header |
| Draw button | **Replaced** | Shift-drag on empty canvas |
| Left-click opens menu | **Fixed** | Right-click only; left-click selects |
| Marquee selection | Unchanged | Plain drag on empty canvas |
| Shift-click adds to selection | Unchanged | Shift only means "draw" on EMPTY canvas |
| Home at /screens/home/edit | **Replaced** | Edited in its own tab |
| Home in the Screens list | **Removed** | It is not a screen |
| Every style and config control | Unchanged | Restored by 1a21e7e; culled per widget only once variants exist |
