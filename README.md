# Stage Utility

A kiosk dashboard for a live-production / service tech station. It pulls together
several live sources and shows them on monitors around the stage:

- **Planning Center Online** — the band lineup (people, roles, photos), the active
  plan, and a live service countdown.
- **Shure** wireless systems — RF, battery, frequency, and audio level for each mic
  or in-ear pack.
- **ProPresenter** — the live slide: current/next text, the song **section**
  (Verse/Chorus/Bridge/Intro/Outro…), chords, running timers, and a slide thumbnail.
- **ProdCom** — live audio **transcription** (captions), shown full-screen or as a
  strip on the dashboards.

Each monitor is a **display** (a screen at its own URL) pointed at a **view** —
reusable content you build once and can route to any number of displays. A view is one
of several types: a slot grid, a tech dashboard, a stage/confidence view, full-screen
captions, or a **custom** layout you design visually (drag clocks, timers, slide text,
mic-slot grids, logos, etc. onto a canvas). A phone-friendly remote runs on the same
LAN so a tech can re-assign slots and switch plans from the floor.

It's a self-contained **web/server app**: a small Node backend serves the kiosk
displays, the settings UI, the phone remote, and a REST + SSE API — all on one port.
There is no Electron/desktop runtime.

---

## Contents

- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Quick start (development)](#quick-start-development)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [URLs & ports](#urls--ports)
- [Integrations](#integrations)
- [Data model & concepts](#data-model--concepts)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [npm scripts](#npm-scripts)
- [Data, secrets & backups](#data-secrets--backups)
- [Development notes](#development-notes)

---

## How it works

```
 Planning Center ─┐                          ┌─ Displays        (build/renderer, React)
  (lineup, REST)  │                          │    /            picker
 Shure wireless  ─┤    ┌──────────────┐      │    /display-N   slots │ dashboard │
  (TCP, RF/batt)  ├───▶│  Node server │─────▶│                 stage │ captions
 ProPresenter    ─┤    │  (server.ts) │      ├─ Settings UI     (/settings)
  (HTTP, slides)  │    │  :8788       │      ├─ Phone remote    (public/control.html)
 ProdCom         ─┘    └──────┬───────┘      │
  (HTTP/SSE, text)            └──────────────┴─ REST  /api/*
                                               SSE   /api/events  (live push)
```

The backend (`server.ts` + `main/`) polls Planning Center on a schedule, Shure gear
and ProPresenter continuously, and holds a long-lived SSE connection to ProdCom. It
resolves the current plan into the configured **slots** and broadcasts state to every
connected client over Server-Sent Events. High-frequency data rides its own SSE
channels — `pco:live` (countdown), `propresenter:status` (slide), and
`prodcom:transcript` (captions) — so each can update and fail independently. The
frontend is a React app served as static files; the phone remote is a standalone
HTML page.

## Tech stack

| Layer    | Tech |
|----------|------|
| Backend  | Node **≥24**, TypeScript run via `tsx` (no compile step), built-in `http`/`net`/`crypto` only — **zero third-party runtime deps** |
| Frontend | React 19, TanStack Router + Query, Tailwind CSS v4, Radix UI, dnd-kit, Vite 8 (Rolldown) with the React Compiler enabled |
| Transport| REST over HTTP + Server-Sent Events for live updates |
| Storage  | JSON files + an AES-256-GCM encrypted secrets blob, in a local data directory |

## Quick start (development)

Requires Node ≥ 24. From the repo root, run **two terminals**:

```bash
# Terminal 1 — backend (API + SSE) on :8788
npm install
npm run server

# Terminal 2 — Vite dev server (hot reload) on :3000
npm run dev
```

Then open:

- **Display picker** → http://localhost:3000/ (then pick a display, e.g. `/display-1`)
- **Settings UI** → http://localhost:3000/settings

The Vite dev server proxies `/api` and `/photos` to the backend on `:8788`. If
`localhost:3000` won't connect, see [Development notes](#development-notes).

## Deployment

It's pure Node + a static build, so it **runs on Linux, macOS, and Windows** (Node
≥ 24). The only platform-specific piece is how you make it auto-start on boot and
restart on crash. See **[INSTALL.md](INSTALL.md)** for step-by-step guides:

| Platform | Auto-start mechanism | Install |
|----------|----------------------|---------|
| **Linux** (Pi/server) | **systemd** (`Restart=on-failure`, enabled on boot) | one command: `sudo ./scripts/install.sh` |
| **macOS** | **launchd** LaunchDaemon (`RunAtLoad` + `KeepAlive`) | manual build + a plist |
| **Windows** | **NSSM** service (auto-start + crash-restart), or Task Scheduler | manual build + service |

On Linux the installer checks Node, builds the UI, sets up the data directory, and
installs the auto-starting `stage-utility` service. Re-run after `git pull` to
update; `sudo ./scripts/uninstall.sh` removes it.

For a manual/production run on any OS (no auto-start):

```bash
npm ci
npm run build
npm start          # node --import tsx server.ts  → http://localhost:8788/
```

The listen port (`8788`) can be overridden with the `STAGE_UTILITY_PORT`
environment variable.

## Configuration

All configuration is done at runtime through the **Settings UI** — nothing lives
in the repo. Open `…/settings-window.html` and work through the sidebar:

1. **Integrations → Planning Center** — enter your **App ID** + **Secret** (from a
   [PCO Personal Access Token](https://api.planningcenteronline.com) → Developers →
   Personal Access Tokens). Set the **refresh interval** (5 min – 2 h) or hit
   **Refresh now**; the card shows when it last synced.
2. **Integrations → Wireless Gear** *(optional)* — add Shure devices by IP, TCP
   port (usually `2202`), and channel count.
3. **Integrations → ProPresenter** *(optional)* — host + API port (default `1025`,
   the Network port in ProPresenter → Settings → Network). Drives the stage view's
   slide text, section, chords, timers, and thumbnail.
4. **Integrations → ProdCom** *(optional)* — host + API port (default `24480`), plus
   an API key only if ProdCom's "Require Authentication" is on. Drives the captions.
5. **Service Types** — choose which PCO service types are in play.
6. **Plan** — **Auto** (follow the next upcoming event; rolls to the next one ~1 h
   after the current service ends) or **Manual** (pick a plan).
7. **Views** — build reusable content (drag to reorder, duplicate, live preview).
   Pick a **type** when you create one:
   - **Slots** — the channel grid: link each slot to a PCO person/position, a static
     label, or leave it empty; optionally bind it to a wireless channel; drag to
     reorder; stack slots that share a charger into one column.
   - **Dashboard** — clock + PCO countdown + ProPresenter now/next summary.
   - **Stage** — confidence view: slide text, section, chords, preview, timers.
   - **Captions** — full-screen transcription.
   - **Custom** — a visual editor: drag/resize objects (clocks, countdowns, slide
     text, mic-slot grids, captions, logos, images, shapes, …) onto a canvas, style
     them, and **save designs to a reusable layout library** to reuse on other views.
8. **Displays** — your physical screens. Each has its own URL and is **routed to a
   view** (one view can drive many screens). Rename, drag to reorder, or open in its
   own window.
9. **Connect** — toggle the on-screen QR code for the phone remote.

## URLs & ports

| Surface | Dev (`npm run dev`) | Production (`npm start`) |
|---------|----------------------|--------------------------|
| Display picker | `http://localhost:3000/` | `http://<host>:8788/` |
| A specific display | `http://localhost:3000/display-1` | `http://<host>:8788/display-1` |
| Settings UI | `http://localhost:3000/settings` | `http://<host>:8788/settings` |
| Phone remote | — (use `:8788`) | `http://<host>:8788/` when no built UI is present¹ |
| API / SSE | proxied to `:8788` | `http://<host>:8788/api/*` |

The server binds `0.0.0.0:8788` (LAN-accessible). Override the port with the
`STAGE_UTILITY_PORT` environment variable.
Clean URLs (`/settings`, `/display-N`) are served directly in production and mapped
by a small Vite middleware in dev. The display picker at `/` lists every configured
display; clicking the brand/logo in any display returns there.

¹ The standalone phone control page (`public/control.html`) is served at `/` only
when there is no `build/renderer/` directory; once the UI is built, `/` serves the
React app instead.

## Integrations

| Integration | Kind | Config | Notes |
|-------------|------|--------|-------|
| **Planning Center** | lineup | App ID, Secret, refresh interval | Fetches service types, plans, and team members; auto-refreshes on the chosen interval (default 1 h) plus on demand. Also drives the live service countdown (`pco:live`). |
| **Wireless Gear** | wireless | per-device host / port / channels | Shure **ULX-D**, **Axient Digital**, and **PSM (in-ear)** drivers over TCP; reports RF, battery, charging, frequency, audio level. |
| **ProPresenter** | control | host, API port (`1025`) | Talks directly to ProPresenter 7.9+'s local HTTP API (LAN, no auth). Polls the active presentation, slide status, arrangement, timers, and a thumbnail; broadcasts `propresenter:status`. Section is resolved from the arrangement **play order** (works through repeats, jumps, and text-less Intro/Instrumental/Outro slides). |
| **ProdCom** | lineup | host, API port (`24480`), API key | Holds an SSE connection to ProdCom's transcript stream and re-broadcasts `prodcom:transcript`; backfills recent lines on connect. Powers the Captions display + dashboard transcript strips. |
| **Bitfocus Companion** | control | host, port | Descriptor present; control endpoints exist. Reserved for future use. |

## Data model & concepts

A **slot** is one channel strip on the display. Each slot has a `channel` label and
a **link** that decides who/what it shows (`renderer/types.d.ts`):

- `pco` **by position** — matches whoever fills a team position (e.g. "Electric Guitar").
- `pco` **by person** — pinned to a specific PCO person id.
- `static` — a fixed label + color (e.g. "Backup").
- `empty` — a placeholder.

A slot can optionally carry a **device binding** to a wireless channel, so the
display shows that pack's RF/battery next to the person. Slots can **stack** into a
shared on-screen column (mirrors two people sharing a dual-bay charger).

**Views & displays.** A **view** is a reusable content definition; a **display**
(output) is a physical screen at its own URL, routed to exactly one view. One view can
drive many displays, so you change content in one place. Both can be reordered. View
**kinds**:

- **Slots** — the channel grid (its own slot set, per service type). Only this kind uses the slot editor.
- **Dashboard** — clock, the PCO live countdown, and a ProPresenter now/next summary.
- **Stage** — a confidence view: current/next slide text, song section + chords, a
  live slide thumbnail, running timers, and the countdown.
- **Captions** — full-screen, auto-scrolling transcription from ProdCom.
- **Custom** — a free-form layout authored in the **visual editor**: a fixed design
  canvas (default 1920×1080) of positioned **objects** — clock, countdown, current/next
  slide text + notes, slide thumbnail, section chip, mic-slots grid, transcript, brand
  logo, NDI placeholder, image, **plan file**, shape, text — each bound to the same live
  data. Positions and sizes are stored as fractions of the canvas, so a layout renders
  identically at any resolution.

  The **plan-file** object shows a file attached to the *current Planning Center plan* —
  e.g. the stage plot. It matches by filename (case-insensitive substring, default
  `"stage plot"`) across everything on the plan (plan Files, service-type files, item/song
  charts — via PCO's `all_attachments`), so it auto-tracks the live plan week to week
  without re-pointing. PDFs render client-side (pdf.js, lazy-loaded); images render
  directly. The server resolves + proxies the file (PCO only issues short-lived links) and
  caches it on disk by attachment id. The *rendered image* (not the source file) can be
  framed in the inspector: **crop** (edge insets), **trim** (auto-remove the white page
  margin), **background** (keep / fill black / knock white out to transparent), and a
  **fit box to file** button that matches the object box to the content's aspect ratio.

**Layout templates** are named custom layouts saved to a reusable library (save / load /
overwrite / delete from the editor). **Slot presets** similarly snapshot a slot
arrangement by name.

The full base state is the `StageState` object pushed over SSE; high-frequency data (the
PCO countdown, ProPresenter slide, and transcript) rides separate SSE channels so a
display can render and recover from each independently. The countdown matches PCO's own
behavior — it always counts **down** (to the service start, then per item), going
red/negative when an item runs over.

**Backward compatibility.** The older "a display *is* its content" model is preserved as
a computed compat shim in `StageState` (`displays` / `slots` / `slotsByDisplay`) so
existing clients keep working; on first run, existing displays auto-migrate to
views + outputs with their URLs and slot data intact.

## API reference

All endpoints are under `/api`. State-changing routes return the updated
`StageState`. Live updates arrive on the SSE stream rather than by polling.

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
| POST | `/api/views` | Create a view (`{name, kind}`) |
| PATCH | `/api/views/:id` | Update name / kind / `ndiSource` / `layout` |
| POST | `/api/views/:id/slots` | Save a slots-view's slots |
| POST | `/api/views/:id/duplicate` | Duplicate a view |
| POST | `/api/views/:id/copy-slots` | Copy slots from another view |
| POST | `/api/views/reorder` | Reorder views |
| DELETE | `/api/views/:id` | Delete a view |
| GET | `/api/outputs` | List physical displays |
| POST | `/api/outputs` | Add a display |
| PATCH | `/api/outputs/:id` | Rename / route to a view (`{viewId}`) |
| POST | `/api/outputs/reorder` | Reorder displays |
| DELETE | `/api/outputs/:id` | Remove a display |
| GET / POST | `/api/layout-templates` | List / save a custom-layout template |
| PATCH / DELETE | `/api/layout-templates/:id` | Update / delete a template |

Legacy aliases (retained for older clients; they map onto views/outputs):
`POST /api/slots`, `GET/POST /api/presets` + `/api/presets/:id/apply` + `DELETE /api/presets/:id`,
and `POST /api/displays` + `PATCH/DELETE /api/displays/:id`.

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
| GET | `/api/integrations/wireless/channels` | Bindable channels |
| GET / POST | `/api/wireless/meter-rate` | Get / set the polling interval |

**ProPresenter & ProdCom**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/propresenter/thumbnail?k=…` | Live slide thumbnail (JPEG proxy; `k` cache-busts per slide) |
| GET | `/api/prodcom/transcript` | Recent transcript buffer (backfill for a freshly-loaded Captions display) |

**Branding & other**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/branding/source?target=app\|empty` | Original (un-cropped) brand/empty logo source |
| POST | `/api/branding` | Update app name + logos |
| GET | `/api/events` | Server-Sent Events stream (`stage:state-changed`, `pco:live`, `propresenter:status`, `prodcom:transcript`, `integrations:state-changed`, `wireless:connections-changed`) |
| GET | `/photos?u=…` | Cached Planning Center photo proxy |

## Project structure

```
.
├── server.ts                  # Backend entry point
├── index.html                 # Kiosk display (Vite entry)
├── settings-window.html       # Settings UI (Vite entry)
├── vite.config.ts             # Multi-page build + dev proxy + React Compiler
├── main/                      # Backend
│   ├── services/              # stage-controller, remote-server, pco-service,
│   │                          #   live-poller, propresenter-service, prodcom-service,
│   │                          #   wireless/device managers, integration-manager,
│   │                          #   stores (settings/slots/views/presets/layout-templates),
│   │                          #   slot-resolver, encryption, broadcaster, app-paths, …
│   ├── providers/wireless/    # Shure ULX-D / Axient / PSM drivers + registry
│   └── types/                 # Backend type contracts (stage.ts: View/Output/LayoutDTO…)
├── renderer/                  # Frontend (React)
│   ├── main/                  # Displays: stage-view (router/picker) → slot grid,
│   │                          #   dashboard-view, stage-display-view, transcription-view,
│   │                          #   layout-renderer (custom layouts); hooks + pco-timer
│   ├── settings/              # Settings app (settings-view + sections/: views-section,
│   │                          #   outputs-section, slots-section, layout-editor, …)
│   ├── components/            # Shared components + ui/ primitives
│   ├── fonts/                 # Self-hosted Outfit (brand title)
│   └── lib/api.ts             # REST + SSE client
├── public/control.html        # Standalone phone remote
├── scripts/                   # install.sh / uninstall.sh
└── INSTALL.md                 # Server deployment guide
```

## npm scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server (frontend) on `:3000` |
| `npm run server` | Backend via `tsx server.ts` on `:8788` (dev) |
| `npm start` | Backend via `node --import tsx server.ts` (production) |
| `npm run build` | Build the renderer into `build/renderer/` |
| `npm run type-check` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config + react-hooks) |
| `npm run format` | Format with `oxfmt` |

## Data, secrets & backups

State persists in a **data directory** — `$STAGE_UTILITY_DATA` if set, otherwise
`~/.stage-utility`:

- `settings.json` — non-secret config (service type, plan mode, outputs/displays, branding, …)
- `views.json` — view definitions (kind + config; custom views carry their layout)
- `slots.json` — slot sets, keyed by view + service type
- `layout-templates.json` — saved custom-layout library; `presets.json` — slot presets
- `secrets.bin` — integration secrets, **AES-256-GCM encrypted**
- `encryption.key` — 32-byte key, auto-generated on first run (mode `600`)
- `photo-cache/` — cached PCO photos
- `cache/attachments/` — cached PCO plan files (stage plots etc.), keyed by attachment id

**Back up this directory.** If you lose `encryption.key`, the encrypted secrets are
unrecoverable and you'll need to re-enter every credential.

## Development notes

- **React Compiler** is enabled in `vite.config.ts` via `@rolldown/plugin-babel` +
  `reactCompilerPreset()` — components are auto-memoized at build time. (Vite 8 /
  Rolldown is oxc-based, so `@vitejs/plugin-react`'s `babel` option doesn't apply;
  the Rolldown Babel plugin is used instead.)
- The backend is run directly as TypeScript via `tsx`; there is no separate compile
  step. `tsx` is a runtime dependency for this reason.
- **Multiple displays in dev:** the Vite proxy mishandles several concurrent SSE
  streams, so only the most-recently-loaded display updates. Test multi-display
  against the built app on `:8788`, not the `:3000` dev server.
- **`localhost:3000` won't load?** Plain `vite` binds IPv6-only; if your browser
  resolves `localhost` to IPv4 it can't connect. Use `http://127.0.0.1:3000`
  (or run `npm run dev -- --host`), or just use the built app on `:8788`.
- **`PP_DEBUG=1`** before `npm run server` logs the ProPresenter slide→section
  resolution each poll (`rawIdx → section / next / text`) — handy when verifying the
  stage view against a live service.
- `npm run type-check`, `npm run lint`, and `npm run build` are all expected to pass
  cleanly before merging.
