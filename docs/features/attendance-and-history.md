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
- **Recorders** capture attendance / SPL / service-timeline per service, keyed to the
  plan + occurrence, and **auto-finalize at the plan's SERVICE END marker** (robust to
  a parked live controller). Records are written atomically and reconciled on startup.
- **Layout objects:** **people counter**, **people summary** (several metrics side by
  side, each toggleable), and **people graph** (live rolling window **or** a recorded
  service, with PCO-item markers, a hover tooltip, and an optional kiosk live/recorded
  toggle).
