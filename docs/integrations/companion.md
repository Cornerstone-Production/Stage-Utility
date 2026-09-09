# Bitfocus Companion

Drives and reads Stage Utility from [Bitfocus Companion](https://bitfocus.io/companion)
— Stream Deck buttons for plan control, view routing and blackout, with feedback
from the live service.

The module is a separate repository:
[companion-module-cornerstone-stageutility](https://github.com/Cornerstone-Production/companion-module-cornerstone-stageutility).

## How it connects

Companion runs in **both directions**, and they are independent:

| | |
|---|---|
| **In** | the Companion module connects to this app's HTTP/SSE server on port 8788. Nothing to set up here; the row counts the clients attached |
| **Out** | with a host and port filled in, this app can press a named Companion button — for a rule, or for a cue called by voice |

The inbound half needs no config and no enable switch. The outbound half is off
until you fill in the host: blank means "we do not dial Companion", and every
outbound path says so rather than guessing at an address.

The module marks its event stream with an `X-Companion-Module` header (or
`?client=companion`). The server counts those streams and reports the total to
the integration manager, which is what the settings panel's "N connected" shows.
The inbound half is therefore presence and guidance only — there is nothing to
enable, and Test only reads Companion once a host is filled in below. It carries
**no enable switch** for that reason: the server
listens either way, so a switch would have said "off" while the module went on
connecting and controlling the app. Its row reads **No clients yet** until a
Companion connects, which is a listener at rest rather than a fault, and it is
never counted in the context bar's "N disconnected".

## Setup

**In Companion** — add a **Cornerstone Stage Utility** connection and enter this
server's IP and port. No password; the API is LAN-only.

The module requires **Companion 4.3.0 or newer**, which is where Companion added
the v2 connection API the module is built against. On anything older it installs
and shows up in the module list, but the connection never starts — Companion
reports "Connection not found or not running" and loads no config, which looks
like a broken download rather than a version mismatch.

**In Stage Utility** — Settings → Integrations → **Bitfocus Companion** shows the
LAN IP and port split into separate copyable fields, because Companion takes host
and port separately and cannot resolve a DNS name. A live connected-client count
sits alongside them.

### To press Companion buttons from here

| Field | |
|---|---|
| **Companion Host** | Companion's IP. Leave blank and nothing outbound happens |
| **API Port** | Companion's web and HTTP API port, `8000` by default. Companion's **Settings → Protocols → HTTP** must be on |

**Test** reads Companion's configuration and reports its build and how many
buttons it found. It never presses anything.

Everything outbound comes from Companion's own configuration export
(`/int/export/full`), which is unauthenticated **unless the Companion admin has
set a password** — with one set, the button picker says so instead of showing an
empty list.

## Pressing a button

The automation action **Press a Companion button** presses one button at a page,
row and column, exactly as a finger would. Build it under Settings → Automation
and pick the button from the list rather than typing coordinates; the three
numbers stay visible and editable for a button that is not in the export.

Two things it does not do:

**It reports "dispatched", never "on".** Companion answers the moment it hands
the press to a control. Nothing in the chain reads the projector back, so the log
says what was sent, not what happened.

**One action is one press.** For a sequence, make a Companion button that runs the
sequence and press that. A rule that half-ran a chain would be worse than one that
did nothing.

## Calling a cue by name

**Scope: setup and teardown, not for cues during a service.** These are the
things somebody walks in and turns on, and walks out and turns off. Every
imported cue carries the condition **no service is live**, which fails closed: it
refuses while a service is running or about to start, and when Planning Center
cannot be read — each with a sentence a voice assistant can read out.

A cue is an ordinary automation rule whose trigger is **Called by name**. It has
a `name` in `lower_snake_case`, unique across rules, and runs only when something
calls it:

```
POST /api/cues/<name>
Authorization: Bearer su_...
```

It never fires from anything happening in the building — no state change, no
snapshot, no schedule reaches it.

| Answer | |
|---|---|
| `200` | dispatched. `{ok, detail}`, plus `simulated: true` while the engine is in simulate mode — the call succeeded and nothing reached a device |
| `202` | this cue is set to **Ask twice**. `{confirm, expiresInSec}`; call again within 30 s with `?confirm=<token>`, or in the body. A confirmation is **single use** and lapses after 30 s — replaying one is answered with a fresh confirmation, never a second press |
| `401` | no token, or a revoked one |
| `404` | no cue by that name |
| `409` | refused. `{error, reason}`; `error` is a sentence to read out, like *"The Gospel Way is live"* |

| `reason` | |
|---|---|
| `service-live` | a service is running, or starts within the hour. Carries `plan` when the plan has a title |
| `planning-center-unknown` | Planning Center is configured and cannot be read, so we will not guess. Also on a `[cues]` line in the server log |
| `button-missing` | the Companion button this cue presses is not in the export any more. Nothing is pressed — see [When a button moves](#when-a-button-moves) |
| `condition-not-met` | one of the rule's other conditions did not hold |
| `cooldown` | the cue ran within its cooldown |
| `once-per-service` | the cue is set to run once per service and already has, this occurrence |
| `disabled` | the rule's own switch is off |
| `disarmed` | automation is disarmed |

Every call, allowed or refused, lands in the automation Activity log with the
calling token's label, and on a `[cues]` line in the server log.

### Tokens

Settings → Automation → **Calling cues** mints one token per caller. The token is
shown **once** — only a SHA-256 of it is stored — so a lost one is replaced, not
recovered. Revoke them individually, which is why each has a label.

The same token is required by `POST /api/action/invoke`, and by minting or revoking
a token, for anything that is not a browser request from this server's own pages —
a script or a Companion `generic-http` action calling it needs one. The app's own
pages are unaffected.

**What the token is, and what it is not.** It identifies the caller in the activity
log, and it keeps the call route closed to anything that has not been handed one. It
is not a perimeter: anyone with write access to the app over the LAN can change any
setting, including the cue rules and the tokens themselves, as they always could.
The perimeter is the network — do not expose Stage Utility beyond the LAN or
Tailscale. Companion's own HTTP API is unauthenticated in the same way, and the
mitigation there is the same: an ACL on the switch port Companion is on.

### Importing ON/OFF pairs

Settings → Automation → **Import from Companion…** finds, per page, buttons whose
labels differ only by a trailing `ON`/`OFF` (or `Startup`/`Shutdown`) and offers
each pair as two cues, `<name>_on` and `<name>_off`. A pair whose buttons drive a
utility device — a projector, a television, a smart plug or bulb, a lighting console
— is ticked by default; everything else is offered unticked, because a cue that
presses it is a cue somebody can say by accident.

Pairs are matched **within a page**: "Conf TVs ON" on two auditoriums' pages are
different televisions, and crossing them is the kind of mistake found out during
setup. When the same label does appear on two pages, both cues are named after
their page so neither is lost.

Each pair row has a **State** column: pick the Companion custom variable that
holds what the device is actually doing, and the generated Home Assistant switch
reports that rather than what it last asked for. See
[Real state](#real-state) — a variable named after the pair (`projectors` or
`projectors_state`) is picked for you.

Each imported pair becomes two rules with **no service is live** and a two-second
cooldown. They are ordinary rules afterwards — edit, disable or delete them like
any other. Re-running the import skips names that already exist and tells you
which.

### Single buttons

Under the pairs, the same dialog lists **Single buttons** — every other labelled
button, one cue each, named after the button's own label. A button with no label
is left out: a cue called nothing cannot be called.

**Nothing in this section is ticked for you.** A pair is plainly a thing being
turned on and off; a single button is whatever somebody put on a Companion page,
and a pre-ticked camera shot or playback macro is a cue somebody can say by
accident. Search by label, page or cue name and tick what you want.

They carry the same **no service is live** condition and two-second cooldown as a
pair's halves, and the same page-naming rule applies when the same label is on two
pages. In Home Assistant a single button becomes a `script` rather than a switch —
there is no on and no off to give a switch a state.

### When a button moves

Coordinates are the one thing about a Companion button that does not last.
Somebody drags a button one key over, or inserts a page ahead of it, and a cue
built on `p17 r2 c6` presses whatever is there now — Companion answers `204` for
an empty coordinate and a cheerful `200` for the wrong button, so nothing says
so.

So every **Press a Companion button** action stores the button's identity beside
its coordinates: the page's own opaque id, which a renumber does not change, and
the ids of the actions the button runs. A control in Companion has no id of its
own; its actions do, and they travel with the button when it is moved. The label
is stored too and refreshed whenever the button is confirmed.

It is checked on startup, whenever you press **Test** on the Companion
integration, whenever you press **Refresh** in the button picker, and hourly —
always against the same cached configuration export the picker reads, never a
second request. Three outcomes, each a pill on the rule's row under Settings →
Automation:

| | |
|---|---|
| **in place** | the button at those coordinates still runs those actions |
| **moved** | exactly one button on that page runs them, and it is somewhere else. The coordinates are updated, the pill says where it went, and it stays amber until you re-pick the button — the point of it is telling you about a move you did not make |
| **button missing** | none on that page runs them, or more than one does, or the page is gone |

**A missing button refuses.** The cue answers `409 button-missing` and presses
nothing; so does the rule firing from any other trigger, and the editor's Test.
It does not fall back to the coordinates and it does not pick the closest label —
a cue that presses the wrong button during setup is worse than one that says it
cannot. More than one match is refused for the same reason: two buttons carrying
one identity is a Companion somebody duplicated, and guessing between them is a
coin toss on real gear. Open the rule and pick the button again to clear it.

A button that runs no actions at all has no identity but its coordinates, and is
reported in place while something is there and missing when it is not. It is
never searched for.

**When Companion cannot be reached, nothing changes.** No status is touched and
no cue is refused — a pass that downgraded every cue while a switch was
rebooting would refuse every cue in the building. The failure is on a
`[companion] export unavailable` line in the server log; every move, adoption
and disappearance is on a `[companion] cue <name>:` line, and each run ends with
`[companion] reconciled N cues: N in place, N moved, N missing`.

Cues imported from Companion and buttons chosen with the picker are fingerprinted
as they are created. A rule that predates this has no fingerprint, shows no pill,
and is adopted at its own coordinates by the first check.

### When a button is renamed

Relabel a button in Companion and the cue named after it is renamed to match, so
`projectors_on` becomes `screens_on` when the button starts saying "Screens ON".
The old name **keeps answering**: `POST /api/cues/projectors_on` still fires the
cue, so a Home Assistant config already pasted into `configuration.yaml` — and
any HomeKit switch made from it — carries on working. Re-paste the YAML when
convenient; the generated fragment names each renamed cue in a comment.

A cue keeps up to five former names, oldest dropped first, and they share one
namespace with live names: no other cue may take a name or a former name that is
already in use. Remove one in the rule editor and that URL stops resolving.

Four cases where the name is kept, each on a `[companion] cue <name>:` line:

| | |
|---|---|
| **you named the cue yourself** | a name that is not the one the import would have produced from the button's old label is never touched. A Companion label is not authority over a name you typed into Home Assistant |
| **the new name is taken** | by another cue's name, by another cue's former name, or by another cue being renamed in the same check |
| **one half of an ON/OFF pair** | a pair renames together or not at all. Renaming one half leaves a Home Assistant switch with no off |
| **the button is missing** | its label is whatever it said the last time anybody could see it |

The label on the rule's action is refreshed either way — that is what the button
says, not what the cue is called. **Spoken as** is left alone unless it was the
button's label exactly, so words you chose for an assistant survive a relabel; a
pair's spoken name is composed by the import and never follows.

### Home Assistant

**Copy YAML** and **Download YAML** in the same panel both produce the whole
configuration fragment: one `rest_command` per cue, a template switch per pair
under the `template:` key, and a `script` per cue that is not half of a pair.
That is the current template format — the legacy `platform: template` under
`switch:`, which Home Assistant now refuses with a repair notice, is not
generated, and a fragment saved from an older version needs replacing. Each
switch's entity id follows its name, so an automation of your own naming an old
`switch.…` may need its id updating. A cue that has been renamed carries a
comment naming the `rest_command` it used to be; former names are never emitted
as commands of their own. Copy YAML writes it to the clipboard, which needs a
secure browsing context and fails on the plain-HTTP LAN address most installs
run on — use **Download YAML** there instead.

Save the download as `packages/stage_utility.yaml` in Home Assistant's config
folder, and add this to `configuration.yaml` once:

```yaml
homeassistant:
  packages: !include_dir_named packages
```

A package rather than a direct paste, because the fragment carries top-level
`script:` and `template:` keys, and a default `configuration.yaml` already has
`script: !include scripts.yaml` — pasting the fragment in as-is would be a
duplicate key. `secrets.yaml` sits in the same config folder; the File editor
add-on is the easiest way to reach both it and the packages folder.

Put the token in `secrets.yaml` **with the scheme**:

```yaml
stage_utility_token: "Bearer su_..."
```

and reload. A switch is `optimistic: true` unless its pair has a **state
variable** — Stage Utility reports that it dispatched the press and nothing more,
so Home Assistant shows what it asked for rather than what the device did.

### Real state

Companion answers a press the moment it hands it to a control and never says what
happened at the other end, so an optimistic switch still reads *on* for a
projector somebody turned off at the wall. Bind the pair to a Companion **custom
variable** and it reports the truth instead.

In Companion:

1. create a custom variable, one per pair — `projectors_state` is the name this
   looks for by default, and so is `projectors`;
2. add a **Set custom variable** action to the pair's ON button setting it to
   `on`, and one to the OFF button setting it to `off`.

In Stage Utility, either pick the variable in the **State** column when you import
the pair, or open the pair's `_on` cue and set **State variable**. The `_off` half
inherits it. If your buttons set something other than `on`/`off` — `POWER=ON`,
`1` — set **Value meaning on** and **Value meaning off** to match; they may not be
the same string.

The comparison is **exact and case-sensitive**, after trimming whitespace from
both ends: a variable holding `ON` does not match the default `on`, and reads
*unknown*. Set **Value meaning on** to `ON` or have the button write `on`.

The generated YAML then also carries one `rest` sensor polling
`GET /api/cues/states` every ten seconds, with an attribute per bound pair, and
each bound switch reads its own attribute off it instead of being optimistic. One
sensor covers every pair. Unbound pairs are untouched and stay optimistic.

Stage Utility only ever **reads** the variable. The state has to come from the
buttons that did the work, or it is the same optimism one system further along.

A pair reads **unknown** when the variable holds something that is neither value,
when Companion does not have a variable by that name, or when Companion cannot be
reached. The rule's row in Settings → Automation shows an amber `unknown` pill
with the reason, `/api/cues/states` carries it as `reason`, and the log says so
once per change:

```
[cues] state of projectors_state (projectors) unreadable: no such custom variable in Companion
```

In Home Assistant an unknown pair reads *off*, because a template switch has no
third state — the reason is on the sensor's attribute and on the rule's row. It
stays **pressable**: the generated switch carries no `availability_template`, on
purpose, because an unavailable entity cannot be commanded and an unreachable
Companion would then also stop you turning the device on. Pressing a cue never
depends on the state variable.

If the whole read fails rather than one pair — the server could not answer at all
— Settings → Automation says so in one line above the rules list and shows no
pills, rather than leaving them out silently.

Nothing polls Companion in the background: the variables are read when
`/api/cues/states` is called and the answer is served for five seconds, so an
install nobody polls costs nothing.

## What the module exposes

**Actions** — PCO Live next/previous, refresh lineup, jump to next plan, set plan,
set service type, set plan mode, route a view to an output, blackout an output,
refresh displays, apply a preset, show/hide the QR code.

**Feedbacks** — countdown overtime, mic battery low, mic offline, ProPresenter
disconnected, plan in manual mode, output showing a given view, output blacked
out, occupancy over a threshold, captions idle, and a people-count text feedback
that writes the count onto a button.

**Variables** — plan and series title, service type, plan mode, ProPresenter
current/next item and slide position, PCO countdown label and seconds, mics
online and total, lowest battery and its channel, last caption text and speaker,
people attendance and occupancy (with per-zone variables), last sync time. Plus
one pair per automation signal — see below.

## Signals

An automation rule can publish a named value that a **Companion Trigger** acts on.
Stage Utility never presses a button and never contacts the device: it says what is
true, and Companion decides what to do. That keeps device actions — a Dante
crosspoint, say — inside the module that owns them.

Each signal becomes two variables:

| | |
|---|---|
| `$(stage:signal_<name>)` | the published value |
| `$(stage:signal_<name>_error)` | why the last evaluation failed; blank when healthy |

with feedbacks **Automation signal equals** and **Automation signal failed to
resolve**. `stage` is whatever you named the connection in Companion.

**Use letters, digits and underscores in a signal name.** The name becomes part of
a Companion variable id, and anything else may not resolve.

### Worked example: routing talkback

Production marks the talkback vocalist in Planning Center by adding a marker to
their note for that event, alongside the slot number they already use: `4 TB`.

In Stage Utility, under **Settings -> Automation**:

```
When:  Before a rehearsal or service      60 minutes, rehearsal + service
Then:  Set a Companion signal from the roster
         Signal name:      dante_tb
         Marker in notes:  TB
         Only this position: Vocals
         Send for each slot:  1 -> Vox 1
                              2 -> Vox 2
                              4 -> 31.Vox 4
```

In Companion:

```
Trigger
  When:  variable $(stage:signal_dante_tb) changes
  Then:  audinate-dantecontroller: Make Crosspoint
           Source Channel Name:  $(stage:signal_dante_tb)
           Destination Channel:  Lead TB
```

One trigger covers every slot, because the Dante module accepts variables in
every field. Adding a fifth slot is one row in the rule and nothing in Companion.

### What it does on failure

**Nothing, and it holds the previous value.** If nobody is marked, or two people
are, or the matched slot has no row in the table, the rule refuses and records why.
The last good route stays in place — an unrelated scheduling mistake must not take
talkback off mid-service.

Every outcome is in the automation Activity log, and the failure also lights the
**signal failed to resolve** feedback, so a button on the wall can go red. That is
the only way anyone learns about it in the moment.

### Two things to know

**The value you type is sent verbatim, and nothing validates it.** Dante channel
names may carry numeric prefixes (`31.Vox 4`) or be renamed at will, so the table
takes exactly what you see in Dante Controller. A typo produces a perfectly valid
signal that fails silently at the crosspoint — **test each row once after setting
it up.**

**A restart re-asserts the routing.** Variables are re-sent when the module
reconnects, so Companion re-runs the trigger. That is deliberate and self-healing,
but it does mean a crosspoint someone changed by hand will be put back.

## Network cost

**The module is event-driven, not polling.** It holds one SSE connection to
`/api/events` and reacts to pushes. A local one-second timer ticks the countdown
and re-evaluates the two time-relative feedbacks — that runs in the module's own
memory and puts nothing on the network.

It listens to seven channels: `server:hello`, `stage:state-changed`, `pco:live`,
`propresenter:status`, `prodcom:transcript`, `wireless:connections-changed`,
`people:count`.

REST is used for two things: writes (every action is a POST), and a hydrate on
connect that fetches nine endpoints in one burst — state, views, outputs, service
types, presets, wireless channels, PCO live, ProPresenter status and people
count.

**Poll fallback is off by default** (`0` seconds) and should stay that way unless
an SSE connection cannot be kept open. When enabled it re-runs that nine-endpoint
hydrate on every tick, so a five-second fallback is 108 requests a minute, most
of them for configuration that rarely changes.

The module reports those channels to the server. It sends a `cid` on the event
stream and posts its channel list to `POST /api/events/subscribe` when the stream
opens, so the fan-out skips everything else — notably the 4 Hz `spl:metrics`
stream, which the module has no use for. See
[network traffic](../ops/network-traffic.md) for how the filter works.
