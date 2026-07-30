# PCO Calendar — research findings

**Status:** research complete, design NOT started. Four questions below need answers
before a spec can be written; they are product decisions, not technical ones.

Driving use case: *"cool the room based off the PCO master calendar"* — an Ecobee
action fired by a calendar trigger, via the automation engine.

## What the app uses today

Only PCO **Services** (`services/v2`). `main/services/pco-service.ts` contains no
reference to Calendar. This is a new product surface.

## The API

**Endpoint:** `GET /calendar/v2/event_instances` (and `/{id}`)

An *EventInstance* is one occurrence of an event — the right resource for "what is
happening in the building on Sunday", since a weekly event has many instances.

**Attributes:** `starts_at`, `ends_at`, `all_day_event`, `name`, `description`,
`location`, `church_center_url`, `recurrence`, `recurrence_description`,
`published_starts_at`, `published_ends_at`, and **`kind`** — `standard` or
**`blockout`**. Blockouts are not real events and must be filtered out.

**Filtering:** `where[starts_at]`, `where[ends_at]`, `where[created_at]`,
`where[updated_at]`, plus scope filters including `future` and `approved`.

**Ordering:** `order=starts_at` (prefix `-` to reverse).

**Includes:** `event`, `event_times`, **`resource_bookings`**, `tags`.

**Pagination:** `per_page` (max 100, default 25) + `offset`.

Sources: [EventInstance resource](https://api.planningcenteronline.com/docs/apps/calendar/versions/2022-07-07/vertices/resource),
[Authentication](https://api.planningcenteronline.com/docs/overview/authentication)

## Authentication — no new credentials needed

Planning Center is **one API across all products** (Check-Ins, Giving, Groups, People,
Calendar, Services). A Personal Access Token acts with the permissions of the user who
created it.

So the **existing App ID / Secret should reach Calendar**, provided the account that
minted the token can see Calendar in the organization. That is a permission check, not
a new integration — considerably cheaper than expected.

**To verify before building:** with the current credentials, `GET
/calendar/v2/event_instances?per_page=1` should return 200 rather than 403.

## The two findings that shape the design

**`resource_bookings` is how you know which room.** "Cool *the room*" needs a
room-to-thermostat mapping, and the room comes from the resource bookings on an
instance (a Resource in Calendar is a room or a piece of equipment). Without including
that relationship, an event is just a name and a time — not enough to know what to
cool.

**`kind: blockout` must be excluded.** Blockouts mark unavailability, not events. A
naive "any upcoming instance" trigger would pre-cool the building for a blockout.

## Open questions

These are product decisions and I should not guess them.

1. **Which events should count?** Every calendar instance, or only those matching
   something — a tag, a specific resource/room, an approval state? A church calendar
   typically carries a lot that should not touch HVAC.

2. **Which rooms map to which thermostats?** The mapping has to live somewhere. Is it
   one thermostat per Calendar resource, a manual mapping table in Settings, or is
   there effectively one room that matters?

3. **How far ahead?** Pre-cooling is a lead time — 60 minutes? 90? Fixed, or per room
   given they warm at different rates?

4. **Trigger only, or also display?** A `calendar.event-starting-in` trigger is one
   thing. "What's on in the building today" as a layout object or a Settings view is a
   different (and possibly more immediately useful) feature off the same data.

## Likely shape, once those are answered

A `pco-calendar-service.ts` polling `event_instances` with
`filter=future&include=resource_bookings&order=starts_at`, caching the next N
instances, broadcasting `pco:calendar`, and contributing a
`calendar.event-starting-in` trigger to the automation engine — with the room taken
from the instance's resource bookings.

Polling cadence should be gentle: a calendar changes on human timescales, so every
15–30 minutes is ample and stays well clear of PCO's rate limits. The existing
`serviceWindow` back-off applies.

**Dependency:** the automation engine (`2026-07-26-automation-engine-design.md`) must
exist first — this is one trigger provider, not a standalone feature. And the Ecobee
half remains blocked on API access regardless.
