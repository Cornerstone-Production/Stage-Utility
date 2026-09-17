# Built-in cues

**Goal.** A cue button on a console, a Home Assistant switch and a Companion
toggle can drive OBS, REAPER, ProVideoPlayer and the app itself with no
automation rule behind them. The app ships those cues.

**Why.** A cue is a rule, and that is right: one definition feeds the cue
button, Home Assistant and Companion at once, with idempotent calls, a settle
window and an activity-log line. But a button that starts a REAPER recording
today costs two rules named as a pair, and nothing about those rules is
automation. The pieces the pair collapses to, an ON action, an OFF action and an
`app:` state source, are already fixed by the actions themselves
(`implicitStateBinding` in `cue-pairs.ts`). The app can state them once.

## What a built-in cue is

A rule the app synthesises from a table and never stores. It has the shape
every cue has, so every consumer of cues works unchanged:

| Field | Value |
|---|---|
| `id` | `builtin:<base>` |
| `trigger` | Called by name, `name: <base>_on` / `<base>_off`, or `<base>` for a button |
| `action` | the table's ON or OFF action |
| `conditions` | none: a panel button must work during a service |
| `enabled` | true |
| `cooldownSec` | 0 for switch halves (the idempotent call handles repeats), 1 for buttons |

The pair's state binding is what `implicitStateBinding` already implies for the
ON action, so a built-in switch is a bound pair without anybody binding it.

### The table

Switches, listed while the integration is enabled in Settings:

| Base | Name | ON | OFF | State | Tone |
|---|---|---|---|---|---|
| `obs_record` | OBS recording | `obs.record start` | `obs.record stop` | `app:obs.recording` | live |
| `obs_stream` | OBS stream | `obs.stream start` | `obs.stream stop` | `app:obs.streaming` | live |
| `obs_virtual_cam` | OBS virtual camera | `obs.virtual-cam start` | `obs.virtual-cam stop` | `app:obs.virtualCam` | default |
| `reaper_record` | REAPER recording | `reaper.transport record` | `reaper.transport stop` | `app:reaper.recording` | live |

**Tone** is how the cue button colours the switch. `default` is today's
rendering: green ring when on, grey when off. `live` is for a switch whose ON
means on air or recording: **red** ring and dot when on, **green** ring when
the device is connected and off, which reads as standby. Unavailable and stale
render as today for both. The manifest carries `tone: "live"` on those
switches; a switch without it is `default`. User-made pairs have no tone
setting yet; the field exists so one can be added later without a new shape.

Per ProVideoPlayer layer, one set for every layer in the last PVP status, named
by a slug of the layer name (`Lower Thirds` → `lower_thirds`):

| Base | Name | ON | OFF | State |
|---|---|---|---|---|
| `pvp_<layer>_shown` | `<Layer>` shown | `pvp.unhide-layer` | `pvp.hide-layer` | `app:pvp.layer-hidden:<Layer>` with `onValue: off`, `offValue: on` |
| `pvp_<layer>_muted` | `<Layer>` muted | `pvp.mute-layer` | `pvp.unmute-layer` | `app:pvp.layer-muted:<Layer>` |

"Shown" is the operator's direction: a lit button means the layer is on screen.
The family reads `on` while hidden, so the binding is inverted through the
values `StateBinding` already carries. No new state source is needed.

Buttons (momentary):

| Base | Name | Action | Listed while |
|---|---|---|---|
| `pvp_<layer>_clear` | Clear `<Layer>` | `pvp.clear-layer` | PVP enabled |
| `pvp_clear_workspace` | Clear PVP workspace | `pvp.clear-workspace` | PVP enabled |
| `pco_advance` | Next item | `pco.live.advance` | Planning Center connected |
| `display_refresh` | Refresh displays | `display.refresh` | always |

Exact counts, for the guard: 4 fixed switches, 2 switches and 1 button per PVP
layer, 3 fixed buttons.

## Where they enter

One function, `builtinCueRules(): Rule[]`, in a new `main/services/builtin-cues.ts`,
reading the integration flags and the last PVP status. A second,
`cueRules()` on the engine, returns stored rules plus built-ins and replaces
`listRules()` in exactly these readers:

- `callByName` (the call route), so `POST /api/cues/obs_record_on` runs the
  action through the same path as any cue: disarm, idempotent "already on",
  settle window, `[cues]` log line, activity log.
- `cueManifestDeps.rules` and `cueStatesDeps.rules`, so the manifest lists them
  as switches and buttons and `/api/cues/states` reads their state.
- `home-assistant-yaml.ts`, so the YAML fallback carries them too.

`listRules()` is unchanged: the Automation page, export, import and the config
snapshot never see a built-in. Nothing is persisted.

### Names are reserved

`assertCueValid` refuses a new or edited rule whose cue name is a built-in's
name, with the sentence `"obs_record_on" is a built-in cue`. A stored rule that
already holds a built-in's name keeps working: the built-in with that base is
left out and one line says so at boot and on every rule change:
`[cues] built-in obs_record not offered: rule "REC on" owns obs_record_on`.
That is how an install that built its own OBS pair last week upgrades without a
duplicate entity in Home Assistant, and how it discovers it can delete the pair.

### The manifest says which are built in

`ManifestSwitch` and `ManifestButton` gain `builtin?: true`, and `ManifestSwitch`
gains `tone?: "live"`. Home Assistant and Companion ignore both fields. The cue
button's picker groups on the first and its colours follow the second.

### The set can change

The manifest version bumps, and the `cues` channel says `manifest`, when the
built-in set changes: an integration is enabled or disabled, or the PVP layer
names change. Both already have a change path; each calls the same
`bumpManifestVersion` the rules path calls. A PVP that goes offline keeps its
last layers listed with state unknown, so entities do not churn on a reconnect.

## The cue button picker

The **Cue** select in the layout editor lists **Built in** first, then **Your
cues**, each as a labelled group. Entries read as today: name, room, and
(switch) or (button). Nothing else about the button changes: the same states,
the same call.

## Docs

- `docs/automation.md`, in Cues, a new subsection **Built-in cues** with the
  table, the reservation rule, and the sentence about deleting a pair the
  built-in replaces. The **State from Stage Utility** section already documents
  every source the table uses.
- `docs/reference/widgets.md`, cue button: the picker's two groups and the two
  tones, with what red and green mean on each.
- `docs/integrations/obs.md`, `reaper.md`, `provideoplayer.md`: one line each
  naming the cues that exist for that integration.
- `docs/integrations/companion.md`, the Home Assistant section: built-ins appear
  as entities like any other cue.
- `docs/integrations/ultritouch.md`: the setup step becomes "pick OBS recording
  from Built in".

## Logging

- Boot and each rule change: `[cues] N built-in cues offered (obs 3, reaper 1,
  pvp 7, app 2)`, only when the count changes.
- A suppressed built-in, as above.
- Calls log as every cue does, `[cues] obs_record_on by console: dispatched`.

## Tests, each proven red

- Every table entry's action id exists in `AUTOMATION_ACTIONS`, its state ref
  parses, and the counts are exactly 4 switches and 3 buttons plus 3 per layer.
- Disabled integration: no built-ins for it in the manifest. Enabled: present
  with `builtin: true`, state from a stubbed `readAppState`.
- A stored rule named `obs_record_on` suppresses that built-in and logs once.
- Saving a rule with a built-in name is refused with the sentence above.
- `callByName("obs_record_on")` runs `obs.record start`; called again while
  `app:obs.recording` reads on, answers `already on` and sends nothing.
- PVP layer rename bumps the manifest version and emits `manifest` on `cues`.
- Renderer: the picker renders two groups with the built-ins first; a `live`
  switch renders `data-tone="live"` and its on state is the red ring, its off
  state the green one; a default switch is unchanged.
- Real path against a test server on an empty data dir with OBS marked enabled
  and its socket stubbed: `GET /api/cues/manifest` lists `obs_record`;
  `POST /api/cues/obs_record_on` from a same-origin request dispatches; the
  Automation page shows no built-in.

## Out of scope

- Hiding a single built-in from Home Assistant. Every built-in is an entity;
  a per-cue setting needs a store and comes when somebody needs it.
- REAPER play, ProPresenter and YouTube or Resi cues: no action pair with a
  state source exists for them yet.
- Renaming a built-in: names are fixed so Home Assistant entity ids are stable.
