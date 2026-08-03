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

## Reading it back

The History tab puts all three on one calendar — days with data are marked. Open
a service for its charts: an attendance trend with plan-item markers and a service
average, and per-item SPL.

Above them is a KPI overview you can reorder and toggle sparklines on: service
timers, attendance, highest and lowest attended, day totals. On a baptism weekend
a Baptisms block appears alongside, showing people, total, testimony and baptism
times, and per-person averages.

Service windows are editable if a capture went wrong, individual items can be
excluded from the timers, and a service report is exportable.

## Attendance metrics

**Attendance** is people in the room. **Entries** is the cumulative door count,
which double-counts anyone who steps out and back — the two are kept separate.

Available on dashboards and custom layouts: in-room now, peak, low, per-service,
day total, percent of capacity, and versus average. The layout objects are a
people counter, a people summary with individually toggleable metrics, and a
people graph that shows either a live rolling window or a recorded service.

A gap of more than three minutes in the samples renders as a break in the curve
rather than a straight line, since missing samples mean the counter was
unreachable, not that the room emptied.

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
