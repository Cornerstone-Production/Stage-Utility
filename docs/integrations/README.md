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

## Closing a settings dialog with unsaved edits

Each integration's settings open in a dialog. Escape, the close button and a
click outside all ask before they discard: with unsaved edits you get **Keep
editing / Discard / Save & close**, and *Save & close* only closes if the save
was accepted — a credential the device refuses stays on screen.

That question covers the form and the repeater lists a dialog can hold — the
Ross TSL **multiviewer feeds** and the ProPresenter **additional instances**,
which each have their own Save button. Saving from the confirm writes those
lists as well as the form.

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
   layout object render case + inspector; `object-integration.ts` mapping; a place
   in `CATEGORY_ORDER` in `integrations-panel.tsx`.

Settings → Integrations is a grid of cards, one per integration, showing its name,
what it is pointed at and its connection. All of them are on the page at all
times: the ones not set up sort below a "Not set up" heading and are drawn
quietly. Clicking a card opens its settings in a dialog — `?integration=<id>` on
the URL, so a link opens straight onto one and Back closes it. `CATEGORY_ORDER`
sets the order cards are laid out in; it draws no headings.

Most integrations describe their settings as `ConfigField`s and the dialog renders
them. Five do not: Live scores' only setting is WHICH TEAMS, and a two-step
sport-then-team picker over ~2,000 clubs is not a config field, so its descriptor
carries an empty schema and `integrations-panel.tsx` renders a panel of its own
for it — as it does for Wireless Gear, OSC, RossTalk and Companion. Reach for that
only when the setting genuinely cannot be a field: a bespoke panel is a second
place for a settings page to drift.

A panel holding a repeater row that cannot wrap marks its root with
`WIDE_PANEL_ATTR` (`integration-dialog-size.ts`), which puts its dialog in the
wide variant. A new one that forgets fails `integration-dialog-size.test.tsx`.

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
read it, and nothing else about these payloads changed.

Change-driven channels that are not status integrations carry no `rev` and cannot
be given one: the OSC feedback map, the baptism timer, wireless telemetry, the
ProdCom transcript buffer, the integration list, the patch file and the calendar
grid are all pushed by other machinery, and the calendar's payload is by design
free of per-fetch values. The same race is the same bug there, so `useStatusChannel`
falls back to the one fact left — whether the frame is LIVE or a REPLAY of the
snapshot `api.ts` caches for late subscribers. A live frame is something the server
sent after the read went out, so it wins; a replayed frame can be hours old
(the server stops feeding that cache for a channel nobody is subscribed to), so it
is applied for the first paint but never vetoes the read.

## Automation

Rules that fire integrations from Stage's own state — see [Automation](../automation.md).
