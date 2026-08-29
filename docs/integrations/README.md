# Integrations

Every integration is optional and configured under **Settings → Integrations**,
where each shows its own connection state. Most also drive a custom-layout object
you can place on a screen.

**Planning Center is the exception** — it supplies the plan, the people and the
countdown, so the app needs it.

| Integration | What it surfaces |
|---|---|
| [Planning Center](planning-center.md) | Service plans, live rundown, pre-service countdown, room and event calendar |
| [ProPresenter](propresenter.md) | Current/next slide, section, thumbnails |
| [ProdCom](prodcom.md) | Live production transcription strip |
| [Smaart](smaart.md) | FOH SPL meters (Smaart v8) |
| [Wireless](wireless.md) | Wireless mic RF/battery/charger status |
| [OBS Studio](obs.md) | Recording / streaming / virtual-cam state |
| [REAPER](reaper.md) | Recording state (Web Interface poll) |
| [OSC](osc.md) | Control buttons to LAN gear + feedback |
| [Resi](resi.md) | Whether Resi is streaming, and for how long |
| [YouTube](youtube.md) | Whether you are live on YouTube, and for how long |
| [Bitfocus Companion](companion.md) | Stream-deck control of Stage (reversed — module dials in) |
| [SenSource Vea](sensource.md) | People counts (attendance / occupancy) |
| [Ross MultiViewer (TSL)](ross-tsl.md) | Pushes a count onto a multiviewer tile |
| [RossTalk (Carbonite / Ultrix)](rosstalk.md) | Commands to Ross gear — custom controls, switching, routing, salvos |

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

## Automation

Rules that fire integrations from Stage's own state — see [Automation](../automation.md).
