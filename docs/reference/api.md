# API reference

The HTTP surface. Also what Bitfocus Companion and the automation engine call.

All endpoints are under `/api`. State-changing routes return the updated
`StageState`. Live updates arrive on the SSE stream rather than by polling.

Request bodies are capped and a body over the limit is refused with `413` rather
than being read into memory. The cap depends on what the route carries: 8 MB for
ordinary JSON, 24 MB where the body is an image (`/api/branding`,
`/api/layout-images`), 64 MB for a config bundle (`/api/config/import`), and
128 MB for a binary upload.

**Stage & plan**
| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | Liveness check |
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
| POST | `/api/show-qr` | Toggle the connect QR on the display |

**Views, displays & layouts**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/views` | List views |
| POST | `/api/views` | Create a view (`{name, kind, surface?}`) |
| PATCH | `/api/views/:id` | Update name / kind / `ndiSource` / `layout` / `surface`. Converting a bound view is refused, naming the screens |
| POST | `/api/views/:id/slots` | Save a slots-view's slots |
| POST | `/api/views/:id/duplicate` | Duplicate a view |
| GET | `/api/views/:id/export` | Download the view and anything it embeds as one file |
| POST | `/api/views/import` | Merge an exported view in; returns what landed and what needs rebinding |
| POST | `/api/views/:id/copy-slots` | Copy slots from another view |
| POST | `/api/views/reorder` | Reorder views |
| DELETE | `/api/views/:id` | Delete a view |
| GET | `/api/outputs` | List physical displays |
| POST | `/api/outputs` | Add a display |
| PATCH | `/api/outputs/:id` | Rename / route to a view (`{viewId}`) / set `{mode}` (`display`\|`panel`). A console view on a display screen is refused |
| POST | `/api/outputs/reorder` | Reorder displays |
| DELETE | `/api/outputs/:id` | Remove a display |
| POST | `/api/action/invoke` | Run an automation action (`{actionId, params?}`) — what a console control does |
| POST | `/api/notes` | Save a notes/checklist object's content (`{objectId, content}`) |
| POST | `/api/bar-items` | Set the context bar's items and order (`{items}`) |
| GET / POST | `/api/layout-templates` | List / save a custom-layout template |
| PATCH / DELETE | `/api/layout-templates/:id` | Update / delete a template |

`GET /api/displays` returns each output joined with its routed view's kind, for
clients that want a flat list. `POST /api/displays/refresh` reloads connected
screens. `GET /api/displays/presence` returns `{connected: [outputId]}` — the
screens with a browser attached, which each display page reports by heartbeat
(the same set the `displays:presence` SSE channel broadcasts on change).

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

**ProPresenter & ProdCom**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/propresenter/thumbnail?k=…` | Live slide thumbnail (JPEG proxy; `k` cache-busts per slide) |
| GET | `/api/prodcom/transcript` | Recent transcript buffer (backfill for a freshly-loaded Captions display) |

**SPL (Smaart) & rundown**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/spl/metrics` | Latest live SPL reading per meter (device/channel) |
| GET | `/api/spl/history/current` | The active service's per-item SPL record (live) |
| GET | `/api/spl/history` | List saved past-service SPL records |
| GET | `/api/spl/history/:key` | One past-service record |
| GET | `/api/pco/plan-items` | Ordered plan items + note categories (Script / SPL Rundown) |
| GET | `/api/pco/checklist` | The active plan's checklist, read from its plan notes, with ticks applied |
| GET | `/api/pco/checklist-sources` | Note categories + team names this service type offers (settings picker) |
| POST | `/api/pco/checklist/tick` | `{ key, done }` — tick one row; answers with the whole list |
| POST | `/api/pco/checklist/clear` | Untick every row on the active plan |

**People, attendance, timeline & baptism**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/people/count` | Live building occupancy (SenSource) |
| GET | `/api/sensource/locations` \| `/api/sensource/zones` | Pickers for the SenSource config |
| GET | `/api/attendance/history` \| `/history/:key` \| `/history/current` | List / one / live attendance record |
| GET | `/api/service-timeline` \| `/:key` \| `/current` | List / one / live per-item timing record |
| GET | `/api/obs/status` | OBS streaming / recording / scene state |
| GET | `/api/resi/status` \| `/api/youtube/status` | Whether that platform is live, and since when |
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

**Branding & other**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/branding/source?target=app\|empty` | Original (un-cropped) brand/empty logo source |
| POST | `/api/branding` | Update app name + logos |
| GET | `/api/events` | Multiplexed Server-Sent Events stream with per-connection channel filtering. Channels: `stage:state-changed`, `pco:live`, `propresenter:status`, `prodcom:transcript`, `spl:metrics`, `spl:history`, `people:count`, `attendance:history`, `service-timeline:history`, `obs:status`, `osc:feedback`, `baptism`, `integrations:state-changed`, `wireless:connections-changed`, `wireless:channels` |
| POST | `/api/events/subscribe` | Set the channels a connection wants (channel filtering) |
| GET | `/photos?u=…` | Cached Planning Center photo proxy. `u` must be an `https` URL on `planningcenteronline.com`; anything else, and any redirect, is refused — it is not a general-purpose proxy |
