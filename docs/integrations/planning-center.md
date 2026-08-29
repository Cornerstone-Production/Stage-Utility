# Planning Center Online integration

Pulls the live service plan, team roster, photos, and on-air countdown from
Planning Center Online (PCO) — the primary data source that most Stage layouts
and displays read from.

## How it works

Stage talks to PCO's Services v2 REST API
(`https://api.planningcenteronline.com/services/v2`) using **Basic Auth** — a
Personal Access Token's App ID + Secret. Every request pins the API version with
an `X-PCO-API-Version` header (see [API version](#api-version)). The client
(`pco-service.ts`) flattens JSON:API responses into slim DTOs and caches by
volatility:

- **LONG (15 min):** near-static per service day — service types, note
  categories, team positions, plan service times.
- **MEDIUM (3 min, or 45 s inside a service window):** still-editable plan
  content — plan list, items, team members, attachments.
- **Uncached:** the live on-air timer (`getLive()`), so the countdown stays
  real-time.

A **service window** is the same one the integration reconnect schedule uses:
PCO's rehearsal and service times widened by the lead and tail configured under
Settings → Advanced (`service-window.ts`). It compares instants against plan
times, so there is no calendar-date or hour-of-day question in it. The MEDIUM TTL
is resolved when a cache entry is read rather than when it is written, so a window
opening shortens entries that are already cached.

The two PCO-freshness uses of the window — this TTL and the roster re-pull below —
deliberately ignore the reconnect schedule's **enabled** switch, which governs how
integrations back off when reconnecting rather than how fresh PCO data is. Turning
it off does not slow either of them down; the lead and tail under it still shape
the window.

`stage-controller.ts` owns the synced state and re-pulls the plan/roster/photos
on the configured **Refresh interval** (5 min–2 h). Two things run faster than
that setting: the live countdown, which updates continuously, and the **team
roster**, which is re-pulled once a minute while a service window is open so a
last-minute substitution reaches a stage display in about a minute rather than
waiting up to two hours. Outside a window the roster makes no extra requests at
all and moves on the configured interval exactly as before.

The **Pre-service countdown** option picks what the countdown counts to: *Plan
start* (matches PCO's green timer, service time minus pre-service items above a
"service start" header) or *Service start time*. Avatars are upscaled and plan
attachments (e.g. the stage plot) are proxied and cached so kiosk displays get a
stable URL that always tracks the current plan.

Testing the integration lists service types as a minimal auth check. The Secret
is stored encrypted (secret key `secret`).

## API version

PCO versions each product by date. A request selects one with an
`X-PCO-API-Version: YYYY-MM-DD` header, and PCO resolves it by an equal-or-earlier
match. A request that sends no header is served whatever version is set as the
app's default in PCO's developer console — a setting outside this repository that
differs between installs.

Stage pins the version explicitly, in `PCO_API_VERSION` in `pco-service.ts`:

```
X-PCO-API-Version: 2018-11-01
```

Always an exact date, never a "give me the newest" sentinel — a floating request
would let a PCO release change field names, defaults or pagination under a running
install with no code change here. Services publishes exactly two versions,
`2018-08-01` (withdrawn 2 April 2024) and `2018-11-01`, so the pin is both the
newest and the only one still served. The single documented difference between
them is that `2018-11-01` makes the `/people` endpoint respect the "Can view
people not on My Teams" permission; Stage calls no `/people` endpoint.

To bump it: take the newest date from the version selector at
<https://api.planningcenteronline.com/docs/apps/services>, read that version's
changelog entry for field or pagination changes, change the constant, and confirm
against a real organisation that the plan, roster and photos still render.

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
