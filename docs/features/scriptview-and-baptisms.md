# ScriptView and Baptisms

Two operator surfaces built on the Planning Center plan.

# ScriptView

A rundown dashboard at `/scriptview` — every plan item with the note columns your
department cares about, section headers, lengths, a clock and a live countdown.
The current item highlights while a service is running.

Pick a service type from the landing page and it opens at a readable, shareable
URL (`/scriptview/weekend/audio`) you can pin in its own tab. The clock follows
the plan's timezone.

Configure it under **Settings → ScriptView**, with a live preview.

## Where the rundown can appear

The same table renders in three places, from one implementation — so a column set
you define once looks identical wherever it shows up:

| | Follows | Columns from |
|---|---|---|
| **The `/scriptview` pages** | the service type in the URL | the layout in the URL |
| **A Script view** on a display | the app's active plan | its **Columns** setting |
| **An Embedded view object** inside a custom layout | the app's active plan | the Script view it points at |

The third is how you put the rundown under your own objects on one screen instead
of stacking two browser tabs. Add an **Embedded view** object to a custom layout
and point it at a Script view.

The embed shows the rundown only — no back arrow, no layout switcher, and the
Prev/Next controls are always off so a stage monitor cannot drive the live
controller. Its header (plan title, countdown, clock) is off by default, since a
layout usually has its own; turn it on per object.

Custom views cannot be embedded. That is what stops an embed containing an embed;
use a container to compose objects within one layout.

## Layouts

A layout is a set of columns — Audio, Video, Lighting, and so on. Layouts are
global: define one and it works across every service type.

Each has per-element toggles for the clock, item time, song key, BPM,
arrangement, item notes and total time.

## Category roles

Planning Center note categories are defined per service type, and the names drift
— one church might have `Audio` on some types and `Audio/Visual` on others, plus
case and spelling variants of the same department.

A **role** is a named, ordered set of those category names:

```
Audio    →  Audio, Audio/Visual
Guitars  →  AG, EG, EG 1 (Lead)
```

Layout columns reference roles rather than raw category names, so one layout
works everywhere.

**Resolution:** the role's non-empty members, joined in order. If the first member
has no note the next one shows; if several do, they merge. Member order is the
priority, and you can reorder it.

A role whose members a service type doesn't define is hidden rather than shown as
an empty column.

**Managing them:** Settings → ScriptView → Category roles. Rename, add or remove
members, reorder. Two diagnostics flag problems you would otherwise notice only by
absence — categories in no role (which can never appear as a column) and
categories in more than one (ambiguous, since two columns would claim the note).

Seeding creates one role per category, containing only itself. Merging is always
your call — automatic keyword matching guesses badly, and a wrong merge hides a
department's notes with no visible cause.

## Row colors

Each layout picks one source for its row color, under **Row color**:

| | Rows tinted by |
|---|---|
| **From PCO** (default) | Planning Center's own item colors — song, header, media, custom types |
| **By category** | a note category you choose, wherever it has a note on the item |
| **None** | nothing |

A running item always outranks the tint.

**From PCO** remaps rather than copying: PCO's swatches are pale pastels made for a
white table and would read as near-white on a dark panel, so each hue maps to a
colour chosen for a dark surface. Add a colour in PCO and rows follow within
fifteen minutes, including new custom item types.

**By category** can use any category the service type defines, not just the columns
this layout shows — "Lighting has a cue here" is useful to a stage manager without
showing the cue text. Colours are assigned from the category name and are not
configurable, since Planning Center has no colour for a note category.

## On different screens

ScriptView renders on stage panels, laptops and phones, and changes shape rather
than centring a fixed column:

| Width | Shape |
|---|---|
| under 640 | stacked blocks, each column labelled |
| 640–1024 | table without the clock column |
| over 1024 | every column, full width |

# Baptisms

An operator page at `/baptism`, also available as a Settings tab. The workflow is
grouped — all testimonies first, then all baptisms.

Sessions are named by service and cross-linked into Service History with
per-person splits and averages. A **Baptism timer** layout object puts the live
count and timer on a display.

## Starting from the plan

The timer can start itself, since the two ends of a baptism differ:

- **Testimonies** happen during an item named the same thing every week, so a
  **keyword** finds it. Set it under Advanced; off by default.
- **Baptisms** happen during whichever songs are on that week, so no keyword can
  find them. Bind that end **to an item on the plan**, on the Baptisms tab.

Binding both ends is also more accurate than a manual button. Between testimonies
and baptisms there are usually several minutes of vows and prayer; started from the
item the baptisms actually happen during, that gap belongs to neither phase.

Auto-start only moves forward — idle → testimonies → baptisms. It never restarts
and never fires into a phase already running, so a re-fired item or a plan re-sync
cannot wipe a session underway. The operator page shows which item started it,
with reset one tap away.

**It leaves itself alone on ordinary weeks.** Neither trigger can fire without
something to fire on: the keyword only matches an item that exists, and per-plan
bindings only exist on plans you set them on. So the setting can stay on all year.

Keep the keyword specific — plain "baptism" would catch a "Baptism class signup"
announcement where "baptism stories" would not. The Baptisms tab states, for the
plan currently loaded, which item will start each phase or that nothing will.

## Pause

The clock can stop for the talking between people without that time landing on
anyone. A segment is time already banked plus time since it last resumed, and both
the operator page and the display object read the same fields, so a paused clock
shows the same everywhere.
