# Automation

Rules of the form **when something happens in Stage, do something to a device.**
Built under **Settings → Automation**.

> Rules fire with nobody present. Build every rule with the **Write a log message**
> action first, watch it through a real service, and only then attach the real
> action. Simulate mode is on by default for the same reason.

## A rule

| Part | |
|---|---|
| **When** | one trigger |
| **If** | zero or more conditions, all of which must hold |
| **Then** | one action |
| **Cooldown** | seconds before this rule may fire again (default 30) |
| **Once per service** | fire at most once per service occurrence |

Triggers fire on **change**, not on state. Stage's channels carry snapshots — the
live plan re-broadcasts constantly, the people counter reports the same number
every poll — so a trigger compares the previous snapshot with the new one.
*People count rises above 50* fires on the poll where it crossed, not on every
poll after.

## Needs setup

A trigger, condition or action can declare a param **required** — a RossTalk
command needs a target, an SPL trigger needs a meter key. The editor checks
every param against the current build's registry the moment you press **Save**,
marking each bad field and putting the count in the footer.

Saving with a problem still saves — turned off, with a note that it runs once the
field is fixed. It is never refused outright, so a rule half set up is never lost
because the dialog would not let go of it. Fix the field and save again and the
footer offers to turn it back on; saving does.

The rules list marks a rule with a problem **Needs setup: N fields**, naming
them, and its switch will not turn it on — turning ON a rule that still has a
problem is the one thing this refuses, both in the editor and from the list,
because that is the one action asking the rule to actually run.

**A rule already enabled with a problem — from before this build, or a restored
config — keeps running exactly as it did.** Loading it, restoring it, or a
background pass (the Companion reconcile, learning a state source) touching an
unrelated field never turns it off. The list still shows the badge; the switch
still refuses to re-enable it if you turn it off yourself. It is enforced the
next time *you* save or enable it, not the moment this build starts.

The layout editor's action-button object follows the same check, live as you
edit — there is no Save step there. A button needing setup is marked in the
editor's canvas only, never on a live display; pressing it on a display or a
console keeps refusing exactly as it always has (`action-invoke.ts`) if nothing
is configured.

An **optional** field is never a problem when it is empty. A field naming a
runtime list — a RossTalk target, a ProPresenter macro — is never a problem
just because that list came back short or without the stored value; the field
shows an amber note instead and saves as it is, because the machine it names may
simply be off right now.

## Triggers

| | Fires when |
|---|---|
| Service goes live | the plan moves from pre-service into the rundown |
| Service ends | the plan finishes |
| Plan reaches an item | the live item's title starts matching your text |
| Plan item is due | an item's scheduled moment passes — see [Firing an item on time](#firing-an-item-on-time) |
| People count rises above | attendance or occupancy crosses a threshold upward |
| People count falls below | crosses it downward |
| OBS starts recording | OBS begins recording |
| OBS stops recording | it stops. A recorder going offline does not count — that is unknown, not stopped |
| REAPER starts / stops recording | REAPER's own transport, read from its web interface. Same rule about offline |
| *X* connects / disconnects | any integration's link comes up or drops. One pair per integration, named for it — "OBS connects", "Smaart disconnects" |
| Resi goes live / stops streaming | a watched Resi encoder starts or stops. Unreachable does not count |
| YouTube goes live / stops streaming | a broadcast on your channel reaches `live`, or leaves it |
| OBS starts / stops streaming | the stream output starts or stops |
| OBS starts / stops the virtual camera | the virtual camera output starts or stops |
| An OSC message arrives | a value at an OSC address changes to equal, or crosses, what you name — see [Inbound OSC](#inbound-osc) |
| A phrase is said on ProdCom | a **new** transcript line contains your text, optionally on one channel only. It reads the line as displays receive it, so a phrase that is also a ProdCom keyword marked sensitive will not match while [redaction](integrations/prodcom.md#sensitive-keywords) is on |
| Baptism timer starts | the timer leaves idle |
| Baptism moves to another phase | testimony to baptism, or either back to idle |
| Baptism timer finishes | it returns to idle |
| A display connects / disconnects | a display arrives or goes, or any when left blank. Pick it from the list of screens — the field stores the display's id, not the name on its card |
| Every display has disconnected | the last display drops off — fires once, not repeatedly while none are connected |
| SPL rises above / falls below | a Smaart meter crosses a level. Name the meter `device::channel`; leave the metric blank for the usual one |
| A pack's battery falls below | a wireless pack crosses a percentage, for one mic or any |
| A pack's RF falls below | the same for RF bars (0-5) |
| The service runs over plan by | cumulative overrun across finished items passes your margin — checked as each item ends |
| An update becomes available | a new release appears, not repeatedly while one waits |
| Before a rehearsal or service | a set number of minutes before any rehearsal or service time on the plan |
| A cue starts on a ProVideoPlayer layer | a layer starts showing different media. The same clip looping round is not a new cue |
| A ProVideoPlayer layer clears | a layer that was showing something now holds nothing. PVP going unreachable does not count |
| A ProVideoPlayer clip stops rolling | a clip has stopped, ended or been paused |
| A ProVideoPlayer layer is hidden / unhidden | the layer's hidden flag flips |
| A ProVideoPlayer layer is muted / unmuted | the layer's mute flag flips |
| Called by name | something called `POST /api/cues/<name>` with a token, or a cue button on one of this app's own consoles. This one NEVER fires by itself — see [Cues](#cues) |

Every trigger fires on an **edge** — the moment something changes — never on a
state that merely persists. The channels carry state snapshots, re-sent
constantly, so a trigger that fired on a level would fire dozens of times per
service.

Nothing treats a device going offline as a value. A missing reading is unknown,
so a pack dropping off the network is not a low battery, an unreachable OBS is
not "stopped streaming", and an integration vanishing from a payload is not a
disconnect.

Each recorder has its **own** pair of triggers, named for its machine. There is
no "either recorder" trigger: the two publish separate state, and OBS starting
while REAPER is already rolling is not the moment recording began. Pick the
machine you mean, or build two rules. To ask about the other recorder while a
rule fires on this one, add the **OBS is recording** or **REAPER is recording**
condition.

ProVideoPlayer layers, playlists and cues are matched **by name, not by id** — an
id is opaque and changes when a workspace is rebuilt from a template. **Renaming
the layer in ProVideoPlayer stops the rule**, silently. Nothing else will tell
you. A name that is only digits cannot be used at all: PVP reads an all-digits
value as a position rather than a name.

### Inbound OSC

**An OSC message arrives** makes the app drivable by anything on the network that
can send a UDP packet. Point the device's OSC reply at this server on the
feedback port (default `9000`, Settings → Integrations → OSC) and the values
land where a rule can read them. REAPER's own OSC control surface transmits
transport state, so it is the easy first sender.

| Field | |
|---|---|
| **OSC address** | exactly as the device sends it, starting with a slash |
| **From target** | blank for any sender; a configured target to accept it only from that one |
| **Argument** | `0` is the first. Use `1` for the value in a channel-and-value reply |
| **Match** | equals, crossed above, crossed below |
| **Value** | the value for equals, the threshold for a crossing. `1` matches a float `1.0`; `true`/`false` match an OSC `T`/`F`; strings compare case-insensitively |

Like every trigger here it fires on a **change**, not on a state. Two
consequences worth knowing before you build a rule:

- A **bang** — a message with no arguments — is stored as `true` and stays
  `true`, so it is a change **at most** once, and **not at all** if it is the
  first thing to arrive on the channel after a restart: the first snapshot after
  the app starts is a baseline and is never read as an event. Nothing is
  remembered across a restart, so for a sender that has the feedback port to
  itself that is every time. **Use an address that carries a value.**
- For the same reason the first message on any address after a restart is a
  baseline, not an event. A rule on `/record` will not fire on the `1` that was
  already there when the app came back up — it fires on the next change.
- Feedback is broadcast at most every 200 ms. Two changes inside that window
  arrive as one snapshot, so `/x 1` immediately followed by `/x 0` is a single
  change to `0` and the `1` never happened as far as a rule is concerned.

Scoping to a target needs the app to know which target sent the packet, which it
decides from the source address — see [OSC](integrations/osc.md). Leave the
field blank if in doubt.

## Conditions

**A service is live**, **no service is live**, **service type is**, **day of week**, **time is between**,
**baptism phase is**, **OBS is recording**, **REAPER is recording**, **Resi is
streaming**, **YouTube is streaming**, **a ProVideoPlayer layer has content**,
**is playing a video**, **is hidden** or **is muted**, **ProVideoPlayer has
something on screen**, and *X* **is connected** for each integration. All
selected conditions must hold.

They keep triggers simple: "when occupancy rises above 50" would also fire for a
Tuesday meeting, so you add "and a service is live".

**Service type is** picks from the service types on your Planning Center account,
so a rule can be built for Sunday morning and left alone on a Wednesday.

Conditions cannot be negated — the list is a plain AND — which is why **a service
is live** and **no service is live** are two separate entries rather than one with
a switch. They are not opposites. **No service is live** fails closed: it holds only
when Planning Center says nothing is on, so it refuses while a service is running or
about to start (within the hour before it), and when Planning Center is configured
and cannot be read at all. With no Planning Center configured there is nothing to
check and it holds. It is what a cue carries so it cannot be run during setup or
mid-service.

Conditions only **hold** or don't — unlike a trigger they never fire on their own.
"OBS is recording" qualifies a rule that some other trigger started; it is not a
way to act the moment recording begins. Use the matching trigger for that.

A time window may cross midnight, and day-of-week and time-of-day both read the
app's time zone (Settings → Advanced), not the server's clock. An unconfigured
condition holds rather than blocking, so a half-built rule does not silently never
fire — with one deliberate exception: a ProVideoPlayer layer condition with no
layer named does **not** hold, because "some layer, I did not say which" would
qualify a rule against a layer nobody chose. That question is **ProVideoPlayer has
something on screen**, which exists separately. None of them hold while PVP has
never connected, either: unreachable is unknown, not empty. "Baptism phase is" does not hold at all until the timer has run — including
for "idle", because before it runs we do not know that it is idle.

## Actions

| | |
|---|---|
| Write a log message | nothing but the log entry — the testing tool |
| Send a RossTalk command | a Carbonite or Ultrix command at a target |
| Send an OSC message | to an OSC target |
| Advance PCO Live one item | steps the live plan forward once |
| REAPER transport | Record, Stop or Play, through the same web interface the [REAPER](integrations/reaper.md) integration polls. Record does nothing when REAPER is already recording, and refuses outright when the transport cannot be read — 1013 is a toggle, so pressing it on an unknown is how "start recording" ends one |
| OBS recording | Start or stop OBS's recording over the same obs-websocket connection the [OBS](integrations/obs.md) integration holds — no Companion button in between. Start does nothing when OBS is already recording, Stop does nothing when it is not |
| OBS streaming | Start or stop OBS's stream, on the same connection and with the same start/stop idempotency |
| OBS virtual camera | Start or stop the virtual camera a video call picks up as a webcam, on the same connection and with the same start/stop idempotency |
| Trigger a ProPresenter macro | runs one of your own ProPresenter macros, on a chosen instance — see [Triggering a macro from a rule](integrations/propresenter.md#triggering-a-macro-from-a-rule) |
| Refresh all displays | reloads every connected display |
| Set a Companion signal from the roster | publishes a value for a Companion Trigger to act on — see [Signals](integrations/companion.md#signals) |
| Press a Companion button | presses one button at a page/row/column. Reports "dispatched", never "on" — see [Pressing a button](integrations/companion.md#pressing-a-button) |
| Fire a ProVideoPlayer cue | a cue from a playlist. ProVideoPlayer always plays it on the cue's own layer |
| Clear a ProVideoPlayer layer | takes whatever is on that layer off screen |
| Clear every ProVideoPlayer layer | blanks every screen PVP is driving |
| Hide / unhide a ProVideoPlayer layer | the layer's hidden flag |
| Mute / unmute a ProVideoPlayer layer | the layer's mute flag |
| Set a ProVideoPlayer layer's opacity | 0 is invisible, 100 is fully opaque |
| Start a baptism session | begins a session at person 1's testimony; does nothing while one is already running |
| Advance the baptism timer | the phase-aware primary press — see below |
| Step the baptism timer back | undoes the last press without losing the session |
| Pause or resume the baptism timer | toggles the running clock; says so when nothing is running to pause |
| Finish the baptism session | closes the in-progress person, freezes the session, and logs it |

> ProVideoPlayer answers every command with "OK" whether or not it acted on it, so
> every ProVideoPlayer action above reads PVP's state back to confirm what it did.
> A command that was accepted and ignored is recorded as a **failure**, not a
> success — which is the opposite of what the log would otherwise show.
>
> There is no action for firing a cue onto a layer you choose, because
> ProVideoPlayer does not offer one: its layer-addressed endpoint accepts the
> argument and ignores it, playing the cue on its own configured layer. Which
> layer a cue uses is set in ProVideoPlayer, not here. See
> [ProVideoPlayer](integrations/provideoplayer.md).

> **OBS recording**, **OBS streaming** and **OBS virtual camera** need nothing beyond the
> [OBS](integrations/obs.md) integration being set up and connected — they use
> its websocket, not a second one. A command sent while the output is already in
> that state is answered `already recording` / `already stopped` and nothing goes
> to OBS: obs-websocket rejects a redundant `StartRecord` with a request error,
> which would read as a failed cue over a recording that is running perfectly
> well. With OBS disconnected the action fails and says so; it never queues.

> **REAPER transport** needs REAPER's web interface switched on — the same
> prerequisite as the [REAPER](integrations/reaper.md) integration, and the same
> host and port. REAPER's Record is a TOGGLE: pressed while it is recording it
> stops the recording, so the action reads the transport first and sends nothing
> when REAPER is already rolling. Stop and Play go out unconditionally.

> **Trigger a ProPresenter macro** needs ProPresenter's Network API switched on
> — the same prerequisite as the [ProPresenter](integrations/propresenter.md)
> integration, and the same host and port. The macro runs on the instance you
> pick, and whatever the macro does in ProPresenter it does here; Stage Utility
> never inspects it.
>
> The macro is identified by its **name**, not by its internal id. Names mean
> the same thing on every machine and survive a re-import, where an id does
> not — so the same rule works in both auditoriums, and re-importing a
> ProPresenter library does not quietly break every rule. The cost is that
> renaming a macro in ProPresenter stops the rule finding it; the action then
> fails with `no macro called "SONG INTRO" on MA` rather than a bare 404.
>
> The macro dropdown lists what every configured instance reports, so an
> instance that could not be read simply contributes nothing — the rule editor
> still opens. When more than one instance is set up and all of them answered, a
> name only some of them have is marked, `DOORS (MA only)`; while any instance is
> unreachable the mark is dropped, because "only" is a claim about the machines
> that answered. A macro already chosen on a rule is always shown, marked, even
> while the machine that has it is off.
>
> A rule whose ProPresenter is **switched off** triggers nothing and says so —
> `MA is switched off` — rather than dialling the last address the card held.

> **Advance the baptism timer** is one action, not four. It does whatever the
> [baptism timer's](features/scriptview-and-baptisms.md) own operator panel
> would do right now — start a session, begin person 1 once a grouped session
> arms, close a testimony or a baptism, move to the next person — so a single
> [action button](reference/widgets.md#control) or Companion key runs the whole
> service and nobody has to know which press is legal in which phase.

## Cues

A **cue** is a rule triggered by **Called by name** rather than by anything
happening in the building. It runs only when something calls
`POST /api/cues/<name>` with a bearer token, so it is how a voice assistant, a
script or Home Assistant reaches Stage Utility. A page on this app's own origin
needs no token — that is how a cue button on a console fires, and such a call is
logged as `console`.

Getting cues into Home Assistant — and from there into Apple Home — is the
[Home Assistant integration](integrations/companion.md#the-integration): install
it from HACS, give it this server's address and a cue token, and every cue is a
switch or a button there. A generated
[YAML fragment](integrations/companion.md#the-generated-yaml) is the fallback
for an install that cannot run a custom integration.

**For setup and teardown, not for cues during a service.** Turning the projectors
on before a rehearsal, turning the foyer televisions off after. Every cue imported
from Companion carries the **no service is live** condition, and refuses with a
sentence — *"The Gospel Way is live"* — while a service is running or about to
start, and when Planning Center cannot be read.

A cue's editor has an **Allowed during a service** switch that is the same
condition in one control: off (the imported default) refuses the cue while a
service is live or about to start, on removes the condition and lets it fire
whenever it is called. The rules list marks every cue that is on with a
clearly visible **any time** badge, so the ones that can fire mid-service are
easy to spot in a long list. A pair's row carries one badge over both halves,
and reads **any time** if either half can fire — each half is evaluated against
its own conditions, so one unguarded half is a pair that can fire mid-service.
Its switch, in the pair's dialog, writes both halves at once.

The rules list is in two sections. **Home Assistant** holds every cue that has
an entity there — pairs as switches, single cues as buttons. **Everything else**
holds the cues whose **Home Assistant** switch is off and every rule with a
trigger other than Called by name. An ON/OFF pair is ONE row, named by the words
it is spoken as.

A row is a summary: the enable switch, the name, any former names, the
service-guard badge, whether Home Assistant has an entity for it, and the
one-line *when … then*. Pressing the row — anywhere but the enable switch —
opens the editor in a dialog over the list, so the list and the search field
stay where they are. **Test** and **Delete** are in its footer beside **Cancel**
and **Save**; Escape, the overlay and Cancel all discard the draft, and a save
the server refuses leaves the dialog open with the change still in it. Deleting
asks first, naming the cues that go.

Adds, edits and deletes are each logged on `/log` under `[automation]`, with the
rule's name and id, so a bulk delete leaves a record of exactly which rules went.

A pair opens ONE dialog. **This pair** holds the settings that belong to the
pair rather than to one direction of it — Home Assistant, Allowed during a
service, State variable, Room — and a **Turn on** / **Turn off** control below
it swaps the fields that differ: cue name, spoken as, former names, the button
it presses, cooldown, once per service, enabled. Saving writes both halves, and
the pair's own settings land on the `_on` rule. **Test** fires the half that is
selected and says which.

A cue's editor has a **Home Assistant** switch under Allowed during a service.
Off, the cue is voice-only: no entity is created for it, it is left out of the
generated YAML and the manifest, and it moves to Everything else.
`POST /api/cues/<name>` still fires it. For a pair the switch covers both halves
— one switch, hidden or shown together — and Home Assistant removes the entity
within a few seconds, breaking automations there that refer to it. See
[Keeping a cue out of Home Assistant](integrations/companion.md#keeping-a-cue-out-of-home-assistant).

The **Search rules** field is pinned to the top of the list and filters live by
rule name, cue name, spoken name, former names, a Companion button's label, and
the trigger and action's own names. A pair shows whenever either half matches.

| | |
|---|---|
| **Cue name** | `lower_snake_case`, unique across rules — and across every cue's former names. This is the URL |
| **Former names** | names this cue still answers to, kept when its Companion button was relabelled and the cue renamed to match. Up to five, oldest dropped first. Remove one and that URL stops resolving |
| **Spoken as** | what you say to the assistant. Becomes the friendly name in the generated Home Assistant config |
| **Room** | where the thing is. Recorded in the log; nothing routes on it |
| **Home Assistant** | on by default. Off keeps the cue out of Home Assistant and Apple Home entirely, leaving it callable by voice and by HTTP. A pair's two halves share one setting, stored on the `_on` half |
| **State variable** | in **This pair**, for an ON/OFF pair only, and required for a [toggle](integrations/companion.md#toggle-buttons) pair whose halves press one button. Saved on the `_on` rule. Either a Companion **custom variable** your own buttons set — `projectors_state`, or `custom:projectors_state` — or a **module variable** a connection publishes for itself, `<connection label>:<name>` as in `VCR-Overhead-Light:power_state`. The generated Home Assistant switch then reports what the device is doing rather than what it was asked to do, and a call asking for the state it is already in presses nothing. A button that drives a smart plug, television, projector or OBS has its module variable offered here already, marked `(inferred)`. Blank leaves the switch optimistic. See [Real state](integrations/companion.md#real-state) and [State from Stage Utility](#state-from-stage-utility) |
| **Learning** | shown in **This pair** for a pair with no binding whose connections have no verified module row: the app probes them for candidate variables and binds one by watching what moves when you press the pair on and off. **Learn again** forgets what it found and probes again. See [Learning a state source](integrations/companion.md#learning-a-state-source) |
| **Ask twice** | the first call is answered with a confirmation and does nothing; a second call within 30 seconds, carrying it, runs it. A confirmation is single use and lapses after 30 seconds — a replayed one is answered with a fresh confirmation, never a second press |
| **Once per service** | honoured on a call as well as on a trigger: a second call in the same service occurrence is refused `once-per-service` |

The rule's own conditions, cooldown and enable switch all apply to a call exactly
as they do to a trigger — a cue is a rule, not a second path through the engine.
Every call, allowed or refused, is in the Activity log with the calling token's
label.

**A bound cue only presses when it needs to.** When a cue is half of a pair with
a [State variable](integrations/companion.md#real-state), the variable is read
before the press. If it already says what the call is asking for, nothing is
pressed and the answer is `200 {ok: true, detail: "already on", state: "on",
skipped: true}` — mirrored for off. This is checked before the cue's cooldown,
so a repeated call is answered "already on" rather than refused `cooldown`.
Within eight seconds of a press the last press is what a repeat is compared
against rather than the variable, which lags it by however long Companion takes
to poll the device — the same state answers `already on (just pressed)`, the
opposite presses. See [The settle
window](integrations/companion.md#the-settle-window). The Activity log records it as its own
outcome, `skipped`, not as a suppression: nothing refused the call.

```
09:14:02  Projectors ON    —    skipped: already on, not pressed
```

A state that cannot be read — the variable missing, Companion unreachable, a
value matching neither — **presses**, and the answer carries `state: "unknown"`.
A read never stops a press, though an unreachable Companion delays one by up to
three seconds. Only a call is checked this way; a rule the engine
fires from a trigger of its own presses without reading anything.

A cue that presses a Companion button remembers which button, not just where it
was: if somebody moves it, the coordinates follow it and the rule's row says so;
if it is gone, the cue answers `button-missing` and presses nothing rather than
pressing whatever is now at those coordinates; if it is RELABELLED, the cue is
renamed to match and the old name keeps answering. See
[When a button moves](integrations/companion.md#when-a-button-moves) and
[When a button is renamed](integrations/companion.md#when-a-button-is-renamed).

Set the whole thing up under [Companion](integrations/companion.md#calling-a-cue-by-name):
the button picker, the ON/OFF and single-button import, the tokens and the Home
Assistant paste.

### Built-in cues

Some cues need no rule behind them. Stage Utility ships them, and they appear
wherever a cue appears — in the cue manifest, in Home Assistant, on a cue
button, at `POST /api/cues/<name>` — without anything being saved. They are not
on the Automation page, they are not in a config export, and they cannot be
edited or deleted.

Switches, listed while the integration is switched on in Settings:

| Cue | What it does | State |
|---|---|---|
| `obs_record_on` / `obs_record_off` | OBS recording | `app:obs.recording` |
| `obs_stream_on` / `obs_stream_off` | OBS stream | `app:obs.streaming` |
| `obs_virtual_cam_on` / `obs_virtual_cam_off` | OBS virtual camera | `app:obs.virtualCam` |
| `reaper_record_on` / `reaper_record_off` | REAPER recording | `app:reaper.recording` |

Two more per ProVideoPlayer layer, named from the layer — `Lower Thirds` becomes
`lower_thirds`:

| Cue | What it does | State |
|---|---|---|
| `pvp_<layer>_shown_on` / `_off` | shows and hides the layer | the layer is not hidden |
| `pvp_<layer>_muted_on` / `_off` | mutes and unmutes the layer | the layer is muted |

**Shown** is the operator's direction: the switch is on when the layer is on
screen.

Buttons, which are momentary:

| Cue | What it does | Listed while |
|---|---|---|
| `pvp_<layer>_clear` | takes everything off that layer | ProVideoPlayer is on |
| `pvp_clear_workspace` | blanks every PVP layer at once | ProVideoPlayer is on |
| `pco_advance` | steps Planning Center Live forward one item | Planning Center is connected |
| `display_refresh` | reloads every display | always |

Each switch reports what the gear is doing, from the same connection that drives
it, and each is idempotent — "start the recording" said twice while it is
recording answers `already on` and sends nothing. None of them involve
Companion, and none carry the **no service is live** condition: a panel button
has to work during a service.

**The names are reserved.** A rule that tries to take one, as its cue name or as
a former name, is refused with *"obs_record_on" is a built-in cue*. The
per-layer ProVideoPlayer names are the exception: they are made from your own
layer names, so reserving `pvp_lyrics_shown_on` would refuse a rule that was
legal until somebody renamed a layer. A rule holding one of those simply
suppresses that layer's built-in, exactly as below.

A rule saved before these existed and already holding one keeps working; the
built-in with that name is left out instead, and the server log says which and
why:

```
[cues] built-in obs_record not offered: rule "REC on" owns obs_record_on
```

That pair can be deleted whenever you like — the built-in appears in its place,
under the same name, so nothing in Home Assistant has to be repasted.

The set changes when an integration is switched on or off, when Planning Center
connects, and when ProVideoPlayer reports different layer names. The cue
manifest's version moves with it, so an integration re-reads. A ProVideoPlayer
that goes offline keeps its layers listed, reading unknown, rather than removing
every entity until it comes back.

### State from Stage Utility

A cue that does not press a Companion button has no Companion variable to read,
and does not need one — Stage Utility is already talking to the device. Those
bindings are written `app:<source>` and are offered in the **State variable**
select whenever the integration behind them is set up.

| Source | Reads |
|---|---|
| `app:reaper.recording` | `on` while REAPER is recording, `off` while it is connected and not, unknown while it is not connected |
| `app:obs.recording` | `on` while OBS is recording — a paused recording is still a recording — `off` while it is connected and not, unknown while it is not connected |
| `app:obs.streaming` | `on` while OBS is streaming, `off` while it is connected and not, unknown while it is not connected |
| `app:obs.virtualCam` | `on` while OBS's virtual camera is running, `off` while it is connected and not, unknown while it is not connected |
| `app:youtube.live` | `on` while YouTube is broadcasting, `off` while it is connected and not, unknown while it is not connected |
| `app:resi.live` | `on` while Resi is broadcasting, `off` while it is connected and not, unknown while it is not connected |
| `app:pvp.layer-hidden:<name>` | `on` while the ProVideoPlayer layer called `<name>` is hidden, `off` while it is shown, unknown while PVP is not connected |
| `app:pvp.layer-muted:<name>` | `on` while the ProVideoPlayer layer called `<name>` is muted, `off` while it is not, unknown while PVP is not connected |

The two ProVideoPlayer sources take a layer NAME, matched the same way the PVP
actions match it — trimmed, and case-insensitively. `<name>` is everything after
the second colon, so a layer called `Lower Thirds: Speaker` is written
`app:pvp.layer-hidden:Lower Thirds: Speaker`. Renaming the layer in PVP stops
the reading, exactly as it stops the action: the state then reads unknown with
`No PVP layer called "<name>"` rather than reporting the layer as shown. Two
layers of one name read unknown too — PVP allows the duplicate, and a switch
that silently picked one of them would report a layer nobody chose.

`app:youtube.live` and `app:resi.live` are read-only: there is no action here that
starts or stops a broadcast on either platform. Bind a pair to one when the cue
that goes on air is something else — an operator's own Companion button, or a cue
that starts the encoder feeding it — and the switch then reports what the
platform says rather than what the button asked for.

A pair is bound to one of these without anybody choosing it when its `_on` half
is one of the actions that starts what the source watches:

| ON half | Bound to |
|---|---|
| **REAPER transport** → Record | `app:reaper.recording` |
| **OBS recording** → Start recording | `app:obs.recording` |
| **OBS streaming** → Start streaming | `app:obs.streaming` |
| **OBS virtual camera** → Start virtual camera | `app:obs.virtualCam` |
| **Hide a ProVideoPlayer layer** | `app:pvp.layer-hidden:<the layer it names>` |
| **Mute a ProVideoPlayer layer** | `app:pvp.layer-muted:<the layer it names>` |

Unhide and Unmute imply nothing as an ON half: their "on" direction is the
opposite one, so a pair built that way is left unbound rather than bound to a
source it would report backwards.

It is the only answer there is, and the two values are fixed at `on` and `off`,
so the value rows are not offered. Setting **State variable** to anything else on
that pair overrides it.

Such a pair is a switch in Home Assistant like any other, reports a real state,
and is idempotent — "start the recording" said twice while it is recording
answers `already on` and sends nothing, which matters because REAPER's Record is
a toggle and because OBS rejects a redundant start outright.

None of them involve Companion: the cue drives the recorder directly and the
state comes off the same connection, so there is no button to build and no
module variable to wait for.

## Firing an item on time

A plan usually has an item nobody remembers to fire — doors, a pre-roll, a
countdown. Pair the **Plan item is due** trigger with the **Advance PCO Live one
item** action and it fires itself.

Pick the item by title from the dropdown, or type one. The match is a
case-insensitive substring, and it is matched by **title, not id** — ids are new
objects every week, so a title is the only thing that survives to next Sunday.
**Renaming the item in Planning Center stops the rule**, silently. Nothing else
will tell you.

**Relative to** chooses what the offset counts from:

- *The item's own time* — when that item is scheduled.
- *The service start* — the service time, ignoring where the item sits.

A negative offset fires early, positive late.

### How an item gets a time

Planning Center puts **no time on a plan item**. It publishes a length and a
position, and the clock you see beside each row is arithmetic. Stage does the same
arithmetic, so an item's time is one of two things:

- **Exact** — a **plan time** whose name matches the item's title. Add one in PCO
  (Plan → Times) called `Doors` and the item called `Doors` is pinned to a real
  clock that holds even when the service runs long.
- **Estimated** — otherwise, the service time plus the running total of item
  lengths, anchored on the `SERVICE START` header. This matches the plan editor,
  and it drifts exactly as the plan does: an item that runs four minutes long
  pushes everything after it four minutes late.

Estimated times are dependable **above** the service-start header — nothing has run
yet, so there is nothing to drift. That is the doors case. For anything mid-service,
add a plan time or anchor on the service start.

### What it will not do

**It never jumps.** PCO's API has no jump action — next and previous are all it
offers — so the rule takes exactly one step. It cannot skip ahead to an item, and
it will not step repeatedly to get there: that would fire every item in between,
live.

Because of that, set **Only if the next item is** on the action. If the plan is not
sitting where the rule expected, it does nothing and logs why. Leave it blank only
when you genuinely want an unconditional single step.

**It never takes control.** The action is permission-gated, not possession-gated:
the connected account has to be permitted to control Live for that service type,
and if it is not, PCO's own refusal appears in the Activity log. Stage will not
seize control from whoever is driving.

### Before you arm it

Run it in simulate mode for a full weekend and read the Activity log. Every
outcome is recorded, including skips and the reason for them.

## Safety

**Simulate mode** (on by default) — rules evaluate fully and the resolved action is
logged, but nothing reaches a device. Leave it on while you build.

**Per-rule enable and Test fire** — the enable switch is on the row; **Test** is in
the editor's footer. Test runs the action immediately, ignoring the trigger, so you
can prove the action before arming the rule. It respects simulate.

**Disarm all** — stops every rule at once regardless of its own switch, and persists
across a restart. Simulate is for building; disarm is for stopping.

**Cooldown** — a value oscillating across a threshold produces real crossings each
time. The cooldown stops one flapping sensor firing repeatedly.

**Restart seeding** — the first snapshot on each channel after startup establishes a
baseline and is never evaluated, so an update or crash mid-service cannot read it as
a change and fire everything at once.

**A rule with a missing or invalid param** — see [Needs setup](#needs-setup)
above; a rule saved with a problem runs turned off rather than with a param the
action cannot use.

**A rule this build does not understand** — `automation-rules.json` travels: it is
exported, restored onto other machines and hand-edited. A rule naming a trigger,
condition or action this version does not have is refused and reported rather than
guessed at. An unknown **condition** fails closed and names itself in the activity
log, so the rule does not fire. An unknown **action** is logged as failed. An
unknown **trigger** has no channel, so the rule simply never fires. Nothing about a
rules file can stop the server, whatever is in it; anything it could not evaluate
appears on `/log` under `[automation]`.

The activity log records suppressions as well as fires, with the reason:

```
14:02:11  Roll opener      rosstalk.command "CC 1:05"   sent
14:02:11  Cool the room    —                            suppressed: cooldown (19s left)
14:02:40  Stream crosspt   rosstalk.command "XPT 3:7"   SIMULATED
```

RossTalk has its own simulate switch, independent of the engine's. A command
reaches the wire only when both are off — the engine's does not cover a manual send
from a layout button, and RossTalk's does not cover other actions. The log shows
which one suppressed a send.

## Your first rule against real gear

Off-air, in this order:

1. Build the rule with **Write a log message**. Arm it. Watch a real service.
2. Confirm the log shows it firing at the right moment, once.
3. Swap in the real action, leaving simulate on. Confirm the log shows the exact
   command it would send.
4. Turn simulate off, with something harmless as the action.
