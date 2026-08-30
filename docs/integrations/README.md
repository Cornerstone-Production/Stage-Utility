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
| [ProVideoPlayer](provideoplayer.md) | What is on each PVP layer, and control of layers from rules |
| [OSC](osc.md) | Control buttons to LAN gear + feedback |
| [Resi](resi.md) | Whether Resi is streaming, and for how long |
| [YouTube](youtube.md) | Whether you are live on YouTube, and for how long |
| [Bitfocus Companion](companion.md) | Stream-deck control of Stage (reversed — module dials in) |
| [SenSource Vea](sensource.md) | People counts (attendance / occupancy) |
| [Ross MultiViewer (TSL)](ross-tsl.md) | Pushes a count onto a multiviewer tile |
| [RossTalk (Carbonite / Ultrix)](rosstalk.md) | Commands to Ross gear — custom controls, switching, routing, salvos |
| [Live scores](scores.md) | Followed teams' live scores (ESPN public scoreboard) |

## Adding a new integration

REAPER is the cleanest end-to-end template for a polling integration — see
[reaper.md](reaper.md) for the full file map. The pattern:

1. Service singleton in `main/services/<id>-service.ts` (`configure`, `getLatest`,
   `setConnectionListener`, change-driven `broadcast("<id>:status", …)`). Extend
   `StatusIntegration` and publish through its `emit()`; if you override `emit()`
   to throttle or de-duplicate, call `this.bumpRev()` and send
   `this.stamped(snapshot)` at your own broadcast — see the version contract below.
2. Descriptor + `apply<Id>()` + `get<Id>Target()` + `test()` in
   `integration-manager.ts`; secret keys in `SECRET_KEYS`.
3. DTO in its own module under `main/types/` (`live.ts`, `pvp.ts`), re-exported
   from `main/types/stage.ts` (+ mirror in `renderer/types.d.ts`), extending
   `RevisionedStatus`.
4. SSE hydrate + `GET /api/<id>/status` in `remote-server.ts`; `api.ts` invoke case.
5. Live hook `renderer/main/use-<id>-state.ts`, built on `useStatusChannel`;
   layout object render case + inspector; `object-integration.ts` mapping;
   category in `integrations-panel.tsx`.

Most integrations describe their settings as `ConfigField`s and the panel renders
them. One does not: Live scores' only setting is WHICH TEAMS, and a two-step
sport-then-team picker over ~2,000 clubs is not a config field, so its descriptor
carries an empty schema and `integrations-panel.tsx` renders a panel of its own
for it. Reach for that only when the setting genuinely cannot be a field — a
bespoke panel is a second place for a settings page to drift.

Build integrations efficiency-first: change-driven broadcasts, reuse the shared
SSE stream, gate polling and broadcasting on demand, back off when unreachable.

Gate on `inDemand`, never on an SSE-subscriber check. A subscriber check answers
"is a BROWSER watching"; the automation engine reads these channels in-process,
where no such check can see it. Gates written against subscribers alone left
enabled rules that had simply never run on an unattended box, with no error
anywhere — the state an appliance is in for most of the week. `inDemand` (and the
`channelInDemand(channel)` behind it) counts both. A producer that is not an
integration asks `channelInDemand` directly; a consumer that is not a browser
declares itself with `addChannelDemandSource`.

### The snapshot version

A status channel broadcasts only when its value changes, and a display hydrates
with a one-shot read alongside it. If the push landed first, the older read used
to overwrite it — and with no further broadcast until the next real change, the
wrong value stood for as long as the building stayed quiet.

So every status snapshot carries `rev`, a counter the integration advances only
when a frame actually goes out. The hydrate read (`getLatest()`) and the pushed
frame carry the same counter, and `useStatusChannel` applies the read unless it is
strictly older than a push already applied. Pushes always apply, which is also how
a client recovers when the server restarts and the counter returns to 0.

`rev` is additive: a consumer that has never heard of it — the Bitfocus Companion
module reads several of these channels from its own repository — simply does not
read it, and nothing else about these payloads changed. A payload arriving without
a `rev` skips the comparison entirely.

## Automation

Rules that fire integrations from Stage's own state — see [Automation](../automation.md).
