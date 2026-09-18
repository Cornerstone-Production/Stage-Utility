# Attendance and service history

Every service is recorded automatically — attendance, sound levels and item
timing — and browsable afterwards under **Settings → History**.

## What gets recorded

Three recorders run while a service is live, keyed to the plan and the specific
service time so a 9am and an 11am stay separate. They finalise at the plan's
service-end marker and are reconciled on startup, so a restart mid-service does
not lose the record.

While Planning Center reports a service live, **nothing time-based can stop it
being recorded** — no clock, calendar or time zone. A recording ends only when the
plan leaves item mode or reaches its service-end marker. Wall-clock checks apply
only to *starting* a record: a plan more than 12 hours from now is treated as
rehearsal and is not recorded, so stepping through next Sunday's plan during the
week creates nothing.

| | |
|---|---|
| **Attendance** | building occupancy, sampled every 30s |
| **SPL** | max and Leq per plan item, per metric |
| **Timeline** | when each item actually started and ended, against the plan |

Baptism sessions are stamped with the service that was open when they started, so
they land on the right occurrence.

### Back-to-back services on one plan

Two service times on the same plan are two records. Planning Center reports which
occurrence is current, and that id is part of the record's key, so the 9am and the
11am never share a record even though they share a rundown.

The occurrence Planning Center reports can also change *during* a service: a
service running past its planned end rolls on to the next occurrence, and so does
a momentary Planning Center cache miss. Neither may split a recording in progress.
So the change is judged by the new occurrence's own start time — the open record is
held only while that occurrence is still more than ten minutes away, and closed and
replaced once it has started or is about to. Where no start time is available the
decision falls back to the gap since the last live item: under ten minutes holds,
longer splits.

Each decision is logged once, whichever way it goes:

```
[service-recorder] service-timeline-recorder: service time 1001 → 1002, holding the open record (next occurrence starts in 25 min)
[service-recorder] attendance-recorder: service time 1001 → 1002 began at 11:00:00, closing 100:200:1001 and opening a new record
```

Inside a record, a plan item that goes live again more than ten minutes after its
last run ended is recorded as a second entry rather than reopening the first, so a
re-run never rewrites what already happened. Both the timeline and the SPL
recorder do this, and each says so:

```
[service-timeline] "Doors" went live again 71 min after its last run ended — recording it as a new entry
[spl-recorder] "Doors" went live again 71 min after its last run ended — recording it as a new entry
```

So a re-run is its own row in the per-item SPL table, with its own max and Leq —
a reprise is not averaged into the earlier performance, and neither is a second
service's item where an occurrence split was missed. A rebuild from the raw
archive splits the same way, on the same ten-minute gap between one item's
samples, so a mid-service restart cannot merge two runs back together.

Stepping back to an item within that window still reopens it, which is what an
operator jumping to the previous song expects.

## Reading it back

The History tab opens on **All services**: a Trends card, then a calendar beside
the day's services. Open a service for its own page, described after it.

### All services

**Trends** leads the page. One tile per service type, showing a sparkline of the
busiest service on each of the last eight **days** that type recorded, the
average across them, and the change against the days before.

The comparison uses whatever prior days there are, up to eight, and says how
many — *+6% vs prior 3*. Below **three** prior days it reads *no prior window
yet* instead: one or two readings are not an average, and a percentage off them
is noise wearing a direction. Because the count is always on the label, a thin
comparison is visible as one rather than passed off as a full eight. The tiles
sort busiest first.

The switch at the top right chooses what is plotted:

| | |
|---|---|
| **Attendance** | peak people in the room, the default |
| **Sound** | the loudest reading on your primary Smaart metric — the same metric a day-list row names, chosen the same way |

Everything below follows the switch: the tiles average decibels, the axis
becomes a dB band framed on the levels rather than anchored at 0, and the
figures above the plot read *Loudest* instead of *Busiest*. A service type that
recorded attendance and no sound keeps its tile and says *no sound recorded*
rather than disappearing when you switch. The choice is remembered per browser.

Everything is counted **per day, at the day's highest reading** — the busiest
service, or the loudest. A church running a 9, an 11 and a 6 records three
figures every Sunday, and attendance is people in the room: summing them
double-counts the family who came to one, and averaging them answers "how full
was a service" when a trend asks "how many came". A peak level does not average
either. The tile's average and a point on the line below it are the same kind of
number for that reason.

Under the tiles, one chart of every service type across the chosen range — 8, 16
or 52 weeks, defaulting to 16, remembered per browser. The **line** runs through
each day's highest reading; a **dot** marks every individual recording, so a week
that stood for three services still looks like three. A recording with nothing
under the current measure is not plotted at all, because a service nobody counted
is not a service of nobody, and one with no meter running is not a silent one.

The sound measure reads each recording's peak from the **SPL summary**, which
this page already loads — not from the per-item records. The chart plots one
point per recording across up to 52 weeks, and reading a full record for each
would be hundreds of files to answer one number apiece.

**Milestones** are marked under that chart: a small triangle, a dashed guide up
the plot, a short label where there is room for one, and the full label on hover.
They come from two places, and draw alike:

- **Your own list**, in Settings → Advanced → Data → History milestones. A date,
  a label, and optionally one service type. "Moved to two services", "new
  building" — the reason a step in the line is there.
- **Series changes**, derived: wherever a plan's series title differs from the
  previous recording of the same type. The first series a type ever records is
  not a change, and a plan with no series title is stepped over rather than
  counted as leaving and rejoining one.

A milestone scoped to **one service type** draws only while that type's line is
on, in that line's colour. One that applies to everything stays neutral — a
colour would claim a series it has not got. The legend under the chart is the
switch: clicking a service type takes its line off, and its milestones with it.
That choice is remembered per browser, like the range.

Each mark is focusable as well as hoverable, and carries its full label as its
accessible name: the triangle is a few pixels of glyph holding the only copy of
a sentence.

Milestones never appear on a single service's chart. They are statements about
the history, and one drawn across a Sunday morning would read as something that
happened during that service.

A milestone is refused, with the reason, when its date is not a real calendar
day, when its label is blank or longer than 60 characters, or when it names a
service type nothing has ever recorded — each of those would store a row you can
see in Settings and a mark that never appears. One that reached the file another
way — a hand edit, a restored backup — is skipped rather than drawn at a date
nothing happened on, is **left in the file** rather than deleted by the next
save, and the server names it on a `[history]` line.

If the milestone list cannot be read at all, the card says *milestones
unavailable* and the reason is logged. The derived series-change marks still
draw.

The **calendar** shades a day by how many services were recorded on it, in four
steps, with everything at four or more on the darkest. There is no dot and no
count in the cell: the day number sits alone and the shade carries the rest,
with the count on the cell's tooltip and its accessible name. Today is outlined
in the accent and the selected day carries a heavier accent ring; neither fills
the cell, so the shade still shows underneath.

The **list** beside it is the selected day's services. Each row carries the start
time and service type, the plan title, the series and how many items ran, then
four figures:

| | |
|---|---|
| Peak attendance | the most people in the room at once |
| Ran | what the service ran; **Running**, counting up, while it is still recording |
| vs plan | its difference against the planned total — absent while recording, where most of a plan not yet run reads as a service running short |
| Peak *metric* | the loudest reading on the primary Smaart metric |

They are the service page's own figures, picked out of the same derivation, so a
row and the page it opens cannot quote different numbers for one recording. A
service whose attendance recorder opened before its first plan item went live —
the arrival ramp — is a simpler row saying how many are in the room so far.

Where there is no level, the row says **why** under the dash — *no sound
recorded*, *metric hidden in Sound*, or *sound unavailable* when the record
could not be read at all. The last one is its own case on purpose: a server that
was down is not a meter that was off, and the reason is logged on a `[history]`
line naming the service.

Below the list is an **Overview** of how the services themselves ran — how many,
their average length, average start against the scheduled time, and average
per-item overrun — plus the average sound level, which Trends does not plot.
Right-click it (or tap and hold) to switch the sound summary off or to pick the
Smaart metric it reports. It carries no attendance figure and no attendance
chart: Trends, at the top of the page, plots attendance over a chosen range, and
two charts of the same quantity over different windows disagreed with each
other.

The shared `/history` link shows the same figures; it carries no Delete.

### The service page

A sticky header, then three cards: **Rundown**, **Attendance** and **Sound**.
The two charts are the same chart, described below the header.

The header stays put while the page scrolls, so what you are looking at is
always labelled and every action is always one reach away. It carries, top to
bottom:

- a crumb back to **All services**;
- the plan title, and one muted line of series, service type, date and start
  time. While the recording is still open, a green **recording** pill sits
  beside it;
- one action group — **Edit times**, **Copy report**, **Merge**, **Rebuild from
  raw**, **Delete**, with Delete set apart as the one that cannot be undone.
  **Merge** appears only when there is another recording on the same day to
  merge into, and **Reset pacing** only while the service is live. The shared
  `/history` link carries Copy report alone;
- six figures, read left to right:

  | | |
  |---|---|
  | Started | when the first counted item went live, and how early or late that was against the scheduled time |
  | Planned | the counted items' planned total, and the time the service would end on it |
  | Actual | what it ran, its difference against the plan, and when it ended |
  | Avg overrun | the mean per-item difference, and how many items of how many ran over |
  | Peak attendance | the most people in the room at once, and how many came in during the service — the same two figures the Attendance card calls Peak and Entries |
  | Peak *metric* | the loudest reading on the primary Smaart metric, named after the metric it read |

  Started, Planned and Actual count up live while a service is recording. A
  record with no attendance or no sound shows a dash, not a zero;
- a nav over the three cards. The entries are ordinary links, so they work with
  the keyboard and with middle-click, and the one you are looking at is
  highlighted as you scroll.

On a phone the header stacks and the six figures scroll sideways in their own
row; the page itself never scrolls sideways.

On a weekend a baptism session links to, a fourth **Baptisms** card appears
between Rundown and Attendance. It is not in the nav — an entry that came and
went by the week would read as a fault.

### The service chart

One chart serves attendance and sound. Three parts, top to bottom.

**The stat strip** is the section's heading and its readout. At rest it shows the
figures you chose in Customize — attendance defaults to peak, lowest, average and
samples; sound to peak, the loudest item and the message's Leq. Point at the plot
and it becomes the time under the cursor with each line's value there. Point at an
item's block and it adds that item's number, title, what it ran and what it was
planned for. While the service is still recording it reads `LIVE` with the current
values, and a pointer anywhere on the chart wins over that — you asked about that
instant.

**The plot** draws one line per series with no fill behind the plot area. The
time axis is ticked every thirty minutes — every ten on a service under ninety —
on the clock's own half hours, so a service starting at 19:47 is ticked at 20:00
and 20:30.

Time before and after the service proper is hatched at 45°, with a hairline at
each boundary, so the arrival ramp and the emptying-room taper are visibly not
the service. Both charts take that window from the same place: the first plan
item that is not pre-service, and the attendance record's own end.

A line breaks wherever more than three minutes of **sampling** is missing, since
that means the counter was unreachable rather than that the room emptied. A line
with no sampling behind it — a reference line, a per-item step — is never broken
that way; it has no gap to have.

Attendance plots people in the room, in green, with a dashed reference line at the
service average.

Sound plots the **recorded samples**: `spl.csv` holds a reading per second, and
the chart reads them bucketed (see
[`/api/spl/history/:key/series`](../reference/api.md)). The solid line is each
bucket's loudest reading, with its gradient; the dashed line is each bucket's
energy average. Its y axis is chosen to frame the levels, never anchored at 0 dB.
While a service is recording the series follows the recorder's own broadcast
rather than a timer of its own: a re-read the moment a new item goes live, and
otherwise at most one every ten seconds. Between items the line grows by about a
third of a pixel on a two-hour plot, which is not worth re-reading the archive
for on every open tab.

A service with **no raw rows** — recorded before the raw layer existed, or with
its archive pruned — falls back to one step per plan item, each item's Leq held
flat across the time it ran. A read that FAILS is not that: the chart says
"Sound samples unavailable" and draws nothing rather than presenting a per-item
step as the whole answer, and the server logs the reason on a `[spl-series]`
line.

Either way an item's peak mark is a tick on the top edge of its block rather than
at the loudest instant, because the instant is not in the per-item record; hover
the block and the strip says what it peaked at.

**The item lane** is two rows under the axis: pre-service items outlined above,
in-service items filled below, each spanning the time it actually ran. A block is
labelled with the item's full title when it fits, otherwise with its rundown number
— the same number the table above uses — otherwise with nothing. A title is never
clipped or shortened, because a half-title names a different item. Below 600px the
lane keeps only the in-service row and labels become numbers.

Items that **overlap** — a reopened item, or a service whose occurrence split was
missed — stack onto their own lines rather than hiding under one another, up to
two extra. Hovering picks the topmost.

**Customize** is the sliders button at the section's right. It holds which series
to draw, which figures the strip shows at rest, and for sound which Smaart
metrics to surface.

The Smaart metric choice does more than pick table columns: the first one still
ticked is the **primary** — the metric the chart's line is read from when the
service has no raw samples, the one each item's peak mark and the strip's Peak
and Message figures report, and the one the raw series is requested for. Untick
every metric and the chart says so rather than drawing an empty plot.

The legend under the plot is the same choice as a row of buttons: clicking one
turns that series off and on, and it stays in step with Customize because both
write the same preference. A series that is off is still listed, struck through —
a legend that dropped what was off could never turn it back on.

Every one of these is remembered **per browser** — they are view preferences,
not recording settings: `attendance:visibleMetrics`, `spl:visibleFigures`,
`spl:visibleSeries` and `spl:visibleMetrics`. The Smaart metric list used to be
a server setting shared by everyone, so one person clicking a legend entry
changed what the next person saw; a browser that has never chosen is seeded from
that old setting once, so no existing selection was lost.

While a service is recording, the chart grows with it: new samples extend the line
in place, the newest stretch draws in, the live edge carries a pulsing dot, the
current item's block grows, and the time axis widens in ten-minute steps rather
than sliding on every sample. All of that motion is off when the machine asks for
reduced motion; the live edge itself stays, because it is information.

The overview's attendance trend can carry a second line: the **service SPL** for
each date, drawn behind the attendance curve on its own dB scale. Right-click the
chart — or tap and hold it, or tap the **⋯** in its corner on a touch device — to
switch it on and to choose which Smaart metric it plots — the list offers the
metrics your history actually holds, and defaults to the LAeq with the longest
averaging window the meter reports (LAeq 10 over LAeq 2 over LAeq 1), because that
is the steadiest number for "how loud was the service".

Hovering a point with a mouse shows its reading in a tooltip; on a touch device,
tapping a point pins that same reading in place — no hover needed — until another
tap elsewhere on the page clears it.

Each point is the service's equivalent continuous level, energy-averaged across
its plan items and weighted by how long each ran, so a 30-second welcome does not
count as much as a 25-minute sermon. Several services on one date combine the same
way. A date with no recording breaks the line rather than dropping it to zero — a
missing reading is not a quiet service. The setting is per-machine and off by
default; Home's **Recent services** widget offers the same two settings on its own
right-click (or tap-and-hold) menu, but only History shows the summary below —
Home stays headline figures only.

On History, while the line is on, the same right-click (or tap-and-hold) menu also puts an average
level under the average attendance, in the same shape: the level across settled
weekends, then the latest weekend against the four before it. The comparison is
a **dB difference**, not a percentage — decibels are logarithmic, so a percentage
of one says nothing about loudness — and it is never coloured, because a louder
weekend is not a worse one. A change under half a dB, below what most listeners
can tell apart, shows no arrow at all rather than a direction nobody could hear.
Both figures are energy averages. Weekends with no SPL recording are left out,
and the block is absent entirely when nothing in scope carries a level.

Above them is a KPI overview you can reorder and toggle sparklines on: service
timers, attendance, highest and lowest attended, day totals. On a baptism weekend
a Baptisms block appears alongside, showing people, total, testimony and baptism
times, and per-person averages.

Service windows are editable if a capture went wrong, individual items can be
excluded from the timers, and a service report is exportable.

The rundown itself is a table of every item as it ran: number, title, planned
length, actual, the difference, and the times it started and ended. An item
excluded from the timers is marked **not counted** and dimmed; one whose times
were corrected is marked **edited**.

**Edit times** also makes each item's own Started and Ended editable. An item
that recorded wrong — a pre-roll that reads eleven minutes because the plan was
still being shuffled in Planning Center — is corrected to what it actually ran,
and the row's Actual, its delta, and the header's Actual and Avg overrun figures
all follow. A corrected row is marked **edited**, with the recorded times in its
tooltip and a **Reset** beside it that puts them back.

The correction is an overlay, not a rewrite. The recorded stamps stay exactly as
the recorder wrote them, so Reset always has something to restore. Neighbouring
items do not move: shortening an item leaves a gap before the next one, visible
in the table, rather than inventing a time for an item nobody asked about. A
correction has to fall inside the recording's own window and end after it starts
— if the window itself is wrong, fix that first with the Start and End fields at
the top.

**Rebuild from raw**, in the header's action group, discards a recording's stored
summaries and derives them again from the rows in the
[data archive](../data-archive.md): item timings from the plan-item event rows,
sound levels from the SPL samples, attendance from the record's own samples. For
a capture the recorder got wrong — the raw rows are append-only and keep the
evening as it happened. Item time corrections survive it: they are an overlay
over the rebuilt run, not a change to it.

While a service is recording, **Reset pacing** (in the live service's detail
here, and beside the Previous/Next controls wherever the console offers them)
stops items before now from counting toward the Service pacing widget: items
that started before the reset are excluded, and the readout's baseline moves
forward to the reset instant. It touches only that one widget's math — the
recorded rundown itself is untouched, so nothing is deleted or re-windowed.
Available only while a service is live; the server refuses otherwise.

Two recordings of the same service — a run that overran its planned end and
rolled its tail into the next occurrence — can be merged back together, in either
direction. Attendance is stored per-service, so the two curves are re-expressed
against a common start before they are joined; the merged trend reads as one
continuous service rather than restarting at the seam.

## Attendance metrics

**Attendance** is people in the room. **Entries** is the door count, which
double-counts anyone who steps out and back — the two are kept separate.

A service's Entries is what the recorder counted **while the service was
running**, so the arrival ramp before it and the emptying-room taper after it
are not in it. History, the pasted report and the dashboard people widgets all
read that one figure.

Available on dashboards and custom layouts: in-room now, peak, low, per-service,
day total, percent of capacity, and versus average. The layout objects are a
people counter, a people summary with individually toggleable metrics, and a
people graph that shows either a live rolling window or a recorded service.

A gap of more than three minutes in the samples renders as a break in the curve
rather than a straight line, since missing samples mean the counter was
unreachable, not that the room emptied.

### Ramp and taper

Recording covers more than the service proper. Sampling starts during the arrival
ramp — the lead window before the service time, default 60 minutes — and continues
through a taper after the last item, also 60 minutes by default, so the curve shows
the room emptying. Both windows are set in Advanced.

Only the service proper feeds peak, low, average and last; the ramp and taper
would otherwise drag those figures toward an empty room — far enough that an
average over the whole recording can come out below the recorded low. A record
with no in-service samples at all, one still arriving or one that never went
live, has no average rather than the ramp's.

Where two services are close enough that one's taper overlaps the next one's
ramp, the ramp wins — the room is filling for the next service, not emptying
from the last.

A service shows up in History as soon as its attendance recording begins — up to
60 minutes before the scheduled start by default (the arrival-ramp window above)
— marked "arriving" with a running count of people in the room, and carrying the
same green **recording** pill a live service's page does. It shows the
Attendance and Sound cards and nothing else: there is no rundown, no KPI row and
no report until the first plan item goes live in Planning Center and the
timeline record opens, at which point the page becomes the full service page
without being reopened.

## Sound levels

Levels are energy-averaged (Leq), not arithmetically. Decibels are logarithmic, so
a plain mean understates a dynamic item by 8–15 dB.

Songs are identified from Planning Center's item type and prefixed `SONG: ` in
exports, so a filter isolates them.

## Excel export

**History → Export** writes one sheet per data set, each a real Excel table with
frozen headings and filter arrows. The filename covers the range you picked, not
the day you exported.

| Sheet | Shape |
|---|---|
| `SPL` | one row per plan item, every metric side by side |
| `SPL data` | one row per item per metric — the shape a PivotTable wants |
| `Attendance` | per service |
| `Baptisms` | one row per person, with testimony and baptism splits |

Both SPL sheets are real tables, so *Insert → PivotTable* opens with the range
already filled in. A `Service time` column distinguishes a 9am from an 11am on the
same date.

Blank metric cells are normal: columns are the union across everything exported,
so a service whose meter reported fewer metrics leaves the rest empty. Services
recorded before a given metric existed are blank for it.

For the raw samples behind these figures, see the
[data archive](../data-archive.md).
