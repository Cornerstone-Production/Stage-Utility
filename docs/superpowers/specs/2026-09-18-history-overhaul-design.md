# History overhaul

**Goal.** The History tab reads as part of this app: one chart module for
attendance and sound with plan items on the time axis, a stat strip instead of
a floating tooltip and three loose tiles, one Customize control per section
instead of chip rows, a calendar shaded by services, per-type trends with
milestones, and a service page that grows live and smoothly while a service
is being recorded.

**Mockups.** Attendance chart https://claude.ai/artifact/TKkuHXRD37qNk3tfFgyKxG;
whole tab https://claude.ai/artifact/RG7jaaPoWn4YWMcCz2gz78 (v4).

**Kept as is.** The green attendance line with its gradient. The month
calendar's shape. The rundown table's columns. Edit times, Merge, Copy report,
Delete, Recalculate, Rebuild from raw, and per-item time edits as built.

## Three PRs, in order

| PR | What lands | Why this order |
|---|---|---|
| 1 | The chart module, used by the attendance and sound sections; the stat strip; Customize; the item lane; live growth | It is what the operator looks at every week and it sets the pattern the other two reuse |
| 2 | The service page: sticky header, KPI row, one action group, section nav; rundown restyle on the app's type scale | Reuses PR 1's strip and Customize |
| 3 | All services: the Trends card first, then the calendar shaded by service count and the list rows with KPIs | Reuses PR 1's chart for the trend line |

Each PR ships its docs (`docs/features/attendance-and-history.md`,
`docs/reference/widgets.md` where the chart is shared) and the operator-facing
preferences it adds.

## PR 1: the chart module

One component, `HistoryChart`, in `renderer/settings/sections/history-chart/`,
fed by a `series[]`, an `items[]` (the record's timeline entries), the service
window, and `yScale`. Attendance and sound are two configurations of it.

**Plot.** No plot-area fill. Grid lines at the y ticks in `--line` at low
opacity. Axis text 11px Plex Mono, tabular, `--muted`.

> **Token names, corrected during PR 1.** `--line`, `--line2`, `--card2`,
> `--muted` and `--accent` are the mockup's names. This app's are
> `--color-line`, `--color-line-strong`, `--color-fill`, `--color-fg-muted` and
> `--color-accent` (renderer/styles.css). The module uses those and carries no
> colour literal. The primary series draws
at 1.8px with a gradient fill to zero; secondary series at 1.2px, dashed where
they share a scale. Before and after the service window is a 45° hatch in
`--line`, with a hairline at each boundary. Everything is theme tokens; the
component renders in light and dark with no literals.

**Item lane.** Two rows under the x axis, pre-service items above in outline,
in-service items below filled `--card2` with `--line2` stroke. Each segment
spans `startedAt` to `endedAt` on the plot's x scale. Label rule: the full
title when its measured width plus 12px fits, otherwise the rundown number
(sequence + 1, matching the table's first column), otherwise nothing. Nothing
is ever clipped. Hover a segment: it takes the accent outline and the strip
shows the item's number, title, ran and planned. Segments carry a per-item
peak mark for the sound chart (a 3px tick in the series colour).

> **Corrected during PR 1.** This said "a 3px tick at the loudest sample's x".
> There is no such x: the SPL recorder stores one stat block per plan item and
> `spl:history` broadcasts the same shape, so the loudest INSTANT is not
> recorded anywhere. The tick is on the block's top edge and means "this item
> peaked at N" — and on the top edge rather than through the middle, because a
> full-height tick struck through the item's own label.
>
> The same gap decides what the sound LINE is: a step, each item's Leq held flat
> across the time it ran, not a sampled curve. And it has no gradient fill — a
> fill runs to the axis floor, and a dB axis has no floor that means anything.

**Stat strip.** One row above the plot, the section's header. At rest, the
figures the operator chose in Customize (defaults: attendance peak, lowest in
service, average, samples; sound peak LAeq, loudest item, Message Leq), 20px
values with 11px uppercase labels, hairline separators between figures. On hover, the time, the
hovered series' values and the current item. While recording, `LIVE · time`
and the live values. It replaces the tooltip and the summary tiles.

**Customize.** A sliders button at the section's right opens a popover with
checkbox groups: series, at-rest figures, and for sound the Smaart metrics.
Choices persist in the existing preference store the chips use today. The
legend under the plot stays as the quick toggle for series that are on.

**Live growth.** While the record is open, the component appends samples from
the existing `attendance:history` and `spl:history` broadcasts. The path's
`d` is updated in place, never rebuilt; the new stretch draws in over 200ms;
the live edge carries a 4px dot with a soft pulse; the current item's segment
grows. The x domain widens in ten-minute steps with a 600ms ease. All motion
honours `prefers-reduced-motion`. Guard: a test drives a fake stream of
samples and asserts one path element persists across updates.

**Chips removed.** The Chart and Summary chip rows on both sections go; the
SPL "Show metrics" chip row goes. Each becomes a Customize group.

## PR 2: the service page

**Sticky header.** Crumb back to All services; the plan title; series, service
type, date and time on one muted line with a green `recording` pill while
live; the action group (Edit times, Copy report, Merge, Rebuild from raw,
Delete); six KPIs in one row (started with early/late, planned, actual with
delta, average overrun with the over count, peak attendance, peak LAeq); a
section nav (Rundown, Attendance, Sound) that highlights as you scroll.

**Rundown.** The table on the app's scale: 10px uppercase headers, 13px rows,
mono tabular numbers, `not counted` and `edited` marks as today. Edit times
mode as built in the per-item edits PR, with its edit bar above the table.

## PR 3: All services

Order on the page: Trends, then the calendar beside the list. Trends is the
defining view of the tab and leads.

The Overview blend and the Export disclosure are not mentioned here and were
KEPT, below Trends — this section describes what leads, not what the page is
allowed to contain, and removing a working view is not a decision a silence
makes.

> **Trimmed after review.** The Overview kept its own average attendance, its
> peak, and an attendance chart, over a different window than Trends and with a
> different average — two charts of one quantity on one screen that disagreed.
> It is the TIMING card now (services, average length, average start, average
> overrun) plus the sound level, which Trends does not plot. What went, and
> where it went:
>
> | Dropped | Covered by |
> |---|---|
> | the average-attendance lead stat | a Trends tile per service type |
> | Peak attendance | a Trends tile, and each day-list row's own peak |
> | the attendance trend chart | the Trends chart, over a chosen range |
> | the SPL trend LINE on that chart | nothing — the average level and its dB delta stay, the per-date line does not |
>
> The SPL line is the one real loss and is named rather than implied. The
> chart component itself still serves Home's Recent services card.

**Calendar.** Shade is the number of services that day in four steps. No dots,
no counts; the shade alone carries it. The day number is centred in its cell.
Today is outlined in the accent; the selected day carries the accent ring.

**List.** Grouped by day. Each row: time and service type, plan title and
series with item count, then peak attendance, ran, versus plan, and the peak on
the operator's PRIMARY Smaart metric — not LAeq, which this said. The service
page's own header has named the metric it actually read since PR 2, because a
church metering LCeq is not told it peaked at an LAeq it never recorded. The row
figures are picked out of `serviceKpis` by key rather than derived again, so a
week reads at a glance and a row cannot disagree with the page it opens.

> **Corrected during PR 3.** The row needs the FULL SPL record for a peak;
> `spl:getSummary`, which the list already held, carries a service-level Leq per
> metric and no peak at all. The selected day's records are fetched — one to
> four, not a year of them. Everything else on this page, Trends included, is
> computed from records the list already loads, and no route was added for
> trend data.

**Trends.** A card with one tile per service type: a sparkline of peak
attendance over the last eight recordings, the average, and the change against
the eight before.

> **Read literally during PR 3, per DAY.** The window is eight DAYS, not eight
> recordings: a church with three Sunday services plots three points a week
> within two hours of each other, and a line through them was a sawtooth in
> which a week-to-week trend was invisible. The line runs through each day's
> BUSIEST service and a dot marks each recording; the tile averages the same
> per-day figure, so the two halves of the card quote the same kind of number.
>
> "The eight before" means a type shows no change until it has recorded sixteen
> days, and the tile says "no prior window yet" rather than implying one. The alternative — splitting whatever is available
> in half — makes the average and the compared window two different things,
> and a tile whose average is over five recordings and whose change is over two
> is harder to read than one that says it cannot tell yet. A type with fewer
> than two recordings then needs no special case; it falls out of the same rule. Below it, one chart across the chosen range for all types
using PR 1's module, with milestone marks under the axis: a small triangle,
a dashed guide up the plot, a short label when there is room, the full label
on hover. Milestones are an operator list (date, label, optional service type)
kept in Settings, plus automatic marks where a plan's series title changes.
Milestones never appear on a single service's chart.

## Logging

Nothing new fails silently here: the charts read what the stores already
broadcast. One line when a milestone list entry cannot be parsed:
`[history] milestone "<label>" has no valid date, skipped`.

## Tests, each proven red

- Lane label rule: full title fits, number when not, nothing when neither;
  never a clipped string.
- Segment geometry: a segment's x span equals the item's window on the scale.
- Strip: at-rest figures follow the Customize choices; hover shows the nearest
  sample; live shows `LIVE`.
- Axis: the dB band is a multiple of ten, so no gridline is labelled 82.5.
- A series that declares no sampling gap is never broken (the average reference
  line and the sound step line both would be, under the sampled-series rule).
- The attendance average counts in-service samples only — over the whole
  recording it comes out BELOW the recorded low.
- Live: appending samples keeps the same path element; reduced motion disables
  the pulse and draw-in.
- Calendar: shade step and count for 0, 1, 2, 3, 6 services.
- Trends: change versus prior eight; a service type with fewer than two
  recordings shows no change.
- Milestones: a list entry with a bad date is skipped and logged; series
  changes produce one mark per change.

## Out of scope

- Mobile layouts beyond stacking (the lane collapses to the in-service row
  and labels become numbers below 600px).
- Exporting charts as images.
