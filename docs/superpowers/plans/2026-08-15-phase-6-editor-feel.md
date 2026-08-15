# Phase 6 — An editor that looks like a tool, not a control panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make building a view feel like arranging things, not filling in a form.
Draw where you want something and pick what goes there; choose a look from
pictures instead of fifteen numeric fields; and let Home be edited like every
other surface.

**Architecture:** Four independent pieces. Draw-to-create and the object picker
are new UI over the geometry that already exists. The inspector's rebuild is a
re-grouping, not a deletion — every control survives, most of them behind one
disclosure. Home becomes layout-backed, with today's hand-built panels shipped as
the default layout and as objects, so no install sees a change it did not ask for.

**Tech Stack:** React, the existing pointer handlers, `node:test` + jsdom.

## Global Constraints

- No emojis anywhere: UI, code, comments, commit messages, PR bodies.
- Every guard ships with proof: reintroduce the bug, watch the test go red, say so.
- **No feature is removed without a stated reason or a named replacement.** The
  parity inventory is part of the deliverable and is checked control by control.
- A repeated pattern is fixed everywhere at once; the commit says how many.
- New `catch` blocks rethrow or return the failure.
- Numeric fields use the themed `NumberInput`.
- Dark surfaces stay strictly R=G=B neutral. No purple.
- Motion uses the Phase 5 tokens; no literal durations.
- Docs updated in the same PR.

---

## The problem, stated precisely

The right panel currently holds **38 rows**. Sixteen of them are pure styling:

`Style · Font size · Weight · Color · Align · V-align · Uppercase · Shadow ·
Max lines · Fill · Opacity · Radius · Padding · Border · Elevation · Align`

That is the Photoshop feeling. The other 22 rows are what the object *shows*
(which integration, which metric, which view to embed) and are the entire point
of the object — those are not in scope for reduction.

Adding an object today is: pick a type from a dropdown, it appears at a fixed
spot in the middle, then drag and resize it to where you actually wanted it.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/editor/draw-to-create.ts` (new) | Pure: pointer rect → a normalised, clamped, minimum-sized FracRect |
| `renderer/editor/object-picker.tsx` (new) | The graphical picker: grouped cards with icon, name and one line of description |
| `renderer/editor/object-catalog.ts` (new) | Group, icon, accent and blurb for each of the 41 types — one exhaustive record |
| `renderer/editor/look-controls.tsx` (new) | Look swatches, accent swatches, size steps, the 9-cell align grid |
| `renderer/editor/inspector.tsx` | Re-grouped: Shows / Look / Position / Advanced |
| `renderer/editor/layout-editor.tsx` | Draw-to-create wired into the canvas; picker replaces the Add dropdown |
| `renderer/app/home/home-layout.ts` (new) | The default Home layouts, as data |
| `main/services/home-views.ts` (new) | Seeds and migrates the two Home views |
| `docs/reference/layout-editor.md` | Updated for the new flow |

---

### Task 1: The object catalog

Everything downstream needs the same facts about a type, and a picker missing an
object is worse than no picker.

**Files:** Create `renderer/editor/object-catalog.ts`, `object-catalog.test.ts`

**Interfaces:**

```ts
export interface CatalogEntry {
  group: "Service" | "Timers" | "Slides" | "Audio" | "Video" | "Streaming" | "Gear" | "Notes" | "Misc";
  label: string;
  blurb: string;          // one line, what it shows
  icon: LucideIcon;
  accent: string;         // a token, for the icon tile
}
export const CATALOG: Record<LayoutObjectType, CatalogEntry>;
```

- [ ] **Step 1: Write the failing test**

```ts
test("every object type is in the catalog", () => {
  // Record<LayoutObjectType, …> already makes tsc enforce this, which is
  // stronger than a runtime check. This asserts the EXACT count as well, so a
  // new type cannot be added to both sides without someone looking at it.
  assert.equal(Object.keys(CATALOG).length, 41);
  for (const t of Object.keys(CAPABILITIES)) {
    assert.ok(CATALOG[t], `${t} missing from the catalog`);
    assert.ok(CATALOG[t].blurb.length > 0 && CATALOG[t].blurb.length < 80,
      `${t}: a blurb must exist and fit one line`);
  }
});
```

- [ ] **Step 2: Run it, watch it fail** (`CATALOG is not defined`)
- [ ] **Step 3: Write the catalog.** Type it as `Record<LayoutObjectType, CatalogEntry>`
      so a missing entry fails `tsc` (TS2741), not just the test.
- [ ] **Step 4: Green**
- [ ] **Step 5: Prove the guard.** Delete one entry; confirm `tsc` fails AND the
      test fails. Say so in the commit.
- [ ] **Step 6: Commit**

---

### Task 2: Draw where it goes, then say what it is

**Files:** Create `renderer/editor/draw-to-create.ts` + test,
`renderer/editor/object-picker.tsx`; modify `layout-editor.tsx`

Drag on empty canvas currently draws a marquee selection. That stays: a drag that
starts on empty canvas and selects nothing is the same gesture. The rule is
**modifier-free drag on empty canvas draws a new object's box**; the picker opens
on release; Escape or dismissing it cancels and leaves nothing behind.

- [ ] **Step 1: Write the failing tests**

```ts
describe("the drawn rect", () => {
  test("normalises a rect dragged up-and-left", () => {
    // Dragging from bottom-right to top-left is the same rectangle.
    const r = rectFrom({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 });
    assert.deepEqual(r, { x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
  });

  test("a flick smaller than the minimum becomes a default-sized object", () => {
    // A click that moves 2px is a click, not a 2px object nobody can select.
    const r = rectFrom({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.501 });
    assert.ok(r.w >= MIN_DRAW && r.h >= MIN_DRAW);
  });

  test("it never escapes the canvas", () => {
    const r = rectFrom({ x: 0.9, y: 0.9 }, { x: 1.4, y: 1.6 });
    assert.ok(r.x + r.w <= 1 && r.y + r.h <= 1);
  });

  test("a rect drawn inside a container is local to that container", () => {
    const r = localiseTo({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.4, y: 0.3, w: 0.2, h: 0.2 });
    assert.ok(r.x >= 0 && r.x <= 1 && r.w <= 1);
  });
});
```

- [ ] **Step 2: Run, watch all four fail**
- [ ] **Step 3: Implement `draw-to-create.ts`** — pure, fractions in and out.
- [ ] **Step 4: Green**
- [ ] **Step 5: Prove the guards.** Remove the normalisation and watch the
      up-and-left test go red; remove the clamp and watch the escape test go red.
- [ ] **Step 6: Build the picker.** Grouped cards: coloured icon tile, name,
      one line of description. A search field focused on open, arrow keys and
      Enter, Escape cancels. It is the same component the toolbar "Add object"
      button opens, so there is one picker, not two.
- [ ] **Step 7: Wire it.** On release, open the picker anchored to the drawn rect;
      on choose, insert at that rect and select it; on cancel, nothing is added.
- [ ] **Step 8: Guard that cancelling adds nothing**

```ts
test("dismissing the picker leaves the layout untouched", () => {
  // The bug: the object is created on release and deleted on cancel, so an
  // undo step and a flash of an unwanted object both survive.
  const before = layout.objects.length;
  drawAndCancel();
  assert.equal(layout.objects.length, before);
  assert.equal(historyDepth(), 0, "a cancelled draw is not an undo step");
});
```

- [ ] **Step 9: Drive it in a browser.** Draw a box in open canvas, in a
      container, and dragging up-and-left. Screenshot each. Confirm marquee
      selection still works.
- [ ] **Step 10: Commit**

---

### Task 3: A look you pick from pictures

Sixteen styling rows become four visual controls plus one disclosure. **Nothing
is deleted** — see the parity inventory.

**Files:** Create `renderer/editor/look-controls.tsx` + test; modify `inspector.tsx`

The panel becomes four sections:

| Section | Holds | Open by default |
|---|---|---|
| **Shows** | The per-type configuration (rows 1–22 today) | yes |
| **Look** | Surface swatches, accent swatches, size steps, align grid | yes |
| **Position** | X/Y/W/H, and the Phase 4 responsive controls | no |
| **Advanced** | Font px, weight, uppercase, shadow, max lines, opacity, radius, padding, border width, elevation | no |

- [ ] **Step 1: Surface swatches.** The eight existing `STYLE_PRESETS` rendered as
      actual miniature previews — a small box showing that fill, border and
      elevation — not a dropdown of words. Selected state is a ring.
- [ ] **Step 2: Accent swatches.** The colour row: a set of tokens plus a custom
      picker, replacing the bare `<input type="color">` as the primary control.
      The custom picker stays, one click deeper.
- [ ] **Step 3: Size steps.** S / M / L / XL mapped to fractions of canvas height,
      with the exact px field in Advanced. An operator sizing a clock wants
      "bigger", not "0.0787".
- [ ] **Step 4: Align grid.** The nine-cell grid from Phase 4's `PinGrid`, reused
      rather than reimplemented — it already reads spatially.
- [ ] **Step 5: The parity guard**

```ts
// The rule this defends: minimising the panel must not remove a capability.
// Every style field the type system knows about must still be reachable from
// SOME control, even if that control now lives behind a disclosure.
test("every LayoutStyle field is still editable somewhere", () => {
  const reachable = collectEditableStyleFields(); // walks the inspector's controls
  for (const field of STYLE_FIELDS) {
    assert.ok(reachable.has(field), `${field} became unreachable when the panel was slimmed`);
  }
});
```

- [ ] **Step 6: Prove it.** Delete the Advanced section entirely and watch this go
      red naming the fields that vanished. Restore. Say so in the commit.
- [ ] **Step 7: Count the rows.** Assert the default-open row count is under 12,
      so "minimised" is a fact rather than a feeling.
- [ ] **Step 8: Browser pass.** Every control reachable, the panel visibly
      shorter, screenshots before and after.
- [ ] **Step 9: Commit**

---

### Task 4: Home, editable — a carried debt, not a new idea

**Files:** Create `renderer/app/home/home-layout.ts`, `main/services/home-views.ts`
+ tests; modify the Home route

**This was promised and missed.** The design doc says:

> Home ships first as a **fixed arrangement** of those widgets (Phase 2), and
> becomes an editable console once edit mode exists (Phase 4). The widgets are
> identical in both cases, so nothing built early is discarded.

Phase 2's out-of-scope list repeated it: *"Home as an editable console — Phase 4,
once edit mode exists."* Phase 4's plan then contained no Home task at all. The
deferral was dropped when that plan was written, and nothing checked one plan's
deferrals against the next plan's scope.

**The doc's premise is also false as built.** Home's panels are bespoke React
talking straight to the state hooks (`useObsState`, `useReaperState`,
`computePcoTimer`) — they are not layout objects. So "the widgets are identical
in both cases, so nothing built early is discarded" does not hold, and this task
is bigger than the doc assumed: the widgets have to become objects first.

That is why Step 1 exists, and why the honest sequence is objects → default
layout → migration, not "flip a switch".

Both states should be editable. Neither is today, and that has nothing to do with
whether a service is running — it is the same reason for both.

- [ ] **Step 1: Objects for what Home shows.** `readiness`, `next-service` and
      `getting-started` become layout object types, joining the catalog and the
      capability registry. They keep their drill-downs (`drilldown` capability,
      which Phase 3 already models).
- [ ] **Step 2: The default layouts, as data.** Today's idle and live panels
      expressed as two layouts. Compared against the current design in a browser
      before going further: if the default does not match what shipped, this is a
      redesign wearing a migration's clothes.
- [ ] **Step 3: Seed and migrate.** Two views, `home-idle` and `home-live`, created
      if absent. Idempotent, and it never overwrites a Home an operator has
      already edited.

```ts
test("a customised Home survives the migration running again", () => {
  const once = migrateHome(seeded);
  const edited = withObjectRemoved(once, "readiness");
  const twice = migrateHome(edited);
  assert.deepEqual(twice, edited, "migration must never restore what was deleted");
});
```

- [ ] **Step 4: Prove it.** Make the migration unconditional and watch this go red.
- [ ] **Step 5: The edit affordance.** "Edit this dashboard" on Home, going to the
      same editor as everything else. Both states editable, each its own layout,
      because they answer different questions.
- [ ] **Step 6: Guard that both are editable**

```ts
test("both Home states are layout-backed and editable", () => {
  for (const id of ["home-idle", "home-live"]) {
    const v = views.find((x) => x.id === id)!;
    assert.ok(v.layout, `${id} must be layout-backed`);
    assert.ok(canEdit(v), `${id} must be editable`);
  }
});
```

- [ ] **Step 7: Browser pass.** Home unchanged on first load; edit each state; a
      deleted object stays deleted across a restart.
- [ ] **Step 8: Commit**

---

## Feature parity inventory

The panel is being minimised, so this is checked control by control.

| Control today | After | Where |
|---|---|---|
| Style (dropdown of 8) | **Kept, improved** | Look — as swatches you can see |
| Color | **Kept, improved** | Look — swatches, custom picker one click deeper |
| Font size (px field) | **Kept, plus** | Look — S/M/L/XL; exact px in Advanced |
| Align, V-align | **Kept, improved** | Look — one 9-cell grid instead of two rows |
| Weight | Kept | Advanced |
| Uppercase | Kept | Advanced |
| Shadow | Kept | Advanced |
| Max lines | Kept | Advanced |
| Fill | Kept | Advanced |
| Opacity | Kept | Advanced |
| Radius | Kept | Advanced |
| Padding | Kept | Advanced |
| Border | Kept | Advanced |
| Elevation | Kept | Advanced |
| Align (distribute) | Kept | Position |
| Rows 1–22 (what it shows) | Untouched | Shows |
| Add object dropdown | **Replaced** | The picker — same list, with pictures |
| Marquee selection | Untouched | Still a drag on empty canvas |
| Reset to default look | Untouched | Look |

**Nothing is removed.** Ten controls move behind a disclosure; four are replaced
by something more direct; one dropdown becomes a picker.

If the intent was to genuinely *delete* the fine-grained styling rather than
demote it, say so and it comes out in one commit — but deleting it silently is
the failure mode this table exists to prevent.

## Audit of every earlier phase

Checked each phase plan's deferrals against what is in the tree, because the Home
miss showed that a deferral in one plan is not automatically scope in the next.

| Deferred | Promised for | Status |
|---|---|---|
| Nav group labels | Phase 1b | **Built** — `NAV_GROUPS` in `destinations.tsx`, consumed by the rail |
| Configurable context-bar registry | Phase 3 | **Built** — `Record<BarItemId, BarItem>`, compiler-enforced |
| `View.surface`, Output modes | Phase 3 | **Built** |
| Control objects bound to `ActionDef` | Phase 3 | **Built** — 41 types in the capability registry |
| Drill-down targets | Phase 3 | **Built** — 4 targets |
| Notes and checklist objects | Phase 3 | **Built** |
| Resize across every object type | Phase 5 | **Built** — measured, 8 defects fixed |
| Snapping and alignment guides | Phase 5 | **Built** |
| Default-look pass, reset | Phase 5 | **Built** |
| Motion tokens | Phase 5 | **Built** |
| **Home as an editable console** | **Phase 4** | **MISSED — this plan, Task 4** |
| Stacking threshold | Phase 5 | Deferred by decision, recorded |
| Min/max height | Phase 5 | Not building, by decision, recorded |

One miss in six phases. The process gap that produced it: nothing carried a
phase's deferral list into the next phase's scope. **Every future phase plan
opens by listing the previous phases' unbuilt deferrals and saying, for each,
whether it is in scope or deferred again with a reason.** This plan does that
above.

## Open question

**How graphical is the canvas itself?** The reference shows widget cards with
icons and descriptions *on the canvas* while editing. That reads well for a
dashboard builder and badly for a stage display, where the canvas is a true
preview of what goes on the wall and an operator needs to trust it. This plan
keeps the canvas a real preview and puts the graphical treatment in the picker
and the panel. Worth a look at the mockup before Task 2 starts.
