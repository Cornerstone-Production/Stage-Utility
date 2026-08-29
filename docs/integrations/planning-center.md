# Planning Center Online integration

Pulls the live service plan, team roster, photos, and on-air countdown from
Planning Center Online (PCO) — the primary data source that most Stage layouts
and displays read from.

## How it works

Stage talks to PCO's Services v2 REST API
(`https://api.planningcenteronline.com/services/v2`) using **Basic Auth** — a
Personal Access Token's App ID + Secret. The client (`pco-service.ts`) flattens
JSON:API responses into slim DTOs and caches by volatility:

- **LONG (15 min):** near-static per service day — service types, note
  categories, team positions, plan service times.
- **MEDIUM (3 min):** still-editable plan content — plan list, items, team
  members, attachments.
- **Uncached:** the live on-air timer (`getLive()`), so the countdown stays
  real-time.

`stage-controller.ts` owns the synced state and re-pulls the plan/roster/photos
on the configured **Refresh interval** (5 min–2 h). The live countdown updates
continuously regardless of that setting. The **Pre-service countdown** option
picks what it counts to: *Plan start* (matches PCO's green timer, service time
minus pre-service items above a "service start" header) or *Service start time*.
Avatars are upscaled and plan attachments (e.g. the stage plot) are proxied and
cached so kiosk displays get a stable URL that always tracks the current plan.

Testing the integration lists service types as a minimal auth check. The Secret
is stored encrypted (secret key `secret`).

## Item times

PCO publishes no scheduled time on a plan item — an Item carries a title, a type,
a length and a position, and its `item_times` stay empty until something actually
goes live. Stage therefore derives an item clock, exactly as the plan editor does:
the service time plus the running total of item lengths, anchored on the
`SERVICE START` header.

**Plan times override it.** A `plan_time` whose name matches an item's title pins
that item to a real clock instead. This is the way to make an item exact, and it
holds when the service runs long. Match is on the whole name, case-insensitively.

Automation reads this clock — see [Automation](../automation.md#firing-an-item-on-time).

## Plan notes as a checklist

A plan's **notes** — the ones a team lead writes at the top of a plan and files
under a note category — can be read as a pre-service checklist and ticked off on
Home. The list is authored in Planning Center; nothing is typed into Stage.

**Choosing what feeds it:** Settings → Plan → **Pre-service checklist**. Pick note
categories, teams, or both. A note matching *either* is included. Nothing chosen
means no checklist — it never fills itself with every note on the plan.

**How a note becomes rows:** if any line in the note starts with a bullet (`-`,
`*`, `[ ]`), the bulleted lines are the rows and the rest is context. If no line
is bulleted, every non-blank line is a row.

```
Doors at 8, band on stage 8:30.      <- context, not a row
- Wireless batteries fresh           <- row
- CO2 tank hooked up                 <- row
```

The same list appears in two places: the **Readiness** card on Home, and the
**Checklist** object on a custom layout. One source, one set of ticks — ticking in
one shows in the other. On a wall display the list shows but cannot be ticked.

**Ticks** are stored in Stage only; Planning Center never sees them. They are
keyed to the row's wording, so adding or reordering lines in the note leaves
existing ticks on their own rows, and rewording a row clears its tick. Each plan
gets its own ticks, so the next service starts with a clean list. Settings → Plan
→ **Clear ticks** starts the current plan over.

Teams, not positions: `PlanNote` has no position relationship, so a note can be
narrowed to Production but not to a single position within it.

## Calendar

A second PCO product, read by a second client (`pco-calendar-service.ts`) against
`https://api.planningcenteronline.com/calendar/v2`, sharing the Services client's
credentials, concurrency gate and retry budget. It pins
`X-PCO-API-Version: 2018-11-01`; Calendar is versioned by date and an app sending
no header gets whatever default is configured in PCO's developer console, which
is not part of this repository.

One request draws a month. `event_instances` is asked for the events
**overlapping** the visible six-week grid — `starts_at <= gridEnd` **and**
`ends_at >= gridStart` — not for the events starting inside it. A start-only
range drops a multi-day event that was already running on the first square.

**Filtering is by calendar and by tag, server-side.** Both are chosen per view
(Screens → the view → **What this calendar shows**) and both are optional;
choosing nothing draws everything. Tags are the useful filter: a room or vehicle
booked for an event appears on the main calendar too, so narrowing by calendar
alone thins very little. PCO matches several tags from one tag group as "any of
these" and tags from different groups as "all of these", so the picker names each
tag's group.

Colours come from the **tag**, not the calendar. A Calendar's own `color` is an
enum of names with no value behind it; a Tag's is a real hex string. A tag colour
with too little contrast against the display's backdrop is lightened until it is
visible — the palette is the organisation's, and nothing else about it is
changed.

**There is no booking-versus-event distinction, because PCO does not model one.**
A resource reserved for an event is an event instance like any other and inherits
the tag of whoever reserved it, so no rule separates a meeting from the van
booked to get there. Filter by tag instead.

Times are bucketed into days on the **server**, in the app time zone. All-day
events arrive as local midnight expressed in UTC, and a browser — or a UTC-clocked
host — bucketing them by UTC date puts them on the wrong square.

The current month is **pushed**, not polled. The server re-reads Planning Center
on a three-minute timer — once for the whole building — and broadcasts on the
`calendar:grid` SSE channel only when the grid is not what it was, which for a
calendar is a couple of times a week. It skips the read entirely when no screen
is showing a calendar. The channel is hydrated on connect, so a display opened
mid-month is not blank until something happens to change.

**Month navigation** is a separate path. Chevrons in the header page back and
forward up to 36 months, and any month other than the current one is a one-shot
`?month=YYYY-MM` read that nothing subscribes to — a past month is not going to
change while it is being looked at. Returning to the current month drops back to
the live channel.

Paging is per screen and is not stored on the View: a View can be routed to
several screens at once, so a stored offset would page every wall in the building
because one operator looked at December. A **wall display has no chevrons at all**
— controls are live only where the operator made the surface operable — and a
console paged away resets to the current month after ten minutes and on reload.

Caching is separate from the Services client's: event instances for 3 minutes,
calendars and tags for 15.

## Controlling Live

`controlLive()` posts PCO's own `go_to_next_item` / `go_to_previous_item`. There is
**no jump action** in the API, so nothing in Stage can skip to an item. The
connected account must be permitted to control Live for that service type; Stage
never calls `toggle_control`, so it cannot take control from whoever is driving.

## Setup

**In Planning Center:** api.planningcenteronline.com → Developers → Personal
Access Tokens → create a token. Note the **App ID** and **Secret** shown there.

**In Stage:** Settings → Integrations → **Planning Center** → enter the **App ID**
and **Secret**, pick a **Refresh interval** and **Pre-service countdown**, enable
it, and **Test connection** (should report the number of service types found).
