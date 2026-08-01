# Stage Utility

A kiosk dashboard for a live-production / service tech station. It pulls together
several live sources and shows them on monitors around the stage:

- **Planning Center Online** — the band lineup (people, roles, photos), the active
  plan, and a live service countdown.
- **Shure** and **Sennheiser** wireless systems — RF, battery, frequency, and audio
  level for each mic or in-ear pack.
- **ProPresenter** (one or more instances) — the live slide: current/next text, the song
  **section** (Verse/Chorus/Bridge/Intro/Outro…), chords, running timers, and a thumbnail.
- **ProdCom** — live audio **transcription** (captions), shown full-screen or as a
  strip on the dashboards.
- **Smaart** (Rational Acoustics) — live **SPL** from a FOH rig, recorded max/avg
  **per service item**, with a history browser.
- **SenSource Vea** — live **people counting** / attendance, with per-service recording
  and trend graphs (and optional push to a **Ross** multiviewer via TSL UMD).
- **OBS Studio** (streaming/recording state) and **OSC** control + feedback to LAN gear.

It also includes **ScriptView** (per-service-type PCO rundown dashboards), a unified
**History** browser (SPL + attendance + item timing, by calendar), and a **baptism**
timer/operator workflow.

Each monitor is a **display** (a screen at its own URL) pointed at a **view** —
reusable content you build once and can route to any number of displays. A view is one
of several types: a slot grid, a tech dashboard, a stage/confidence view, full-screen
captions, or a **custom** layout you design visually (drag clocks, timers, slide text,
mic-slot grids, logos, etc. onto a canvas). A phone-friendly remote runs on the same
LAN so a tech can re-assign slots and switch plans from the floor.

It's a self-contained **web/server app**: a small Node backend serves the kiosk
displays, the settings UI, the phone remote, and a REST + SSE API — all on one port.

---

## Contents

**In this file** — [How it works](#how-it-works) · [Tech stack](#tech-stack) ·
[Get the code](#get-the-code) · [Quick start](#quick-start-development)

**Documentation**

| | |
|---|---|
| [Install, deploy and configure](docs/ops/install-and-config.md) | putting it on a machine and pointing it at your gear |
| [Integrations](docs/integrations/README.md) | Planning Center, ProPresenter, wireless, OBS, REAPER, Smaart, OSC, RossTalk and the rest |
| [Attendance and service history](docs/features/attendance-and-history.md) | recording a service and reading it back |
| [ScriptView and Baptisms](docs/features/scriptview-and-baptisms.md) | two operator-facing surfaces on the PCO plan |
| [Patch sheet](docs/patch-sheet/DESIGN.md) | the stage patch sheet |
| [Data model and concepts](docs/reference/data-model.md) | Views, Outputs, Slots — the nouns |
| [API reference](docs/reference/api.md) | the HTTP surface |
| [Reliability, backups and data](docs/ops/reliability.md) | behaviour under load, and where your data lives |
| [Network traffic](docs/ops/network-traffic.md) | what this actually puts on your LAN during a service |
| [Updates and logs](docs/ops/updates-and-logs.md) | the in-app updater |
| [Contributing](docs/contributing.md) | commit convention, branching, releases |
| [Project structure](docs/contributing-appendix.md) | orientation in the codebase |

The sections below are kept as stubs so existing links still resolve.

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

## Get the code

```bash
git clone https://github.com/Cornerstone-Production/Stage-Utility.git
cd Stage-Utility
```

For installing on the actual display devices (Pi / Mac / Windows), the per-device
clone + setup steps are in **[INSTALL.md](INSTALL.md)**.

## Quick start (development)

Requires Node ≥ 24. From the repo root (see [Get the code](#get-the-code) above),
run **two terminals**:

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

Moved to [install and config](docs/ops/install-and-config.md).

## Configuration

Moved to [install and config](docs/ops/install-and-config.md).

## URLs & ports

Moved to [install and config](docs/ops/install-and-config.md).

## Integrations

| Integration | Kind | Config | Notes |
|-------------|------|--------|-------|
| **Planning Center** | lineup | App ID, Secret, refresh interval, countdown target | Fetches service types, plans, and team members; auto-refreshes on the chosen interval (default 1 h) plus on demand. Also drives the live service countdown (`pco:live`). Request volume is minimized (tiered caches, consolidated `plan_times` + team-positions calls, 429 backoff). |
| **Wireless Gear** | wireless | per-device host / port / channels | Shure **ULX-D**, **Axient Digital**, **PSM (in-ear)**, and Sennheiser **EW-DX**, **EW-G4 (SSC)**, **Spectera** drivers; reports RF, battery, charging, frequency, audio level. Offline/manually-entered devices supported. |
| **ProPresenter** | control | host, API port (`1025`), **per-instance name** | Talks directly to ProPresenter 7.9+'s local HTTP API (LAN, no auth). **Multiple instances** can be configured and selected per layout object. Polls the active presentation, slide status, arrangement, timers, and a thumbnail; broadcasts `propresenter:status`. Section is resolved from the arrangement **play order**. |
| **ProdCom** | lineup | host, API port (`24480`), API key | Holds an SSE connection to ProdCom's transcript stream and re-broadcasts `prodcom:transcript`; backfills recent lines on connect. Powers the Captions display + dashboard transcript strips. |
| **Smaart (SPL)** | control | host, port (`26000`), password | Connects to Smaart's modern JSON-over-WebSocket API (8.3+, auto-negotiates SDK V3/V4) for live SPL. Streams per-meter readings (`spl:metrics`); a recorder tracks max/avg SPL **per plan item** per service (`spl:history`), browsable under **History**. |
| **OBS Studio** | control | host, WebSocket port (`4455`), password | Connects to OBS's obs-websocket v5 (direct, not via Companion). Reports streaming/recording/scene state; drives an **"OBS status"** layout object that turns red while recording. |
| **OSC** | control | per-button targets (host / port / address / args) | Custom-layout **OSC button** objects send OSC over UDP to LAN gear and reflect device state via OSC **feedback**; multiple targets per button. Zero external deps (`node:dgram` + a hand-rolled codec). |
| **SenSource Vea** | people | client ID + secret (or static token), poll interval | People-counting: pulls authoritative building occupancy (zone→location scoping, nets ins/outs across doors). Feeds the **attendance** metrics, trend graph, and per-service recording. |
| **Ross MultiViewer (TSL UMD)** | output | switcher host, TSL port | Pushes live people counts to a Ross multiviewer/switcher as TSL UMD tally text. |
| **Bitfocus Companion** | control | host, port | Backed by a separate Companion module; in-app control endpoints exist. |

## Attendance & service history

Moved to [attendance and history](docs/features/attendance-and-history.md).

## ScriptView

Moved to [scriptview and baptisms](docs/features/scriptview-and-baptisms.md).

## Baptisms

Moved to [scriptview and baptisms](docs/features/scriptview-and-baptisms.md).

## Reliability & efficiency

Moved to [reliability](docs/ops/reliability.md). For what the app puts on the
network — about 11 Mbit/s across six screens during a service, and close to
nothing between them — see [network traffic](docs/ops/network-traffic.md).

## Backups & portability

Moved to [reliability](docs/ops/reliability.md).

## Data model & concepts

Moved to [data model](docs/reference/data-model.md).

## API reference

Moved to [api](docs/reference/api.md).

## Project structure

Moved to [contributing appendix](docs/contributing-appendix.md).

## npm scripts

Moved to [contributing appendix](docs/contributing-appendix.md).

## Data, secrets & backups

Moved to [reliability](docs/ops/reliability.md).

## Development notes

Moved to [contributing appendix](docs/contributing-appendix.md).

## Branches & releases

- **`main`** — stable, web-only release line. This is what you install and what the
  in-app updater follows. Tagged releases (`vX.Y.Z`) are published under
  [Releases](https://github.com/Cornerstone-Production/Stage-Utility/releases).
- **`beta`** — pre-release track for testing changes before they land on `main`. A device
  checked out on `beta` auto-updates from `beta`. Promote to `main` by merging + tagging.
- Day-to-day work happens on short-lived `feat/*` / `fix/*` branches opened as PRs.

## License

Licensed under the **GNU General Public License v3.0 (or later)** — see [LICENSE](LICENSE).

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).
