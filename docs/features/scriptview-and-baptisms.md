# ScriptView and Baptisms

Two operator surfaces built on the Planning Center plan.

# ScriptView

A rundown dashboard at `/scriptview` — every plan item with the note columns your
department cares about, section headers, lengths, a clock and a live countdown.
The current item highlights while a service is running. That address and the
rundowns under it render without the app's sidebar and header, for a stage
tablet; the same launcher with the chrome is **ScriptView** in the sidebar, at
`/scriptview/manage`.

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

The embed shows the rundown only — no back arrow and no layout switcher. Its
header (plan title, countdown, clock) is off by default, since a layout usually
has its own; turn it on per object.

**Follow the live item** (on by default) scrolls the rundown to keep Planning
Center's live item on screen, so a plan longer than the box does not need anyone
to walk over and touch the display. It only ever scrolls the embed itself, never
the layout around it. Turn it off for a box deliberately parked on the top of the
plan — a pre-service checklist, or one only tall enough for a row or two.

**Font size** is the object's own, and starts at the size the ScriptView page
renders at so the two match. Reach for it when a dense column set needs more rows
on screen: row height is driven mostly by how many columns are shown, because
notes wrap inside narrow ones. Choosing a **Columns** preset on the Script view
gains far more rows than shrinking the type does.

An **Embedded view** object can point at any view, including one holding a custom
layout of its own — nested up to three deep, and a view cannot embed itself; a
tile that would loop draws a notice instead. See
[Multiviews](../reference/layout-editor.md#multiviews) for building a wall of
such tiles. Within one layout, a **container** is still how you group objects so
they move and resize together — it has nothing to do with embedding another
view.

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

An operator page at `/baptism`. It opens in
**grouped** mode — every testimony first, then everyone baptized in turn across
the songs that follow — because that is how a baptism service runs here: the
testimonies happen inside one plan item (typically "Baptism Stories"), then
people are baptized one at a time while the room sings. **Per-person** (a
testimony immediately followed by that person's baptism, repeated for each
person) is still there, picked with the Workflow toggle on the page; the toggle
only responds while the session is idle, so a mode can't be changed out from
under a session already running — and the choice persists: it is part of the
idle state saved to disk, so the next launch reopens in whatever mode was last
left. Only a data directory with nothing saved yet — or a saved state old
enough to predate the mode field at all — has no such state to read, and opens
in **grouped**; that fallback (`baptismDefaultMode`) has no setting screen of
its own, so it changes only if someone edits the settings file directly.

Sessions are named by service and cross-linked into Service History with
per-person splits and averages. A **Baptism timer** layout object puts the live
count and timer on a display.

## Header and figures

The header stays visible while the page scrolls: the title **Baptisms**, a
green **recording** pill whenever the session isn't idle — running, paused, or
armed and waiting for the first person — and a line naming the service and
date, or "No session running" before a first session, or "Session finished"
once one has closed. **Copy report** copies a plain-text summary of the
current or just-finished session to the clipboard; **Export CSV** downloads
every baptism ever recorded (the same multi-sheet export History uses, scoped
to this one sheet).

Six figures sit under the title — **Baptized**, **Timed**, **Wall clock**,
**Not counted**, **Avg testimony**, **Avg baptism** — customizable like every
figure strip in the app, all six shown by default. Hovering a segment on the
Session chart below replaces them with that segment's own person, phase,
duration and boundary times until the pointer moves on.

A nav under the strip jumps to **Timer**, **Session**, **People**, **Past
sessions** and **Trends**, highlighting whichever one is on screen.

## The Session chart

Beneath the timer, a **Session** card draws the whole session as two lanes on
one time axis: the timer lane (every testimony and baptism, oldest first) over
the plan lane (the plan items live while it ran). Stretches the timer lane does
not cover — the armed wait for the first person, an explicit pause, the walk to
the water — are drawn as gaps reading "not counted", never hidden. Putting the
plan on the same axis is what answers *how much of the song set did the
baptisms take*: the dunks spread across several songs, and no single lane can
say that on its own. Hover a segment for its person, phase, duration and
boundary times on the header's stat strip.

The chart is live while a session is running, refetching only on the timer's
own presses rather than on a timer; a finished session's own recorded window
stands in for "now" at the right edge. A session with no service open draws
nothing and says so; one with no raw rows recorded for it (an older session,
or one the archive never saw) says that instead of drawing an empty lane.

## People, Past sessions and Trends

Below the Session chart, a **People** card lists everyone timed in the current
(or just-finished) session — a number, testimony, baptism and total, plus a
split bar showing how much of each person's time was testimony versus baptism.
In grouped mode, someone who has testified but has not yet been baptized shows
a dash under Baptism rather than `0:00`, which would otherwise claim a baptism
that has not happened yet took no time.

A **Past sessions** card lists every finished session, newest first: the
service and date, then how many were baptized, the average testimony and
baptism length, and the total. Each row with a known service links to that
service's page in Service History; a session recorded before that link
existed has no service key to link with, and renders without one rather than
a broken link. Delete removes a session after confirming — its raw rows in
`baptism.csv` are untouched, so it can still be replayed once a rebuild action
exists for baptisms (see Recovery, below).

A **Trends** card averages the last eight sessions against the eight before
them, across four figures: baptized per service, average testimony, average
baptism, and the whole segment's wall-clock length — what a planner budgets
for next week, since it includes the walk to the water and every gap the
timer lane draws as "not counted". Below three prior sessions to compare
against, a tile shows its figure with no change against it, rather than a
percentage or a delta computed from too little history to mean anything.

## Starting from the plan

The timer can start itself, since the two ends of a baptism differ:

- **Testimonies** happen during an item named the same thing every week, so a
  **keyword** finds it, matched on this same tab. Off by default.
- **Baptisms** happen during whichever songs are on that week, so no keyword can
  find them. Bind that end **to an item on the plan**, on the same tab.

Binding both ends is also more accurate than a manual button. Between testimonies
and baptisms there are usually several minutes of vows and prayer; started from the
item the baptisms actually happen during, that gap belongs to neither phase.

Auto-start only moves forward — idle → testimonies → baptisms. It never restarts
and never fires into a phase already running, so a re-fired item or a plan re-sync
cannot wipe a session underway. The operator page shows which item started it,
with reset one tap away.

It also reports only a transition that actually happened. Arming the baptisms
only means something in grouped mode; a baptism item going live while the timer
is in per-person mode — where there is no grouped baptism section to enter —
changes nothing, and says why (see Logging, below) rather than doing nothing
silently. An item whose trigger could not be honored is not treated as settled,
so a later tick tries it again once the operator switches the mode — PCO can sit
on one song for minutes, and only a retry lets the fix actually take.

**It leaves itself alone on ordinary weeks.** Neither trigger can fire without
something to fire on: the keyword only matches an item that exists, and per-plan
bindings only exist on plans you set them on. So the setting can stay on all year.

Keep the keyword specific — plain "baptism" would catch a "Baptism class signup"
announcement where "baptism stories" would not. The Baptisms tab states, for the
plan currently loaded, which item will start each phase or that nothing will.

## Armed, then running

Grouped only. The baptism phase begins either by pressing **Start baptisms**,
once every testimony is in, or by the bound song going live — and neither one
starts a clock: the phase becomes `baptism`, but nobody's time is counting yet.
The band's intro before the first person steps up would otherwise land on
person 1 alone, every week. While armed, the readout says so directly — the
heading reads **Baptisms · armed**, the clock holds at `0:00`, and the line
under it reads "waiting for the first person to step in" — so a frozen clock
does not read as broken.

The operator's own press ("First person in") starts person 1 without banking
whatever the intro ran. Every person after that runs the same way, from their
own press ("Next person in", then "Last person out" for the last one) to the
next — the walk-up, the words spoken over them, the dunk, and getting out, never
the moment of submersion by itself. There is nothing to pause while armed, so
that button is hidden until the first press.

Undo takes back these presses one at a time, latest first. After "First person
in" it returns to armed: person 1's clock is thrown away and everyone who
testified is still waiting, so the next press starts person 1 over. While armed,
it returns to the testimonies, where the last testimony picks up from the time it
had already banked. Undoing "Next person in" or "Last person out" returns to the
person who was being baptized, with their clock starting over from the Undo
press.

## Pause

The clock can stop for the talking between people without that time landing on
anyone. A segment is time already banked plus time since it last resumed, and both
the operator page and the display object read the same fields, so a paused clock
shows the same everywhere.

## Undo

Undo takes back the last press. It never leaves the session broken — there is
always somewhere it can resume from — but the two phases differ in what
survives: a press that lands back in a testimony resumes it from the time
already banked, so it costs nothing; a press that lands back in a baptism, or
in the armed wait before one, discards whatever that segment had counted and
starts it clean — from the Undo press if a clock is now running, from a frozen
`0:00` if it lands in armed. After Finish it reopens the session where Finish
was pressed: the testimony that was running, the person mid-baptism (the same
clean restart), or — in a grouped baptism section nobody had stepped into yet
— the wait for the first person, with no clock running.

## Recovery

Every press on the timer appends a row to `baptism.csv`, the same append-only
file the rest of the archive uses. A session that `baptism.json` loses — a
corrupt file, or a crash between the debounced save and the next write — is not
gone: it can be replayed from those rows. The derived record is a cache of what
the presses already said, not the only copy of it — but unlike an item's
recorded timing, there is no **Rebuild from raw** entry for it yet, so that
replay is not something an operator can trigger from the app. See
[Data archive](../data-archive.md) for the column list, which presses are
recorded, and what the append-only rule buys the rest of the archive.

A save that fails says so. If Finish cannot write the session to
`baptism.json`, the Timer card shows why, under the readout, and keeps showing
it — through the next Start and the Workflow toggle too — until that same
session saves successfully, Reset clears it, or **Dismiss** on the note does.
A different session saving cleanly does not clear it; the note stays up until
the session it actually names is saved, reset, or dismissed. Past sessions
does not list that session; its rows in `baptism.csv` still hold it, if a
service was open while it ran.

## Logging

Failures and skipped auto-start actions are logged under `[baptism]`, so a
Sunday-morning check of the log names the actual problem instead of a blank
timer:

- `auto-start: started testimonies from "…"` / `armed baptisms from "…" — no
  clock runs until the first press` — a keyword or a bound item moved the timer,
  and to where.
- `auto-start: "…" is bound to the testimonies/baptisms but the timer is in
  <mode> mode and stayed in "…" — ignored` — the trigger fired but the timer's
  mode couldn't honor it (see Starting from the plan above); it is retried on
  the next tick rather than being marked done.
- `raw: no service open, session not archived` — an action ran with no service
  recording open, so nothing was written to `baptism.csv` and the action will
  not survive a restart.
- `raw: emit failed: <event> …` — the timer's own state updated, but writing its
  row failed; only the row is missing, not the action.
- `[baptism-timer] persist failed: …` — the debounced save of the in-progress
  state to `baptism.json` failed; nothing reaches the screen for it, since the
  state in memory is still correct — only a restart before a later save
  succeeds would resume from an older point than the last press.
- `[baptism-timer] session save failed: …` — Finish could not write the session
  to `baptism.json`. The Timer card says so as well (see Recovery, above).
- `[baptism-timer] save failure dismissed: …` — the operator dismissed that
  note, so it is no longer on screen.
- `next: ignored, the restored session has nobody at baptismIndex …` /
  `undo: ignored, the restored session has nobody at baptismIndex 0` /
  `finish: closing with nobody at baptismIndex … — no person-complete row
  recorded` — a press landed on a session that was restored into a shape it
  should never be in; the press did nothing (Finish still closes the session,
  just without a row for whoever was mid-baptism).
- `could not load past sessions: …` — the Past sessions and Trends cards'
  fetch failed; both say so on screen rather than reading as no history.
- `delete session <id> failed: …` — a delete did not reach the server; the row
  is restored and the operator sees a toast rather than a change with no
  explanation.
