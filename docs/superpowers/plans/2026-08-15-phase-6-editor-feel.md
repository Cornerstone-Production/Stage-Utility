# Phase 6 — Widgets that work without being tuned

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop asking the operator to make the widget look right. Build widgets
that size themselves, read well at any shape, and need no adjustment — then delete
the options that only existed because they did not.

**Architecture:** The cull comes first and everything follows from it. Options are
removed only where the widget can make the decision better than a person can, and
every removal is justified against what the real config actually uses. The sidebar
palette and drag-to-place replace the add-object dropdown. Home becomes
layout-backed, carrying a debt from Phase 4.

**Tech Stack:** React, `useFitScale` (Phase 5), `node:test` + jsdom.

## Carried from earlier phases

Per the process fix below, this plan opens with the previous phases' unbuilt
deferrals:

| Deferred | Promised for | This plan |
|---|---|---|
| **Home as an editable console** | Phase 4 | **In scope** — Task 5 |
| Stacking threshold | Phase 5 | Deferred again; still no evidence either way |
| Min/max height | Phase 5 | Not building, by decision |

Everything else deferred across Phases 1a–5 was built; the audit is at the end.

## Global Constraints

- No emojis anywhere.
- Every guard ships with proof: reintroduce the bug, watch it go red, say so.
- **An option is removed only with evidence and a named replacement.** "Nobody
  uses it" is evidence; "it feels cluttered" is not.
- **An operator's stored data is never deleted to tidy up.** Removed style fields
  stay in the schema and in their files.
- New `catch` blocks rethrow or return the failure.
- Dark surfaces stay strictly R=G=B neutral. No purple, no tints.
- Motion uses the Phase 5 tokens.
- Docs updated in the same PR.

---

## The evidence

Measured against the real config — 24 objects across 12 views, every one carrying
some style:

| Field | Set on | Distinct values | Reading |
|---|---|---|---|
| `cornerRadius` | 21 | **1** | A constant wearing an option's clothes |
| `padding` | 16 | **1** | Same |
| `borderWidth` | 21 | 2 | Effectively constant |
| `uppercase` | 3 | 1 | Barely used |
| `opacity` | 2 | 1 | Barely used |
| `lineClamp` | 2 | 1 | Barely used |
| `italic` | 0 | 0 | Never used |
| `letterSpacing` | 0 | 0 | Never used |
| `textShadow` | 0 | 0 | Never used |
| `fontWeight` | 19 | 3 | Three weights; the widget can pick |
| `textAlign` | 19 | 2 | Almost always centred |
| `vAlign` | 19 | 3 | Almost always middle |
| `background` | 21 | 6 | Moves in lockstep with border and shadow — a preset, not tuning |
| `borderColor` | 21 | 5 | Same |
| `boxShadow` | 10 | 4 | Same |
| **`color`** | 20 | **5** | **Real, meaningful variation** |
| **`fontSize`** | 19 | **13** | **The most varied — and the one auto-sizing removes** |

Three fields are never used. Six are constants. Three move together as a preset.
`fontSize` varies most precisely *because* widgets do not size themselves — every
one of those 13 values is someone compensating.

**One field carries genuine meaning: `color`.** A green countdown and a red
warning say something a default cannot infer.

---

## What the panel becomes

**17 style fields → 1.**

| Field | Fate | Why |
|---|---|---|
| `fontSize` | **Removed** | The widget sizes text to its box, and keeps sizing it as the box changes |
| `fontWeight`, `italic`, `uppercase`, `letterSpacing` | **Removed** | The widget's own typography; a clock is a clock |
| `textAlign`, `vAlign` | **Removed** | The widget centres itself unless its content says otherwise |
| `background`, `opacity`, `boxShadow` | **Removed** | The card look goes: no tint, no glass, no elevation |
| `cornerRadius`, `padding`, `borderWidth` | **Removed** | One radius, one padding, one outline weight, app-wide |
| `borderColor` | **Replaced** | Becomes **Section colour** — see below |
| `textShadow`, `lineClamp` | **Removed** | Auto-sizing makes both unnecessary |
| **`color`** | **Kept** | The only field with real meaning |

### The new kiosk look

A widget is its content, a 1px outline, and nothing else. No fill, no
transparency, no shadow. The outline exists to separate the widget from the
canvas, not to decorate it.

**Section colour** is the one visual choice: a small set of named colours applied
to the outline (and only the outline), so a wall of widgets can be grouped at a
glance — audio here, video there. Default is neutral.

### Config options: 80 across 41 types

The same treatment, by pattern rather than one at a time:

| Pattern | Count | Fate |
|---|---|---|
| `showLabel` / `showLabels` | ~10 | **Removed.** A label set is a label shown; an empty label shows nothing |
| `label` (custom text) | ~8 | **Kept.** "Doors" is not derivable |
| `fillWhenRecording` | 3 | **Removed, becomes always-on.** Recording should be unmissable; that is the whole point |
| `autoFit`, `scroll`, `orientation` | 3 | **Removed.** The widget reads its own box |
| `hideWhenIdle` | 4 | **Kept.** A tally light that is blank when idle is a different thing, not a styling preference |
| IDs (`meterId`, `channelId`, `actionId`, …) | ~12 | **Kept.** This is what it shows |
| Which-value (`metric`, `field`, `mode`, `format`, …) | ~12 | **Kept.** Same |
| Thresholds, `warnStates` | 2 | **Kept.** Semantic, per-room |

Roughly **80 → 55**, and the ones that remain all answer "what does this show?"
rather than "how should it look?"

---

## The decision this needs from the maintainer

Removing the styling changes how **existing displays look after an upgrade**.
That is the point, but it is not reversible by an operator, so it is a call to
make deliberately.

**A. The new look everywhere (recommended).** Existing per-object styling stops
being rendered. Every display gets flat widgets with outlines on next upgrade.
The stored values stay in the files untouched, so a rollback restores the old
look — nothing is destroyed, only ignored.

**B. New look for new objects only.** Existing layouts keep their glass and
tints. Nothing changes on upgrade — but two looks coexist forever and the
renderer keeps every code path this phase set out to delete.

A is recommended: B keeps the bloat and buys nothing except the absence of a
surprise. **A must be flagged in the release notes**, because someone's stage
display will look different on a Sunday morning.

---

## File Structure

| File | Responsibility |
|---|---|
| `renderer/editor/object-catalog.ts` (new) | Group, icon, colour, blurb for all 41 types |
| `renderer/editor/palette.tsx` (new) | The sidebar: grouped widget cards, draggable |
| `renderer/editor/drag-to-place.ts` (new) | Pure: drop point → a sensible default rect |
| `renderer/editor/draw-to-create.ts` (new) | Pure: drawn rect → normalised, clamped rect |
| `renderer/main/widget-frame.tsx` (new) | The one frame every widget renders in: outline, section colour, padding |
| `renderer/main/layout-objects.ts` | Default styles collapse to almost nothing |
| `renderer/editor/inspector.tsx` | Shows / Colour / Position — that is all |
| `renderer/app/home/home-layout.ts` (new) | Home's default layouts, as data |

---

### Task 1: The object catalog

**Files:** Create `object-catalog.ts` + test

- [ ] **Step 1:** `Record<LayoutObjectType, CatalogEntry>` with group, label, blurb,
      icon and section colour. Typed as a full Record so a missing entry fails `tsc`.
- [ ] **Step 2:** Test asserts exactly 41 entries and that every blurb is 1–80 chars.
- [ ] **Step 3:** Prove it — delete an entry, watch `tsc` and the test both fail.
- [ ] **Step 4:** Commit.

---

### Task 2: The sidebar palette, and two ways to place

**Files:** Create `palette.tsx`, `drag-to-place.ts`, `draw-to-create.ts` + tests;
modify `layout-editor.tsx`

A persistent panel beside the canvas: grouped cards with a coloured icon, the
name, and one line saying what it shows. Drag a card onto the canvas to place it.

Both gestures, because they answer different questions:

- **Drag from the palette** — "I want one of those." Lands at the drop point at a
  sensible default size.
- **Draw on the canvas** — "I want something exactly here, this big." Opens the
  same catalog, filtered, at that rect.

- [ ] **Step 1: Write the failing tests for both geometries**

```ts
test("a dropped widget lands centred on the drop point", () => {
  const r = rectForDrop({ x: 0.5, y: 0.5 }, "clock");
  assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 1e-9);
});

test("a drop near the edge is nudged fully inside", () => {
  const r = rectForDrop({ x: 0.98, y: 0.98 }, "clock");
  assert.ok(r.x + r.w <= 1 && r.y + r.h <= 1);
});

test("a drawn rect normalises whichever way it was dragged", () => {
  assert.deepEqual(rectFrom({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 }),
                   { x: 0.2, y: 0.3, w: 0.4, h: 0.4 });
});

test("a flick becomes a default-sized widget, not a 2px one", () => {
  const r = rectFrom({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.501 });
  assert.ok(r.w >= MIN_DRAW && r.h >= MIN_DRAW);
});
```

- [ ] **Step 2:** Run, watch all four fail.
- [ ] **Step 3:** Implement both modules — pure, fractions in and out.
- [ ] **Step 4:** Green. Prove two guards: remove the edge nudge, remove the
      normalisation, watch each go red.
- [ ] **Step 5:** Build the palette. Groups from the catalog. Drag uses the
      existing pointer handlers, not a new library.
- [ ] **Step 6:** Guard that a cancelled placement adds nothing and costs no undo step.
- [ ] **Step 7:** Browser pass — drag from the palette, draw on canvas, drop near
      an edge, drop into a container, cancel. Screenshot each.
- [ ] **Step 8:** Commit.

---

### Task 3: One frame, and the cull

**Files:** Create `widget-frame.tsx` + test; modify `layout-objects.ts`,
`layout-renderer.tsx`, `inspector.tsx`

- [ ] **Step 1: The frame.** Every widget renders inside `WidgetFrame`: 1px
      outline in the section colour, one radius, one padding, no fill, no shadow.
      One component, so the look cannot drift per type.
- [ ] **Step 2: Text sizes itself, always.** Extend Phase 5's `useFitScale` from
      the readouts that had bugs to every widget that renders text, and make it the
      default path rather than an opt-in. This is the change that makes `fontSize`
      unnecessary; it must land before the field is removed, not after.

```ts
test("every text-rendering widget fits its own box", () => {
  // The registry decides, so a new widget joins by existing. This is the
  // property the whole cull rests on: if it is not true, removing fontSize
  // leaves operators with clipped text and no way to fix it.
  for (const t of TEXT_WIDGETS) {
    assert.match(bodyOf(t), /useFitScale[<(]/, `${t} must size itself`);
  }
});
```

- [ ] **Step 3: Prove it in a browser before removing anything.** Re-run the
      41-type sweep from Phase 5 at four viewports. Zero overflow is the
      precondition for Step 4. If any widget fails, fix it first.
- [ ] **Step 4: Remove the controls.** The inspector keeps Shows, Colour and
      Position. The removed fields stay in the schema and in stored files.
- [ ] **Step 5: The parity guard, inverted.** Phase 6 removes on purpose, so the
      test asserts the *intended* set rather than that everything survives:

```ts
test("the inspector offers exactly the fields we decided to keep", () => {
  assert.deepEqual(editableStyleFields().sort(), ["color", "sectionColor"]);
});

test("stored values for removed fields are preserved, not stripped", () => {
  // Never delete an operator's data to tidy up. A downgrade must restore the
  // old look, which is only possible if the values are still in the file.
  const saved = roundTrip(objectWithLegacyStyle);
  assert.equal(saved.style.background, "rgba(255,255,255,0.04)");
});
```

- [ ] **Step 6:** Prove both — offer `fontSize` again and watch the first fail;
      strip unknown style keys on save and watch the second fail.
- [ ] **Step 7:** Browser pass, before and after screenshots of a real view.
- [ ] **Step 8:** Commit, saying how many fields and options were removed.

---

### Task 4: The config cull

**Files:** modify the object specs and `inspector.tsx`

- [ ] **Step 1:** Remove `showLabel` / `showLabels` across ~10 types **in one
      change**, with the commit saying how many were found and changed. A set
      label shows; an empty one does not.
- [ ] **Step 2:** `fillWhenRecording` becomes always-on across its 3 types.
- [ ] **Step 3:** Remove `autoFit`, `scroll`, `orientation` — the widget reads its
      own box.
- [ ] **Step 4:** Guard that a stored `showLabel: false` still hides the label
      (migration reads it as an empty label), so no display silently gains a
      caption it never had.
- [ ] **Step 5:** Prove it — drop the migration and watch it go red.
- [ ] **Step 6:** Commit with the counts.

---

### Task 5: Home, editable — the carried debt

Unchanged from the previous draft; see the audit for why it is here. Home's panels
are bespoke React, not layout objects, so the sequence is objects → default layout
→ idempotent migration that never overwrites a Home someone edited.

- [ ] **Step 1:** `readiness`, `next-service`, `getting-started` become object types.
- [ ] **Step 2:** Today's idle and live panels expressed as two default layouts,
      compared against the current design in a browser before going further.
- [ ] **Step 3:** Seed `home-idle` and `home-live`; idempotent.
- [ ] **Step 4:** Guard that a customised Home survives the migration running again;
      prove it by making the migration unconditional.
- [ ] **Step 5:** "Edit this dashboard" on both states.
- [ ] **Step 6:** Browser pass; a deleted object stays deleted across a restart.
- [ ] **Step 7:** Commit.

---

## What this costs

Stated plainly, because removing options is the one change an operator cannot
undo:

- **Someone's display will look different.** Flat outlines instead of glass tiles.
  Release-noted, and the stored values remain for a rollback.
- **Text size becomes automatic.** An operator who deliberately made a clock small
  to fit a label beside it loses that lever — the widget will fill its box. The
  answer is to resize the widget, which is a better lever anyway.
- **Per-object background colour is gone.** Section colour on the outline replaces
  grouping-by-fill. A layout using fill to mean something loses that meaning.

If any of these is wrong for a real display you have, say which and it stays.

---

## Audit of every earlier phase

| Deferred | Promised for | Status |
|---|---|---|
| Nav group labels | Phase 1b | Built |
| Configurable context-bar registry | Phase 3 | Built, compiler-enforced |
| `View.surface`, Output modes | Phase 3 | Built |
| Control objects bound to `ActionDef` | Phase 3 | Built |
| Drill-down targets | Phase 3 | Built — 4 targets |
| Notes and checklist objects | Phase 3 | Built |
| Resize across every object type | Phase 5 | Built — 8 defects fixed |
| Snapping and alignment guides | Phase 5 | Built |
| Default-look pass, reset | Phase 5 | Built |
| Motion tokens | Phase 5 | Built |
| **Home as an editable console** | **Phase 4** | **MISSED — Task 5 here** |
| Stacking threshold | Phase 5 | Deferred by decision |
| Min/max height | Phase 5 | Not building, by decision |

One miss in six phases. The gap: nothing carried a phase's deferral list into the
next phase's scope. **Every future phase plan opens by listing the previous
phases' unbuilt deferrals** and saying, for each, whether it is in scope or
deferred again with a reason. This plan does that at the top.
