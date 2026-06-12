# Stage Monitor

A kiosk dashboard for a live-production / service tech station. It pulls the band
lineup (people, roles, photos) from **Planning Center Online** and live wireless
status (RF, battery, frequency, audio level) from **Shure** wireless systems, and
shows them on a stage monitor — who's playing, on which channel, and the health of
their mic or in-ear pack. A phone-friendly remote control panel runs on the same
LAN so a tech can re-assign slots and switch plans from the floor.

It's a self-contained **web/server app**: a small Node backend serves the kiosk
display, the settings UI, the phone remote, and a REST + SSE API — all on one port.
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
 Planning Center  ─┐                          ┌─ Kiosk display   (build/renderer, React)
   (lineup, REST)  │     ┌──────────────┐     │
                   ├────▶│  Node server │────▶├─ Settings UI     (settings-window.html)
 Shure wireless   ─┘     │  (server.ts) │     │
   (TCP, RF/batt)        │  :8788       │     ├─ Phone remote    (public/control.html)
                         └──────┬───────┘     │
                                └─────────────┴─ REST  /api/*
                                                 SSE   /api/events  (live push)
```

The backend (`server.ts` + `main/`) polls Planning Center on a schedule and Shure
gear continuously, resolves the current plan into the configured **slots**, and
broadcasts state to every connected client over Server-Sent Events. The frontend
is a React app served as static files; the phone remote is a standalone HTML page.

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

- **Kiosk display** → http://localhost:3000/
- **Settings UI** → http://localhost:3000/settings-window.html

The Vite dev server proxies `/api` and `/photos` to the backend on `:8788`.

## Deployment

For installing on a server (Linux + systemd), see **[INSTALL.md](INSTALL.md)**. In
short, from a checked-out copy:

```bash
sudo ./scripts/install.sh
```

This checks Node, builds the UI, sets up the data directory, and installs an
auto-starting `stage-monitor` systemd service. Re-run after `git pull` to update;
`sudo ./scripts/uninstall.sh` removes the service.

For a manual/production run without systemd:

```bash
npm ci
npm run build
npm start          # node --import tsx server.ts
```

## Configuration

All configuration is done at runtime through the **Settings UI** — nothing lives
in the repo. Open `…/settings-window.html` and work through the sidebar:

1. **Integrations → Planning Center** — enter your **App ID** + **Secret** (from a
   [PCO Personal Access Token](https://api.planningcenteronline.com) → Developers →
   Personal Access Tokens).
2. **Integrations → Wireless Gear** *(optional)* — add Shure devices by IP, TCP
   port (usually `2202`), and channel count.
3. **Service Types** — choose which PCO service types are in play.
4. **Plan** — **Auto** (follow the next upcoming event) or **Manual** (pick a plan).
5. **Slots** — build the channel layout: link each slot to a PCO person/position,
   a static label, or leave it empty; optionally bind it to a wireless channel;
   drag to reorder; stack slots that share a charger into one column.
6. **Displays** — run multiple kiosk displays, each with its own slot set.
7. **Connect** — toggle the on-screen QR code for the phone remote.

## URLs & ports

| Surface | Dev (`npm run dev`) | Production (`npm start`) |
|---------|----------------------|--------------------------|
| Kiosk display | `http://localhost:3000/` | `http://<host>:8788/` |
| Settings UI | `http://localhost:3000/settings-window.html` | `http://<host>:8788/settings-window.html` |
| Phone remote | — (use `:8788`) | `http://<host>:8788/` when no built UI is present¹ |
| API / SSE | proxied to `:8788` | `http://<host>:8788/api/*` |

The server binds `0.0.0.0:8788` (LAN-accessible). The port is currently fixed.

¹ The standalone phone control page (`public/control.html`) is served at `/` only
when there is no `build/renderer/` directory; once the UI is built, `/` serves the
React kiosk app instead.

## Integrations

| Integration | Kind | Config | Notes |
|-------------|------|--------|-------|
| **Planning Center** | lineup | App ID, Secret | Fetches service types, plans, and team members; auto-refreshes hourly. |
| **Wireless Gear** | wireless | per-device host / port / channels | Shure **ULX-D**, **Axient Digital**, and **PSM (in-ear)** drivers over TCP; reports RF, battery, charging, frequency, audio level. |
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

**Displays** let you drive multiple monitors, each with its own slot set, all
sharing one plan and PCO dataset. **Presets** snapshot a slot arrangement by name so
you can restore it later. The full live state is the `StageState` object pushed over
SSE.

## API reference

All endpoints are under `/api`. State-changing routes return the updated
`StageState`. Live updates arrive on the SSE stream rather than by polling.

**Stage & plan**
| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/state` | Current `StageState` |
| GET  | `/api/service-types` | PCO service types |
| GET  | `/api/plans?serviceTypeId=…` | Plans for a service type |
| POST | `/api/service-type` | Set active service type |
| POST | `/api/plan` | Set active plan |
| POST | `/api/plan/next` | Jump to the next plan (auto mode) |
| POST | `/api/plan/mode` | Set `auto` / `manual` |
| POST | `/api/refresh` | Re-fetch from Planning Center |
| POST | `/api/allowed-service-types` | Set the allowlist |
| POST | `/api/show-qr` | Toggle the connect QR on the display |

**Slots, presets & displays**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/slots` | Save slots for a display |
| GET / POST | `/api/presets` | List / save a preset |
| POST | `/api/presets/:id/apply` | Apply a preset to a display |
| DELETE | `/api/presets/:id` | Delete a preset |
| POST | `/api/displays` | Add a display |
| PATCH / DELETE | `/api/displays/:id` | Rename / remove a display |

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

**Other**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/events` | Server-Sent Events stream (live state) |
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
│   │                          #   wireless/device managers, stores, encryption,
│   │                          #   broadcaster, app-paths, …
│   ├── providers/wireless/    # Shure ULX-D / Axient / PSM drivers + registry
│   └── types/                 # Backend type contracts
├── renderer/                  # Frontend (React)
│   ├── main/                  # Kiosk app (router, stage view)
│   ├── settings/              # Settings app (settings-view + sections/)
│   ├── components/            # Shared components + ui/ primitives
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

State persists in a **data directory** — `$STAGE_MONITOR_DATA` if set, otherwise
`~/.stage-monitor`:

- `settings.json` — non-secret config (service type, plan mode, displays, slots, …)
- `secrets.bin` — integration secrets, **AES-256-GCM encrypted**
- `encryption.key` — 32-byte key, auto-generated on first run (mode `600`)
- `photo-cache/` — cached PCO photos

**Back up this directory.** If you lose `encryption.key`, the encrypted secrets are
unrecoverable and you'll need to re-enter every credential.

## Development notes

- **React Compiler** is enabled in `vite.config.ts` via `@rolldown/plugin-babel` +
  `reactCompilerPreset()` — components are auto-memoized at build time. (Vite 8 /
  Rolldown is oxc-based, so `@vitejs/plugin-react`'s `babel` option doesn't apply;
  the Rolldown Babel plugin is used instead.)
- The backend is run directly as TypeScript via `tsx`; there is no separate compile
  step. `tsx` is a runtime dependency for this reason.
- `npm run type-check`, `npm run lint`, and `npm run build` are all expected to pass
  cleanly before merging.
