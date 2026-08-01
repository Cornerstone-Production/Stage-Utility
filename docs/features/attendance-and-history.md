# Attendance and service history

Recording what happened during a service, and reading it back.

## Attendance & service history

- **People counting (SenSource Vea).** Live building occupancy shown on dashboards
  and custom layouts. Metrics include **in-room now**, **peak attendance** (highest
  in-room), **day attendance** (sum of the day's services' peaks), **per-service
  attendance**, **% of capacity**, **vs average**, and **Low** (lowest in-room during
  the live service). "Attendance" = people in the room; "entries" = cumulative door
  count (double-counts re-entries), kept separately.
- **History tab** (Settings → History) unifies **SPL**, **attendance**, and
  **service-timeline** records into one browser with a **calendar** (dots on days with
  data). Per-service detail shows charts — an attendance trend with **PCO plan-item
  markers** + a service-average line, and per-item SPL — plus a **grouped, drag-orderable
  KPI overview** (timers, attendance, highest/lowest attended, day totals), with
  toggleable sparklines. Service windows are **editable** (fix a bad capture), individual
  items can be **counted/excluded** from the timers, and a service **report** is exportable.
- **Excel export** (History → Export) writes one sheet per data set. Each is a real
  filterable table: frozen headings, filter arrows, rows in date order. The file is
  named for the range it covers, not the day it was made. On the SPL sheet every
  metric gets its own `<metric> Max` / `<metric> Leq` column pair — one row per plan
  item, rather than one row per metric per item — and songs are prefixed `SONG: ` so
  a filter isolates them.
- **The attendance curve breaks where sampling stopped.** Samples land every 30s, so
  a run of missing ones means the counter was unreachable or the server was down —
  not that the room emptied. The chart used to join straight across such a gap,
  drawing a confident hour-long decline nobody measured. Gaps over three minutes now
  render as a break.
- **Baptisms belong to a service occurrence, not a plan.** The timer stamps the
  service the timeline recorder currently has open (`service-key.ts`) when a session
  starts, so a baptism lands on the 9am or the 11am rather than on whichever service
  it happened to overlap. Taking the key from the recorder rather than from PCO's
  live snapshot matters: an overrunning service rolls PCO's "current service time"
  on to the next occurrence, and a key derived from that would put the end of a long
  9am onto the 11am.

  Sessions recorded before this shipped carry no key and still match by overlapping
  the service's window — with the two failure modes that motivated the change: one
  session left running across two services counts in both, and a service that never
  finished falls back to an assumed six-hour window. A keyed session is never
  rescued by overlap, or the 9am's baptism would reappear on the 11am whenever the
  two ran long.
- **A Baptisms section** sits with the rundown, above Attendance and Audio, and only
  when a session links: baptism timings are timing data, and on a baptism weekend
  they explain the overrun in the table right above them. Six figures — people, total,
  testimony and baptism totals, and per-person averages of each. Averages divide by
  people rather than sessions, since a session is only when the operator started and
  stopped. Per-person splits stay in the Baptisms tab.
- **Baptisms export too**, one row per person with testimony/baptism splits, keyed
  by date and service time like the other sheets.
- **SPL exports in two shapes.** `SPL` is wide — one row per plan item with every
  metric side by side — for reading and for comparing metrics on a line. `SPL data`
  is long — one row per item per metric — which is the shape a PivotTable wants, so
  Metric becomes a field you drag rather than a column set at export time. Both are
  real Excel Tables (`xlsx-table.ts`), so *Insert → PivotTable* opens with the range
  already filled in.
- **A `Service time` column** distinguishes a 9am from an 11am on the same date.
  Without it two services export as identical rows.
- **Blank metric cells are expected, and mean three different things.** A record made
  before per-metric stats existed carries only the capture's own metric, so every
  other column is empty for it. `Leq` is empty on anything recorded before energy
  averaging shipped, because the stored figure was the arithmetic mean and is not a
  level. And the columns are the union across the whole export, so a service whose
  meter reported fewer metrics leaves the rest blank.
- **Sound levels are energy-averaged (Leq), never arithmetically.** Decibels are
  logarithmic, so a plain mean of dB readings understates a dynamic item by 8-15 dB —
  a sermon with one loud video averaged 77 dB where the true level was 92. For LAeq
  and LCeq it would also be an average of averages, since each reading is already an
  energy mean over its own window. See `spl-leq.ts`. Records made before this shipped
  hold only the old linear mean; it is neither displayed nor exported, so those rows
  show a blank Leq rather than a misleading number.
- **Songs are identified from PCO's `item_type`**, captured at record time. History
  recorded before that was captured cannot be labelled retroactively, so those rows
  export without the `SONG: ` prefix.
- **Recorders** capture attendance / SPL / service-timeline per service, keyed to the
  plan + occurrence, and **auto-finalize at the plan's SERVICE END marker** (robust to
  a parked live controller). Records are written atomically and reconciled on startup.
- **Layout objects:** **people counter**, **people summary** (several metrics side by
  side, each toggleable), and **people graph** (live rolling window **or** a recorded
  service, with PCO-item markers, a hover tooltip, and an optional kiosk live/recorded
  toggle).
