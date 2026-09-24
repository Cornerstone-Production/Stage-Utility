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
last eight **days** that type recorded, the figure for the latest of those days,
and how that figure compares against the days before it **within the selected
range** — the same 8 / 16 / 52 weeks or All that bounds the chart below, named
in the card's subtitle.

The unit is a **day**, never a recording. A church running a 9, an 11 and a 6
records three figures every Sunday and the tile shows one, captioned *latest day
total* — or *latest day peak* under the sound measure — with the date of that day
beside it, so a type that has not recorded for three weeks does not read as this
week:

| | |
|---|---|
| **Attendance** | the day's services **added up**. The question a trend asks is "how many came", and the three services are three congregations |
| **Sound** | the day's **loudest single recording**. Decibels are logarithmic, so adding two services' peaks is not louder, it is meaningless |

#### What the tile means across a Sunday

The same tile means three different things through a morning, and the label
beside the figure always says which.

| | The figure | Compared against | Label reads |
|---|---|---|---|
| **More services still to come** | every service **started**, the finished ones plus the room right now | every prior day's **first N**, counting only days that ran N or more | *20 prior services* |
| **The last service is running** | the same — every service started | prior completed days' **full totals** | *30 prior services* |
| **The day is over** | the day's full total | prior completed days' **full totals** | *30 prior services* |

**N is services started, not services finished.** A service on air counts from
its first reading, wherever it sits in the day, so the figure climbs through the
morning rather than holding flat and stepping each time a service ends. Nothing
moves at the moment a service *ends*, either: the value simply stops changing.

The first two rows read as a deficit that closes as the room fills — a "how are
we tracking" number, and red for much of the hour on purpose. The last two share
a basis, so **the number does not jump when the last service ends**; only the
dashed line and its hollow node go away.

The first row is first-N because a full-day basis there shows a gap that
**cannot** close: the services that would close it have not run at all, so every
Sunday would read as the church halving until the evening service ended.
First-N closes honestly instead — today's part-filled service N climbs toward
the average of prior days' *complete* first N and lands near it. A prior day
only feeds that average if it ran at least N services: a Sunday that only ever
held two has no third to offer, and averaging its two in would drag the figure
down for a reason that is nothing to do with attendance.

A finished day is compared **whole against whole**, whatever each day ran. A
completed two-service summer Sunday is a two-service Sunday, not a partial three,
and comparing first-twos would hide exactly the seasonal change you are looking
for.

A morning falls back to the last day that had a figure only when it has none of
its own — a counter that has not reported yet, rather than a service that has
not finished. The date beside the figure says which day is being shown.

#### How a day is judged finished

In this order:

1. Something of that type is **still recording** — not finished.
2. The date is **not today** in the app's time zone — finished. The setting
   under Advanced, falling back to the **server's** clock when it is left on
   "follow server clock" — never the zone of the browser you happen to be
   looking from. Most Linux images run UTC, where the calendar date rolls at
   7pm in Chicago, and a laptop in Chicago reading a UTC server would otherwise
   end Sunday five hours before the server did.
3. It is today, and **no service time Planning Center lists for today has yet to
   start** — finished.

Where Planning Center has nothing to say — the integration is off, or no plan is
selected — the list is empty, so today is judged finished the moment its last
recording ends, and a running service is treated as the day's last. With three
services and no Planning Center that means the morning's first service is counted
live against whole days, which reads as a deficit until the day catches up.

Rehearsal times are not service times and never hold a day open.

#### The change figure

It is a **percentage** of the basis it is compared against — *+13% vs 12 prior
services*. Signed, green when it rises, red when it falls. Whole points for
attendance; tenths of a point for sound, where a real swing across a service is
usually a few percent or less and a whole point would round it away.

It is taken from the two figures the tile itself prints, both rounded to the
precision they show — whole people, tenths of a decibel — before the percentage
is taken, so it can never disagree with the numbers above it.

**The basis is counted in services, not days.** A first-N comparison and a
whole-day comparison can rest on the exact same prior days and still be worth a
different number: ten prior days is 20 services under a first-two basis, and
however many those ten days actually ran under a whole-day one. Counting
services carries that distinction on its own, with no separate word for which
basis produced it. The count is always the real one — taken only from services
that fed the average, never the day count times N — so a prior day a first-N
basis excludes for running too few services contributes nothing to it either.

**The range control governs it.** 8, 16 or 52 weeks, or All — the same buttons
that bound the chart, so a tile is compared against exactly the completed days
drawn underneath it. Below **three** qualifying days it reads *no prior window
yet* instead: one or two readings are not an average, and a change off them is
noise wearing a direction.

The tiles are ordered by the figure each one shows — the latest day, highest
first — so the order you read is the order of the numbers in it. The first type
seen in that order takes the first colour in the palette, once, and the
assignment is then frozen.

The switch at the top right chooses what is plotted:

| | |
|---|---|
| **Attendance** | peak people in the room, the default |
| **Sound** | the loudest reading on your primary Smaart metric — the same metric a day-list row names, chosen the same way |

Everything below follows the switch: the tiles read decibels, the axis becomes a
dB band framed on the levels rather than anchored at 0, and a day is the loudest
recording on it rather than the sum. A service type that recorded attendance and
no sound keeps its tile and says *no sound recorded* rather than disappearing
when you switch. The choice is remembered per browser.

A recording with no figure under the current measure is skipped rather than
counted as zero, so a Sunday where two of three services had a counter running
is the total of those two.

Under the tiles, one chart of every service type across the chosen range — 8, 16
or 52 weeks, or **All**, defaulting to 16 and remembered per browser. The same
control governs what a tile's change is measured against. At long ranges the axis
steps in quarters and then half-years rather than crowding, and its labels carry
the year once the span crosses one. The **line** runs through the same daily
figures, one node per recorded day, and every line is the same
weight: they are peers, not a measurement and its references. The tile's headline
and the last node on its line are the same number. A recording with nothing under
the current measure is not plotted at all, because a service nobody counted is
not a service of nobody, and one with no meter running is not a silent one.

The segment running into a day that has **not finished** is drawn dashed, with a
hollow node on its end, and it **builds as the day does**. A solid line into a
Sunday with one of three services done plunges from three thousand to one,
drawing a collapse that the tile beside it spends its whole label denying;
dashed, the same node reads "not done yet".

Each reading **eases** into place over about half a second rather than jumping,
and the dashed segment grows with the node instead of arriving ahead of it, so
an hour of a service filling reads as a room filling rather than as a dozen
twitches. Under `prefers-reduced-motion` the reading lands immediately, the node
stops pulsing, and the dash stays: the dash is the information, the motion is
decoration.

Each service type keeps **one colour**, everywhere: its tile, its sparkline, its
change figure, its line, its legend swatch and its milestones. The colour is
assigned per service type the first time it is seen and then persisted, so it
does not follow the sort order — it does not change when you switch measure or
range, when a quiet type has a loud week, or when a type misses a week.

**Point at the chart** and the card's subtitle becomes the readout: the nearest
**recorded** day to the pointer, then each drawn service type's figure at its own
nearest day, in that type's own colour. The crosshair snaps to the same day, so
the line, the date and the figures are one statement — a date on screen is never
one nothing was recorded on. Moving off puts the sentence back. It replaces a
line that is already there rather than being drawn over the plot, so nothing
covers the lines and the card does not change height.

**Right-click** a tile, a legend entry or the plot for a menu: *Hide <type>*, a
tick per service type, and *Show all*. A hidden type leaves the tiles, the chart
and the readout together; its legend entry stays, dimmed, and clicking it brings
the type back. The choice is remembered per browser.

The sound measure reads each recording's peak from the **SPL summary**, which
this page already loads — not from the per-item records. Recordings made before
per-metric stats existed are included: the summary reports them under the metric
name the record itself carries. The chart plots one
point per recording across up to 52 weeks, and reading a full record for each
would be hundreds of files to answer one number apiece.

**Milestones** are marked under that chart: a small triangle, a dashed guide up
the plot, and the label where there is room for the whole of it. Where two marks
are close enough that their labels would touch, the **later** one keeps its
words and the earlier shows only its triangle — a truncated stub beside a full
label reads as one broken label and names neither mark. Hovering or tabbing to
any mark shows its label whatever it did at rest, so nothing is lost. They come
from two places, and draw alike:

- **Your own list**, in Settings → Advanced → Data → History milestones. A date,
  a label, and optionally one service type. "Moved to two services", "new
  building" — the reason a step in the line is there.
- **Series changes**, derived: wherever a plan's series title differs from the
  previous recording of the same type. The first series a type ever records is
  not a change, and a plan with no series title is stepped over rather than
  counted as leaving and rejoining one.

A milestone scoped to **one service type** draws only while that type's line is
on, in that line's colour. One that applies to everything stays neutral — a
colour would claim a series it has not got. Hiding a service type takes its
milestones with it. The legend names the triangles — *▲ milestone · hover for
the label* — so the marks under the axis are not an unexplained row.

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

The **calendar** shades a day **green** by how many services were recorded on it,
in four steps, with everything at four or more on the darkest. There is no dot
and no count in the cell: the day number sits alone and the shade carries the
rest, with the count on the cell's tooltip and its accessible name. Today is
outlined in the accent and the selected day carries a heavier accent ring;
neither fills the cell, so the shade still shows underneath — and neither shares
a colour with the shade, so the accent means "the day you are looking at" and
nothing else. One sentence under the grid says what the shade is, in place of a
row of tinted swatches repeating the grid above it.

The **list** beside it is the **whole month the calendar is showing**, grouped by
day, newest first — paging the calendar pages the list. Clicking a day scrolls
to that day's group and rings it; it does not hide the rest of the month.

A column header is drawn once, under the first day's label, then a row per
service: the start time with the service type under it, the plan title with its
series and item count under that, and four figures. Each figure's caption sits
under its value. While a recording is still open the row says so twice: the same
green **recording** pill the service's own page carries, after the plan title,
and the pill's dot on its own beside the start time. The dot is the one that
survives a narrow window — the Service column is the only one that can shrink,
and the pill goes with the plan title when it does.

A service a baptism session links to carries a small droplet beside the plan
title, with the count itself next to it — *2* beside the droplet, never a bare
icon — and an accessible name spelling out *2 baptized*. The subtitle under the
title never repeats the count in words: the badge is what survives when the
Service column has no room left, so the series title and item count keep
theirs instead. A service with no linked session carries neither.

| | |
|---|---|
| In room | the most people in the room at once, captioned *peak in room*. Named for the figure rather than for the reduction, because the app also tracks the cumulative door count and "peak" alone names either |
| Ran | what the service ran; **Running**, counting up, while it is still recording |
| vs plan | its difference against the planned total — a dash while recording, where most of a plan not yet run reads as a service running short |
| Peak dB | the loudest reading on the primary Smaart metric, captioned with the metric it read |

A figure a row has nothing for is a dash in its own column, never a closed gap:
the header is drawn once per group, and a row that slid its columns left would
misname every figure to the right of the missing one.

They are the service page's own figures, picked out of the same derivation, so a
row and the page it opens cannot quote different numbers for one recording. A
service whose attendance recorder opened before its first plan item went live —
the arrival ramp — is a simpler row saying how many are in the room so far.

Where there is no level, the row says **why** under the dash — *no sound
recorded*, *metric hidden in Sound*, or *sound unavailable* when the record
could not be read at all. The last one is its own case on purpose: a server that
was down is not a meter that was off, and the reason is logged on a `[history]`
line naming the service.

When any of these cannot be loaded at all, the page says so — "the recorded
history could not be read", or *sound unavailable* on the Trends card — rather
than showing the copy for a history that is genuinely empty. The reason is on a
`[history]` line on the server log, one per thing that failed.

**Export** is a button in the Recorded services header. It opens a date range —
blank for all dates — and a list of sheets, and downloads them as one `.xlsx`.
It reads only, so it is offered on the shared `/history` link too.

The page carries no Overview card. Every figure it blended across a service type
— average length, average start against schedule, average per-item overrun, peak
and level — is on the service page's own KPI row, against the service it belongs
to, where it means something specific rather than something all-time.

A row is a summary that opens the service page; Delete lives on that page's
header, not on the row. The shared `/history` link shows the same figures.

Opening a service writes its key to the URL as `?service=`, so the address bar
names exactly which occurrence is open — reload, bookmark or share it and the
same one opens again, rather than landing back on the whole month. This is the
one URL that opens a specific service, and the only way in from outside the
page itself: a baptism session's own **Past sessions** card, on the Baptisms
tab, links each row with a known service through this same address, so
opening one from there lands here rather than on a copy of this page.

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
  | Peak in room | the most people in the room at once, and how many came in during the service — the same two figures the Attendance card calls Peak and Entries, and the same words the All services row uses |
  | Peak *metric* | the loudest reading on the primary Smaart metric, named after the metric it read |

  Started, Planned and Actual count up live while a service is recording. A
  record with no attendance or no sound shows a dash, not a zero;
- a nav over the three cards. The entries are ordinary links, so they work with
  the keyboard and with middle-click, and the one you are looking at is
  highlighted as you scroll.

On a phone the header stacks and the six figures scroll sideways in their own
row; the page itself never scrolls sideways.

On a weekend a baptism session links to, a fourth **Baptisms** card appears
between Rundown and Attendance, and the nav gains an entry for it in the same
position. Neither shows on an ordinary Sunday.

The card carries: a stat strip — Baptized, Total time, Testimony total,
Baptism total, Avg testimony, Avg baptism, the same six figures the Baptisms
tab itself shows, over every session linked to this service; a read-only
two-lane chart per linked session — the same timer-over-plan chart the live
Baptisms tab draws, showing that session's own testimonies and baptisms
against the plan items running at the time; and, under each chart, that
session's own per-person splits (testimony, baptism and total time per
person). A session with nothing in the shared timing rows for it — recorded
before that raw layer existed, or matched to this service only by its start
time rather than by a service key of its own — shows its splits with a plain
line in place of the chart rather than one reading as an empty session. A
**Open in Baptisms →** link beside the card's title returns to the live tab.

Two or more sessions recorded in one occurrence — a reset and restarted
session, or two people baptized in separate sessions the same weekend — each
draw their own chart and their own splits, never merged into one.

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

A chart whose caller takes the readout itself carries no strip at all: the Trends
chart hands its hover to the card's subtitle line, so nothing sits over the plot.
The attendance and sound charts keep theirs, because they have figures to show at
rest.

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
bucket's loudest reading, with its gradient; the dashed line is that bucket's
**Leq** — its equivalent continuous level, energy-averaged across the bucket
rather than an arithmetic mean of decibels. It is named `Leq` in the legend, in
the strip and in Customize for that reason. Its y axis is chosen to frame the levels, never anchored at 0 dB.
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

Either way an item's peak mark is a tick through the middle of its block rather
than at the loudest instant, because the instant is not in the per-item record.
It is drawn the full height of the block in the primary line's colour, named
**Item peak** in the legend, and switched under Chart in Customize. Hover the
block and the strip says what it peaked at.

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
sound levels from the SPL samples, attendance from the record's own samples, and
baptism sessions from `baptism.csv`. For a capture the recorder got wrong — the
raw rows are append-only and keep the evening as it happened. Item time
corrections survive it: they are an overlay over the rebuilt run, not a change
to it. Baptisms are the one exception to "rebuild replaces": the sessions it
reconstructs are merged into what is already stored rather than replacing it,
so a session the rows cannot reproduce is left alone rather than deleted, and
one already stored that the rows have nothing to say about is kept exactly as
it is — a rebuild never deletes or evicts a baptism session to make room for
another. See
[Baptisms are merged, never replaced](../data-archive.md#baptisms-are-merged-never-replaced)
for the full rule.

The result says what was **rebuilt** — a count per leg, baptisms as "N added"
and "M updated" when the merge actually wrote something — then, separately,
what was **left alone** and why: for the other three legs, a leg the raw
layer had nothing for; for baptisms, sessions the merge matched but found
unchanged, newer in the store already, disagreeing with the rows, or
unreadable. If the store was already at its cap when new sessions were found,
a closing clause says how many could not be added. A leg that failed to save
says so by name rather than being folded into either list.

Rebuilding here also clears a save-failure line on the **Baptisms** tab, and
the Timer card's own note beside it, for any session the merge just added or
updated — the same clearing a rebuild started from either of those two places
already does. See [Recovery](scriptview-and-baptisms.md#recovery) for what
that note shows and exactly when a line clears.

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
