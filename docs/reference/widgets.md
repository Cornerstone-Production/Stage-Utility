# Widget reference

Every widget the app can draw, what it shows, and where that number comes from.

Widgets are one registry used by every surface. The same **Clock** is a Home tile,
a stage-display readout and a console button — so anything here can go anywhere,
and a widget added to the app appears in all of them at once. Where a widget looks
different on Home than on a wall, it says so below.

- **Add one to a screen**: Screens → a view → **Edit** → **Add widget**.
- **Add one to Home**: the pencil in the Home header → **Add widget**.
- **Change one**: click it in the editor and use the inspector, or **right-click a
  Home tile** for its size, when it shows, and the few settings it supports.

A widget whose integration is not set up draws a dash rather than disappearing, so
a screen does not silently lose a tile when a device goes offline. The palette can
hide those: **Hide widgets whose integration is not set up**.

See also [Layout editor](layout-editor.md) for placement, sizing and styling, and
[Integrations](../integrations/README.md) for setting up the sources below.

---

## Text & time

| Widget | What it shows | Source |
|---|---|---|
| **Text** | Words you type, unchanged | You |
| **Clock** | The wall clock | The server's clock, in the app time zone |
| **PCO countdown** | Time until the service starts | Planning Center plan time |

**Clock** follows the app-wide 12/24-hour setting unless you set one on the widget
itself — a clock deliberately put on a wall in 24-hour does not flip when someone
changes their preference in the app. **Seconds** and **AM/PM** are separate
switches.

## PCO / service

| Widget | What it shows | Source |
|---|---|---|
| **Current item** | What the plan is on right now | Planning Center Live |
| **Next item** | What comes after it | Planning Center Live |
| **PCO Prev/Next** | Buttons that move the service on | Planning Center Live (writes) |
| **Service timer** | The running item's clock, and what is next | Planning Center Live |
| **Service pacing** | How far ahead or behind the whole plan the service is, or when it is projected to end | Recorded service timeline · Planning Center Live |
| **Next service** | The next plan, its series and when it starts | Planning Center |
| **Readiness** | What still needs doing before the next service, including the plan's own checklist ([plan notes](../integrations/planning-center.md#plan-notes-as-a-checklist)) | Planning Center + integration states |
| **Recent services** | Attendance, length and start time, recently averaged | Recorded history |
| **Plan file** | A page from a file attached to the plan | Planning Center attachments |
| **Embedded view** | Another view, drawn inside this one | This app |
| **Embedded screen** | What another screen is showing, following its routing | This app |
| **Service order (legacy)** | The plan as a running list with the live item marked | Planning Center |

**Recent services** draws the same attendance trend the History tab does.
Right-click it for **SPL trend line** — the service level for each date, behind the
attendance curve on its own dB scale — and **Metric**, which picks the Smaart metric
it plots. See [Attendance and history](../features/attendance-and-history.md).

**Service pacing** carries slippage forward from earlier items and keeps growing
while the current item runs long, so it answers "are we going to finish on time",
not "was that item long". It needs a recorded service timeline; without one it
shows nothing.

Turn on **Projected end time** and the same widget leads with the wall-clock time
the plan runs out instead of the drift figure. The drift moves under it when
**Show ahead/behind label** is on. The projection needs a live item with a planned
length, so it works with no recording running — but where it cannot answer it
shows a dash rather than a time: no service live, the service already past its
SERVICE END marker, or a plan whose lengths are not filled in. Items Planning
Center marks as post-service are left out. The time renders in the app's time zone
and 12/24-hour setting ([Settings → Advanced](../ops/install-and-config.md#time-zone)),
so a screen driven from a UTC server still reads the venue's clock.

**Embedded view** and **Embedded screen** can be expanded: on an operator
surface each tile carries a control in its bottom-right corner that grows it to
fill the window, and Escape or the panel's close button brings it back. Nothing
navigates, so there is no page to return from. A screen showing the same layout
gets no such control — an overlay opened by a passer-by would stay open until
somebody walked over to it.

A tile whose view holds embeds of its own carries **one** control, the outer
one: what is drawn inside it is that tile's content, not a tile in its own
right. Expand it and the tiles inside the panel get their own controls back, so
a multiview inside a multiview still drills down one level at a time; Escape
closes one level per press.

**Service order** is superseded by ScriptView — see
[ScriptView and Baptisms](../features/scriptview-and-baptisms.md). It is kept so
existing screens do not break.

**Embedded view** offers every view kind and draws every one of them, **Calendar**
included. Dashboard, Stage and SPL Rundown are configured per display rather than
per view, so an Embedded view pointed at one says so and Embedded screen is the
way to bring it into a tile — see
[Multiviews](layout-editor.md#multiviews).

A **Calendar** view draws the current month as six weeks, marks today, and
highlights the one timed event running right now. A day that will not fit shows
the first few events and then a `+N more` count. On a console — anywhere controls
are live — the header carries chevrons to page up to three years either way, and
a Today button back. A wall display has no chevrons and always shows the current
month; a console that was paged away returns to it after ten minutes. Which calendars and tags it
draws are set on the view, not globally, so two screens can show two departments
— see [Planning Center Calendar](../integrations/planning-center.md#calendar).
There is no booking-versus-event setting, because Planning Center does not model
the difference. Today and the running event are decided on the server's clock, in
the app time zone, rather than on the screen's own clock — so a display whose
clock has drifted still marks the right day.

## Status

| Widget | What it shows | Source |
|---|---|---|
| **Record status** | Red while ANY recorder is rolling | OBS + REAPER together |
| **Streaming status** | Whether anything is going out, and for how long | Resi + YouTube + OBS together |
| **Integration status** | Whether one integration is connected | That integration |
| **Screens online** | How many displays are connected, of how many | Live display presence |
| **Recording** *(Home)* | Is anything rolling — every recorder, or one you pick | OBS + REAPER |
| **Streaming** *(Home)* | Live or off air, across every platform or one you pick | Resi + YouTube + OBS |
| **Live scores** | Live score for a team you follow | ESPN public scoreboard |
| **Scores** *(Home)* | Followed teams' scores, on your own page | ESPN public scoreboard |

**Streaming status** can be pinned to one platform, or left on **any**, where it
answers for whichever is live.

**Live scores** shows one game: a team you follow, or **any followed team**, which
picks whichever of them is playing and prefers the one that scored most recently.
Nobody is standing at a wall display to choose, so that is the default. **Show
sport detail** draws the bases and count, the down and distance, or the game
clock; turning it off leaves the score and the status line. The teams themselves
are chosen in Settings, Integrations, Live scores — see
[Live scores](../integrations/scores.md).

The Home card is a quieter reading of the same thing: a chip in the team's colour,
the name, the score, and the trailing side dimmed. It shows one matchup on a
Medium tile and up to three as you make the tile taller. It stays on the page
during a service by default — Sunday afternoon football overlaps the second
service in most churches, which is the day the card exists for — and its own
settings can hide it while a plan item is live.

### The four "is it happening" widgets behave alike

**Record status**, **OBS status**, **REAPER status** and **Streaming status** share
one composition — the source as a caption, the state as a word, and a ticking
number underneath — and all four **fill the whole widget while active**: red for a
recorder, green for a stream. They are usually side by side on the same wall, and
a widget answering the same kind of question in a different shape reads as a
different app.

Per widget you can turn that off (**Fill green when live** / **Fill when
recording**, which colours just the word instead), hide the number, or make it a
tally light with **Hide when idle** — nothing drawn at all until something is
going out.

The Home **Streaming** tile is one object in two presentations. On Home it is a
card in a row of cards; put one on a screen and it wears the composition above,
beside OBS status and REAPER status. So all of its settings are offered on Home,
and two of them describe what the tile does on a screen: **Elapsed time** applies
on both surfaces, while **Fill the card when live** and **Hide when idle** shape
the screen presentation, which is the only one that fills or hides.

Right-click a Home tile to choose what it answers for: **Platform** on
**Streaming** (any, Resi, YouTube) and **Recorder** on **Recording** (every
recorder, OBS, REAPER). Both also offer **Elapsed time**.

> Four Home cards are marked *replaced* below — **OBS recording**, **REAPER
> recording**, **Resi status** and **YouTube status**. Each was the general card
> with its source fixed, so the choice moved onto the card itself and the four left
> the palette. Cards already on a page keep working and keep drawing exactly what
> they drew; open the layout inspector on one to swap it for the card that
> replaced it.

## OBS

| Widget | What it shows | Source |
|---|---|---|
| **OBS status** | Red while OBS is recording, streaming or running a virtual camera | obs-websocket |
| **OBS recording** *(Home, replaced)* | Rolling or stopped, with the elapsed time | obs-websocket |

**OBS status** picks which output it watches — recording, streaming or virtual
camera — and can show the record timecode underneath. See
[OBS](../integrations/obs.md).

## REAPER

| Widget | What it shows | Source |
|---|---|---|
| **REAPER status** | Red while REAPER is recording | REAPER web interface |
| **REAPER recording** *(Home, replaced)* | Rolling or stopped, with the elapsed time | REAPER web interface |

**Show position** puts REAPER's transport position under the word, trimmed to
whole seconds. See [REAPER](../integrations/reaper.md).

## Resi

| Widget | What it shows | Source |
|---|---|---|
| **Resi status** *(Home, replaced)* | Live or off air, with the elapsed time | Resi encoder status |

Set the Home **Streaming** card's **Platform** to Resi for the same reading on your
own page. Resi does not report when a broadcast started, so the elapsed time runs from the
moment the app watched the stream go live. A stream already running the first time
it looked shows **Live** with no number — see [Resi](../integrations/resi.md).

## YouTube

| Widget | What it shows | Source |
|---|---|---|
| **YouTube status** *(Home, replaced)* | Live or off air, with the elapsed time | YouTube Data API |

Set the Home **Streaming** card's **Platform** to YouTube for the same reading on
your own page. YouTube reports a real broadcast start, so its elapsed time is exact. See
[YouTube](../integrations/youtube.md).

## ProVideoPlayer

| Widget | What it shows | Source |
|---|---|---|
| **ProVideoPlayer layers** | What ProVideoPlayer has on each layer, and how long is left | PVP Network API |
| **ProVideoPlayer** *(Home)* | Every layer holding something, and how long is left | PVP Network API |
| **ProVideoPlayer now** | What is on screen right now, and how long is left | PVP Network API |
| **On screen now** *(Home)* | The one thing ProVideoPlayer has up, and how long is left | PVP Network API |

There is no preview image on any of them: ProVideoPlayer's network API offers no
thumbnail or frame of any kind, so these report names, states and times only.

### The layer list

One row per layer: the layer's name on the left, then the file it is holding and
how much of it is left. A layer with nothing on it reads **empty**.

The word after the time says what is unusual — **still** for a graphic, which has
no duration to count and so shows no time at all; **paused** for a clip that has
stopped where it was; **hidden** or **muted** for live content nobody can see or
hear; and a percentage for a layer that has been faded.

**Show** chooses between every layer, only the layers holding something (the
default), and one layer by name. **Progress bar** adds a hairline rule under each
rolling clip; it is off by default, because the time remaining is always shown
and four rules stacked in one tile is a lot of chrome for a glance.

A layer list longer than its widget is clipped — a screen cannot scroll — so the
widget says **+N more** in the corner rather than dropping the tail silently. The
Home card shows up to three layers and does the same.

### ProVideoPlayer now

The same data as one reading rather than a list: the file that is up, how long is
left, and a state word — playing, paused, still or empty — beside the caption.
**Layer** picks which layer it reads; left empty it follows whichever layer has
something on it. A layer with nothing on it says so rather than counting down to
nothing.

**Progress bar** draws a hairline rule under the time. It advances smoothly
rather than a step a second, and snaps instead of sliding whenever the change is
not a tick — a cue change, a scrub, or a display waking up. A paused clip holds
its bar where it stopped.

**Next cue** names the entry after the current one in its playlist. Read the
caveat before you rely on it: **that is the next playlist entry, which is what
plays next only while the playlist keeps auto-advancing.** Fire a cue by hand and
this line is wrong until the next poll. It is the quietest line on the widget for
that reason, it is never drawn without a current cue to anchor it, and it can be
switched off.

The **last cue** a layer played is deliberately not shown on any of these. PVP
reports it and it never clears, so four idle layers were observed all naming the
same cue while showing nothing — and it disagrees with the file that is actually
up even on a layer that is playing. See
[ProVideoPlayer](../integrations/provideoplayer.md).

## ProPresenter

| Widget | What it shows | Source |
|---|---|---|
| **Current slide** | The words on the slide showing now | ProPresenter |
| **Next slide** | The words on the slide coming next | ProPresenter |
| **Slide notes** | Speaker notes on the current slide | ProPresenter |
| **Slide image** | A picture of the slide showing now | ProPresenter thumbnails |
| **Slide progress** | How far through the presentation | ProPresenter |
| **Section chip** | The part of the service running now, as a label | ProPresenter |
| **ProPresenter timer** | One ProPresenter timer, by name | ProPresenter |

**Slide progress** reads as a fraction, a count remaining, a percentage or a bar.
**ProPresenter timer** finds its timer by name, so renaming it in ProPresenter
breaks the link — and it can colour itself as the timer runs down. With more than
one ProPresenter connected, both pick which instance they follow. See
[ProPresenter](../integrations/propresenter.md).

## Mics & RF

| Widget | What it shows | Source |
|---|---|---|
| **Mic slots** | Who is on which mic, as a grid of cards | Planning Center team + wireless gear |
| **Wireless summary** | How many packs are online, and their batteries | Every wireless connection |
| **Mic channel** | RF, battery, runtime and frequency for one pack | One wireless channel |
| **Charger battery** | Battery levels in the charger bays | Shure SBC chargers |

**Wireless summary** leads with the online count and qualifies it underneath with
the lowest battery in the fleet, and — if you turn it on — the **shortest runtime
remaining**. Both are minimums: the pack that runs out first is the one that
decides whether somebody has to move mid-service.

**Mic channel** shows battery percentage as its headline figure with RF and
frequency underneath. Turn **Battery %** off and **Time remaining** on to make the
runtime the headline instead — the figure Wireless Workbench leads with, and the
one that answers "will it last the service". A percentage cannot: the same 60% is
three hours on one pack and forty minutes on another.

Runtime comes from the receiver, not from us, so it is only shown where the gear
computes one — Shure Axient Digital and ULX-D report it, and a dash means this
receiver does not.

Neither figure includes charger bays, and **Mic channel** does not offer them in
its channel picker either: a bay has no RF and no frequency, so a widget bound to
one could only ever draw a dash. **Charger battery** is the widget for bays. IEM
packs are offered, since those do have RF and a battery.

See [Wireless Gear](../integrations/wireless.md) and [Mic slots](../slots.md).

## Audio (SPL)

| Widget | What it shows | Source |
|---|---|---|
| **SPL meter** | The live sound level | Smaart |
| **Sound level** *(Home)* | The loudest meter right now, and which one | Smaart |

**SPL meter** picks its meter and which metric to read, and can colour itself past
thresholds you set. See [Smaart](../integrations/smaart.md).

**Sound level** reads whichever meter is loudest. To watch one instead, right-click
the tile and pick it under **Meter**. A pinned meter that stops reporting says so
rather than falling back to another one, so the number on the tile is always the
channel it names.

## People

| Widget | What it shows | Source |
|---|---|---|
| **People counter** | How many people are in the room | SenSource Vea |
| **People summary** | Several attendance numbers side by side | SenSource Vea |
| **People graph** | How the room has filled over time | SenSource Vea |

**People counter** reads either attendance (everyone who came in today) or
occupancy (how many are in the room now), for the building or one zone. Peak, min
and average are building-only — the zone endpoint does not report them. See
[SenSource](../integrations/sensource.md).

## Transcription

| Widget | What it shows | Source |
|---|---|---|
| **Transcription** | Live captions of what is being said | The transcription service |

## Baptisms

| Widget | What it shows | Source |
|---|---|---|
| **Baptism timer** | The running baptism clock, or the session's totals | The baptism recorder |

See [ScriptView and Baptisms](../features/scriptview-and-baptisms.md).

## Control

These do something when pressed, so they only act on a surface that accepts
input — a console, or an operator's browser. On a wall display they draw and do
nothing.

| Widget | What it does | Target |
|---|---|---|
| **OSC button** | Sends an OSC message, and can reflect the device's state back | LAN gear over UDP |
| **RossTalk button** | Fires a RossTalk command | A Ross switcher |
| **Action button** | Runs one of the app's own actions | This app |
| **Notes** | A shared note anyone can type into | This app |
| **Checklist** | The plan's own checklist, ticked off here ([plan notes](../integrations/planning-center.md#plan-notes-as-a-checklist)) | Planning Center |

**Notes** and **Checklist** are shared, not per-screen: two people looking at them
see the same text. See [OSC](../integrations/osc.md) and
[RossTalk](../integrations/rosstalk.md).

## Layout

| Widget | What it is |
|---|---|
| **Container** | Groups other widgets so they move and scale together |
| **Shape** | A rectangle or circle, for dividing up a screen |
| **Image** | A picture from a file or a URL |
| **Logo** | Your church logo, from Branding |

**Logo** follows Branding rather than carrying its own file, so changing the logo
once changes every screen. See [Layout editor](layout-editor.md) for containers.

## Video

| Widget | What it shows | Source |
|---|---|---|
| **NDI video** | An NDI source from the network | NDI |

NDI needs the native client. The web build ignores this widget.

---

## Home tiles and wall widgets

A few widgets exist as a Home tile and as a wall widget — **Streaming** and
**Streaming status**, for instance. They are not duplicates: one is Home's tile
and one is the wall's, and each is drawn the way its surface wants. Each palette
offers only the one that belongs to it.

- **On Home** they are three-line cards in a grid of equal tiles, with a
  connection line at the bottom ("YouTube not connected") and values sized as
  though every tile had a caption and a sub-line — which is what makes a grid read
  as a grid.
- **Anywhere else** the same widget wears the wall composition: one large word,
  the number underneath, filled with colour while active.

Putting a Home tile on a wall gets you the wall version automatically. You do not
have to pick the right one.
