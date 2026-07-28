# Install, deploy and configure

Getting Stage Utility running on a machine and pointing it at your gear.

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
5. **Integrations → Smaart (SPL)** *(optional)* — host + port (default `26000`), plus a
   password only if Smaart's API requires it. Enable the API in Smaart (Options →
   Preferences → API; modern JSON-over-WebSocket API, Smaart 8.3+). Drives the SPL meter
   object/cards, the per-item max/avg recording, and the **SPL History** browser.
6. **Plan** — **Auto** (follow the next upcoming event; rolls to the next one ~1 h
   after the current service ends) or **Manual** (pick a plan). **Active Service Types**
   here toggles which PCO service types auto-plan selection considers.
7. **Views** — build reusable content (drag to reorder, duplicate, live preview).
   Pick a **type** when you create one:
   - **Slots** — the channel grid: link each slot to a PCO person/position, a static
     label, or leave it empty; optionally bind it to a wireless channel; drag to
     reorder; stack slots that share a charger into one column.
   - **Dashboard** — clock + PCO countdown + ProPresenter now/next summary.
   - **Stage** — confidence view: slide text, section, chords, preview, timers.
   - **Captions** — full-screen transcription.
   - **Custom** — a visual editor: drag/resize objects (clocks, countdowns, slide
     text, mic-slot grids, captions, SPL meters, charger battery, logos, images, shapes,
     **containers**, …) onto a canvas and style them. Group objects inside a **container**
     that moves/resizes as a unit, apply one-click **card presets** (the dashboards'
     rounded "glass tile" look — or **Flat** to clear it), use **Start from Dashboard**
     to drop in the dashboard design as editable tiles, and **save designs to a reusable
     layout library** to reuse on other views.
   - **Script** — a full service rundown (every plan item with PCO note columns,
     section headers, length, clock + live countdown; current item highlighted), with an
     optional per-display PCO Prev/Next control.
   - **SPL Rundown** — a compact item-plus-max-SPL list for the live service.
8. **ScriptView** — a per-service-type PCO rundown dashboard (an in-app replacement
   for ScriptViewer) at `/scriptview`. Pick a service type → open a shareable,
   deep-linkable rundown (`/scriptview/weekend/audio`) to pin in its own tab. Define
   **global layouts** (Audio/Video/Lighting/…) as column presets shared across every
   service type, each with per-element toggles (clock, time, song key/BPM/arrangement,
   item notes, total time) and department row coloring; the projected clock follows the
   plan's timezone, and the live item highlights when the service is running.
9. **Displays** — your physical screens. Each has its own URL and is **routed to a
   view** (one view can drive many screens). Rename, drag to reorder, or open in its
   own window.
10. **Connect** — toggle the on-screen QR code for the phone remote.

## URLs & ports

| Surface | Dev (`npm run dev`) | Production (`npm start`) |
|---------|----------------------|--------------------------|
| Display picker | `http://localhost:3000/` | `http://<host>/` (or `:8788`) |
| A specific display | `http://localhost:3000/display-1` | `http://<host>/display-1` |
| ScriptView | — | `http://<host>/scriptview` (per-service-type PCO rundowns) |
| Settings UI | `http://localhost:3000/settings` | `http://<host>/settings` |
| Phone remote | — (use `:8788`) | `http://<host>/` when no built UI is present¹ |
| API / SSE | proxied to `:8788` | `http://<host>/api/*` |

The server binds `0.0.0.0:8788` (LAN-accessible) and, where the process is
permitted, **also `:80`** so URLs need no port — 8788 always stays up. Override
the main port with `STAGE_UTILITY_PORT`; change/disable the port-free listener
with `STAGE_UTILITY_FRIENDLY_PORT` (`0` = off).
Clean URLs (`/settings`, `/display-N`) are served directly in production and mapped
by a small Vite middleware in dev. The display picker at `/` lists every configured
display; clicking the brand/logo in any display returns there.

¹ The standalone phone control page (`public/control.html`) is served at `/` only
when there is no `build/renderer/` directory; once the UI is built, `/` serves the
React app instead.
