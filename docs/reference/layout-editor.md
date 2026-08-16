# Layout editor

The custom-layout editor: how objects are placed, how they behave on a window
that is not the shape they were designed for, and how the look is reset.

Reach it from **Screens**, then **Edit layout** on any view with a custom layout.

## Placing objects

Objects are stored as fractions of the canvas (0–1), never pixels, so a layout
looks the same on a 1080p screen and a 4K one.

### Grid

A 96-cell square grid. Cells are the same number of pixels on both axes whatever
the canvas shape, so snapped edges land on the lines actually drawn. **Snap all**
applies it to every object's position and size at once.

### Align

Snaps to the *other objects* rather than to the grid: their left, right, top and
bottom edges, their centres, the canvas edges and its middle, and the spacing a
row has already established. Guides appear on the lines being matched and span
only the objects that share them.

Grid and Align are independent and both default on. The grid snaps first and
alignment refines. **Hold Alt while dragging to suppress both** and place
something exactly.

The pull is 8&nbsp;px, measured per axis, so it is the same visual distance
horizontally and vertically.

Resizing snaps only the edge being dragged; the opposite edge stays put.

## Fit, and other window shapes

A layout has one **fit**, set in the **Canvas** popover:

| Fit | What it does | Right for |
|---|---|---|
| Letterbox | Keeps the design's shape exactly, with bars on a screen of a different shape | A wall screen, whose size you know |
| Responsive | Reflows to the window it is on | A control surface, which is on whatever window the operator has |

A control surface with no fit stored is responsive; a wall screen is letterboxed.

### What responsive does

Four mechanisms, each optional and **off by default** — a layout that sets none
of them lays out exactly as it always has.

| Mechanism | Effect |
|---|---|
| Pin (anchors) | Hold a distance from an edge or centre instead of drifting proportionally |
| Keep its shape | Scale evenly inside the space rather than stretching |
| Min / max width | A control cannot shrink below tappable or balloon on a 4K screen |
| Stacking | A genuinely different window shape reflows into a single column, in reading order |

Stacking triggers when the window's aspect strays far enough from the design's,
or when it is narrower than 500&nbsp;px. Each object gets a band, floored at
24&nbsp;px; if the resulting column is taller than the window, the surface
scrolls rather than clipping.

Pin, keep-shape and the width limits are in the inspector under
**On other window shapes**.

### Preview shapes

Beside **Align**: **Design**, **Panel** (1024×768), **Phone** (390×844) and
**Ultrawide** (3840×1080).

Only **Design** is editable. The others render the same component the display
itself mounts, read-only, at that exact viewport — so what you see is what the
screen will do. A caption says which of letterboxing, reflowing or stacking is
happening and why.

## Reset to default look

In the inspector, under **Style**. Puts the object's look back to the default for
its type.

It replaces the style rather than merging into it, so hand-tuned fields are
genuinely cleared. Position, size, configuration and the responsive settings are
left alone, and it can be undone.

## Checking object types at extreme sizes

Objects are measured in a real browser rather than in unit tests: jsdom has no
layout engine, so `scrollWidth` is always 0 there and an overflow assertion would
pass on every bug.

To re-run the sweep, generate a view holding one object of every type
(`CAPABILITIES` in `main/types/object-capabilities.ts` is the list, with
`defaultConfig` and `defaultStyle` from `renderer/main/layout-objects.ts`), point
a display at it, and compare `scrollWidth`/`scrollHeight` against
`clientWidth`/`clientHeight` for each object at several viewport sizes.

Readouts that would otherwise overflow shrink to fit through one shared
measurement (`useFitScale` in `renderer/main/layout-renderer.tsx`). Add new
readouts to it rather than writing fresh sizing maths, so a fix reaches all of
them at once.

## Motion

Three durations and two easings, defined in `renderer/styles.css`:

| Token | Value | Used for |
|---|---|---|
| `--motion-instant` | 90 ms | Hover, press |
| `--motion-quick` | 160 ms | Toggles, tabs, toasts |
| `--motion-settled` | 260 ms | Dialogs, route changes |

`--motion-quick` is wired to Tailwind's default transition, so a bare
`transition-colors` inherits it. Use `duration-(--motion-*)` rather than a
literal; a hard-coded duration fails the test suite.

Reduced motion is honoured globally: transitions and animations collapse to
1&nbsp;ms, except the spinner, which keeps turning slowly because "still working"
is information.
