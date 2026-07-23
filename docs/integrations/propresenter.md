# ProPresenter integration

Reads live slide, item, section, and timer status from ProPresenter over its
local network API and surfaces it on the dashboard and on custom-layout slide
objects (current/next slide text, notes, section, progress, thumbnail).

## How it works

ProPresenter 7.9+ exposes an official local HTTP API on the LAN (no auth).
`propresenter-service.ts` polls a handful of REST endpoints once per second while
a display is watching, dropping to a ~5 s keepalive when nobody is and backing
off (5 s, doubling) while the machine is unreachable:

- `GET /v1/presentation/active`
- `GET /v1/status/slide`
- `GET /v1/presentation/slide_index`
- `GET /v1/playlist/active` (+ `/v1/playlist/<uuid>`)
- `GET /v1/timers/current`

Fields are read defensively (each degrades to null) and assembled into a
`ProPresenterStatusDTO` broadcast on the `propresenter:status` channel. Every
field is verified against ProPresenter 21.3 / API v1. Slide thumbnails are
proxied through Stage at a fixed width. Multiple auditoriums are supported: the
primary instance keeps `propresenter:status`, extra instances get
`propresenter:status:<id>`, and a combined snapshot of all instances is
broadcast on `propresenter:instances` so a layout object can pick which one it
reads.

## Setup

**In ProPresenter:** Preferences → Network → turn the **Network API** on and note
the **port** (default 1025). The machine must be on the same network as Stage.

**In Stage:** Settings → Integrations → **ProPresenter** → enter a **Name**,
**Host** (IP), **API Port**, and optional **Poll interval** (500ms feels instant),
enable it, and **Test connection**. Add more auditoriums via extra instances.

**On a layout:** add slide objects — current/next slide text, current/next slide
notes, current/next section, slide progress, slide thumbnail. Each can target a
specific ProPresenter instance.

## Files

- `main/services/propresenter-service.ts` — poll loop, status DTO, multi-instance
- `main/services/integration-manager.ts` — `PROPRESENTER_DESCRIPTOR`,
  `applyPropresenter()`, `parsePropInstances()`, test
- `main/services/remote-server.ts` — `GET /api/propresenter/status`,
  `/api/propresenter/instances`, `/api/propresenter/thumbnail`
- `renderer/main/use-dashboard-state.ts` — `usePropInstances`, live status
- `renderer/main/layout-renderer.tsx` — slide-* / section / thumbnail render cases
