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
