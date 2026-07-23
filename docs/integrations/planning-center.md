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

## Setup

**In Planning Center:** api.planningcenteronline.com → Developers → Personal
Access Tokens → create a token. Note the **App ID** and **Secret** shown there.

**In Stage:** Settings → Integrations → **Planning Center** → enter the **App ID**
and **Secret**, pick a **Refresh interval** and **Pre-service countdown**, enable
it, and **Test connection** (should report the number of service types found).

## Files

- `main/services/pco-service.ts` — REST client, Basic Auth, tiered cache, DTOs
- `main/services/pco-attachment-cache.ts` — plan-attachment download/proxy cache
- `main/services/stage-controller.ts` — synced plan/roster state, refresh loop
- `main/services/integration-manager.ts` — `PCO_DESCRIPTOR`, credentials, test
- `main/services/remote-server.ts` — `GET /api/pco/live`, `/api/pco/attachments`,
  `/api/pco/plan-items`, `/api/pco/attachment`
- `renderer/main/pco-timer.ts` — live countdown timer hook
