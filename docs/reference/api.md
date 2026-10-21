# API reference

The HTTP surface. Also what Bitfocus Companion and the automation engine call.

Most endpoints are under `/api`; the exceptions are listed under
[Outside `/api`](#outside-api). Live updates arrive on the SSE stream rather than
by polling. What a state-changing route answers with depends on what it changed:
the plan, view, output and slot routes return the updated `StageState`, while the
rest return the collection they touched (`{targets}`, `{rules}`, `{presets}`) or
an outcome (`{ok, …}`). Creating something answers `201`. A JSON reply of 8 KB
or more is gzipped when the request sends `Accept-Encoding: gzip`, as every
browser does; one that does not ask gets it plain.

Failures answer `{error}` with the status that says whose problem it is: `400`
for a body or query the caller got wrong, `409` for something the server cannot
do right now (editing a service that is recording), `413` for an over-limit
body, and `502` for a read that only failed because Planning Center could not be
reached — every `/api/pco/*` read, plus `/api/service-types`, `/api/plans`,
`/api/team-positions` and the two `/api/servicecue` reads. A `serviceTypeId` or
`planId` that is not a Planning Center id (digits only) is a `400` naming the
parameter on any of them; Planning Center is not asked. A `503` is a data file
the server cannot read, naming the file: every save to that store, the kiosk
device routes and `/enroll`, the cue manifest, states and YAML, rule edits, and
a config export or backup. See
[When a store file cannot be read](../ops/reliability.md#when-a-store-file-cannot-be-read).
A recorded file the server cannot read answers `503` the same way from the data
archive's export, inspect and import, the History workbook, and a read of or
edit to that service, its baptism lane included (its SPL series answers `500`,
which the chart shows as samples unavailable): see
[When a recorded file cannot be read](../ops/reliability.md#when-a-recorded-file-cannot-be-read).
A `500` means this app broke, and only that.

## What is protected, and what is not

The app is a LAN appliance with no user accounts, and **every route below is
reachable unauthenticated** unless it says otherwise. Four things do gate:

| | |
|---|---|
| **Cross-origin writes** | Any `POST`/`PUT`/`PATCH`/`DELETE` carrying an `Origin` whose hostname is not the request's `Host` is refused `403`. A request with no `Origin` is allowed, and reads are never gated. Ports are ignored so the dev proxy works |
| **The log** | `/log` and `/api/log` require `?token=…` when `STAGE_UTILITY_LOG_TOKEN` is set, and answer `401` without it. Unset means open. `/api/prodcom/transcript/raw` — the unredacted transcript — uses the same token and the same failure |
| **Device secrets** | `/enroll` authorises a `device` id against the secret that device was issued; an unrecognised device gets a holding screen rather than somebody else's screen. `POST /api/devices/:id/health` takes the same secret in an `x-device-token` header and answers one `401` for an unknown id, an unconfirmed binding and a wrong secret alike |
| **Cue calls** | `POST /api/cues/:name` requires `Authorization: Bearer su_…` and answers `401` without one, **unless the request is a same-origin browser write** — a cue button on a console — which is logged as `console`. `POST /api/action/invoke`, the cue token **writes** (mint, revoke), `import-pairs` and `buttons/refresh` require the same token **unless the request is a same-origin browser write** — an `Origin` naming this server, which a browser sends on every `POST`/`DELETE` and a page on any other origin cannot forge. `Sec-Fetch-Site` is not required (browsers send it only to HTTPS or localhost, and this app is plain HTTP on a LAN address), but when present it must say `same-origin`. Reads are open, including the token list and the Home Assistant fragment: a same-origin `GET` sends no `Origin`, and neither carries a secret |

The cue token identifies the caller in the activity log and keeps the call route
closed to anything that has not been handed one. **It is not a perimeter.** Anyone
with write access to the app over the LAN can change any setting, including the cue
rules and the tokens themselves, as they always could — the rule routes are ungated
like every other settings route. The perimeter is the network: do not expose the app
beyond the LAN or Tailscale, and restrict Companion's own unauthenticated API port
with a switch ACL. See [SECURITY.md](../../SECURITY.md).

Put it behind your own network. Do not expose it to the internet.

Request bodies are capped and a body over the limit is refused with `413` rather
than being read into memory. The cap depends on what the route carries: 8 MB for
ordinary JSON, 24 MB where the body is an image (`/api/branding`,
`/api/layout-images`), 64 MB for a bundle (`/api/config/import`,
`/api/views/import`, `/api/video/import`, `/api/video/import/preview`), and 128 MB for an archive upload (`/api/archive/inspect`,
`/api/archive/import`).

**Stage & plan**
| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | `{ok, app, version, name}` — which server you reached, not just that one answered |
| GET  | `/api/version` | The running code version, uncached. A request from loopback also gets `dataDir` and `pid` — never a LAN caller, since those are a filesystem path and a process id |
| GET  | `/api/state` | Current `StageState` |
| GET  | `/api/service-types` | PCO service types |
| GET  | `/api/team-positions` | Team positions, `{teamId, teamName, positionName}[]`, for the service type selected in the app. `?serviceTypeId=…` answers for that type instead (`400` unless the value is a Planning Center id: 1-20 digits). `?all=1` (or `all=true`) answers for every service type as `{positions, failed}`: each position also carries `serviceTypeId` and `serviceTypeName`, and `failed` names the types that could not be read, which are skipped rather than failing the call. `all=0` and `all=false` mean the default; any other `all` value is `400`. Types are read one at a time and each read is cached |
| GET  | `/api/plans?serviceTypeId=…` | Plans for a service type |
| GET  | `/api/plans/upcoming?days=…` | Every allowed service type's plans from the last 7 days to `days` ahead (whole days; default 60, capped at 365, and anything that is not a whole day above zero takes the default), sorted by date, each with `{serviceTypeId, serviceTypeName, planId, title, sortDate, dates, isCurrent}`. Cached for five minutes, or thirty seconds when a service type could not be read (it is left out and logged, and asked for again at the next refresh); `cacheAgeMs` and the `X-Plans-Cache-Age-Ms` header say how old the list is. Always `200` — when Planning Center cannot be reached the body carries `unavailable` with the reason, and the last good list if there is one |
| GET  | `/api/pco/attachments` | Files on the active plan (plan + item level) |
| GET  | `/api/pco/attachment?match=…` | Stream the active plan's file matching a filename substring (proxied + cached). The `200` carries an `ETag` naming the attachment id and its version (`updated_at`, else size), and `If-None-Match` with it is a `304` with no body and no download; `Cache-Control: private, max-age=300`. `404` when none matches, when Planning Center is not configured, or when no plan is selected; `502` when Planning Center will not give the file up; `500` when reading the plan's attachment list throws, or when the cached file is still missing after being looked up a second time (a newer version of the file was written while this one was being read) |
| POST | `/api/service-type` | Set the active service type: `{id}` (`400` without one). Answers the state |
| POST | `/api/plan` | Set the active plan: `{id}` (`400` without one). Answers the state |
| POST | `/api/plan/next` | Jump to the next plan (auto mode) |
| POST | `/api/plan/mode` | `{mode: "auto" \| "manual"}`; anything else is `400`. Answers the state |
| POST | `/api/refresh` | Re-fetch from Planning Center |
| POST | `/api/live/next` | PCO Services Live: go to the next item (like PCO's timer). Answers `{ok: true}` |
| POST | `/api/live/previous` | PCO Services Live: go to the previous item |
| GET | `/api/pco/live` | Planning Center Live's current item and mode, fetched from Planning Center on each call — the payload the `pco:live` channel pushes. `null` with no credentials or no plan selected |
| POST | `/api/allowed-service-types` | Set the allowlist: `{ids: string[]}` (`400` when `ids` is not an array). Answers the state |
| POST | `/api/plan-switcher-mode` | How the slot editors' plan switcher steps (`{mode: "within-type" \| "upcoming"}`). Editor-only — it changes nothing the screens follow |
| POST | `/api/slots` | Save a display's slots (`{slots, displayId?}`; `400` when `slots` is not an array, `404` for a `displayId` that names no display, and the primary display when it is omitted) |
| POST | `/api/show-qr` | Toggle the connect QR on the display |

**Views, displays & layouts**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/views` | List views |
| POST | `/api/views` | Create a view (`{name, kind, surface?}`) — `201`, answering the state. A missing or unrecognised `kind` makes a slots view. `surface: "console"` is honoured for a custom view or a calendar; any other kind is created as a display |
| PATCH | `/api/views/:id` | Update `name`, `kind`, `ndiSource`, `layout`, `surface`, `slotsLayout`, `serviceCueLayoutId` (also read as `scriptViewLayoutId`), `hideChrome` (boolean — hide the operator app's top bar and context bar while this view is open as a console), `showInSidebar` (boolean — `false` keeps a console out of the operator app's sidebar list; it still opens at `/consoles/:id`; absent means listed; a non-boolean is `400`), or `calendarSources` + `calendarTags` (both together, each an array of `{id, name}` strings, else `400`). Converting a bound view with `surface` here is refused, naming the screens; `POST /api/views/:id/surface` is the call that changes the view and its screens together. A console's `kind` may change only to one that can be a control surface (a custom layout or a calendar); another is `400` with the reason. The body is judged as it will be once all of it is applied: `surface: "display"` beside a `kind` takes any kind, and `surface: "console"` beside a `kind` needs one that can be a control surface. Every `kind` and `surface` refusal is decided before the first write, so a refused body writes nothing, a `name` beside it included. Pass `layoutRev` with a layout to get `409 {error, code, currentRev}` instead of overwriting somebody else's edit. Every refusal is decided before the first write, so a refused body (a stale `layoutRev`, an unknown `serviceCueLayoutId`, a kind or surface refused as above) writes nothing, a `name` beside it included |
| POST | `/api/views/:id/slots` | Save a slots-view's slots (`{slots, target?}`) |
| POST | `/api/views/resolve-slots` | Resolve a slot set without saving it — what the editor previews with. Body `{ slots, target? }`, where `target` is `{ serviceTypeId, planId }` and `planId: null` names the type's default board. Answers `{ slots, roster, reason? }`; `roster` is `live`, `plan`, `none` (a default board, resolved against nobody) or `unavailable` (Planning Center could not be read, and `reason` says why) |
| POST | `/api/layout-objects/:objectId/slots` | Save the slots an inline slots-grid object defines (`{slots, target?}`) |
| GET | `/api/views/:id/slot-targets` | The service type's default board and a plan's own, plus the plan it belongs to. `?serviceTypeId=&planId=` names which pair to read (a `serviceTypeId` with no `planId` is that type's default); absent, it is the active type and plan. Also `/api/layout-objects/:id/slot-targets` |
| DELETE | `/api/views/:id/slots/override/:planId` | Revert that plan to the default. `404` when the plan had no board of its own. Also `/api/layout-objects/:id/slots/override/:planId` |
| POST | `/api/views/:id/slots/promote` | Make a plan's board the service type's default (`{planId}`), clearing the plan's own. `404` when it had none. Also `/api/layout-objects/:id/slots/promote` |
| POST | `/api/views/:id/surface` | Change what a view is for, and with it every screen showing it, in one call: a screen is a control surface exactly when its view is a console, so the view's surface is the one thing written. Body `{surface: "display"\|"console", screens?}`; a `surface` that is neither, or a `screens` that is not an array of screen ids, is `400`. `screens` is the ids of the screens the caller showed the operator before they agreed (`[]` when it asked nothing): when they are not, as a set, the screens showing the view now, nothing is written and the answer is `409 {error, code: "screens-changed", screens: [{id, name}]}` with the list as it is now, to ask again with. Without `screens`, every screen showing the view changes, whatever is there: the call for a script. A view already as asked changes nothing and is not an error. Only a custom view or a calendar may become a console (the only kinds with something to operate), and Home and an unknown view are refused: `400` with the reason, nothing written. Answers the state. A failure puts the view back, with the same `500` shape as `POST /api/outputs`. `PATCH /api/views/:id` with `surface` is the narrower call and refuses a view that screens are showing, in either direction, naming them |
| POST | `/api/views/:id/duplicate` | Duplicate a view, optionally under `{name}`. `201`, answering the state plus `viewId`, the id of the copy this call made |
| GET | `/api/views/:id/export` | Download the view and anything it embeds as one file, `stage-utility-view-<name>-<date>.json` (`404` for an unknown view) |
| POST | `/api/views/import` | Merge an exported view or plan in; returns what landed and what needs rebinding. Body is the bundle, or `{bundle, serviceTypeId?, onClash?}` to land a plan export under a chosen service type (`onClash` is `keep`, the default, or `replace`) |
| GET | `/api/plans/export?serviceTypeId=…[&slots=type\|all&patch=1\|0&presets=1\|0]` (defaults: `slots=type`, `patch=1`, `presets=0`) | Download one service type's setup as one file — its slot boards, the views and layouts holding them, optionally the patch variant it is assigned to and the slot presets. `slots=all` also carries other types' boards on those views. Missing or unknown type, a bad flag, or Planning Center not being configured, is `400` |
| GET | `/api/plans/export/preview?serviceTypeId=…[&slots=type\|all]` | What that file would contain at that scope, for the export dialog's counts. `400` as above |
| POST | `/api/views/:id/copy-slots` | Copy slots from another view onto one board (`{fromViewId, target?}`) |
| POST | `/api/views/reorder` | Reorder views: `{ids: string[]}` (`400` when `ids` is not an array) |
| DELETE | `/api/views/:id` | Delete a view. Screens showing it are left with no view; each one that was a control surface is read-only from then on, and the server logs a `[screens]` line for it. `?ifUnshown=1` deletes the view only if no screen shows it, checked in the same turn that reserves the view for deletion (from then on no screen can be pointed at it, by routing or by a new screen, until the delete is done): when one does, nothing is written and the answer is `409 {error, code: "view-shown", screens: [{id, name}]}`. The Screens page sends it when a screen is removed together with its view |
| GET | `/api/outputs` | List physical displays |
| POST | `/api/outputs` | Add a display — `201`, answering the state plus `outputId`, the id of the screen this call made. `{name?, viewId?, expectSurface?, newView?, slug?, showInSidebar?}`. `viewId` names an existing view of either kind; the screen is a control surface when it is a console and a read-only wall display otherwise, and with no view it shows nothing yet. `newView` (`"wall"` or `"control"`, instead of `viewId`) makes a blank custom view of that kind, named after the screen. `expectSurface` (`"display"` or `"console"`, only with a `viewId`) is the kind of that view the operator was shown, checked in the same turn as the add: when the view is the other kind, nothing is made (no screen, no view write) and the answer is `409 {error, code: "surface-changed", surface}` with what the view is now; it is `400` with `newView`, without a `viewId`, or when it is not one of the two kinds. `showInSidebar` is written on the view a control surface shows, so it needs `newView: "control"` or a `viewId` naming a console; sent without one it is `400`, not ignored. A `mode` is `400`: a screen takes its role from the view it shows. Everything is validated before anything is written: a missing view, Home, a taken or reserved slug, `viewId` with `newView`, or a field of the wrong type is `400` with the reason and creates nothing. A write that fails part-way is rolled back, and the `500` says which step failed (`failed`) and what was and was not undone (`rolledBack`, `notRolledBack`) |
| PATCH | `/api/outputs/:id` | Set `name`, `viewId` (routing), `blackout`, `locked`, `hideTopBar` (show or hide this display's kiosk top bar), `allowHls` (whether a Video widget here may play over HLS; `false` keeps it on WebRTC only), `groups` (the [message groups](../features/stage-messages.md) this display is in, an array of group ids; every id must name a group in `/api/messaging`, and an unknown id is `400` naming it (a body that is not a list of ids is `400` too); stored deduplicated, in the groups' own order, and carried to every client as `resolvedByOutput[<id>].groups`, `[]` while it is in none), `textSize` (the ServiceCue text size this display shows, a number from 50 to 300, kept per display and carried to every client as `resolvedByOutput[<id>].textSize`, `null` while none is kept; another value is `400`), `rotation` (`0`, `90`, `180` or `270`, how far the [Mac output helper](../kiosk-devices.md#mac-output-helper) turns this screen's picture; absent means `0`; another value is `400`), `videoMode` (a mode name from the accepted list, `1080i50` through `720p60`, what a DeckLink port sends this screen in; absent means `1080p59.94`; any other string is `400` naming the list; both are fields of each entry in `GET /api/outputs`, which is where the helper reads them, and are not in `resolvedByOutput`), `slug` (`""` clears; validated against the reserved list — see [Display URLs](../display-urls.md)). A `viewId` of either kind is accepted: pointing a screen at a console makes it a control surface, and at any other view makes it read-only. `expectSurface` (`"display"` or `"console"`, sent with a `viewId`) is the kind of view the caller believes it is routing to, and is checked in the same turn as the write: when the view is the other kind, nothing in the body is written (the view is routed before any other field, so a `name` beside it does not land alone) and the answer is `409 {error, code: "surface-changed", surface}` with what the view is now. The Screens page sends it after the operator confirms a screen going live (or stopping), so a view changed while the question was open is not routed to on the strength of the old answer. Without it the write is allowed, which is what Companion's route action and scripts do; it is `400` when it is not one of the two kinds, or comes without a `viewId` naming a view. Whenever a write changes whether a screen's buttons work the server logs a `[screens]` line. A `mode` is `400` with the reason (a screen takes its role from the view it shows); no field of an entry in `GET /api/outputs` is a role. An id naming no display is also `400` with the reason, for every field |
| POST | `/api/outputs/reorder` | Reorder displays: `{ids: string[]}` (`400` when `ids` is not an array) |
| DELETE | `/api/outputs/:id` | Remove a display |
| POST | `/api/action/invoke` | Run an automation action (`{actionId, params?}`; `400` without a string `actionId`) — what a console control does. Always `200 {ok, detail}`: an unknown action or one that fails is `ok: false` with the reason, and is logged on `[action]`. Needs a cue bearer token unless the request is a same-origin browser request |
| POST | `/api/notes` | Save a notes/checklist object's content (`{objectId, content}`, `content` an object; `400` otherwise). The write is awaited, so a failed save is a failed request |
| GET | `/api/messages` | The [stage messages](../features/stage-messages.md) state, the snapshot `messages:state` also carries: `{rev, serverNow, groups, quickMessages, quickReplies, messages, alerts}`. `serverNow` is the server's clock in milliseconds when the snapshot was built; `messages` is today's, oldest first; `alerts` is every message whose alert is still running, newest first |
| POST | `/api/messages` | Send a message: `{to, text, alert?, from?}`. `to` is group ids from `/api/messaging`, or exactly `["everyone"]`; `text` is 1–280 characters once trimmed; `alert` (default `false`) holds the screens for 30 seconds; `from` (default `"Operator"`) is 1–60 characters. `201` with the message; the server stamps `id`, `at` and `alertUntil`, and a body cannot choose them. A body that breaks a rule is `400` with the reason |
| POST | `/api/messages/:id/clear-alert` | End a running alert early (`{from?}` names who did). `200` with the state, also for an alert that is already over; `404` for an id nobody issued, `400` for one that is not a message id |
| POST | `/api/messages/:id/replies` | Answer a message from a [Messages widget](../features/stage-messages.md#replies-and-who-may-answer): `{text, objectId, outputId?}`. `text` is 1–60 characters once trimmed; `objectId` is the widget, found in the stored layouts (containers included), and `outputId` the screen it is drawn on when it is on one. `201` with the reply `{id, at, from, text}`. `from` is the server's: the screen's name, else the name of the view holding the widget; the body cannot set it. `403` when `outputId` names a screen that is not a control surface (its view is not a console) or does not draw that widget (in its routed view, or one that view embeds), when `outputId` is omitted and the widget has no groups of its own, or when the widget's groups (its own list, else the screen's) do not include a group the message went to and it was not sent to Everyone; this keeps honest clients honest and is not authentication, as the app has no logins; `409` when the message already has 20 replies, `404` for an unknown message (or one cleared at midnight), or an `objectId` that is not a Messages widget; `400` with the reason for a message id, `objectId` or `outputId` of the wrong shape, or text that breaks a rule |
| GET / PUT | `/api/messaging` | The groups (`{id, name}`), quick messages and quick replies, and the `version` they are at. `PUT` replaces all three — `{version, groups, quickMessages, quickReplies}`, `version` being the one the body was built from and a new group carrying no `id` — answers `200` with what is stored (at the next `version`), `409` with code `config-changed` when `version` is not the stored one (another window saved first; nothing is changed, so reload and make the change again), and `400` with the reason for a body with no `version` or past a limit: 20 groups of 1–40 characters, names unique without regard to case and never `Everyone`; 24 quick messages of 1–280; 12 quick replies of 1–60; a group `id` the server never issued. A group left out of the body is deleted and comes off every screen that held it; if that last step fails the config is still saved and the answer is `500` with code `groups-not-cleared`, and the next `PUT` retries it, built from a fresh `GET`'s `version` (the `500` carries none, and a `PUT` with the old version is `409`) |
| POST | `/api/bar-items` | Set the context bar's items and order. `{items}` for the desktop bar, `{mobileItems}` for the phone's own set (empty = follow the desktop bar). Either may be omitted and is then left as it stands |
| GET / POST | `/api/layout-templates` | List / save a custom-layout template (`{name, layout}`, `layout` an object with an `objects` array and a canvas with numeric `width` and `height`; `400` otherwise). Saving answers `201` with the list |
| PATCH / DELETE | `/api/layout-templates/:id` | Update (`{name?, layout?}`, at least one) / delete a template. Both answer the list |
| GET / POST | `/api/layout-groups` | List / save a reusable object group (`{name, object}`; `201`, answering the list) |
| DELETE | `/api/layout-groups/:id` | Delete a group. Answers the list |

**`target` on a slot write.** Optional, and picks which of a service type's two
boards the write lands on. Read by `POST /api/views/:id/slots`, `POST
/api/layout-objects/:objectId/slots`, `POST /api/views/:id/copy-slots` and `POST
/api/presets/:id/apply`. `POST /api/slots` does not read it.

| `target` | Lands on |
|---|---|
| omitted | the current plan's board if a plan is selected, else the type's default |
| `{"kind":"default","serviceTypeId":"…"}` | that service type's default |
| `{"kind":"plan","planId":"…","serviceTypeId":"…"}` | that plan's board only |

A `target` that is present but malformed is a `400`, not a fall back to the
default, and a `{"kind":"plan"}` target naming a service type the plan does not
belong to is a `400` as well. An unknown view, layout object or plan is a `404`.
See [Mic slots](../slots.md#defaults-and-this-week).

`GET /api/displays` returns each output joined with its routed view's kind, for
clients that want a flat list. `POST /api/displays/refresh` reloads connected
screens (`{id?}`; omit it for all of them). `GET /api/displays/presence` returns
`{connected: [outputId], rev}` — the screens with a browser attached, which each
display page reports by heartbeat to `POST /api/displays/presence` (`{outputId, …}`, or `{outputId, leaving: true}` when the page closes; answers `{ok}`, false without an `outputId`). The same set
rides the `displays:presence` SSE channel; `rev` is what lets a client tell a
stale read from a fresh one.

The heartbeat body may also carry `video`: an array of up to 32 reports, one
per Video widget instance on that screen currently showing a relay or
external feed's picture — `{feedId, via: "webrtc"|"hls", decoded, dropped,
stalls, width, height, jitterBufferMs?}`,
`decoded`/`dropped`/`stalls` as deltas since that instance's last report, not
running totals. `jitterBufferMs` is the WebRTC receive-delay figure in
milliseconds: how long the average frame waited in the browser's jitter buffer
over that interval. It is `null` when the screen could not measure it, and
absent for HLS. A malformed array — not an
array, over 32 entries, or any entry with a non-string/empty `feedId`, a
`via` other than `webrtc`/`hls`, a `decoded`/`dropped`/`stalls` that is not
a whole number from 0 to 100000, a `width`/`height` that is not a whole
number from 0 to 16384, or a `jitterBufferMs` that is neither
absent/`null` nor a number from 0 to 600000 — is refused whole and
read the same as no `video` field at all; the rest of the heartbeat (the
Connected dot, the screen-size read) still lands. A report naming a feed id
this build no longer holds is dropped on its own, without refusing the
others. See [Health from the screens](../integrations/video-feeds.md#health-from-the-screens).

**Presets** — every route answers the list of presets unless noted.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/presets` | List |
| POST | `/api/presets` | Snapshot the current slots under a name: `{name, viewId?}` (`displayId` is read when `viewId` is absent; with neither, the primary display). `400` for a blank name |
| POST | `/api/presets/import` | Add one from data: `{name, slots}` |
| POST | `/api/presets/reorder` | `{ids: string[]}` |
| POST | `/api/presets/:id/apply` | Write it onto a view: `{viewId, target?}` (`displayId` is read when `viewId` is absent), taking the same optional `target` as a slot save. Answers the state plus `appliedViewId`, the view that was written. `404` or `400` as a slot save refuses |
| PATCH | `/api/presets/:id` | `{name?}` renames; `{slots}` replaces its slots, or `{overwriteFromDisplayId}` overwrites it from that view's current slots |
| DELETE | `/api/presets/:id` | Delete |

**Integrations & wireless**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/integrations` | `{descriptors, states}`: each integration's settings schema, and its connection state |
| POST | `/api/integrations/:id/config` | Update config: `{config: {…}}` (`400` when `config` is not an object). Secrets are encrypted. Answers the integration's state |
| POST | `/api/integrations/:id/enabled` | Enable / disable: `{enabled: boolean}`. Answers the integration's state |
| POST | `/api/integrations/:id/test` | Test a connection |
| POST | `/api/integrations/youtube/connect` | Start a device-flow attempt using the SAVED client ID and secret. `409` with `{error: "Save the client ID and secret first"}` when either is blank or mode is not `oauth`. Otherwise the status below |
| GET | `/api/integrations/youtube/connect` | `{status: "idle" \| "pending" \| "connected" \| "error", userCode?, verificationUrl?, expiresAt?, message?, channelTitle?}` — never the device code. Open, like every other read in this app: any LAN reader can see a pending `userCode` while an attempt is running, which is acceptable because the code only grants read-only YouTube access and is only good for a few minutes |
| DELETE | `/api/integrations/youtube/connect` | Cancels a pending attempt, or clears a stale error back to idle. `{disconnect: true}` in the body instead clears the stored refresh token and channel title and stops the service. Answers the status above |
| GET | `/api/wireless/providers` | Available device drivers |
| GET / POST | `/api/wireless/connections` | List / add a device connection (`{name?, providerId?}`; adding answers `201` with the list) |
| PATCH / DELETE | `/api/wireless/connections/:id` | Update (`{name?, providerId?, enabled?, config?}`) / remove a connection. Both answer the list |
| POST | `/api/wireless/connections/:id/test` | Test a device connection |
| GET | `/api/integrations/wireless/channels` | Bindable channels — `{id, label, deviceType}` per configured channel, whether or not it has ever reported. For pickers; `deviceType` is what lets one offer mics without charger bays |
| GET | `/api/integrations/wireless/statuses` | Live telemetry — full `DeviceStatus` per RF channel (RF, battery, runtime, frequency, audio). Chargers excluded. For widgets |
| GET / POST | `/api/wireless/meter-rate` | Get / set the polling interval, `{ms}`; `POST` takes a non-negative number (`400` otherwise) |

`PATCH /api/wireless/connections/:id` also accepts `POST`, and takes either the
fields themselves or `{patch: {…}}`. The same is true of `/api/osc/targets/:id`.

**OSC** — targets are a list of their own rather than integration config.

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/osc/targets` | List / add a target (`{name?}`; adding answers `201` with the list) |
| PATCH / DELETE | `/api/osc/targets/:id` | Update (`{name?, enabled?, config?}`) / remove. Both answer the list |
| POST | `/api/osc/targets/:id/test` | Send a probe. UDP, so this proves the packet left, not that it arrived |
| POST | `/api/osc/send` | `{targetId, address, args?}` — what an OSC button fires (`400` without a string `targetId` and `address`, or when the send fails) |
| GET | `/api/osc/feedback` | The latest value seen per `targetId::address` |
| GET / POST | `/api/osc/feedback-port` | The UDP port incoming feedback is listened for on, `{port}`; `POST` takes `{port}` (a number, or a string that reads as one) |

**RossTalk** — the entry point for a layout button, Companion and automation
alike. See [RossTalk](../integrations/rosstalk.md) for the command catalogue.

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/rosstalk/targets` | List (`{targets, simulate}`) / add (`{name?}`; `201`, answering the list) |
| PATCH / DELETE | `/api/rosstalk/targets/:id` | Update (the fields themselves in the body) / remove. Both answer the list |
| POST | `/api/rosstalk/targets/:id/test` | Open the socket and send nothing |
| GET | `/api/rosstalk/commands?family=carbonite\|ultrix` | The commands that family accepts, with their parameters |
| GET / POST | `/api/rosstalk/simulate` | The global simulate switch (**on** out of the box): `{simulate}`; `POST` takes `{simulate: boolean}` |
| POST | `/api/rosstalk/send` | `{targetId, commandId, params}` or `{targetId, raw}` (`400` without a string `targetId`). Answers with the line that was sent — or would have been. A rejected command is `400` with the reason |

**Automation** — see [Automation](../automation.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/automation/registry` | Every trigger, condition and action this build offers: `{triggers, conditions, actions, reservedCueNames}`, each definition `{id, label, params, help}` (a trigger also carries its `channel`). `reservedCueNames` is the sorted list of cue names the app ships, which no rule may take |
| GET | `/api/automation/plan-items` | The current plan's items, for the item pickers: `{items: [{value, label, dueAt, exact}]}`, `value` the item's title. Empty, never an error, with no plan loaded |
| GET | `/api/automation/propresenter-instances` | Every ProPresenter a rule can address, as `{items: [{value, label}]}` |
| GET | `/api/automation/propresenter-macros` | Macro names across every configured instance, unioned: `{items, unreachable}`. Empty, never an error, when one is unreachable, and `unreachable` names the instances that did not answer. A name only some instances have is labelled `DOORS (Main only)` — but only while every instance answered, since "only" is a claim about the machines that did |
| GET / POST | `/api/automation/rules` | List (`{rules, settings}`, each rule carrying its own `issues` — see below) / create a rule (`{name, trigger, action, …}`; `400` without those three, or for a duplicate or malformed cue name) |
| PATCH / DELETE | `/api/automation/rules/:id` | Update / delete. `PATCH` answers the rule with its `issues`, and `400` for an unknown id or a refused cue name; `DELETE` answers the list of rules |
| POST | `/api/automation/rules/:id/run` | Run the action once, now: [Run by hand](../automation.md#run-by-hand). Body `{confirmed?: boolean}`. Bypasses the trigger, conditions, cooldown, once-per-service and the rule's own switch; honours simulate and the disarm switch. `200 {outcome: "fired" \| "simulated" \| "failed", detail}` (an action that fails is still `200`, outcome `failed`), `404` unknown rule, `409` disarmed, `428` a confirm-before-running rule without `confirmed: true`, `401` with no same-origin Origin and no bearer token. Built-in cues can be run by their id |
| GET / POST | `/api/automation/settings` | `{simulate, disarmed}`; `POST` takes either or both, as booleans, and answers the settings |
| GET / DELETE | `/api/automation/log` | Read (`{entries}`) / clear (`{ok: true}`) the Activity log |
| POST | `/api/automation/rules/import-pairs` | Create cues from Companion. `{pairs}` makes two per ON/OFF pair, `{buttons}` makes one per single button; either key, or both, in one request. A button carrying `stateVariable` is a [toggle](../integrations/companion.md#toggle-buttons) and makes a PAIR instead — two cues pressing that one button, bound on the `_on` half. `stateVariable` on a pair binds its `_on` half the same way; a pair sent without one whose connections have no verified row has its source [learned](../integrations/companion.md#learning-a-state-source) instead. Answers `{created, skipped}`; a name already in use is skipped, never overwritten. `400` with neither key. Every imported cue carries a 3-second cooldown |

A rule's **issues** — see [Needs setup](../automation.md#needs-setup) — are an
array of `{step, index?, key, label, message}`: `step` is `"trigger"`,
`"condition"` or `"action"`; `index` is which condition, present only for that
step; `key` and `label` name the param; `message` is the reason, worded for
display. GET computes them fresh against the current build's registry on every
read — never stored on the rule.

POST and PATCH validate the same way and answer the rule itself with `issues`
attached — the same shape GET's list items carry, not a wrapper — so a script
reading the rule off the response is unaffected (POST is `201`). A save with
issues does not fail: it writes the rule with `enabled: false`
regardless of what was asked, and reports why. There are two refusals, both
`409` with `{error, code: "invalid-params", issues}` and nothing written: a
`PATCH` whose *entire* content is turning a rule with issues ON (`{enabled:
true}` and nothing else, which is what the rules list's switch sends), and a
`POST` that creates a rule with issues and asks for `enabled: true`. A rule
already enabled with issues (predates this build, or arrived from a restore) is
untouched by GET, by init, and by any write that does not go through this route
— see [Needs setup](../automation.md#needs-setup) for why that matters.

**Cues** — an automation rule called by name. See
[Companion](../integrations/companion.md#calling-a-cue-by-name).

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/cues/:name` | Run the cue. `:name` is the cue's current name or any of its former names (see [When a button is renamed](../integrations/companion.md#when-a-button-is-renamed)); a current name always wins. `200` dispatched — `{ok, detail}`, plus `state` (`on`, `off` or `unknown`) when the cue is half of a pair with a **State variable**, and `{detail: "already on", skipped: true}` when the variable already says what the call asked for and nothing was pressed. Within eight seconds of a press the last COMMAND is what a repeat is compared against rather than the variable, which lags it: the same state is `{detail: "already on (just pressed)", skipped: true}` and carries no `state`, the opposite presses whatever the variable reads (see [The settle window](../integrations/companion.md#the-settle-window)). `202` confirm required (`?confirm=…`, or `confirm` in a JSON body, to complete), `401` no token (a same-origin browser, such as a cue button on a console, needs none and is logged as `console`), `404` unknown, `409` refused with `{error, reason}`. `reason: "button-missing"` means the Companion button it presses is no longer in the export — nothing was pressed |
| GET / POST | `/api/cues/tokens` | List callers, `{tokens}` (never a hash) / mint one (`{label}`, `400` without one). Minting answers `201 {token, secret}`: the secret is returned once and never again |
| DELETE | `/api/cues/tokens/:id` | Revoke one caller. Answers `{ok, tokens}`, or `404` for an id nobody holds |
| GET | `/api/cues/home-assistant.yaml` | The Home Assistant fragment for every cue — `text/yaml; charset=utf-8`, not JSON, with `Content-Disposition: attachment; filename="stage_utility.yaml"` so it downloads as a fixed name |
| GET | `/api/cues/manifest` | Every cue as JSON, for an integration rather than a pasted config: `{version, server: {name, lanUrl}, switches, buttons}`. `version` goes up on any rule change and is the only thing worth comparing about it. A `switch` is an ON/OFF pair — `{id, name, room, on, off, toggle, state, reason?, settling?, commanded?, stateSource?, available}`, `state` one of `on`, `off`, `unknown`; `stateSource` is the Companion variable the state is read from, or an `app:<source>` such as `app:reaper.recording` for a pair Stage Utility answers for itself — treat it as opaque; `settling: true` with `commanded` (`on`/`off`) means a press was dispatched for that pair in the last eight seconds and `state` may still be from before it — show `commanded`, not `state`; a `button` is a lone cue — `{id, name, room, cue, available}`; a cue named `<base>_on` or `<base>_off` whose partner does not exist is neither, and is omitted from both lists, exactly as it is from the generated YAML. A switch or button the app ships rather than the operator made carries `builtin: true` (an integration can ignore it), and a switch may carry `tone: "live"` (ON means on air or recording). A cue whose Companion button has gone missing is listed with `available: false`, never dropped; a cue whose **Home Assistant** switch is off is omitted entirely, and a hidden pair omits both halves rather than exposing them as buttons. `?all=1` lists hidden cues too, each carrying `hiddenFromHome: true`, for the app's own cue buttons; an integration must not pass it. Open read; state comes from the same five-second cached read as `/api/cues/states`. Answers `503` rather than an empty list while `automation-rules.json` cannot be read, as do `/api/cues/states` and the YAML, and `?all=1` with them, so the app's own cue buttons go too; an integration must treat a failure as "unknown", never as "no cues" ([When a store file cannot be read](../ops/reliability.md#when-a-store-file-cannot-be-read)). Pairs with the [`cues`](#channels) channel |
| GET | `/api/cues/states` | What each bound ON/OFF pair's device is actually doing: `{ok, checkedAt, states}`, `states` keyed by the pair's base — `{on, off, variable, value, state, reason?, settling?, commanded?}` with `state` one of `on`, `off`, `unknown`. `settling: true` with `commanded` (`on`/`off`) means a press was dispatched for that pair in the last eight seconds and `value` may still be from before it — Companion polls the device on its own interval (see [The settle window](../integrations/companion.md#the-settle-window)); that one variable is re-read every second until it agrees. `ok` is false when any pair is unknown. Open read. Reads the bound sources on demand, in parallel, and serves the whole answer for 5 seconds — a Companion variable (custom, or a module's own), or an `app:<source>` this app answers itself, such as `app:reaper.recording` off the REAPER transport poll; only pairs with a **State variable** are in it, and an install with none reads nothing at all. A pair whose **Home Assistant** switch is off is still here, carrying `hiddenFromHome: true` — the app's own rules page reads this route for every pair's state, and the generated Home Assistant sensor lifts only the bases the YAML listed, which are the shown ones. The [`cues`](#channels) channel drops those rows |

**Companion** — reading the connected Companion's own configuration.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/companion/buttons` | Every pressable button (`{ok, buttons, cachedAt}`). Each carries `page`, `pageId`, `pageName`, `row`, `col`, `label`, `drives` and `actionIds` — the page's opaque id and the button's sorted action ids are its identity, and survive being renumbered or dragged to another key. Answers `200` with `{ok: false, reason}` when Companion is unreachable, so a picker can say which |
| POST | `/api/companion/buttons/refresh` | Drop the five-minute cache, re-read, and re-check every cue's button against it. `{ok, buttons, cachedAt, reconcile}`, where `reconcile` is `{applied, failed}` — `failed` names each cue whose new status could not be saved (`{ruleId, label, detail}`). Answers `ok: false` when any status failed to save, or `{ok: false, reason, buttons: []}` when Companion could not be read at all |
| GET | `/api/companion/pairs` | The import dialog's whole offer: `{ok, pairs, buttons, customVariables}` — ON/OFF pairs, the labelled buttons that are not half of one, and the names of Companion's custom variables (what a pair's state can be bound to; empty on an install with none) — each offer with its proposed cue name (`slug`) and whether that name (or any cue's former name) already exists (`exists`). A pair also carries `suggested`, true when its buttons drive a utility device such as a projector or a light and the dialog ticks it by default; single buttons are never suggested. A pair carries `stateSource` (the verified module variable its button drives, or `null`) and `learnable: true` when nothing in the table covers it and its state source will instead be [learned](../integrations/companion.md#learning-a-state-source) from a press. One request, because deciding which buttons are unpaired needs the pairs, and because the two lists' proposed names are disambiguated against each other. Answers `200` with `{ok: false, reason, pairs: []}` when Companion is unreachable — no `buttons` key |

**ProPresenter & ProdCom**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/propresenter/thumbnail?k=…&i=…` | Live slide thumbnail (JPEG proxy; `k` cache-busts per slide, and `i` picks the ProPresenter instance, the primary when absent or `default`). Sixteen thumbnails are kept so screens showing one slide share a fetch. `503` when ProPresenter is not connected or has no active slide, `502` when it will not give the image; never cacheable (`no-store`) |
| GET | `/api/propresenter/status` \| `/api/propresenter/instances` | Latest slide/timer state / every configured instance |
| GET | `/api/prodcom/transcript` | Recent transcript buffer (backfill for a freshly-loaded Captions display). Text that matched a ProdCom keyword marked sensitive is already replaced with asterisks; such a line carries `redactions`, the number of hidden runs. Never gated — a display carries no token |
| GET | `/api/prodcom/transcript/raw` | The same buffer with nothing hidden, for reviewing what a keyword covered up. Token-gated by `STAGE_UTILITY_LOG_TOKEN`, exactly like `/api/log`: unset means open, set means `?token=…` or a `401` |
| POST | `/api/prodcom/transcript/clear` | Empty the buffer everywhere at once |
| GET | `/api/prodcom/channels` | ProdCom's own channel list (id, name, color) — every channel it has, whether or not it has spoken. Backs the Transcription colors panel |

**SPL (Smaart) & rundown**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/spl/metrics` | Latest live SPL reading per meter (device/channel) |
| GET | `/api/spl/history/current` | The active service's per-item SPL record (live) |
| GET | `/api/spl/history` | List saved past-service SPL records |
| GET | `/api/spl/history/:key` | One record, by key — the recorder's own live copy when that service is the one currently recording (so a record too new for the persist debounce, or mid resume-rebuild, still answers), else the stored one |
| GET | `/api/spl/history/:key/series?metric=…&bucketSec=5` | The record's raw samples, down-sampled for a chart. `404` when the service has no raw rows |
| GET | `/api/spl/summary` | One row per recording: per Smaart metric, the service-level `leq`, its loudest single reading `max`, and the sample `count`. Either figure may be null; a metric with neither is left out. A recording made before per-metric stats existed is reported under its own `metricKey`, from the per-item fields. What the Trends chart's sound measure plots, so a year of recordings is one request rather than one per service |
| GET / POST | `/api/spl/visible-metrics` | Which SPL metrics the history charts draw: `{metrics}`, server-wide; `POST` takes `{metrics: string[]}` |
| GET / POST | `/api/spl/trend` | A stored `{shown, metric}` preference for an SPL line on an attendance trend. Nothing in the app reads it; the Recent services widget keeps its own `showSpl` and `splMetric` settings |
| GET | `/api/pco/plan-items` | Ordered plan items + note categories (ServiceCue / SPL Rundown) |
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
| GET | `/api/sensource/locations` \| `/api/sensource/zones` | Pickers for the SenSource config. `502` with the reason when Vea cannot be read |
| GET | `/api/attendance/history` \| `/history/:key` \| `/history/current` | List / one (`null` for a key nothing recorded) / live attendance record. `?summary=1` on the list leaves each finished record's `samples` out, for a page that shows only its stored figures; a record still recording keeps them. One record answers the recorder's live copy when that service is recording, else the stored one |
| GET | `/api/service-timeline` \| `/:key` \| `/current` | List / one (`null` for a key nothing recorded) / live per-item timing record (`null` with none recording). One record answers the recorder's live copy when that service is recording, else the stored one |
| GET | `/api/obs/status` \| `/api/reaper/status` | Whether that recorder is rolling, and for how long |
| GET | `/api/pvp/status` | ProVideoPlayer layer state — what is on each layer, and how far in |
| GET | `/api/resi/status` \| `/api/youtube/status` | Whether that platform is live, and since when |
| GET | `/api/scores/status` | Followed teams' live scores + the last scoring change |
| GET \| POST | `/api/scores/favourites` | Read / replace the followed teams: `{favourites: [{league, teamId, …}]}` (`400` when it is not an array). Entries naming a league this build does not know, or with no team id, are dropped |
| GET | `/api/scores/teams?league=<id>` | One league's teams, for the picker. `400` for an unknown league, `502` when ESPN cannot be read |
| GET | `/api/baptism` \| `/api/baptism/sessions` | Live baptism state / saved sessions (the timer's actions are below) |
| GET | `/api/baptism/lane?serviceKey=<key>` | One service's session lane: each testimony and baptism in real time, from its raw rows (`400` without `serviceKey`) |

**The SPL series**

`GET /api/spl/history/:key/series` reads the service's raw `spl.csv` rows — a
reading per second per metric — and returns them bucketed, because a two-hour
service is thousands of rows per metric and no plot is that wide:

```json
{ "serviceKey": "…", "metric": "SPL A Fast", "metrics": ["LAeq 1", "SPL A Fast"],
  "bucketSec": 5, "buckets": [{ "t": 1789675200000, "max": 94.1, "avg": 88.4 }] }
```

`t` is epoch ms at the bucket's start. `max` is the loudest single reading in
it; `avg` is the bucket's **energy** average (Leq), not an arithmetic mean —
decibels are logarithmic. Both are rounded to two decimal places, which is what
a meter reports. Buckets are anchored to the earliest row, so a service
beginning at 19:47:13 does not open with a part-empty one, and a bucket the
meter said nothing in is absent rather than zero. One bucket is emitted once
however the rows are ordered on disk — rolled files and merged services do not
arrive in time order.

`bucketSec` in the answer may be **wider** than the one asked for: the series is
capped at ~2,000 buckets and the width grows to fit rather than the window being
truncated. `metric` may differ from the one asked for — an unknown metric falls
back to the record's own, then to the first recorded — and `metrics` lists every
metric these rows carry, so a client can offer a switch without a second
request.

`500` means the rows are there and could not be READ — an unreadable directory,
a half-written file. The reason is logged server-side on a `[spl-series]` line;
the History chart says the samples are unavailable rather than falling back.

`404` means the service has **no raw rows at all**: a record from before the raw
layer existed, or one whose archive was pruned. That is not the same as a silent
meter, and the History chart falls back to a per-item step only for the 404.

**Correcting a recording**

A recording is one thing stored in three places — per-item timings, SPL and
attendance — all keyed by the same `serviceKey`. These routes treat it as one
thing.

| Method | Path | Purpose |
|--------|------|---------|
| DELETE | `/api/service-timeline/:key` \| `/api/attendance/history/:key` \| `/api/spl/history/:key` | Delete the recording. Any of the three deletes **all three**; the response is `{ deleted, records }` naming what was removed |
| GET | `/api/history/live?serviceKey=<key>` | Read-only (`400` without `serviceKey`): `{ live }`, whether any recorder is actively writing this key right now — the same check `assertNotLive` refuses on for the routes in this section that edit a recording (not every route here checks it — milestones and `/api/log/client` never do, and Reset pacing requires the opposite, a LIVE service). A client asks this before offering an action the server would otherwise 409, rather than guessing from a record it already holds |
| POST | `/api/history/window` | Move a recording's start/end, trimming items and samples outside it: `{serviceKey, startedAt?, endedAt?}`, ISO strings (`400` without a string `serviceKey`). Answers `{ok: true}` |
| POST | `/api/history/recalc` | Re-derive attendance aggregates from the stored samples: `{serviceKey}`. Answers `{ok: true}` |
| POST | `/api/history/rebuild` | Recompute the timing, SPL, attendance and baptism summaries for `serviceKey` from the [raw rows](../data-archive.md). Answers `{ timeline, spl, attendance, baptism, baptismDetail?, failed }`, each of the first four `{ rebuilt, items, missing }`; `409` while the service is recording or when there are no raw rows at all — both carry a body of `{ error, code }`, `code` being `"live"` for the first and `"no-raw-rows"` for the second (see `/api/baptism/rebuild` below) — `500` for any other failure (no detail in the body — the reason is on the server's own log) |
| POST | `/api/history/item-counted` | Override whether one item counts toward the service timers: `{serviceKey, itemId, counted}`. Answers `{ok: true}` |
| POST | `/api/history/item-times` | Correct one run of one item's recorded start/end. `{ serviceKey, itemId, sequence, startedAt?, endedAt? }` — ISO strings, `null` clears that override, an absent field leaves it alone. Answers the updated record with the correction applied |
| POST | `/api/history/merge` | Merge `sourceKey` into `targetKey` and delete the source, raw samples included. Answers `{ok: true, …}` with what each of the three stores did |
| POST | `/api/log/client` | `{ tag, message }` — one line onto the server log, so a browser-side failure reaches [`/log`](../ops/updates-and-logs.md). `tag` is a short lower-case word (`history`), written as `[history] …` at `warn`. Both fields are scrubbed, the message is cut at 300 characters, a bad `tag` or a blank `message` is `400`, a success answers `{ok: true}`, and a client is cut off after ten lines a minute with `429` — the cut-off writes one line of its own, so a throttled browser does not read as one that stopped failing |
| GET | `/api/history/milestones` | The operator's dated marks for the Trends chart |
| POST | `/api/history/milestones` | Add or replace one. `{ date, label, serviceTypeId? }`, plus `id` to replace. `400` with the reason for a `date` that is not a real `YYYY-MM-DD` day, a blank or over-60-character `label`, or a `serviceTypeId` nothing has recorded — each would store a mark nobody would ever see. Answers the whole list |
| DELETE | `/api/history/milestones/:id` | Remove one. Answers the whole list, or `404` when there is no such id |
| POST | `/api/service-timeline/current/reset-pacing` | Reset the Service pacing readout on the LIVE record: items that started before now stop counting toward it. 409 if no service is recording |

Two things to know:

- **A service that is recording right now cannot be edited or deleted** — these
  answer `409`. The recorder holds the same record and would write its own copy
  back over any change, and releasing it only makes the next live tick start a
  fresh empty record in its place. Correcting a recording is a post-hoc repair.
  A service whose record a recorder could not save yet is refused the same way,
  with `code: "unsaved"`, until the retried save lands: see
  [When a recorded service cannot be saved](../ops/reliability.md#when-a-recorded-service-cannot-be-saved).
- **An item time correction is an overlay.** The recorded stamps are never
  rewritten: the edit is stored on the record as `itemTimeEdits` and applied to
  `startedAt`, `endedAt` and `actualDurationSec` on every read, so a rebuild from
  the raw rows cannot undo it and clearing it restores what the recorder saw. An
  edited item carries `editedFrom` with the recorded values. `400` if the end is
  not after the start or either time falls outside the recording's own window.
  Neighbouring items are not moved.
- **Deleting a recording keeps its raw samples.** The
  [data archive](../data-archive.md) is the source of truth the records are
  derived from; removing it is a separate, irreversible decision. A merge does
  move the raw samples, because otherwise a later rebuild would undo the merge.

**ServiceCue**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/servicecue/rundown?serviceTypeId=…[&planId=]` | Resolved rundown (items, columns, service times, timezone). With no `planId`: the app's plan for the active service type, else the nearest upcoming one. `isDefaultPlan` says whether the plan returned is that one |
| GET / POST | `/api/servicecue/layouts` | List / save global layouts |
| GET / POST | `/api/servicecue/config` | Get / set which service types show on the landing |
| GET | `/api/servicecue/note-categories?serviceTypeId=…` | Note categories for the column picker |
| GET / POST | `/api/servicecue/roles` | List / save [category roles](../features/servicecue-and-baptisms.md#category-roles) |
| POST | `/api/servicecue/roles/seed` | One role per note category on a service type. Adds only; never rewrites a role you have |

Requests to `/api/scriptview/…` answer `308` with the same path and query under
`/api/servicecue/…`, keeping the method and body, so a script written against the
old paths still works once its client follows redirects.

**Patch sheet** — see [Patch sheet](../patch-sheet/README.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET / POST | `/api/patch` | The whole patch file / replace it |
| GET | `/api/patch/export?sheetId=…&format=csv\|xlsx[&variantId=&includeUnused=1&planId=&serviceTypeId=]` | One sheet as a file. Unknown sheet, variant or format is `400` |
| POST | `/api/patch/parse-xlsx` | Read a spreadsheet into `{headers, rows}` for the import mapper. Writes nothing |

**Baptisms** — the timer's actions are one `POST` each under `/api/baptism/`,
and each returns the new timer state: `start`, `baptized`, `start-baptisms`,
`next`, `advance`, `undo`, `finish`, `pause`, `resume`, `reset`,
`dismiss-save-error` (clears the note a failed session save leaves), and `mode`
(`{mode: "grouped"|"per-person"}`). `advance` dispatches to whichever action is
legal for the timer's current phase — meant for a caller (an automation,
Companion) that should not have to track phase to drive the timer forward. The
operator panel itself calls it only while armed ("First person in"); once a
phase is running the panel already knows which specific action applies and
calls that one directly. `GET` and `POST /api/baptism/triggers` read
and set which plan items start each phase, for one plan: `?planId=…` on the read, and
`{planId, testimonyItemId, baptismItemId}` on the write (`planId` may also come in the
query; `400` when it is in neither). The read answers what is stored for that plan, or
`{}`. `DELETE /api/baptism/sessions/:id` removes one saved session and answers
`{deleted}`.

`GET /api/baptism/lane?serviceKey=<key>` answers `{ spans }`, each
`{ kind: "testimony"|"baptism", person, startedAt, endedAt }`, oldest first,
derived from the service's `baptism.csv`. A span is one run of one clock: a pause
splits a testimony in two, and the stretches between spans — the armed wait, a
pause, a press that was undone — are time nobody was timed for. The last span's
`endedAt` is `null` while its clock is still running. A session reset before it
finished is not in the lane, because it was never recorded. `{ spans: [] }` for a
service with no baptism archive; a `500` when the archive exists and cannot be
read.

`POST /api/baptism/rebuild` takes `{ serviceKey }` rather than acting on the
live timer: it replays that service's `baptism.csv` and MERGES the result into
the stored sessions, never replacing them — see
[Baptisms are merged, never replaced](../data-archive.md#baptisms-are-merged-never-replaced).
Answers `{ rows, sessions, updated, added, unchanged, newer, disagreeing,
invalid, kept, full, restoredIds }` — see
[Baptisms are merged, never replaced](../data-archive.md#baptisms-are-merged-never-replaced)
for what each of the eight outcome categories means; `restoredIds` names the
sessions this call actually added or updated. `400` for a body
with no `serviceKey`; `409` while that service is recording, and a DIFFERENT
`409` when it has no `baptism.csv` at all (a session recorded before the raw
layer existed has a timeline record but none) — both carry a body of
`{ error, code }`, `code` being `"live"` for the first and `"no-raw-rows"`
for the second, since a client cannot tell two 409s apart by status alone;
`500` for any other failure, with no detail in the body. `/api/history/rebuild`
runs the same merge as its own baptism leg, and its 409s carry the same
`code` (see below), since both routes throw the same two errors through the
same dispatcher.

**Updates, backup and the archive** — see
[Updates and logs](../ops/updates-and-logs.md) and
[Data archive](../data-archive.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/update/status` \| `/api/update/notices` | Where the updater is / `{justUpdated}`, the notice waiting to be shown (`null` once dismissed) |
| POST | `/api/update/check` | Ask now. Unlike the scheduled check, this always reports |
| POST | `/api/update/apply` \| `/api/update/track` | Install / switch tracks (`{branch: "main" \| "beta"}`; `400` without a string `branch`). Either takes `{override: true}`, below |
| GET | `/api/update/lock` | `{active, reasons}` — why an update would be refused right now |
| POST | `/api/update/notices/dismiss` \| `/api/update/restart` \| `/api/update/auto` | Dismiss the post-update dialog (`{ok: true}`) / restart (the reply is the update status, plus `relaunchFailure` when this server could not arrange its own relaunch on launchd) / set the automatic-update mode and window (see Settings above) |
| GET | `/api/config/export` | The config snapshot as a download, `stage-utility-config-<date>.json`, the date in the app time zone. Credentials are excluded |
| POST | `/api/config/import` | Apply a snapshot (the bundle itself, or `{bundle}`), then **restart**. The reply is `{ok, applied, restarting}`, plus `relaunchFailure` (a reason) when this server could not arrange its own relaunch on launchd |
| GET / POST | `/api/config/snapshots` | List / save a named snapshot on this machine (`{name}`; saving answers `201`) |
| POST / DELETE | `/api/config/snapshots/:id/recall` \| `/api/config/snapshots/:id` | Apply one (then restart, with the same reply as an import) / delete one |
| GET / POST | `/api/backup/schedule` | The automatic-backup schedule. `POST` takes any of `{enabled, includeArchive, destination, intervalDays, keep}` |
| POST | `/api/backup/run` | Run one now. Answers the schedule, with `lastError` set when the run failed |
| GET | `/api/archive/export` | The raw sample archive as a zip |
| POST | `/api/archive/inspect` | Read a zip and report what it holds. Writes nothing |
| POST | `/api/archive/import` | Apply it. `X-Archive-Mode: skip\|merge\|replace` decides what happens to services recorded differently here (`skip` when absent or anything else) |

The import answers what it did and, separately, what it could not do:
`rawFilesFailed` names archive members it could not write, and
`itemTimeEditsDropped` names per service any item time corrections whose run
lost the merge — the local run wins, so the correction describing the run that
did not survive goes with it. Both are empty on a clean import.

**`/api/update/apply` and `/api/update/track` answer `409`** —
`{error: "locked", locked: true, reasons}` — while a service is live or any
recorder is running. Pass `{override: true}` to go anyway.

**Kiosk devices** — see [Kiosk devices](../kiosk-devices.md).

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/devices` | `{scanning, bound, seen, matches, health, updates, updatesListeningSince}`. Device secrets are stripped. A device that is one output of a Mac output helper carries its `output` (`{kind, name, port, modes?}`) in `bound` and `seen`. `health` lists what each helper output last reported, `{deviceId, fps, repeated, dropped, latencyMs?, at, receivedAt, struggling}`, for the ones still reporting; it is never stored. `updates` lists each Mac helper and Windows kiosk that has checked for updates in the last 20 minutes, `{machine, platform, host?, have, want, state, target?, detail?, at?, checkedAt, update, reason, waitingOn?, waitUntil?}`, also never stored; `updatesListeningSince` is when the server began answering checks |
| GET | `/api/machine-updates/check` | Asked every five minutes by a Mac's or a Windows kiosk's updater, and once by the Windows installer for its launcher's SHA-256: [Keeping the helper on the server's version](../kiosk-devices.md#keeping-the-helper-on-the-servers-version). Query: `machine` (its device id), `platform` (`macos` or `windows`), `have` (the helper's version, or the launcher's SHA-256), `host?`, `state?` (`idle`, `updated`, `failed`, `retrying`, `no-session`, `not-running` or `local-network`; what it last did), `target?` and `detail?` (what that was about, and why), `at?` (when, in unix seconds by the machine's clock, so a new failure is told from the same one reported again). Answers `{version, update, reason}`, where `version` is the server's version, or for Windows its launcher's SHA-256: `update` is true when the machine is behind and nothing holds it (for a Mac: a live service, the service window, or Planning Center's times not known yet; for both: the switch, and a version that failed there before). `400` naming the field for a check that is not one. Not authenticated: what a machine says is shown and logged, and drives nothing else |
| POST | `/api/machine-updates/request` | Update now, or Try again: `{machine}`. Overrides the switch, the service window and a past failure at the machine's next check, never a live service. `404` for a machine that has not checked in the last 20 minutes. Answers `{ok}` |
| POST | `/api/machine-updates/auto` | `{enabled}`: whether Mac helpers and Windows kiosks update with this server. Answers the state |
| POST | `/api/devices/scan` | Open or close the scan window. `{holder?, stop?}`: a Screens page holds one while it is open. A scan is what makes the server answer a device that is not set up; devices are listed in `seen` whether or not one is open. Answers `{scanning}` |
| POST | `/api/devices/claim` | Bind a device to an output. `{deviceId, outputId}` binds it to that screen. With no `outputId` it makes a new screen first, from the same fields as `POST /api/outputs` (`name`, or `newName`, else the device's hostname; `viewId` (with `expectSurface`, which refuses as above with a `409` that makes no screen and binds nothing) or `newView`, `slug`, `showInSidebar`; a `mode` is `400`), validated before anything is written. Binding the device is the last step of making the screen, so a binding that fails puts back everything before it (the screen, a view made for it, a sidebar listing written on an existing view) and answers the same `500` as `POST /api/outputs`. Those fields with an `outputId` are `400`. A device already bound is not made a new screen: with no `outputId` it is `409` naming the screen it shows (moving it is a claim with that screen's `outputId`). Answers `{ok, displaced, outputId}` |
| POST | `/api/devices/release` | Unbind it. The screen keeps its view and slug |
| GET | `/api/devices/for-output/:outputId` | Which device drives this screen |
| POST | `/api/devices/:id/health` | An output helper reports how one output is doing, every ten seconds: `{fps, repeated, dropped, latencyMs?, at}`. `fps` is frames per second over the window (0 to 1000); `repeated` the percent of that window's frames that repeated the one before because the page was late (0 to 100); `dropped` the whole number of frames the card has dropped since the output opened (cumulative, so a lower number than last time means it was reopened); `latencyMs` optional, a DeckLink output's measured delay from render to air in milliseconds (a number from 0 to 10000; `null` or absent until the helper has one, and then absent from the stored reading and from `GET /api/devices`; any other value is `400` naming the field); it is shown in Screen settings and is not part of the struggling rule; `at` the helper's own clock in ms since the epoch, which the server does not trust: a report is dated by when it arrives. Authenticated by the device's own secret, the one `/enroll` checks, sent in the `x-device-token` header, not by the same-origin rule a browser is held to. An id this server holds no binding for, a binding that has no secret pinned yet, and a missing or wrong secret are all `401`, so the route does not say which ids exist; a body that is not a report is `400` naming the field. Answers `{ok}`. A reading older than 60 seconds is dropped |

**Settings** — one `POST` each, all answering the updated `StageState`. A body of
the wrong shape is `400` with the reason unless noted.

| Path | Body |
|---|---|
| `/api/show-qr` | `{show: boolean}` |
| `/api/onboarding-dismissed` | `{dismissed: boolean}` |
| `/api/ndi-enabled` | `{enabled: boolean}` |
| `/api/kiosk-discovery` | `{enabled: boolean}` — whether the server answers devices looking for one |
| `/api/public-url` | `{url: string \| null}` — the address used for the connect QR and display links; blank or `null` clears it |
| `/api/timezone` | `{timezone: string \| null}` — an IANA zone, or `null` (blank) to follow the host clock; an unknown zone is `400` |
| `/api/hour-cycle` | `{hourCycle: "12h" \| "24h"}` |
| `/api/reconnect-schedule` | any of `{enabled, leadMin, tailMin, dormantMin}`, the numbers rounded and clamped (lead and tail 0–1440, dormant 1–1440 minutes) |
| `/api/taper-window` | any of `{preMin, postMin}`, whole minutes clamped to 0–240 |
| `/api/update/auto` | any of `{mode: "manual" \| "auto-install" \| "auto-full", dayOfWeek: 0–6 \| null, hour: 0–23}`; out-of-range numbers are clamped, and `null` is any day |
| `/api/baptism-auto-start` | `{enabled?: boolean, testimonyKeyword?: string}`, at least one; the keyword is cut at 80 characters |
| `/api/saved-colors` | `{color: string, keep: boolean}` — save (`true`) or forget (`false`) one colour |
| `/api/icon-color` | `{key, color}` — `color` is `#rrggbb`, or `""` to clear. `key` names a screen or page |
| `/api/icon-glyph` | `{key, glyph}` — an icon name (a letter, then letters and digits, up to 64), or `""` to clear |
| `/api/caption-colors` | `{channel, color}` — a hex colour for one transcription channel; anything else, or `null`, reverts it to automatic. Answers the state unchanged for a blank `channel` |
| `/api/caption-colors/follow-prodcom` | `{on: boolean}` — whether a channel with no colour of its own follows ProdCom's |
| `/api/checklist-sources` | `{categories?, teams?}`, below |
| `/api/bar-items` | `{items?, mobileItems?}`, above |

`/api/checklist-sources` takes `{categories}` and `{teams}` — plan-note category
and team names, not ids. Either may be omitted and is then left as it stands; a
present one must be a `string[]`, and `[]` clears that list. A body naming
neither is a 400.

**Video feeds** — see [Video feeds](../integrations/video-feeds.md)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/video/state` | `{rev, relay, kinds, ports, binaryPresent, archivePresent, feeds, screens}` — the same snapshot `video:state` pushes. `relay` is the switch/relay status the page's own line reads: `{state: "off"}`, `{state: "downloading", receivedBytes, totalBytes}`, `{state: "starting", version}`, `{state: "running", version, ports}`, or `{state: "failing", reason, kind, retryAt, placeArchiveAt?, assetName?}` — see [Video feeds](../integrations/video-feeds.md#the-relay-and-its-switch). `kinds` is the source kinds this build offers, matching the editor's **Source** dropdown. `ports` is the SAVED set (what the next start uses); a running relay's own ports are under `relay.ports` and can differ for the moment between a ports save and the restart it triggers. `binaryPresent` is whether the pinned MediaMTX binary is already extracted on this machine and runnable, checked fresh on every read — it is what tells the Video feeds page's "off" status line apart: the download-size sentence only ever shows before the FIRST download, never again once it has one. `archivePresent` is whether the pinned archive is already in `video-relay/downloads` (placed by hand, say), extracted or not; with it, the "off" line says the relay sets up from it instead of naming a download. `feeds` is each feed's wire view — id, name, kind, source, how it plays, and its live status — never a password; see [Feed states](../integrations/video-feeds.md#feed-states). `screens` is every (screen, feed) pair a presence heartbeat has reported playback for in the last rolling minute — `{outputId, feedId, via, struggling, droppedInWindow, decodedInWindow, stallsInWindow, lagging, jitterBufferMsInWindow, width, height, reportedAt, episode, laggingEpisode}`, struggling or not. It is change-driven, the same as every other field this route and `video:state` share: `screens` is re-read only when a pair appears, leaves or flips `struggling` or `lagging`, a struggling pair's `episode` moves, a lagging pair's `laggingEpisode` rises by a tenth of a second, or a feed is removed. Between those, every other field of a pair — `via`, `width`, `height`, `droppedInWindow`, `decodedInWindow`, `stallsInWindow`, `jitterBufferMsInWindow` and `reportedAt` — is as of the last re-read, not a live meter, struggling or not: a screen playing cleanly for minutes can read a `reportedAt` several minutes old though it still heartbeats every 10 seconds, and a WebRTC-to-HLS fallback with no struggle publishes nothing, so `via` can still read `webrtc` on a screen now playing HLS. `episode` is the worst window since `struggling` last turned true — `{droppedInWindow, decodedInWindow, stallsInWindow, width, height}`, frozen at whichever report made the window worst, not the live one; `null` while not struggling. `lagging` is a separate flag from `struggling`: the window's worst `jitterBufferMs` went over 1000 ms, held for 60 seconds after the last report that did. `jitterBufferMsInWindow` is a diagnostic for reading the raw figure: the worst over the window, `null` when no report in it carried one (HLS, or a browser that cannot measure it), and stale until the next change publishes, like the other window totals; `laggingEpisode` is `{jitterBufferMs}`, the worst since `lagging` last turned true, `null` while not lagging. See [Health from the screens](../integrations/video-feeds.md#health-from-the-screens) |
| GET | `/api/video/probe` | `{feeds: {[feedId]: {state, codec?, width?, height?, reason?, checkedAt, since?, busy?}}, at}` — the same snapshot `video:probe` pushes: what asking each pulled camera to describe its stream found. `state` is `checking` (no answer yet since a page began watching), `ready` (with `codec` and `width`/`height` when the camera's description gives them), `failed` (with `reason`, an operator-readable sentence naming the camera's host, and `since`, when the current run of failed answers began) or `unchecked` (an SRT address, which cannot be asked without streaming it). `checkedAt` is when the camera was last asked, in ms since the epoch. Only pulled feeds appear, and none of them while the Video feeds switch is off. The server asks only while a client has NAMED `video:probe` in its reported channel filter (`POST /api/events/subscribe`) — a client with no filter, such as curl or a display that has not reported one yet, does not count, though it receives every channel — every 15 seconds, and once at once on the first one, and drops everything when the last leaves, so this reads `{feeds: {}}` with nobody watching. `at` is the server's clock when the snapshot was made, ms since the epoch; `at - checkedAt` is an answer's age without the viewer's clock. A `checking` entry carries `busy: true` once the camera was reached but was busy answering another request. Never carries a password. See [Checking pulled feeds](../integrations/video-feeds.md#checking-pulled-feeds) |
| GET | `/api/video/feeds` | `{feeds}` |
| PATCH | `/api/video/ports` | Saves the relay's six ports and restarts it if it is running. Body: `{rtmp, srt, webrtcUdp, webrtcHttp, hls, api}`, every value a whole number from 1024 to 65535 and all six different — `400` naming the rule otherwise. `200` with `{ports}` |
| POST | `/api/video/feeds` | Add a feed. `{name, source}`; `201` with `{feed}`. `400` with the reason for a body that fails validation — a name that is not 1 to 60 characters of text, a kind this build does not offer, an address carrying a username or password |
| PATCH | `/api/video/feeds/:id` | Update a feed; answers `{feed}`. Any field omitted from the body keeps its current value; a field present is validated as on POST. `404` for an unknown id |
| DELETE | `/api/video/feeds/:id` | Remove a feed (`{ok: true}`, or `404` for an unknown id). A layout still pointed at it keeps the binding and renders it as offline |
| GET | `/api/video/feeds/:id/usage` | `{layouts}` — every layout with a Video widget bound to this feed, for the editor's used-by line and the delete confirmation |
| GET | `/api/video/feeds/:id/push?protocol=srt\|rtmp\|whip` | A push feed's paste-ready address: `{protocol, address, password}`. `?protocol` previews another protocol with the SAME stored password, without saving anything; omitted or invalid falls back to the feed's own saved protocol. `404` for an unknown id or a feed that is not `push`; `403` for a cross-origin browser request (unlike every other GET here, this one answers a live secret) |
| POST | `/api/video/feeds/:id/push/new-password` | Replaces the feed's publish password (`404` for an unknown id or a feed that is not `push`), reconciles the relay, and kicks whoever is currently publishing so the old password stops working at once. `{protocol, address, password, applied, kicked}` — `applied` is false only if a running relay's reconcile itself failed; `kicked` is `"dropped"` once a connected publisher actually was, `"none"` if nobody was publishing or no relay was running to ask, and `"failed"` only if a publisher was there and dropping it did not work |
| GET | `/api/video/export?feeds=a,b&ports=1&passwords=1` | The feeds as a download, `stage-utility-video-feeds-<date>.json`: `{kind: "stage-utility-video-feeds", version, appVersion, createdAt, source, feeds: [{id, name, source, password?}], ports?}`. Feeds keep their ids. `feeds` is a comma-separated list of ids (omitted: every feed); `ports=1` adds the relay ports; `passwords=1` adds each pull feed's camera password and push feed's publish password, as stored (none is made for the file). `400` naming the reason for an unknown id or a flag that is not `1`, `0`, `true` or `false`; `403` for a cross-origin browser request with `passwords=1`. See [Moving feeds between servers](../integrations/video-feeds.md#moving-feeds-between-servers) |
| POST | `/api/video/import/preview` | Body is the file. Compares each feed in it with this server's without writing anything: `{server, createdAt, hasPasswords, feeds: [{id, name, kind, status, differences, error?, filePassword?, here}], absent, ports?}`. `status` is `new`, `same`, `differs` or `invalid` (a feed this build cannot take; `error` says why). `differences` is `[{field, here, file}]` for `name`, `kind`, `url`, `username`, `protocol`, `player` or `ref`, and `{field: "password"}` with no values. `filePassword` is true when the file carries a password for that feed (the password itself is never returned). `absent` names this server's feeds the file lacks; `ports` is `{file, here, same}` and present only when the file carries ports. `400` for a file of the wrong kind or version, with `feeds` not a list, a bad or repeated id, or unusable ports. Accepts up to 64 MB |
| POST | `/api/video/import` | `{bundle, choices?, expect?, ports?}`: lands the file's feeds under their own ids. `choices` maps a feed id to `replace` (the default) or `keep` for a feed that differs; `expect` maps a feed id to the `here` fingerprint the preview gave it (this server's feed under that id as the review saw it, `""` for none, keyed per server process and never a hash of a password); a feed edited, added, deleted or given a new password here since, is skipped with "Changed on this server since the review. Review the file again." rather than written, and a caller that sends no `expect` still gets that check against what was there when the import started. `ports: true` also saves the file's relay ports. Never removes a feed and never changes the Video feeds switch. Passwords go to the secrets store, never to the feed file. `200` with `{added, addedIds, replaced, kept, same, skipped: [{name, reason}], newPushPasswords, passwordsWritten, portsApplied, portsError?}` (feed names); `newPushPasswords` names push feeds that got a new publish password because the file had none. `400` as for the preview or for a malformed `choices`, `expect` or `ports`. A secret that cannot be written undoes the whole import and answers `500`. Accepts up to 64 MB |

Playback is proxied on Stage Utility's own origin, not under `/api`, because
the relay's own HTTP listeners are loopback-only: `POST /video/<feedId>/whep`,
`PATCH`/`DELETE /video/<feedId>/whep/<session>`, `POST /video/<feedId>/whip`
(OBS's Authorization Bearer token forwarded through),
`PATCH`/`DELETE /video/<feedId>/whip/<session>`, and
`GET /video/<feedId>/<file>.m3u8|.mp4|.m4s`. `404` for an unknown feed id, a
kind the feed's own source cannot serve (embed/external have no relay path;
WHIP needs a push feed whose own protocol is WHIP), or a file name outside
the HLS pattern; `413` for a WHEP/WHIP body over 64 KB; `502` if the relay
refuses the connection or the exchange times out (15 s for WHEP/WHIP, past the
relay's own 10-second dial of a pull feed's device so its reason comes
through, 30 s for HLS — an LL-HLS blocking playlist reload can legitimately hold that
long); `503` while the relay is not running, or in the moment after it
starts, before it has been given the feed.

**Branding & events**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/branding/source?target=app\|empty\|avatar\|icon` | Original (un-cropped) upload and saved crop for the logo, empty-slot image, default avatar or tab and home-screen icon: `{original, crop}`, plus `art` (the square the sizes are drawn from) for the icon. Images come back as `/branding-images/…` references |
| POST | `/api/branding` | Update branding; any of `{name, monochrome, accentColor, logo, logoOriginal, emptyLogo, emptyLogoOriginal, avatar, avatarOriginal, logoCrop, emptyLogoCrop, avatarCrop, icon}`. `accentColor` is `#rrggbb` or `null`; each image is an `image/` data URL (under about 1.5 MB) or `null` to clear, and an `…Original` may instead be the `/branding-images/…` reference `/api/branding/source` returned, if that file is stored; each crop is `{scale, x, y}` or `null`. `icon` is `null` to remove the custom tab and home-screen icon, or a complete set `{art, original, crop, background, apple, any192, any512, maskable}`: `background` is `#rrggbb`, `original` (a data URL or a stored reference) and `crop` may be `null`, and every other image is a PNG data URL, `apple` exactly 180 x 180, `any192` 192 x 192, `any512` and `maskable` 512 x 512, `art` any square size. An incomplete set or a wrong size is refused whole. Anything else is `400` naming the field. Up to 24 MB of body. Answers the state |
| GET | `/api/events` | Multiplexed Server-Sent Events stream — see [Channels](#channels) |
| POST | `/api/events/subscribe` | Set the channels a connection wants (`{cid, channels: string[]}`). Answers `{ok}`, false when either is missing, in which case nothing changes |
| GET | `/api/events/poll?cid=&since=` | The same channels, collected by polling — see [Polling](#polling) |

## Channels

`GET /api/events` is one stream carrying everything, filtered per connection.
Pass `?cid=<your id>` and then `POST /api/events/subscribe` with the same `cid`
and the channels you render; until you do, you are sent all of them. A stream
marked `?client=companion` (or with an `X-Companion-Module` header) is counted
toward the Companion integration's connected-client total.

A comment heartbeat goes out every 20 seconds, and a client whose socket backs up
past 2 MB is dropped rather than buffered.

Both transports are named on [`/log`](../ops/updates-and-logs.md):
`[events] stream client connected (3 streams)` and its `closed` counterpart, and
`[events] poll client <cid> started` / `expired (no poll for 30s)`.

### Polling

`GET /api/events/poll` carries the same channels for a client that cannot hold a
stream open. A browser page opts in with `?transport=poll` on its URL
([Display URLs](../display-urls.md#polling-transport)); this is the endpoint
underneath it.

| Parameter | |
|---|---|
| `cid` | **Required.** The same client id `/api/events/subscribe` is keyed by, so one channel filter serves both transports. A request without it is a 400. |
| `since` | The `seq` from the previous response. Omit it to ask for a snapshot. |

```json
{
  "now": 1789923805519,
  "seq": 148,
  "resync": false,
  "frames": [ { "channel": "pco:live", "data": { "mode": "item" } } ]
}
```

`frames` are in the order they were broadcast, and `data` is the same payload the
stream would have sent on that channel. `seq` is what to send as the next
`since`.

`now` is the server's clock in epoch milliseconds, stamped as the answer is sent.
A client that measured its own round trip places the server's clock at `now +
rtt/2`, which is the correction that keeps a polling display's countdowns on
time: a frame can sit in the buffer for the whole interval, so a timestamp
*inside* a frame says when it was broadcast, not when it was sent.

With no `since`, the response is the connect-time snapshot — the same channels
the stream hydrates, `server:hello` first — and `resync` is `false`, because
nothing was missed.

`resync: true` means the request's `since` is no longer covered. The frames are a
fresh snapshot rather than a continuation, and the client should drop its
position and ask for a snapshot again rather than resume from the returned `seq`.
Three things cause it:

- the server keeps only the last 500 broadcasts, and only for 60 seconds, so a
  client that stopped asking has a gap it cannot fill;
- a `since` ahead of the server's own counter — a client that outlived a server
  restart;
- a `cid` that had expired and come back. Nothing is buffered while no client is
  polling, so the counter does not move while you are away and your `since` can
  look perfectly current when it is not. The registry is what knows otherwise.

Channel filtering applies to the buffered frames, so a client that reported a
narrow set through `/api/events/subscribe` is not sent the rest of the firehose.
It does **not** apply to the snapshot: the SSE hello burst is unfiltered too, and
for the same reason — a client caches every hydrated channel at connect so that a
component mounting later is served from that cache rather than waiting for the
channel to change.

A `cid` that has not polled for 30 seconds is dropped. Poll clients count as
subscribers exactly as open streams do, so a producer that only runs while
something is watching starts for a polling client and stands down when it
expires.

**Hydrated on connect** — these carry state rather than events, so the stream
opens with a full snapshot of each and a display is never blank waiting for
something to change:

`server:hello` · `stage:state-changed` · `pco:live` · `propresenter:status` ·
`propresenter:instances` · `spl:metrics` · `spl:history` · `attendance:history` ·
`service-timeline:history` · `baptism:state` · `obs:status` · `reaper:status` ·
`pvp:status` · `scores:status` · `resi:status` · `youtube:status` ·
`update:status` · `companion:signals` · `osc:feedback` · `people:count` ·
`wireless:channels` · `calendar:grid` · `displays:presence` · `video:state` ·
`video:probe` · `messages:state`

**Pushed only when something happens:**

`prodcom:transcript` · `prodcom:channels` · `slots:devices` · `integrations:state-changed` ·
`wireless:connections-changed` · `osc:targets-changed` ·
`rosstalk:targets-changed` · `scores:favourites-changed` ·
`rosstalk:simulated` · `automation:rules` · `cues` · `cues:all` ·
`automation:settings` · `automation:log` · `patch:updated` · `kiosk:devices` (`{scanning, seen, health}`; the Screens page and the sidebar's count of screens not set up refetch `/api/devices` on each, and a steady output's health does not push one) ·
`display:refresh` · `settings:allowedServiceTypeIds-changed` · `baptism:rebuilt` ·
`update:notice` · `propresenter:status:<id>`

`update:notice` is `{tag, count}`: a new release has appeared, sent once per
release and only while a browser is subscribed to it, so a release found
overnight with nobody connected is announced the next time somebody is. It is
not replayed on connect. `propresenter:status:<id>` is the status of one
ProPresenter instance other than the first, in the same shape as
`propresenter:status`; `propresenter:instances` lists them. Ross TSL and RossTalk
are outputs and publish no channel.

`baptism:rebuilt` fires once a baptism rebuild — the Baptisms page's own, a
save-failure note's, or History's whole-service rebuild — actually writes a
session, and when a History merge moves sessions onto the service it keeps:
`{serviceKey, ids}`, `ids` naming the sessions added, updated or moved.

Every status snapshot carries a `rev` counter so a hydrate read cannot overwrite
a newer push — see [Integrations](../integrations/README.md#the-snapshot-version).

`cues` is for a Home Assistant integration and carries two kinds of message:
`{type: "state", id, state, reason?, settling?, commanded?}` when a bound ON/OFF
pair's device changes — or when it enters or leaves its
[settle window](../integrations/companion.md#the-settle-window), which is a
change in what the reading is worth — and `{type: "manifest", version}` when the
rules change and
`/api/cues/manifest` should be re-read. `id` is the pair's base, as in
the manifest, and only pairs the manifest lists are pushed — a pair whose
**Home Assistant** switch is off is absent from this channel exactly as it is
from the manifest, though `/api/cues/states` still carries it. While at least
one client is subscribed the bound Companion variables are read every five
seconds and only changes are pushed; with nobody subscribed there is no timer
and nothing is read. A value that lands while a
pair is settling is read and pushed at once rather than at the next tick.

`cues:all` is the same two messages for the app's own cue buttons, carrying
every pair including those hidden from Home Assistant (each with
`hiddenFromHome: true`). An integration reads `cues`; a panel reads `cues:all`.
Either channel having a subscriber starts the five-second read.

## Outside `/api`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/photos?u=…[&s=N]` | Cached Planning Center photo proxy. `u` must be an `https` URL on `planningcenteronline.com`; anything else, and any redirect, is refused — it is not a general-purpose proxy (`400` without `u`, `404` for a photo it will not serve, `500` for a failed read). The `200` is `public, max-age=31536000, immutable`, except a full-size photo standing in for a smaller one Planning Center would not give, which is `no-cache`. `s` is the longest side the photo is drawn at, in device pixels, rounded up to 128, 192, 256, 384, 512 or 768; it scales `u`'s geometry down, never up, and anything else is ignored. See [Photos](../integrations/planning-center.md#photos) |
| GET | `/log` | The server's recent output, as a page, with a health strip and level/source filters. Token-gated when `STAGE_UTILITY_LOG_TOKEN` is set |
| GET | `/logs` | Redirects to `/log`, query string intact. Same gate, checked before the redirect — an unauthorised request is a 401, never a 302 into one |
| GET | `/api/log[?since=N]` | `{ lines, reset, latestSeq, checks }`. Same gate. Omit `since` for the whole buffer; pass the previous `latestSeq` to get only what is newer. `reset: true` means replace rather than append — you asked for everything, the buffer rolled past your cursor, or your cursor is above the newest line, which means it came from before a restart (`seq` is per-process and starts again at 1). `checks` is the health snapshot the page draws: version, uptime, app time zone, warning and error counts, and one entry per configured integration |
| GET | `/enroll?device=…&token=…` | Where a kiosk device asks which screen it is. Redirects to that screen, or shows a holding page |
| GET | `/kiosk/install-linux.sh` \| `install-macos.sh` \| `install-windows.ps1` | The kiosk agent installers, with this server's address already in them |
| GET | `/kiosk/kiosk-windows.ps1` \| `kiosk-update-windows.ps1` | The [Windows kiosk's launcher](../kiosk-devices.md#the-windows-kiosks-launcher) and its updater, which the Windows installer downloads. The launcher's SHA-256 over these bytes is what `GET /api/machine-updates/check` compares a PC's with |
| GET | `/kiosk/StageUtilityOutput-arm64.zip` \| `StageUtilityOutput-x86_64.zip` | The Mac [output helper](../kiosk-devices.md#installing-the-mac-output-helper) for that architecture. Fetched once from the GitHub release matching this server's version, checked against the SHA-256 the releases API lists for that asset, cached under the data directory and served from there. `404` with the reason when it is not cached and the release cannot be reached, does not exist or does not list the zip; `502` when the release host answers any other status, the release lists the zip with no digest or a malformed one, or the download fails its checksum or the size limit or does not finish |
| GET | `/kiosk/StageUtilityOutput-arm64.zip.sha256` \| `StageUtilityOutput-x86_64.zip.sha256` | That zip's SHA-256, one `shasum` line (`<hex>  <zip name>`) built from the release's digest and cached per version; the release has no such file. The installer verifies the zip against it. Same `404` and `502` as the zip's for a release that cannot give the digest |
| GET | `/layout-images/:name` \| `/branding-images/:name` | Uploaded images, content-addressed and served immutable |
| GET | `/manifest.webmanifest` | The web app manifest, built per request: `name` and `short_name` are the app name, so renaming the app renames the home-screen label on Android. `no-cache` |
| GET | `/apple-touch-icon.png` \| `/icon-192.png` \| `/icon-512.png` \| `/icon-maskable-512.png` | The home-screen icons the pages and the manifest name. The operator's own [tab and home-screen icon](../features/operator-app.md#branding) when one is set, else the built-in file, and the built-in file too when the stored one is missing. A query string is ignored: the tab loads `/icon-192.png?v=<hash>` so a changed icon is a new URL. `no-cache`, so a new icon reaches the next install |
| POST | `/api/layout-images` | Store an image and return its URL |
| GET | `/api/history/export` | The service report as a spreadsheet (`?from=&to=&include=…`, `include` a comma-separated choice of `services`, `attendance`, `items`, `spl` and `baptisms`; names it does not know are ignored) |

Everything else is the app itself: `/<display id>` and `/<slug>` render a
screen, and the operator pages render the app — see
[Display URLs](../display-urls.md).
