# Phase 7 — Editor fixes, Home in its own tab, and widget variants

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.
> Steps use checkbox (`- [ ]`) syntax.
>
> **This document is the resume point.** If context was lost mid-phase, read
> "Where we are" first, then the task with the first unchecked step.

---

## Where we are (2026-08-16, end of session)

**Done this session:** the five toolbar/navigation fixes (221ebb4), the context
menu and page gutter (9ccb4ba), the Phase 6 revert (1a21e7e), the page gutter
done properly (6470e8c — the first pass fixed 3 of 13 places and doubled the
other 10), **Task 6, Home in its own tab (14165c9)**, and its review pass
(270afbb). Deployed to 8799.

**Next: Task 7 — the widgets, one by one.** Tasks 1 through 6 are complete.
Nothing else in this plan is outstanding.

**One thing to know before Task 7:** there are 45 object types now, not 43. Task 6
added `home-live-status` and `home-recent-services`, because Home drew four things
and only two of them were widgets. The three pinned counts are in
`object-catalog.test.ts`, `object-fit.test.ts` and `object-capabilities.test.ts`.

## Branch and PR state

**Branch:** `feat/phase-6` — Phases 5 and 6 are stacked on it, unmerged.
**Dev server:** port 8799, running against the LIVE config `~/.stage-utility`.
Rebuild and restart it after each task so the maintainer can review.

| PR | What | State |
|---|---|---|
| #267 | Phase 5 — editing interaction and object polish | open, awaiting the maintainer |
| #268 | Phase 6 plan | merged |
| #269 | destructive actions red, not amber | merged |

`feat/phase-6` CONTAINS #267's commits, so it has no PR of its own yet: opening
one against `beta` would duplicate a review that is already open. The order is
merge #267, then raise this branch. Pushed either way, so nothing is only local.

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

**DONE (221ebb4).** The menu was already right-click only; the real cause was
draw mode — with it armed, a plain click produced the minimum-size fallback rect
and opened the picker. A click that never moved now opens nothing.


**Bug:** left-click on the canvas opens the add-widget context menu. It should be
right-click only; left-click selects or clears the selection as it always did.

**Files:** `renderer/editor/layout-editor.tsx`

- [x] **Step 1:** Reproduce in a browser and note which handler fires.
- [x] **Step 2:** Write the failing guard — the menu opens from `onContextMenu`
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

- [x] **Step 3:** Fix. **Step 4:** Prove the guard. **Step 5:** Browser check —
      left-click clears the selection, right-click opens the menu.
- [x] **Step 6:** Commit.

---

### Task 2: Shift-drag draws; the Draw button goes

**DONE (221ebb4).** Shift-drag on empty canvas; button and mode removed.


**Files:** `renderer/editor/layout-editor.tsx`

Draw mode currently needs a toolbar toggle. Shift is used for additive selection
on an OBJECT; on empty canvas it means nothing, so it is free there.

- [x] **Step 1:** Guard first.

```ts
test("shift-drag on empty canvas draws; a plain drag still marquees", () => {
  // Both must remain true. Taking the plain drag would break marquee selection,
  // which this phase does not change.
  assert.match(SRC, /e\.shiftKey/, "the draw path keys off shift");
  assert.match(SRC, /setMarquee/, "the marquee path survives");
});
```

- [x] **Step 2:** Route draw mode off `e.shiftKey` at pointer-down instead of the
      `drawMode` state. Remove the toolbar button and the state.
- [x] **Step 3:** Prove — remove the shiftKey check, watch it go red.
- [x] **Step 4:** Browser: shift-drag draws and opens the picker; plain drag
      marquees; shift-click on an object still extends the selection.
- [x] **Step 5:** Commit.

---

### Task 3: One "Add object" button, three buttons gone

**DONE (221ebb4).** Palette starts hidden; hide-unconfigured moved into its header.


**Files:** `renderer/editor/layout-editor.tsx`

Today the toolbar carries an Add-object **dropdown**, a **Widgets** toggle and a
**filter** icon — three controls for one job.

Becomes: a single **Add object** button that opens the palette panel. The palette
is hidden until asked for. The dropdown, the Widgets toggle and the filter icon
all go; the filter's hide-unconfigured behaviour moves into the palette itself as
a small control in its header.

- [x] **Step 1:** Guard that nothing is lost.

```ts
test("every type the dropdown offered is still reachable from the palette", () => {
  // The dropdown is gone; the SET it offered must not shrink with it.
  assert.deepEqual(paletteTypes().sort(), dropdownTypesBefore().sort());
});

test("hide-unconfigured survived the filter icon's removal", () => {
  assert.match(PALETTE_SRC, /hideUnconfigured|dimmed/);
});
```

- [x] **Step 2:** Build. **Step 3:** Prove. **Step 4:** Browser: the button opens
      the palette, drag still places, the hide-unconfigured control still works.
- [x] **Step 5:** Commit.

---

### Task 4: The right panel is resizable

**DONE (221ebb4).** `usePanelWidth` generalised from the sidebar's hook;
`useSidebarWidth` and `useInspectorWidth` are thin wrappers. Verified 320 -> 440px.


**Files:** `renderer/editor/layout-editor.tsx`, and whatever the left rail uses

The left sidebar can already be dragged. The inspector cannot, and it is the panel
that most needs the room.

- [x] **Step 1:** Find how the rail does it and REUSE that, rather than writing a
      second resizer. If it is not reusable, extract it so there is one.
- [x] **Step 2:** Width persists per session, clamped to a usable range.
- [x] **Step 3:** Guard: one resizer implementation, used twice.

```ts
test("there is one resize implementation, not two", () => {
  const defs = ALL_SRC.match(/function useResizablePanel\b/g) ?? [];
  assert.equal(defs.length, 1);
});
```

- [x] **Step 4:** Prove. **Step 5:** Browser: drag the divider, reload, width holds.
- [x] **Step 6:** Commit.

---

### Task 5: Screens in the rail returns to the grid

**DONE (221ebb4).** The reset branch now requires being exactly on the destination.


**Bug:** clicking **Screens** in the rail while editing a layout leaves you in the
editor. It should return to the grid of screens.

**Files:** `renderer/app/rail.tsx` or `destinations.tsx`

Likely cause: the rail marks a destination active by path PREFIX, so
`/screens/<id>/edit` is already "on" Screens and the link is a no-op to the
router. The fix is for the rail's Screens link to target `/screens` exactly.

- [x] **Step 1:** Confirm the cause in a browser before changing anything.
- [x] **Step 2:** Guard.

```ts
test("a rail link navigates to its own path, even from a child route", () => {
  // The bug: from /screens/x/edit, clicking Screens did nothing because the
  // link was already considered active.
  assert.equal(railTarget("/screens", "/screens/view-2/edit"), "/screens");
});
```

- [x] **Step 3:** Fix. **Step 4:** Prove. **Step 5:** Browser: from the editor,
      click Screens, land on the grid. Check the same from Patch and ScriptView.
- [x] **Step 6:** Commit.

---


---

### Task 5b: Context menu items fire, and pages get a right gutter

**DONE (9ccb4ba).** Reported after the first five.

- [x] The context menu did nothing on click — not just Delete. Its
      dismiss-on-outside-click listener runs in the CAPTURE phase, so an
      unfiltered `close()` fired on the pointerdown of a click on a menu ITEM and
      unmounted the menu before the click reached the button. Now it ignores
      pointerdowns from inside the menu.
- [x] Delete is red, not amber. The fix existed (858b391, merged as #269) but
      this branch forked before that merge; cherry-picked.
- [x] The page gutter moved to `<main>`, applied once. Routes were each padding
      themselves and the recent ones did not.
- [x] **Finished properly in 6470e8c.** The first pass removed three local copies
      and there were thirteen, so the ten it missed went from flush to inset
      TWICE — 40px against 20 everywhere else, with Home showing both in one
      scroll. This is the "fix every instance of a repeated pattern" rule in
      CLAUDE.md, missed on exactly the kind of change it was written for.
      `renderer/app/page-gutter.test.ts` now asserts an EXACT set of files may
      carry the class pair; proven by putting it back on `plan-section.tsx`.
      Measured 20/20 on all ten pages in a browser.

### Task 6: Home edits in its own tab

**DONE (14165c9).**

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

- [x] **Step 1:** The storage. Home keeps its View record; presence and array
      order are the only things read from it. Every x/y/w/h is filler the type
      demands, written down at the top of `main/services/home-view.ts` and in
      `docs/reference/data-model.md` so nobody tries to fix an overlap nothing
      draws from.
- [x] **Step 2:** The in-tab editor (`renderer/app/home/home-editor.tsx`): a
      switch and a drag handle per card, and nothing else. The rules are pure and
      separate, in `home-cards.ts`.
- [x] **Step 3–4:** Guards, in `home-view.test.ts` and `home-cards.test.ts`, each
      proven by reintroducing its bug in-session.
- [x] **Step 5:** Browser, against a COPY of the config on :8801. Switched Recent
      services off and dragged Readiness to the top: both landed on disk
      (`layoutRev` 1 then 2, object ids preserved), survived a reload, and
      survived a real server restart.
- [x] **Step 6:** Committed (14165c9), and 8799 rebuilt on it.

**What it turned into, beyond the three bullets above.** Four things the plan did
not anticipate, each with a reason:

1. **Two new object types.** Home drew four things and only two were widgets, so
   `home-live-status` and `home-recent-services` joined the registry and
   `IdlePanel`/`LivePanel` were deleted. Without this, "Home's cards come from the
   shared registry" would have been true of half of Home.
2. **Seeding needed a second condition.** Home shipped with two cards and now has
   four. Keying purely off "does the view exist" — the Phase 6 rule — would leave
   every install that ran the older build permanently missing the new ones.
   `seedHomeView` now also refreshes a Home that has never been SAVED
   (`layoutRev` unset) and never touches one that has.
3. **Home was in the rail twice.** It is a console view, so the rail's Consoles
   group listed it beside the real front door — found in the browser, not by a
   test. Both lists go through `screensListViews` now.
4. **Plan and Commission stay put, deliberately.** They sit below the cards and
   are not editable: one mutates PCO selection, the other hands out display URLs.
   Front-door utilities, not dashboard content — stated in the code and the docs
   rather than left as an omission.

**Then the review passes found four more things (270afbb), all fixed:**

1. **A lost update that could resurrect a card.** Every edit was computed from
   the server's copy, so two changes inside one round-trip both built on the
   pre-edit array. `save` takes an updater now and applies it to the newest list
   — `pending` across a round-trip, a ref within one React batch.
2. **A Home card could kill a wall display.** Three of the four contain links to
   `/screens` and `/history`, and every surface except Home is on the kiosk
   router, whose route table is `/`. A touch took the display to "Route not
   found" and left it there. Wrapped `pointer-events-none` in the layout
   renderer, matching the `["readout"]` capability they already declare.
3. **Five more places counted views** and a seeded Home inflated every one —
   including the SERVER's "cannot remove the last view", which let an operator
   delete their only real view. Seven call sites total, all through
   `screensListViews`.
4. **One sortable row, not five.** The `useSortable`-plus-style block was in four
   places before this branch added a fifth. `useSortableRow` replaces all of
   them; every drag surface re-driven in a browser.

---

### Task 7: Beautiful widgets, one by one

**The next session's work.** Start here in the morning.

#### What the maintainer asked for, in his words

> "I want to create a beautifully designed widget for every single widget we
> have, one-by-one... having to tweak them should only ever be for a reason, the
> default should work 90% of the time, they shouldn't have to tweak it to be
> usable at all."

Read that carefully, because it is NOT "remove the options":

- **The default must be usable with zero tweaking.** That is the bar, and it is
  the bar for every widget, not on average.
- **Tweaking stays available.** It becomes something you reach for with a reason,
  not something you must do to make the widget presentable.
- **Every single widget gets this treatment**, one at a time, deliberately.

#### What this corrects about the Phase 6 cull

Phase 6 removed the knobs and shipped a bare frame. That was backwards twice
over: the defaults were not yet good enough to stand alone, and removal was never
the goal. **Design the default so well that nobody reaches for the knob — then
leave the knob there anyway.**

A refinement learned from seeing the layouts with the controls restored: for some
widgets the styling IS the design. A container and a shape are structural — their
fill and border are what they are for, and they should keep full control
permanently. The widgets that need this work are the ones currently FIGHTING
their knobs: readouts that look wrong until someone sets a font size.

#### Method, per widget

For each widget, in one commit:

- [ ] **Look at it in the real config first.** How is it actually used, at what
      sizes, on which surfaces? Do not design for an imagined case.
- [ ] **Design the default** so it is correct with nothing set — legible at a
      dashboard tile AND at a wall-sized box, since text now sizes itself.
- [ ] **Add variants only where the widget does genuinely different jobs.** A
      clock has three (big time / time with label / time and date). Most widgets
      have one. A variant is a different JOB, never a skin.
- [ ] **Leave every existing control in place.** If the default is right, the
      controls stop being load-bearing on their own.
- [ ] **Prove it in a browser** at a dashboard tile and at a large box, against
      the real config.
- [ ] **Commit per widget**, so any one can be reverted without the others.

#### Order

The ten in real use first — read them out of the config rather than guessing.
From the current config that means the clock, PCO countdown, current/next item,
mic slots, plan file, REAPER and OBS status, SPL meter and people counter.

Stop whenever it stops being an improvement. This is a per-widget judgement, not
a migration with an end state to reach.

#### The standing rule

A knob comes out AFTER its replacement exists, never before, and only if it is
still pointless once the default is good. Auto-sizing then `fontSize` worked. The
other fifteen fields, removed first, had to be reverted (1a21e7e).

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

---

### Task 8: Home becomes a widget grid

**Agreed after a prototype** (artifact `bbdc77eb`), which is the spec. Replaces the
show/hide toggles Task 6 shipped.

Home stops being a stack of four fixed cards and becomes an iOS-style grid: add
any widget in the registry, at one of four preset sizes, drag to arrange.

**The grid, settled by the arithmetic.** Three columns. Sizes are (columns ×
rows): `S 1×1`, `M 2×1`, `L 2×2`, `XL 3×2`.

- `S + M`, `S + L` and `S + S + S` each fill a row; `XL` is a row of its own.
- `L` leaves a 1-wide, 2-tall gap that two stacked `S` complete exactly — the
  block that makes the layout read as composed rather than striped.
- Small is 1×1, so every leftover slot is fillable. Nothing can strand a gap.
- **What it gives up:** `M + M` is 4 over a 3-wide row, so two equal halves side
  by side is not expressible. Thirds and 1/3+2/3 replace it. Decided knowingly.

**Container queries, not viewport.** The prototype first used `@media` and
collapsed to 2 columns under an 860px WINDOW — which is what Home looks like
beside the sidebar, so it never showed three columns at all. The grid must query
its own container: 3 columns down to ~520px of container, then 2, then 1.

**Rendering.** `useLayoutData` and `ObjectContent` are both exported, and the
render context is one object literal over them — so Home can draw any registry
widget without a canvas. Text scales off a nominal height derived from the card's
pixel height, so a default readout lands at roughly a third of its card, which is
what the canvas already does.

- [x] **Step 1:** `LayoutObject.home = { size, when }`, defaults per type on the
      registry spec (`homeSize` / `homeWhen`), and the grid operations in
      `home-cards.ts` — all pure, all non-mutating.
- [x] **Step 2:** `home-grid.tsx` renders each card through `ObjectContent` with
      a context built from `useLayoutData`, and `boxStyle` for the card's own
      frame. **The frame was the one real bug**: rendering `ObjectContent` alone
      left every Home card transparent and edge-to-edge, because on a canvas it
      is the object WRAPPER that paints the box.
- [x] **Step 3:** In-place editing — hover a card for its size picker, visibility
      and remove; drag a card onto another to reorder; `Add widget` opens a sheet
      with all 43 widgets, searchable, each offering all four sizes.
- [x] **Step 4:** Visibility is a per-card setting, and the editor shows EVERY
      card including ones whose mood is not current — you cannot arrange what the
      page is hiding.
- [x] **Step 5–7:** 22 guards in `home-cards.test.ts`, including the tiling
      arithmetic itself. Driven in a browser against a copy of the real config:
      added a Clock at Small, resized it to Large, confirmed both landed on disk
      (`layoutRev` 2, `{"size":"l","when":"always"}`) and survived a restart.
      Three columns hold to a 900px window; 760px drops to two. Committed.

**Sequencing note.** I argued for the widget pass (Task 7) first, so the grid has
designed widgets to arrange. Overruled deliberately — the grid is the more
interesting problem and the widget work lands inside it either way.

---

### Task 9: One widget idiom — the Home card style, everywhere

**Agreed, not yet started.** This is where to pick up.

> "I want all of the stage display idiom to match the home card style you
> created and I want that to be the style going forward"

#### The style, stated

The composition the Home stat cards use, which is the one to standardise on:

```
CAPTION           ← uppercase, letterspaced, ~55-75% opacity, sans
0:04:12           ← the value: mono + tabular for numbers, sans for words
OBS + REAPER      ← the sub-line: what it is, or the qualifier
```

Left-aligned, inside the neutral card, vertically centred in its box.

**Scaled, not fixed.** A wall read from forty feet needs a much bigger value
than a dashboard tile. The same COMPOSITION and the same proportions between
the three lines, sized to the box — not the same pixels.

#### What it replaces

- **Fit-to-fill bare strings.** Most readouts are one string grown until it runs
  out of room, so the value's size is an accident of its box and its caption
  ends up microscopic beside it.
- **Centred readouts.** The cards are left-aligned; the widgets are centred.
- **The solid-fill status widgets.** `obs-status` and `reaper-status` paint a
  solid red panel with white text — a third design language again, and the
  loudest mismatch on Home. Compare to `home-recording-obs`, which says the same
  thing in the card idiom.

#### Why the first attempt was wrong

A `compact` flag on the render context, set by Home, that capped font size and
left-aligned. Reverted before commit. It produced TWO idioms — dashboard widgets
one way, stage widgets another — which is the opposite of the ask. The style is
not a mode; it is the style.

#### Method

- [ ] **Step 1: the comparison page FIRST.** Generated from the registry like
      the widget review (artifact `18a02512`), showing every affected widget
      NOW vs PROPOSED, at BOTH a wall size and a dashboard tile — because the
      whole claim is that one composition works at both. Approve by looking.
- [ ] **Step 2:** A shared `Readout` component — caption, value, sub — that
      scales to its box. One implementation; `Stat` becomes its dashboard-sized
      instance rather than a second copy.
- [ ] **Step 3:** Move readouts onto it one at a time, committing per widget so
      any one can be reverted alone. Roughly twenty: clock, countdown, pp-timer,
      pacing, SPL, people counter/panel, baptism, slide progress, charger, the
      wireless pair, the status pills, section chip.
- [x] **Step 4 — DECIDED: the red fill stays.** It is a see-it-across-the-room
      signal and it works. The card idiom gains a FILLED variant: same
      caption/value/sub composition, painted on a solid ground instead of the
      neutral card. So a filled widget is the same widget wearing a state, not a
      different design language.
- [ ] **Step 5:** Guards. The composition is structural, so it can be asserted:
      every readout renders a caption, a value and (where it has one) a sub, in
      that order. Prove each by removing a line.
- [ ] **Step 6:** Browser, at a real wall size AND a Home tile, against a COPY
      of the config.

#### Risks, stated up front

- **This lands on real stage displays** — Right Display, ethan, Henry — not just
  Home. It is a rendering change, so unlike the default-style pass it moves
  layouts that already exist. That is the point, and it is also why Step 1 is a
  comparison page rather than a description.
- **DECIDED: size comes from the box.** The composition derives all three line
  sizes from the widget's own dimensions, so a widget is legible at whatever size
  it is placed at without anybody tuning a number. A stored `fontSize` therefore
  stops governing the value — which is a knob becoming genuinely pointless rather
  than being taken away, the order the standing rule requires.
- **Do not remove a knob in this pass.** The standing rule: a control comes out
  after its replacement exists and is good, never alongside.
