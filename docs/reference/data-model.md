# Data model

The nouns the app is built from.

## Views and displays

A **view** is content you build. A **display** is a physical screen at its own URL,
routed to exactly one view. One view can drive many displays, so content changes in
one place.

View kinds:

| | |
|---|---|
| **Slots** | the mic channel grid — its own slot set per service type |
| **Dashboard** | clock, service countdown, ProPresenter now/next |
| **Stage** | confidence view — slide text, section, chords, thumbnail, timers |
| **Captions** | full-screen auto-scrolling transcription |
| **Script** | the full rundown with note columns, headers, lengths, live countdown |
| **SPL Rundown** | a compact item-plus-level list for the live service |
| **Custom** | a layout you design in the visual editor |

## Surfaces: displays and consoles

A view also declares what it is **for**, alongside its kind:

| | Display | Console |
|---|---|---|
| Where it renders | a screen at its own URL | the app, or a screen set to panel mode |
| Controls | never fire | live |
| Editing (notes, checklists) | read-only | live |
| Drill-down | no | in the app only |
| Audience | anyone walking past | the operator |

A screen has a matching **mode**. It is a read-only `display` unless deliberately
set to `panel` — the way a control surface is built. Only a panel may show a console
view, and that rule is enforced by the server, not just the picker: a wall screen
cannot end up rendering a live button by accident.

Converting a view that screens are currently showing is refused, naming those
screens, rather than silently unbinding them.

Only **custom** views can be consoles: the built-in kinds have no editable layout,
so there is nowhere to put a control.

### Home

Home is a view too, but a deliberately odd one. It stores which widgets the front
page shows, their order, and each one's size and visibility — and **nothing else
about it is read**. Every object's position is filler the type requires; Home has
no canvas, because a grid of tiles has no geometry to arrange.

Home is edited in the Home tab itself, with the pencil in the header. In edit
mode each tile gains a size picker, a visibility select, a remove button and a
drag handle, and **Add widget** offers the whole object registry.

The widgets come from the same registry every other surface uses, so a Home tile
and a stage-display widget are the same component — anything you can put on a
wall you can put on Home. Sizes are fixed shapes on a three-column grid:

| Size | Columns × rows |
|---|---|
| **S** | 1 × 1 |
| **M** | 2 × 1 |
| **L** | 2 × 2 |
| **XL** | 3 × 2 |
| **Tall** | 3 × 4 |

Each tile also carries when it should appear: always, only while a service is
running, or only the rest of the week.

On Home a widget wears Home's card — the app's radius, hairline and surface —
rather than the dark ground and canvas-relative geometry its styling carries for
a wall. Colour that reports STATE still shows (a recorder's red while recording);
colour that is decoration does not, so one grid of tiles reads in both themes.

A widget removed stays removed, including across a restart. A build that adds one
gives it to installs that have never edited Home, and leaves an edited Home
alone.

### Upgrading an existing install

Nothing has to be done by hand. On first start, any view containing a button
becomes a console and the screens showing it become panels, so a control surface that
worked before still works. What moved is written to the log, so a stray control
left on a wall display years ago can be spotted and set back deliberately.

## Object capabilities

Every layout object declares what it can do — render data, invoke an action,
open a route, or write back — and where it is rendering decides which of those
are live. That is what makes the same layout safe on a wall and useful on a
panel.

Control objects invoke an entry in the **automation action registry**, the same
one automation rules fire. One place to add a capability; a rule reaches it on a
trigger, an operator reaches it on a press.

**Notes** and **checklists** hold what an operator types. That content is stored
separately from the layout (in `notes.json`, keyed by object) so it survives
renaming or rearranging a view, and it is treated as configuration — it rides
along in every backup.

## Slots

A slot is one channel strip. It carries a channel label and a link deciding who it
shows: a Planning Center position, a specific person, a static label, or empty.

A slot can bind to a wireless channel so the screen shows that pack's RF and
battery beside the person, and slots can stack into a shared column — mirroring two
people on a dual-bay charger.

Details in [slots](../slots.md).

## Custom layouts

A fixed design canvas (1920×1080 by default) of positioned objects. Positions and
sizes are stored as fractions of the canvas, so a layout renders identically at any
resolution.

Objects include the clock, countdown, slide text and notes, slide thumbnail,
section chip, mic-slot grid, transcript, SPL meter, charger battery, live plan
controls, logo, image, plan file, shapes, text, people counter and graph, OBS
status, OSC button, integration status, wireless summary, caption filter, baptism
timer and service order.

**Containers** are boxes that hold other objects. A child's position is a fraction
of its container, so moving or resizing the container moves and scales its contents
together, nesting up to two levels. Drop an object onto a container to nest it.

**Card presets** apply the built-in dashboards' rounded tile look — fill, border,
radius, padding — to any object in one click, and **Flat** clears it. **Start from
Dashboard** builds the dashboard as editable tiles to work from.

**Plan file** shows a file attached to the current plan, such as the stage plot. It
matches by filename across everything on the plan, so it follows the live plan week
to week without re-pointing. PDFs and images both render. The rendered image can be
cropped, trimmed of its page margin, given a background treatment, or have the
object box fitted to its aspect ratio.

## Presets and templates

**Layout templates** are named custom layouts saved to a reusable library. **Slot
presets** snapshot a slot arrangement by name. Both are global and can be recalled
onto any view or service type.

## How state reaches a screen

The base state is pushed over one event stream. High-frequency data — the
countdown, the current slide, transcripts, and per-slot telemetry — rides separate
channels so a screen renders and recovers from each independently.

The countdown matches Planning Center's own behaviour: it counts down to the
service start, then per item, going red and negative when an item runs over.
