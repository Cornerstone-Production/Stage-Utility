# API reference

The HTTP surface. Also what Bitfocus Companion and the automation engine call.

Most endpoints are under `/api`; the exceptions are listed under
[Outside `/api`](#outside-api). Live updates arrive on the SSE stream rather than
by polling. What a state-changing route answers with depends on what it changed:
the plan, view, output and slot routes return the updated `StageState`, while the
rest return the collection they touched (`{targets}`, `{rules}`, `{presets}`) or
an outcome (`{ok, …}`). Creating something answers `201`.

## What is protected, and what is not

The app is a LAN appliance with no user accounts, and **every route below is
reachable unauthenticated** unless it says otherwise. Three things do gate:

| | |
|---|---|
| **Cross-origin writes** | Any `POST`/`PUT`/`PATCH`/`DELETE` carrying an `Origin` whose hostname is not the request's `Host` is refused `403`. A request with no `Origin` is allowed, and reads are never gated. Ports are ignored so the dev proxy works |
| **The log** | `/log` and `/api/log` require `?token=…` when `STAGE_UTILITY_LOG_TOKEN` is set, and answer `401` without it. Unset means open |
| **Device enrolment** | `/enroll` authorises a `device` id against the secret that device was issued. An unrecognised device gets a holding screen rather than somebody else's screen |

Put it behind your own network. Do not expose it to the internet.

Request bodies are capped and a body over the limit is refused with `413` rather
than being read into memory. The cap depends on what the route carries: 8 MB for
ordinary JSON, 24 MB where the body is an image (`/api/branding`,
`/api/layout-images`), 64 MB for a bundle (`/api/config/import`,
`/api/views/import`), and 128 MB for an archive upload (`/api/archive/inspect`,
`/api/archive/import`).

**Stage & plan**
| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | `{ok, app, version, name}` — which server you reached, not just that one answered |
| GET  | `/api/version` | The running code version, uncached |
| GET  | `/api/state` | Current `StageState` |
| GET  | `/api/service-types` | PCO service types |
| GET  | `/api/team-positions` | Team positions for the active plan |
| GET  | `/api/plans?serviceTypeId=…` | Plans for a service type |
| GET  | `/api/pco/attachments` | Files on the active plan (plan + item level) |
| GET  | `/api/pco/attachment?match=…` | Stream the active plan's file matching a filename substring (proxied + cached) |
| POST | `/api/service-type` | Set active service type |
| POST | `/api/plan` | Set active plan |
| POST | `/api/plan/next` | Jump to the next plan (auto mode) |
| POST | `/api/plan/mode` | Set `auto` / `manual` |
| POST | `/api/refresh` | Re-fetch from Planning Center |
| POST | `/api/live/next` | PCO Services Live: go to the next item (like PCO's timer) |
| POST | `/api/live/previous` | PCO Services Live: go to the previous item |
| POST | `/api/allowed-service-types` | Set the allowlist |
| POST | `/api/slots` | Save a display's slots (`{slots, displayId?}`) |
| POST | `/api/show-qr` | Toggle the connect QR on the display |

**Views, displays & layouts**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/views` | List views |
| POST | `/api/views` | Create a view (`{name, kind, surface?}`) — `201` |
| PATCH | `/api/views/:id` | Update `name`, `kind`, `ndiSource`, `layout`, `surface`, `slotsLayout`, `scriptViewLayoutId`, `hideChrome` (boolean — hide the operator app's top bar and context bar while this view is open as a console), or `calendarSources` + `calendarTags` (both together, else `400`). Converting a bound view is refused, naming the screens. Pass `layoutRev` with a layout to get `409 {error, code, currentRev}` instead of overwriting somebody else's edit |
| POST | `/api/views/:id/slots` | Save a slots-view's slots |
| POST | `/api/views/resolve-slots` | Resolve a slot set against the current plan without saving it — what the editor previews with |
| POST | `/api/layout-objects/:objectId/slots` | Save the slots an inline slots-grid object defines |
| POST | `/api/views/:id/duplicate` | Duplicate a view |
| GET | `/api/views/:id/export` | Download the view and anything it embeds as one file |
| POST | `/api/views/import` | Merge an exported view in; returns what landed and what needs rebinding |
| POST | `/api/views/:id/copy-slots` | Copy slots from another view |
| POST | `/api/views/reorder` | Reorder views |
| DELETE | `/api/views/:id` | Delete a view |
| GET | `/api/outputs` | List physical displays |
| POST | `/api/outputs` | Add a display — `201` |
| PATCH | `/api/outputs/:id` | Set `name`, `viewId` (routing), `blackout`, `locked`, `hideTopBar` (show or hide this display's kiosk top bar), `slug` (`""` clears; validated against the reserved list — see [Display URLs](../display-urls.md)), or `mode` (`display`\|`panel`). A console view on a display screen is refused, with the reason, as `400` |
| POST | `/api/outputs/reorder` | Reorder displays |
| DELETE | `/api/outputs/:id` | Remove a display |
| POST | `/api/action/invoke` | Run an automation action (`{actionId, params?}`) — what a console control does |
| POST | `/api/notes` | Save a notes/checklist object's content (`{objectId, content}`) |
| POST | `/api/bar-items` | Set the context bar's items and order. `{items}` for the desktop bar, `{mobileItems}` for the phone's own set (empty = follow the desktop bar). Either may be omitted and is then left as it stands |
| GET / POST | `/api/layout-templates` | List / save a custom-layout template |
| PATCH / DELETE | `/api/layout-templates/:id` | Update / delete a template |
| GET / POST | `/api/layout-groups` | List / save a reusable object group (`{name, object}`) |
| DELETE | `/api/layout-groups/:id` | Delete a group |

`GET /api/displays` returns each output joined with its routed view's kind, for
clients that want a flat list. `POST /api/displays/refresh` reloads connected
screens (`{id?}`; omit it for all of them). `GET /api/displays/presence` returns
`{connected: [outputId], rev}` — the screens with a browser attached, which each
display page reports by heartbeat to `POST /api/displays/presence`. The same set
rides the `displays:presence` SSE channel; `rev` is what lets a client tell a
stale read from a fresh one.

**Presets** — `GET /api/presets`, `POST /api/presets` (snapshot the current
slots under a name), `POST /api/presets/import`, `POST /api/presets/reorder`,
`POST /api/presets/:id/apply` (onto a view or display), `PATCH /api/presets/:id`
(rename, replace its slots, or overwrite it from a display) and
`DELETE /api/presets/:id`.

**Integrations & wireless**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/integrations` | Integration states |
| POST | `/api/integrations/:id/config` | Update config (secrets encrypted) |
| POST | `/api/integrations/:id/enabled` | Enable / disable |
| POST | `/api/integrations/:id/test` | Test a connection |
| GET | `/api/wireless/providers` | Available device drivers |
| GET / POST | `/api/wireless/connections` | List / add a device connection |
| PATCH / DELETE | `/api/wireless/connections/:id` | Update / remove a connection |
| POST | `/api/wireless/connections/:id/test` | Test a device connection |
| GET | `/api/integrations/wireless/channels` | Bindable channels — `{id, label, deviceType}` per configured channel, whether or not it has ever reported. For pickers; `deviceType` is what lets one offer mics without charger bays |
| GET | `/api/integrations/wireless/statuses` | Live telemetry — full `DeviceStatus` per RF channel (RF, battery, runtime, frequency, audio). Chargers excluded. For widgets |
| GET / POST | `/api/wireless/meter-rate` | Get / set the polling interval |

`PATCH /api/wireless/connections/:id` also accepts `POST`, and takes either the
fields themselves or `{patch: {…}}`. The same is true of `/api/osc/targets/:id`.

**OSC** — targets are a list of their own rather than integration config.

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/osc/targets` | List / add a target |
| PATCH / DELETE | `/api/osc/targets/:id` | Update / remove |
| POST | `/api/osc/targets/:id/test` | Send a probe. UDP, so this proves the packet left, not that it arrived |
| POST | `/api/osc/send` | `{targetId, address, args?}` — what an OSC button fires |
| GET | `/api/osc/feedback` | The latest value seen per `targetId::address` |
| GET / POST | `/api/osc/feedback-port` | The UDP port incoming feedback is listened for on |

**RossTalk** — the entry point for a layout button, Companion and automation
alike. See [RossTalk](../integrations/rosstalk.md) for the command catalogue.

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/rosstalk/targets` | List (`{targets, simulate}`) / add |
| PATCH / DELETE | `/api/rosstalk/targets/:id` | Update / remove |
| POST | `/api/rosstalk/targets/:id/test` | Open the socket and send nothing |
| GET | `/api/rosstalk/commands?family=carbonite\|ultrix` | The commands that family accepts, with their parameters |
| GET / POST | `/api/rosstalk/simulate` | The global simulate switch (**on** out of the box) |
| POST | `/api/rosstalk/send` | `{targetId, commandId, params}` or `{targetId, raw}`. Answers with the line that was sent — or would have been. A rejected command is `400` with the reason |

**Automation** — see [Automation](../automation.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/automation/registry` | Every trigger, condition and action this build offers |
| GET | `/api/automation/plan-items` | The current plan's items, for the item pickers |
| GET / POST | `/api/automation/rules` | List (`{rules, settings}`) / create a rule |
| PATCH / DELETE | `/api/automation/rules/:id` | Update / delete |
| POST | `/api/automation/rules/:id/test` | Fire the action now, ignoring the trigger. Honours simulate; a refusal is `400` with the reason |
| GET / POST | `/api/automation/settings` | `simulate` and `disarmed` |
| GET / DELETE | `/api/automation/log` | Read / clear the Activity log |

**ProPresenter & ProdCom**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/propresenter/thumbnail?k=…` | Live slide thumbnail (JPEG proxy; `k` cache-busts per slide) |
| GET | `/api/propresenter/status` \| `/api/propresenter/instances` | Latest slide/timer state / every configured instance |
| GET | `/api/prodcom/transcript` | Recent transcript buffer (backfill for a freshly-loaded Captions display) |
| POST | `/api/prodcom/transcript/clear` | Empty the buffer everywhere at once |

**SPL (Smaart) & rundown**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/spl/metrics` | Latest live SPL reading per meter (device/channel) |
| GET | `/api/spl/history/current` | The active service's per-item SPL record (live) |
| GET | `/api/spl/history` | List saved past-service SPL records |
| GET | `/api/spl/history/:key` | One past-service record |
| GET / POST | `/api/spl/visible-metrics` | Which SPL metrics the history charts draw |
| GET | `/api/pco/plan-items` | Ordered plan items + note categories (Script / SPL Rundown) |
| GET | `/api/pco/checklist` | The active plan's checklist, read from its plan notes, with ticks applied |
| GET | `/api/pco/checklist-sources` | Note categories + team names this service type offers (settings picker) |
| GET | `/api/pco/calendar?viewId=…[&month=YYYY-MM]` | A month as a six-week grid of days, bucketed in the app time zone and filtered by the view's calendars and tags. Omit `month` for the current one. 400 if `month` is malformed or more than 36 months away; 502 if Planning Center cannot be reached |
| GET | `/api/pco/calendar-sources` | The organisation's calendars and tags (settings picker) |
| POST | `/api/pco/checklist/tick` | `{ key, done }` — tick one row; answers with the whole list |
| POST | `/api/pco/checklist/clear` | Untick every row on the active plan |

**People, attendance, timeline & baptism**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/people/count` | Live building occupancy (SenSource) |
| GET | `/api/sensource/locations` \| `/api/sensource/zones` | Pickers for the SenSource config |
| GET | `/api/attendance/history` \| `/history/:key` \| `/history/current` | List / one / live attendance record |
| GET | `/api/service-timeline` \| `/:key` \| `/current` | List / one / live per-item timing record |
| GET | `/api/obs/status` \| `/api/reaper/status` | Whether that recorder is rolling, and for how long |
| GET | `/api/pvp/status` | ProVideoPlayer layer state — what is on each layer, and how far in |
| GET | `/api/resi/status` \| `/api/youtube/status` | Whether that platform is live, and since when |
| GET | `/api/scores/status` | Followed teams' live scores + the last scoring change |
| GET \| POST | `/api/scores/favourites` | Read / replace the followed teams |
| GET | `/api/scores/teams?league=<id>` | One league's teams, for the picker |
| GET | `/api/baptism` \| `/api/baptism/sessions` | Live baptism state / saved sessions (+ start/next/baptized actions) |

**Correcting a recording**

A recording is one thing stored in three places — per-item timings, SPL and
attendance — all keyed by the same `serviceKey`. These routes treat it as one
thing.

| Method | Path | Purpose |
|--------|------|---------|
| DELETE | `/api/service-timeline/:key` \| `/api/attendance/history/:key` \| `/api/spl/history/:key` | Delete the recording. Any of the three deletes **all three**; the response is `{ deleted, records }` naming what was removed |
| POST | `/api/history/window` | Move a recording's start/end, trimming items and samples outside it |
| POST | `/api/history/recalc` | Re-derive attendance aggregates from the stored samples |
| POST | `/api/history/item-counted` | Override whether one item counts toward the service timers |
| POST | `/api/history/merge` | Merge `sourceKey` into `targetKey` and delete the source, raw samples included |

Two things to know:

- **A service that is recording right now cannot be edited or deleted** — these
  answer `409`. The recorder holds the same record and would write its own copy
  back over any change, and releasing it only makes the next live tick start a
  fresh empty record in its place. Correcting a recording is a post-hoc repair.
- **Deleting a recording keeps its raw samples.** The
  [data archive](../data-archive.md) is the source of truth the records are
  derived from; removing it is a separate, irreversible decision. A merge does
  move the raw samples, because otherwise a later rebuild would undo the merge.

**ScriptView**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/scriptview/rundown?serviceTypeId=…[&planId=]` | Resolved rundown (items, columns, service times, timezone) |
| GET / POST | `/api/scriptview/layouts` | List / save global layouts |
| GET / POST | `/api/scriptview/config` | Get / set which service types show on the landing |
| GET | `/api/scriptview/note-categories?serviceTypeId=…` | Note categories for the column picker |
| GET / POST | `/api/scriptview/roles` | List / save [category roles](../features/scriptview-and-baptisms.md#category-roles) |
| POST | `/api/scriptview/roles/seed` | One role per note category on a service type. Adds only; never rewrites a role you have |

**Patch sheet** — see [Patch sheet](../patch-sheet/README.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/patch` | The whole patch file / replace it |
| GET | `/api/patch/export?sheetId=…&format=csv\|xlsx[&variantId=&includeUnused=1&planId=&serviceTypeId=]` | One sheet as a file. Unknown sheet, variant or format is `400` |
| POST | `/api/patch/parse-xlsx` | Read a spreadsheet into `{headers, rows}` for the import mapper. Writes nothing |

**Baptisms** — the timer's actions are one `POST` each under `/api/baptism/`,
and each returns the new timer state: `start`, `baptized`, `start-baptisms`,
`next`, `undo`, `finish`, `pause`, `resume`, `reset`, and `mode`
(`{mode: "grouped"|"per-person"}`). `GET` and `POST /api/baptism/triggers` read
and set which plan items start each phase, and
`DELETE /api/baptism/sessions/:id` removes one saved session.

**Updates, backup and the archive** — see
[Updates and logs](../ops/updates-and-logs.md) and
[Data archive](../data-archive.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/update/status` \| `/api/update/notices` | Where the updater is / the notice waiting to be shown |
| POST | `/api/update/check` | Ask now. Unlike the scheduled check, this always reports |
| POST | `/api/update/apply` \| `/api/update/track` | Install / switch between the `main` and `beta` tracks |
| GET | `/api/update/lock` | `{active, reasons}` — why an update would be refused right now |
| POST | `/api/update/notices/dismiss` \| `/api/update/restart` \| `/api/update/auto` | Dismiss the post-update dialog / restart / set the automatic-update mode and window |
| GET | `/api/config/export` | The config snapshot as a download. Credentials are excluded |
| POST | `/api/config/import` | Apply a snapshot, then **restart** |
| GET / POST | `/api/config/snapshots` | List / save a named snapshot on this machine |
| POST / DELETE | `/api/config/snapshots/:id/recall` \| `/api/config/snapshots/:id` | Apply one (then restart) / delete one |
| GET / POST | `/api/backup/schedule` | The automatic-backup schedule |
| POST | `/api/backup/run` | Run one now |
| GET | `/api/archive/export` | The raw sample archive as a zip |
| POST | `/api/archive/inspect` | Read a zip and report what it holds. Writes nothing |
| POST | `/api/archive/import` | Apply it. `X-Archive-Mode: skip\|merge\|replace` decides what happens to services recorded differently here |

**`/api/update/apply` and `/api/update/track` answer `409`** —
`{error: "locked", locked: true, reasons}` — while a service is live or any
recorder is running. Pass `{override: true}` to go anyway.

**Kiosk devices** — see [Kiosk devices](../kiosk-devices.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/devices` | `{scanning, bound, seen, matches}`. Device secrets are stripped |
| POST | `/api/devices/scan` | Open or close the scan window |
| POST | `/api/devices/claim` | Bind a device to an output, creating one if asked |
| POST | `/api/devices/release` | Unbind it. The screen keeps its view and slug |
| GET | `/api/devices/for-output/:outputId` | Which device drives this screen |

**Settings toggles** — one `POST` each, all returning the updated `StageState`:
`/api/timezone`, `/api/hour-cycle`, `/api/public-url`, `/api/reconnect-schedule`,
`/api/taper-window`, `/api/checklist-sources`, `/api/kiosk-discovery`,
`/api/baptism-auto-start`, `/api/ndi-enabled`, `/api/onboarding-dismissed`,
`/api/saved-colors`, `/api/icon-color`, `/api/icon-glyph`,
`/api/caption-colors`.

**Branding & events**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/branding/source?target=app\|empty\|avatar` | Original (un-cropped) logo, empty-slot image or default avatar |
| POST | `/api/branding` | Update app name, accent colour, logos and their crops |
| GET | `/api/events` | Multiplexed Server-Sent Events stream — see [Channels](#channels) |
| POST | `/api/events/subscribe` | Set the channels a connection wants (`{cid, channels}`) |

## Channels

`GET /api/events` is one stream carrying everything, filtered per connection.
Pass `?cid=<your id>` and then `POST /api/events/subscribe` with the same `cid`
and the channels you render; until you do, you are sent all of them. A stream
marked `?client=companion` (or with an `X-Companion-Module` header) is counted
toward the Companion integration's connected-client total.

A comment heartbeat goes out every 20 seconds, and a client whose socket backs up
past 2 MB is dropped rather than buffered.

**Hydrated on connect** — these carry state rather than events, so the stream
opens with a full snapshot of each and a display is never blank waiting for
something to change:

`server:hello` · `stage:state-changed` · `pco:live` · `propresenter:status` ·
`propresenter:instances` · `spl:metrics` · `spl:history` · `attendance:history` ·
`service-timeline:history` · `baptism:state` · `obs:status` · `reaper:status` ·
`pvp:status` · `scores:status` · `resi:status` · `youtube:status` ·
`update:status` · `companion:signals` · `osc:feedback` · `people:count` ·
`wireless:channels` · `calendar:grid` · `displays:presence`

**Pushed only when something happens:**

`prodcom:transcript` · `slots:devices` · `integrations:state-changed` ·
`wireless:connections-changed` · `osc:targets-changed` ·
`rosstalk:targets-changed` · `rosstalk:simulated` · `automation:rules` ·
`automation:settings` · `automation:log` · `patch:updated` · `kiosk:devices` ·
`display:refresh` · `settings:allowedServiceTypeIds-changed`

Every status snapshot carries a `rev` counter so a hydrate read cannot overwrite
a newer push — see [Integrations](../integrations/README.md#the-snapshot-version).

## Outside `/api`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/photos?u=…` | Cached Planning Center photo proxy. `u` must be an `https` URL on `planningcenteronline.com`; anything else, and any redirect, is refused — it is not a general-purpose proxy |
| GET | `/log` | The server's recent output, as a page, with a health strip and level/source filters. Token-gated when `STAGE_UTILITY_LOG_TOKEN` is set |
| GET | `/logs` | Redirects to `/log`, query string intact. Same gate, checked before the redirect — an unauthorised request is a 401, never a 302 into one |
| GET | `/api/log[?since=N]` | `{ lines, reset, latestSeq, checks }`. Same gate. Omit `since` for the whole buffer; pass the previous `latestSeq` to get only what is newer. `reset: true` means replace rather than append — the buffer rolled past your cursor, or you asked for everything. `checks` is the health snapshot the page draws: version, uptime, app time zone, warning and error counts, and one entry per configured integration |
| GET | `/enroll?device=…&token=…` | Where a kiosk device asks which screen it is. Redirects to that screen, or shows a holding page |
| GET | `/kiosk/install-linux.sh` \| `install-macos.sh` \| `install-windows.ps1` | The kiosk agent installers, with this server's address already in them |
| GET | `/layout-images/:name` \| `/branding-images/:name` | Uploaded images, content-addressed and served immutable |
| POST | `/api/layout-images` | Store an image and return its URL |
| GET | `/api/history/export` | The service report as a spreadsheet (`?from=&to=&include=…`) |

Everything else is the app itself: `/<display id>` and `/<slug>` render a
screen, and the operator pages render the app — see
[Display URLs](../display-urls.md).
