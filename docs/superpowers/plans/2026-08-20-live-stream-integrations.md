# Live stream integrations — Resi and YouTube

**Goal:** answer "are we streaming, and for how long" the way the app already
answers "are we recording" — same widgets, same context bar, same Home card,
same automation, for Resi and YouTube.

**Architecture:** one `streamers()` / `streamingStat()` pair mirroring the
existing `recorders()` / `recordingStat()` in `renderer/app/recording-status.ts`.
Every surface asks the question once, so a third platform is one entry in one
function rather than another twenty files.

**Tech:** Resi's *internal* Web API (undocumented) and YouTube Data API v3
(OAuth 2.0). Both server-side polls, on the existing PCO-aware reconnect
schedule.

---

## What the research established

Do not re-derive this. It cost several hours and two dead ends.

### Resi — the public API cannot do it

`https://api.resi.io` "Go Live API", spec at `/docs/v3/api-docs`. Nine
endpoints, no more:

```
POST /v1/oauth/token          client_credentials -> access_token, expires_in
GET  /v1/encoders             id, name
GET  /v1/destinationgroups    id, name
POST /v1/schedules/live       start        -> scheduleId
GET  /v1/schedules/{id}       destinations[].status, actions.stop
POST /v1/schedules/{id}/stop  stop
GET  /v1/ondemand/...         VOD only
```

- **No way to list active schedules.** The only source of a `scheduleId` is the
  POST that starts a stream, so the public API can only report on a stream this
  app itself started.
- **No `startedAt` anywhere** in the response schemas.
- **No webhooks.** The words webhook/callback/subscribe do not appear in the
  spec. `/v1/schedules` and `/v1/events` both 404.
- `bitfocus/companion-module-resi-studio` confirms this: it persists
  `SCHEDULE_IDS` in its own config because it cannot discover them.

Cornerstone's Resi goes live on **Resi's own schedule**, so the public API is
useless here. Route rejected.

### Resi — the internal Web API can

From `AustinLMayes/companion-module-resi-web`. Undocumented; its README says so
outright and warns it may break without notice.

```
POST https://central.resi.io/api/v3/auth/token
     {username, password, grant_type: "password_cookie"} -> access_token, expires_in
GET  https://central.resi.io/api_v2.svc/users/me         -> customerId, userId
GET  https://central.resi.io/api/v3/customers/{customerId}/encoders/status?wide=true
GET  https://central.resi.io/api_v2.svc/encoders?wide=true   -> uuid, name
```

Auth header is `Authorization: X-Bearer {token}` — **X-Bearer**, not `Bearer`.

Per-encoder fields the Companion module reads:

| Field | Meaning |
|---|---|
| `status` | `'started'` means live. Passive — true whoever started it. |
| `videoInputSource` | non-null = the encoder has video |
| `lastUpdate` | ISO stamp; the module refreshes when older than 20s |

**Open question, needs a live response:** whether `?wide=true` carries a stream
start time. If it does not, elapsed time is measured from when this app first
observed `started`, persisted so a restart mid-service does not reset it to
zero. Decide once a real payload has been seen; do not guess the field name.

Henry has approved using account credentials (2026-08-20).

### YouTube — works as asked

`liveBroadcasts.list?part=snippet,status&broadcastStatus=active&mine=true`

- `status.lifeCycleStatus === "live"` — live now. Other values: created, ready,
  testStarting, testing, liveStarting, live, complete, revoked.
- `snippet.actualStartTime` — a real start time, populated once state is `live`.
- **OAuth 2.0 only.** An API key will not work for `mine=true`. Scope
  `https://www.googleapis.com/auth/youtube.readonly` is sufficient.
- Quota: 10,000 units/day for a project. A `list` is cheap, but polling every
  15s is 5,760/day. Use the PCO-aware cadence and it lands near 1,000.

---

## Global constraints

- **The repo is public.** No credentials, no channel ids, no customer ids in
  code, tests, fixtures or docs.
- Resi username/password and the YouTube refresh token are **secrets** — they go
  through `main/services/encryption.ts` like every other credential, and must be
  excluded from the config snapshot.
- Every new persisted store declares `"config"` or `"runtime"` in its
  constructor, and a config store joins `CONFIG_FILES` in the same change.
- A new `catch` rethrows or returns the failure. Never log-and-continue.
- Both are cloud APIs behind rate limits. Poll on
  `reconnect-schedule`, never a fixed fast interval.
- Prod is plain HTTP and not a secure context — no `crypto.randomUUID`.

---

## The twenty touchpoints

What OBS and REAPER touch today, and therefore what a stream source must:

**Server**
1. `main/services/{obs,reaper}-service.ts` → `resi-service.ts`, `youtube-service.ts`
2. `main/services/integration-ids.ts` — id registry
3. `main/services/integration-manager.ts` — descriptor, config schema, state
4. `main/services/automation-triggers.ts` — trigger source list
5. `main/services/automation-conditions.ts` + `automation-engine.ts`
6. `main/services/routes/status-routes.ts` — status endpoint
7. `main/types/live.ts` — the DTO
8. `main/types/automation.ts`
9. `main/types/object-capabilities.ts`, `readout-types.ts`, `views.ts` — object union

**Renderer**
10. `renderer/main/use-{obs,reaper}-state.ts` → `use-resi-state.ts`, `use-youtube-state.ts`
11. `renderer/app/recording-status.ts` — **add `streamers()` + `streamingStat()` here**
12. `renderer/app/context-bar.tsx` + `bar-items.tsx` — a "Streaming" bar item
13. `renderer/app/home/cards.tsx`, `home-grid.tsx` — Home widget
14. `renderer/main/layout-objects.ts` — object config + defaults
15. `renderer/main/layout-renderer.tsx` — the readout
16. `renderer/editor/palette.tsx` — palette entry, STATUS group
17. `renderer/editor/inspector.tsx` — per-type rows
18. `renderer/components/integrations-panel.tsx` — settings card
19. `renderer/lib/sse-channels.ts` — broadcast channel
20. `docs/integrations/` — a page each, linked from the README table

---

## Tasks

### Task 1 — the shared streaming shape
- `main/types/live.ts`: `StreamStatusDTO { connected, live, startedAt, platform, detail }`.
  `startedAt` is ISO or null; null means "live but we do not know since when".
- `renderer/app/recording-status.ts`: `Streamer` interface + `streamers(resi, youtube)`
  + `streamingStat(list)` returning `{ value, sub, tone }`, mirroring
  `recordingStat` exactly — including "connected but not live" as its own state.
- Tests: every state, and the elapsed formatting with a null `startedAt`.

### Task 2 — Resi service (internal API)
- `resi-service.ts`: token cache with expiry, `users/me` for customerId,
  encoder status poll, `status === 'started'` per encoder.
- Config: username, password (secret), which encoder(s) to watch.
- Persist the first-observed `started` time in a **runtime** store so elapsed
  survives a restart; prefer a real API start time if the payload turns out to
  carry one.
- Broadcast on change only.

### Task 3 — YouTube service (OAuth)
- Google Cloud project + OAuth consent is the operator's job; the integration
  card must walk through it, because it is the one integration here with real
  setup burden.
- Store the refresh token as a secret; exchange for access tokens as needed.
- `liveBroadcasts.list` on the PCO-aware cadence; back off hard on 403 quota.

### Task 4 — the surfaces
Work the twenty above, driven by `streamingStat()` so each is a presentation of
one judgement.

### Task 5 — automation
Triggers for went-live / went-offline; conditions for is-streaming.

### Task 6 — docs
`docs/integrations/resi.md` and `youtube.md`, README table rows, and the Resi
page must state plainly that it rides an undocumented API that Resi may change.

---

## Decisions already made

- Resi via the internal API, with account credentials — Henry, 2026-08-20.
- YouTube is the passive source of truth if Resi restreams there; both ship.
- Elapsed time comes from the API where one exists, otherwise from first
  observation, persisted.
