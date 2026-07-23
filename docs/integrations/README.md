# Integrations

Stage Utility connects to a range of production tools. Each integration is
optional, configured under **Settings → Integrations**, and (where noted) drives
a custom-layout object. All follow the same shape: a descriptor + service in
`main/services/`, a `<name>:status`-style SSE channel, and a live hook +
render/inspector on the renderer side.

| Integration | What it surfaces |
|---|---|
| [Planning Center](planning-center.md) | Service plans, live rundown, pre-service countdown |
| [ProPresenter](propresenter.md) | Current/next slide, section, thumbnails |
| [ProdCom](prodcom.md) | Live production transcription strip |
| [Smaart](smaart.md) | FOH SPL meters (Smaart v8) |
| [Wireless](wireless.md) | Wireless mic RF/battery/charger status |
| [OBS Studio](obs.md) | Recording / streaming / virtual-cam state |
| [REAPER](reaper.md) | Recording state (Web Interface poll) |
| [OSC](osc.md) | Control buttons to LAN gear + feedback |
| [Bitfocus Companion](companion.md) | Stream-deck control of Stage (reversed — module dials in) |
| [SenSource Vea](sensource.md) | People counts (attendance / occupancy) |
| [Ross MultiViewer (TSL)](ross-tsl.md) | Pushes a count onto a multiviewer tile |

## Adding a new integration

The REAPER integration (added most recently) is the cleanest end-to-end
template — see [reaper.md](reaper.md) for the full file map. The pattern:

1. Service singleton in `main/services/<id>-service.ts` (`configure`, `getLatest`,
   `setConnectionListener`, change-driven `broadcast("<id>:status", …)`).
2. Descriptor + `apply<Id>()` + `get<Id>Target()` + `test()` in
   `integration-manager.ts`; secret keys in `SECRET_KEYS`.
3. DTO in `main/types/stage.ts` (+ mirror in `renderer/types.d.ts`).
4. SSE hydrate + `GET /api/<id>/status` in `remote-server.ts`; `api.ts` invoke case.
5. Live hook `renderer/main/use-<id>-state.ts`; layout object render case +
   inspector; `object-integration.ts` mapping; category in `integrations-panel.tsx`.

Build integrations efficiency-first: change-driven broadcasts, reuse the shared
SSE stream, gate polling on subscribers, back off when unreachable.
