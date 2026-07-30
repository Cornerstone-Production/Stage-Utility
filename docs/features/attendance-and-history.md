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
