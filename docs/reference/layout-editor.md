# Layout editor

The custom-layout editor: how objects are placed, how they behave on a window
that is not the shape they were designed for, and how the look is reset.

Reach it from **Screens**, then **Edit layout** on any view with a custom layout.

## The inspector

Select an object and its settings appear on the right, in three sections that are
always in the same order:

| | |
|---|---|
| **Content** | what this widget shows — the channel a mic tile reads, the mode OBS status watches, the text of a text object. Different for every widget type, and absent for the ones that have nothing to choose |
| **Look** | how it is drawn — surface, tint, font size and weight, colour, alignment, corner radius, border. The same controls for every widget |
| **Place** | where it sits — position, size, and how it behaves when the window is not the shape it was designed for |

The split is worth knowing because it tells you where to look: anything that
changes the NUMBER is in Content, anything that changes how the number is DRAWN
is in Look. They used to be one list, and on a widget with a dozen settings the
one you wanted was wherever it happened to have been added.

**Content is hidden entirely** on a widget with nothing to configure — a clock
showing the time needs no source — rather than left as an empty heading.

See [Widget reference](widgets.md) for what each widget's Content settings mean.

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

## How a readout looks

Every widget that shows a value — clocks, countdowns, timers, SPL, counters, the
status and wireless objects — draws the same three lines:

```
OBS              caption: what this is
RECORDING        value: the reading itself
00:35:09         sub-line: the qualifier
```

All three sizes come from the **widget's own height**, so a readout is legible at
whatever size you place it — a dashboard tile and a wall both work without
setting a font size. The stored font size no longer governs the value.

Only the caption and sub-line a widget actually has are drawn; a clock with
neither gets a value that fills the box.

**Alignment** defaults to left, because three stacked lines of different widths
read as one object when they share an edge. It is still yours to change per
object under **Align** — a centred clock as a centrepiece is a normal thing to
want.

**Filled** is the same composition on a solid ground, used where a state has to
carry across a room: a recorder painting itself red while recording, a section
chip in its own colour. A filled widget is the same widget wearing a state, not a
different design.

The caption and sub-line have pixel floors — they stop shrinking rather than
becoming decoration — so a small widget gives them proportionally more room and
its value proportionally less. That is why the editor draws in the design
canvas' pixels whatever the fit is: it is a scale model of the screen, not a
render at the size of your editor pane, and a small widget in a responsive
layout used to compose differently in the two.

## Editing a console in place

A console has a quiet **Edit** button in its corner. It opens the same editor
this page describes, on the same URL — entering edit mode deliberately creates no
history entry, so Back leaves the console rather than stepping through edit
toggles.

**Done** returns you to the live console, and edit mode belongs to the console
you opened it on: switching to another console tab lands on that console, live,
not in its editor.

## Multiviews

A custom view filled with **Embedded screen** objects is a producer overview: one
tile per screen, each showing what that display is currently routed to, and
following along the moment somebody changes the routing — no edit to the layout
itself.

**Embedded screen** follows a display; **Embedded view** pins one view wherever
it is placed, whatever that view's own display later gets routed to. Dashboard,
stage and SPL rundown views are configured per display rather than per view, so
an Embedded view pointed at one says so instead of rendering it — Embedded
screen is the only way to bring one into a tile.

A screen tile's status dot means only that the screen is **routed to a view and
not blacked out**. It is not a "connected" light: nothing in the app knows
whether a browser is actually open on that display, so the dot never claims it.

On an interactive surface — a console, or a screen set to panel mode — each tile
carries a small button in its bottom-right corner that expands it to fill the
window; Escape or the panel's close control brings it back. A wall display draws
no such control at all, so a tile there cannot be expanded — an overlay a
passer-by opened would stay open until somebody walked over to close it.

Views may be nested three deep, and a view cannot contain itself, directly or
through another embed in between — a tile that would loop draws a notice
explaining why instead of rendering.

## Look: surface and tint

Two independent questions, in that order.

**Surface** is the material — None, Glass, Solid or Outline. It owns the border,
the corner radius and the shadow.

| | |
|---|---|
| None | no card at all; the widget sits straight on the screen |
| Glass | a translucent card — what is behind shows through |
| Solid | an opaque card, with a shadow under it |
| Outline | a hairline border and nothing behind it |

The surface you pick is **stored**, not worked out from the fields afterwards. So
tinting a Glass widget, rounding its corners or giving it a colour of your own
leaves it Glass, and the dropdown goes on saying Glass.

**Tint** is the colour on it, and owns only the background. Any surface can wear
any tint, so a red Solid and a green Glass are both reachable. The row is called
**Fill** on a Solid, because a solid *is* its colour rather than being washed
with one.

A tint is resolved against the surface it lands on: translucent over Glass, so
tinted glass is still glass and the canvas still shows through, and opaque
everywhere else. The swatch shows the hue; the surface decides the strength.

The last dot in the row is a colour wheel — any colour you like. It stays yours:
changing the surface afterwards keeps it rather than resolving it back to a tint.

## What a widget's look is made of

Surface, colour, radius, border, font and alignment. That is the whole list.

Elevation, opacity, padding, text shadow and max-lines used to be here and are
gone — from the model, not just from the panel. They were five ways to make a
widget look slightly wrong: a drop shadow under a card on a black wall is
invisible, an opacity below one is a legibility problem waiting for a service,
and the stored padding was what made small widgets clip, because the readout
composition draws its own. How a widget uses the space it is given is the
composition's job.

Objects created before the surface list was cut down wear an older card —
`#191919` with a 10% hairline — while everything since wears `#141414` with an
8% one. Both are cards; they are cards from two different years, and a layout
built across both reads as some widgets having a border and others not. They are
folded into the current card once, on load, and the server logs how many under
`[layout-defaults]`. A ground you picked yourself is never touched.

## Picking a colour

Every colour control in the app — text, fill, border, tint, a slot's colour, the
brand accent, an icon's tint — is the same panel: a saturation square, a hue
slider, an opacity slider where opacity means something, a hex box you can type
or paste into, and the palette the app itself is built from.

It replaces the browser's native colour input, which could not be themed, could
not express an opacity at all — a translucent ground had to be typed as a string
somewhere else — and on a wall-mounted touch screen opened a system window over a
live dashboard.

Colours are stored as hex while they are opaque and `rgba()` once they are not.
Changes apply as you drag, so the canvas behind the panel shows the result rather
than waiting for it to close.

**Saved colours.** Under the palette is your own: **Save** keeps the colour in
the panel, and it is then in every colour control in the app — the church's
green, a sponsor's blue, whatever this year's stage is. They live on the server,
not in one browser, so a colour mixed on a laptop is there on the tablet by the
desk, and they ride along in the config backup. The same button forgets one when
that colour is showing. Two dozen are kept; saving past that drops the oldest and
says so.

## Selection

Only the selected object is outlined and named. Hovering shows a faint outline
so an object with nothing to draw — a readout with no data, an empty shape — can
still be found without clicking blindly.

## Reset to default look

In the inspector, under **Style**. Puts the object's look back to the default for
its type.

It replaces the style rather than merging into it, so hand-tuned fields are
genuinely cleared. Position, size, configuration and the responsive settings are
left alone, and it can be undone.

Cards are **opaque**. They used to be a few percent white, which looks the same on
a bare canvas but does not cover anything — a widget over a transcript let the
text read straight through it, which looks exactly like a broken layer order.
**Glass**, under Style, is the deliberate see-through look if you want one.

## What changed on your existing layouts

**Card grounds become opaque**, as described above — once, on the first start
after upgrading, and never again. The server logs what it changed, under
`[layout-defaults]`. It is an ordinary style field afterwards: change it on any
object and it stays changed.

Readouts created before the left default also carry a centre alignment nobody
picked. That is left alone rather than cleared: the file cannot tell a default
apart from a decision, and a pass that cleared it also cleared the alignments
operators had set — on every restart, which is every update. Set one of those
widgets to whatever you want; it will stay.

## The inspector's width

Drag its left edge; double-click the edge to go back to the default. It goes as
narrow as the rail on the other side of the window, and the controls condense to
suit: below about 248px each row puts its label above its control and the
controls wrap, so a swatch row or a set of stepper fields takes two lines instead
of running off the edge. Nothing is hidden at any width, and the panel never
scrolls sideways.

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

The inspector is measured the same way and for the same reason — container
queries do not exist in jsdom either. Drag it to its minimum, select one object
of each kind, and compare the panel's `scrollWidth` with its `clientWidth`.

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
