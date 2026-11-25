# Q-SYS integration

Connects to a Q-SYS Core over QRC (JSON-RPC over TCP, default port 1710), reads
the design's components and controls, and writes the values of the controls on
its [allowlist](#allowlist-and-limits).

## How it works

- The service connects to the Core, logs on if a user is set, reads the design
  status and then every component and its controls (the catalog).
- A silent connection is kept alive with a `NoOp` after 30 seconds without a
  request; the Core drops a connection after 60 seconds of silence.
- If the connection drops, the service reconnects with exponential backoff, capped
  by the PCO-time-aware service window. A logon the Core refuses is retried the
  same way. The first failure in a run of them is logged; the retries are not.
- When the Core reports a new design (a different design code, as after a redeploy
  or a Core restart), the catalog is read again. A second change reported while
  that read runs is read after it.
- The integration never calls a method that changes the design. It writes control
  values only, and only to allowlisted controls.

The card's row shows the state: connected with the design name, reconnecting, or
the reason it could not connect. `/log` shows the decisions, tagged `[qsys]`; see
[Troubleshooting](#troubleshooting).

## Setup

### On the Core

1. **QRC** answers on TCP port **1710**. Nothing needs enabling for the connection
   itself.
2. **Script Access.** Set Script Access to **External** (or **All**) in Q-SYS
   Designer on every component whose controls this integration should reach, then
   deploy. If a component is missing from the catalog, check this first.
3. **Access Control.** If the Core has Access Control on, create a user for this
   app (a Core Manager Administrator user) and enter its name
   and password below. With Access Control off, leave both blank.

### In Stage

**Settings → Integrations → Q-SYS**:

| Field | Meaning |
|---|---|
| Core host | The Core's address. |
| Port | QRC port. Default 1710. |
| User, Password | Only if the Core requires a QRC logon. The password is stored encrypted on this machine and is never sent to a browser. |
| Volunteer meter rate | Meter updates per second for volunteer panels. Whole number, 1 to 30, default 10. |
| Staff meter rate | Meter updates per second for staff panels. Whole number, 1 to 30, default 20. |

A [volunteer panel](#panels) moves its meters at the volunteer rate, and a staff panel,
or a console with Q-SYS objects that is not a panel, at the staff rate.

Enable the integration and use **Test connection**. It connects, logs on, and
reports `Connected to <design name>` with the number of components it read, or
the reason it could not. Saving any field, the meter rates included, reconnects to
the Core. A stored rate outside 1 to 30 is read as the nearer bound, and one that
is not a number as its default.

### Trying it without a Core

Q-SYS Designer in **Emulate** answers QRC on the machine it runs on, port 1710.
Point **Core host** at that machine to try the integration with no Core. The
status reports `emulator` so it is not mistaken for a live Core.

## Allowlist and limits

Writes go through [`POST /api/qsys/write`](../reference/api.md#q-sys) and reach only
the controls on the allowlist. Nothing is on it by default. The list is edited on
[`/qsys/manage`](#the-q-sys-page), set over the API with `PUT /api/qsys/allowlist`, or
imported as an allowlist file. Every write is checked by the server.

| Field | Meaning |
|---|---|
| component, control | The control's address: the component's Code Name and the control's name. |
| label | A name for the control. Up to 120 characters on one line. |
| min, max | The value range a numeric write may reach, in the control's own units (dB for a gain). Both set, or both empty. |
| confirm | `none` or `hold`. With `hold`, every button that fires the control (a button, a preset, a switch's On or Off) writes only once held for a second; letting go early sends nothing. |

- A numeric control is writable only with a range on its entry. With `min` and
  `max` empty it is refused (`no-range`).
- A value outside the range is clamped to it, and the clamp is logged.
- Booleans (mute, switch) and triggers (buttons) carry no range. A trigger is fired
  with `true`, which reaches the Core as `1`. A control whose Core Type names a
  trigger is one: `Trigger`, and a snapshot's `load.N`, which a Core reports as
  `State Trigger`. A snapshot's lit state is its `match.N` (a read-only Boolean),
  bound as the preset's **Lit by**.
- A Core reports a Boolean as `true`/`false` in its control list and as `1`/`0` in
  the values it pushes and reads back; either is on or off alike, on a panel and on
  the server. A write's read-back of `1` for `true` is not a mismatch.
- A text control takes any text up to 1024 characters. Only a selector's choice
  list is checked against the control's choices (below); anything else may send
  any text, so allowlist a text control only if any text is safe to send.
- A value of the wrong type is refused (`bad-value`): text or `true` to a gain, a
  number to a mute or a text control, a number that is not finite.
- A control the Core reports as read-only (direction `Read`, as a meter) is refused
  (`read-only`), allowlisted or not.
- An allowlisted control the running design does not have, as after a redeploy that
  removed it, is refused (`not-in-design`) without anything being sent.
- A write is refused (`offline`) while the Core is offline or reconnecting, and
  after a reconnect (or a new design) until the Core has resent the current values
  of every control Stage Utility watches (see [Binding check](#binding-check)). With
  no panel open, writes resume once the catalog is read. A refused write is dropped, never queued
  and sent later: only a fresh write sends again.
- Every write asks the Core for the resulting value in the same call
  (`Component.Set` with `ResponseValues`). The caller gets the Core's value back; a
  value that differs from the one sent is logged.

The allowlist is saved with the server's config and carried by a config backup. It
also exports and imports as its own file (format `stage-utility-qsys-allowlist`,
version 1), never inside a view bundle: it is safety policy, and is reviewed on its
own. An import, a save or a restore that breaks any rule above (a duplicate address,
`min` above `max`, half a range, an unknown `confirm`) is refused whole, naming the
first entry at fault, and the list already saved is kept.

A stored allowlist file that breaks a rule (edited by hand, or written by a build
with other rules) is enforced as an empty list, so nothing is writable, and the
reason is logged. `GET /api/qsys/allowlist` says why in `invalid`. A save or an
import over it is refused (`409`) unless the request carries `replaceInvalid: true`;
then the invalid file is kept beside it as `qsys-allowlist.json.invalid-<time>`
before the new list is saved. Nothing deletes that copy.

The allowlist, its limits and the write route are not PIN-gated (the staff PIN guards
only a volunteer panel's way into the app): anyone who can reach the server can change
them. Restrict the server's port to staff and panel devices.

## Binding objects to controls

Q-SYS objects are in the layout editor's palette under **Q-SYS** (fader, meter, mute,
button, switch, presets, selector, label, channel strip and status; see the
[widget reference](../reference/widgets.md#q-sys)). Selecting one shows its options
in the inspector, and each control it takes is chosen with the **Core browser**: the
Core's components, then the controls of one that fit. Search matches component and
control names.

What is offered depends on the field:

| Field | Offered |
|---|---|
| Fader and strip level | Numeric controls with a range on the Core, not meters |
| Mute, switch, momentary button (**Control type** Momentary), **Lit by** | On and off controls |
| Trigger button, switch pair, preset, Previous | Triggers |
| Selector button | Triggers, and on and off controls (a selector plugin's `Button N`) |
| Selector choice list | Controls that list their choices. The field is offered only when the Core reports one |
| Meter, strip meter | Meter controls: on a meter component (`meter2`), its levels `meter.N`, `peak.N` and `rms.N`, not its settings; elsewhere a control whose name or type starts `meter` |
| Label text, strip name | Text controls |

A field that **writes** is offered only controls that are on the allowlist and that the
writer would accept: not read-only, and a number needs write limits. A field that only
reads is offered every control of the right kind. A list (presets, selector buttons)
adds a row only once a control is chosen. A binding made in the browser is an address
(component and control); a **Lit by** control is a second address that says whether
the object is on, such as a snapshot's match.

A selector's choice list is written by choice, not by range: for a write from a
panel with a selector on that control, the writer accepts only a value that is one of
the Core's reported choices, and such a control needs no allowlist range even when its
Core Type is numeric. Any other object on a control that also lists choices writes it
as its own kind: a mute or a switch on a Boolean sends true and false, and a fader on
a numeric control still needs a range. While the saved views cannot be read the
choices hold for anything but a Boolean.

Controls are listed in number order (`Button 2` before `Button 10`). A selector
plugin lists `Button 1` to `Button 100` whatever its button count, so each `Button N`
shows the name the Core draws on it beside it, read with one `Component.Get` per such
component when the catalog is read; a button with no name shows none. Picking one
for a selector names its row after it. If the Core will not say the names, the
buttons are listed by number, the browser says so, and `/log` has a line.

With no Core connected the browser says so and lists nothing; an existing binding
stays shown and can be cleared. A read that fails for any other reason is logged to
`/log` as a `[qsys]` line and the browser says it could not read.

## Channel strips

A strip's fields are bound one by one, or in one step: **Bind a channel** in its
inspector reads the Core, then you pick a component and a channel. The strip's name,
level, mute, meter and second meter fill from the controls named for that channel:

| Field | Names tried (`N` the channel, `SIDE` input or output) |
|---|---|
| Level | `SIDE.N.gain` |
| Mute | `SIDE.N.mute` |
| Meter | `meter.N` |
| Second meter | none: bind it by hand |
| Name | `SIDE.N.label`, then `text.display.N` |

These are the names a Core gives a mixer's controls. A crosspoint
(`input.1.output.2.gain`) is no channel's. A Core's meters are usually on a meter
component of their own, not on the mixer, so the meter fields mostly stay empty after
the fill; bind them from that component.

Level and mute fill only with an allowlisted, writable control; the others by the same
rule the field's own Core browser uses. A field with no match stays empty and the
inspector says why (not on the allowlist, read-only or no write limits, no control
found). Any field can be changed afterwards.

**Break apart** replaces the strip with a label, a fader (its meters beside it) and a
mute in the strip's footprint, each keeping its binding and the density. A part the
strip had nothing for is left out. The parts keep the strip's look; the label's text is
sized to read on one line across the strip, and the strip's aspect and pixel limits are
not copied, since no part has the strip's proportions. One undo restores the strip.

## Binding check

A Q-SYS object stores the address of the control it reads or writes. Every View
with Q-SYS objects (containers' children included) is checked, a [panel](#panels) or
not, every time the Views are saved, the catalog is read, or the allowlist is saved:

| Problem | Meaning |
|---|---|
| `missing-component` | The Core has no component with that Code Name (renamed or removed in the design). |
| `missing-control` | The component has no control with that name. |
| `not-allowed` | A write object is bound to a control that is not on the allowlist. |
| `read-only` | A write object is bound to a control the Core reports as read-only, or to a number that has no range set on the allowlist. |

Objects that write (fader, mute, button, switch, preset group, selector, and a
strip's gain and mute) need the control to exist, be allowlisted and be writable.
Objects that only read (meter, label, a strip's name and meters, and any binding's
indicator) need the control to exist.

Each problem is one `[qsys] binding: <view>/<object> <problem> (<component>/<control>)`
line on `/log`, written when the problem first appears and not again while it
stands; a line says when every problem has been fixed. The report is at
`GET /api/qsys/bindings` and on [`/qsys/manage`](#the-q-sys-page). The route answers
`503` while the Core is not connected (there is nothing to compare with) or while the
check cannot read the views or the allowlist (the body's `code` says which), and `[]`
only when every binding resolves. A reconnect, or a new design, says every standing
problem again. A config restore restarts the server, which reads the restored views
and allowlist and checks them afresh. An unreadable views file stops the check, and
says so.

The same step gives the watch its panels: every View with Q-SYS objects or a panel
block, the controls its objects read, and its kind. The controls open panels read are
watched with QRC change groups: at most three per connection (values, volunteer
meters, staff meters), each polled by the Core at its rate (`AutoPoll`; 30 a second,
the highest meter rate, is a rate a Core accepts). The Core sends each group's changes
as `ChangeGroup.Poll` notifications, every control's value on the first, and an empty
one on every tick with nothing changed, which is dropped without a broadcast or a
line. After a reconnect or a new design the groups are built again and `Invalidate`d,
which makes the Core resend every value on its next poll. When two people move one fader,
the last write wins, and each panel shows the Core's value after the next poll,
never its own.

## Panels

A Q-SYS panel is a custom console with panel settings. It is built, edited, exported
and imported like any console, and it is listed on `/qsys/manage` rather than among
the consoles in the sidebar. It cannot be made a display or another kind while it
is a panel; **Make it a console** in its settings turns it back into an ordinary
console first. Home cannot be a panel.

| Setting | Meaning |
|---|---|
| Who uses it | **Volunteer** (big targets; meters at the volunteer rate) or **Staff** (dense; meters at the staff rate). |
| Address | The panel's slug: `/qsys/<slug>`. Lowercase letters, digits and single hyphens, up to 64 characters. Unique: a save that takes another panel's address, or an address another panel had before a rename, is refused, naming that panel. `manage` is not allowed. A new address keeps the old one leading to the panel: `/qsys/<old>` opens it and corrects the URL, so an iPad's home-screen icon still works, and every other panel whose cog menu named the old address names the new one. A panel keeps its last 20 old addresses. |
| In its cog menu | The other panels its [cog menu](#cog-menu-and-staff-pin) lists. A volunteer panel opened full screen shows them; none by default. |
| Go back here after | Minutes without a touch before a device whose home this panel is comes back to it from another panel ([auto-return](#auto-return)). 0 to 1440; default 5; 0 never comes back. |

A duplicated panel gets the next free address (`<slug>-2`, `<slug>-3`), and none of
the original's old addresses. A restored backup is never refused over panel
settings: when its views put two panels at one address, the first keeps it and each
later one takes the next free suffix. Panel settings on a view that is not a custom
console, or settings this app cannot read (a hand-edited address, a field from a
newer build), are kept aside on the view, whole, and nothing reads them as a panel.
All of these are logged when the views are loaded (a kept-aside block in full, up to
4096 characters) and
listed at the top of the panels on `/qsys/manage` for as long as the server runs.
There, kept-aside settings can be restored once the view is a custom console
(**Restore as panel**; when the view is a panel now, it asks first and its current
settings are kept aside in their place), or forgotten (**Dismiss**, confirmed; the
log keeps a copy of the settings, up to 4096 characters). A console with Q-SYS objects and no panel
settings still works where it is shown, as a staff panel, and `/qsys/manage`
offers to make it a panel.

### In the sidebar

One **Q-SYS** row, in the Devices section, appears once a Q-SYS panel exists or a Core
is set up; with neither it is not drawn. It is a row like any other for **Customize
sidebar**: hide it, or move it to another section.

- **Hover** (a mouse, resting for half a second): a flyout opens to the right of the
  sidebar listing every panel with its kind, and **All panels and Q-SYS settings**
  last. Items light up under the pointer, and the panel you are on stays lit. The
  flyout stays open while the pointer crosses into it.
- **Tap, Enter or Space**: the row opens in place like a folder, with the same list.
  Touch has no hover, so this is how a phone or tablet reaches it. In the narrow
  icon-only sidebar a tap opens the flyout instead.
- **Keyboard**: the row is focusable. Right or Down arrow opens the flyout and moves
  into it; the arrow keys, Home and End move between items; Escape or Left arrow
  closes it and returns to the row.

Choosing a panel opens `/qsys/manage/<slug>`; the last item opens `/qsys/manage`. The
row is lit on any page under `/qsys/manage`. Escape closes the flyout and nothing
else: on a phone, the sidebar drawer it was opened in stays open.

A console's place among the sidebar's consoles is kept while it is a panel (a panel
is listed under Q-SYS instead), so making it an ordinary console again puts it back
where it was, even if the sidebar was arranged in the meantime.

### Addresses

| URL | What it is |
|---|---|
| `/qsys/<slug>` | The panel full screen, with no sidebar or header from the app: what an iPad opens, saved to its home screen. Its own header shows the panel's name and the connection, and on a volunteer panel (or any panel a cog opened) the cog. `?return=<slug>` names the device's home panel (see [Auto-return](#auto-return)). An old address of a renamed panel opens it and corrects the URL, `?return` included. |
| `/qsys/manage` | The Q-SYS page, in the app (see below). |
| `/qsys/manage/<slug>` | The panel inside the app, with **Edit** in its top-right corner, as on a console. |

An address no panel has shows "There is no panel here", never a blank page.

### What a panel shows

| The connection line says | When | Controls |
|---|---|---|
| Connected to sound system | The panel has read the Core's current values. | Live. |
| Reconnecting to sound system | The page is reading the Core's values again: just opened, back from sleep, or its own connection to Stage Utility came back. | Hold their last values and take no input until the read lands. |
| Sound system offline | Stage Utility cannot reach the Core, or this page cannot reach Stage Utility (the server stopped, the iPad off the network). After 2 seconds without the Core, or 10 seconds without Stage Utility, a card covers the controls, which are dimmed under it: "Audio controls are offline. This page can't reach the sound system, so nothing here will change anything. Use the Q-SYS panel on the wall, or find a tech." The service and the page keep retrying, and the card goes when both are back; the page then reads the Core's values before it takes a touch. | Greyed, no input. |
| No Q-SYS Core is set up | The integration is off or has no Core host. A bar under the header says so; on a staff panel and inside the app it links to the Q-SYS settings. The link is there only when both this panel and the device's home are staff panels: a volunteer panel never has it, and neither does a staff panel a volunteer device's cog opened. | Greyed, no input. The panel stays editable. |

A page that wakes from sleep, or whose connection to Stage Utility drops and comes
back, reads the Core's current values before it takes a touch, and never sends its
own values back: only a fresh touch writes.

#### Faders

A fader on a control whose range has a measured Q-SYS taper follows the Core's own
fader: its thumb sits at the position the Core reports, as on a Q-SYS touch screen
(0 dB at three quarters of the travel on a -100 to +10 dB gain), and a drag moves
along that taper. What a drag sends is still a value in dB, so the allowlist's
limits apply exactly as for any write; the drag stops at them, and the limit line is
drawn at the limit's place on the taper. A strip's meters are drawn on the same
taper, so they line up with the fader.

Measured ranges: -100 to +10 dB. A fader on any other range moves linearly in dB
from -60 dB (or the allowlist's minimum) to the allowlist's maximum, with the Core's
minimum at the bottom stop, and looks no different. Each such range is logged once
(see [Troubleshooting](#troubleshooting)) and listed on
[`/qsys/manage`](#the-q-sys-page) so it can be measured: set the control to a series
of values on a Core and read back each `Position`.

An iPad that opens a panel while Stage Utility is down shows the browser's own error;
one that already had it open shows the card above. Either way the Core and its wall
panels are not affected.

### Cog menu and staff PIN

A volunteer panel opened full screen (`/qsys/<slug>`) has a cog at the right of its
header, and so does any panel a cog opened (any `?return=`, even one that names no
panel), a staff panel included, so a device always has a way back. A staff panel opened on its own, and
panels inside the app, have none. The cog opens a menu, which takes focus while it
is open (Tab stays inside it; Escape or a tap outside closes it):

- **Panels**: the device's home panel, marked "This iPad's home", then the panels
  the home panel's **In its cog menu** setting names. Wherever the cog has taken a
  device, the list is its home's, so a device reaches no further than that. A named
  panel that does not exist is left out. Tapping one opens it, with no PIN.
- **Open Stage Utility**, with a lock and "PIN": asks for the 4-digit staff PIN. The
  server checks it; the right PIN opens the app at `/`, and unlocks nothing else.
  Five wrong tries in a row from one device (its network address) lock that device
  out for a minute, the right PIN included, and the pad counts the minute down. A
  locked device's tries are refused before anything is checked, so a flood of them
  costs the server nothing. The server remembers up to 1000 devices with wrong
  tries or a lock; past that, a new device takes the place of one whose lock is
  over or whose tries are 15 minutes old, and when there is none it is told to wait
  a minute. A count part way to a lock is never reset to make room.
  With no PIN set the pad says "No staff PIN is set. Set one on /qsys/manage
  first." and never opens the app.

The PIN is set on `/qsys/manage` and stored on the server as a salted scrypt hash,
with the scrypt cost it was made with, in `qsys-pin.json`, which a config backup
carries. A hash stored without a cost (by an earlier build) is read at Node's default
cost. A file this build cannot read is read as no PIN set, and logged; it is kept
until a PIN is saved. It keeps curious taps out; it is not
security. `/qsys/manage`, the allowlist and the PIN itself are open to anyone who can
reach the server, so restrict the server's port to staff and panel devices (a
firewall rule, or a VLAN the panels share with the server).

### Auto-return

The panel a device opens first is its home. A panel opened from the cog carries
`?return=<home slug>` in its address, so the way back survives a reload and needs no
device id. While a page is away from home, a bar under its header says "Going back to
<home> in m:ss unless someone touches the screen." with **Go back now**. The count
runs from the last touch: any tap, drag, scroll or key press anywhere on the page
starts it again. At zero the page opens its home, which reads the Core's values
before it takes a touch, as any panel does when it opens.

How long is the HOME panel's **Go back here after**, so every panel a device
wanders to, staff or volunteer, sends it back on the same clock. 0 never goes back
(the cog still lists home). A `?return=` that names no panel is ignored: the page is
its own home.

### Setting up an iPad

1. Open `http://<server>/qsys/<slug>` in Safari, with the panel the iPad lives on
   as `<slug>`. Use the address with no `?return=`: whatever the iPad opens from its
   home-screen icon is its home.
2. Share, **Add to Home Screen**. The panel opens from the icon full screen, with
   no browser bar.
3. Set a staff PIN on `/qsys/manage`, so the cog's **Open Stage Utility** works for
   staff and only for staff.
4. Optional: Guided Access (Settings, Accessibility) keeps the iPad in that one app.

### Moving a panel between installs

A panel's settings travel in its view bundle (see
[Moving a view](../moving-a-view.md)); the allowlist never does. On import:

- The bundle's panel settings are checked as a save of them is: a malformed block,
  or a panel that is not a custom console, refuses the whole file and writes nothing.
  `qsys: null` is no panel settings. Settings a view keeps aside travel with it, up
  to 20 per view of up to 4096 characters each; more refuses the file.
- A panel's old addresses travel with it, except those taken here, which the import
  result names.
- A panel whose address is already taken here, by a panel on this install or another
  in the same file, takes the next free one (`<slug>-2`, `<slug>-3`). The panel here
  is untouched, the import result says which address each panel landed at, and a
  sibling the file names follows the rename.
- A sibling that no panel has after the import is kept and not an error: the cog menu
  leaves it out, the import result names it, and `/qsys/manage` lists it.
- A bundle imports on a server with no Core set up. The panel arrives, shows "No
  Q-SYS Core is set up" and stays editable; its controls are greyed until a Core is
  connected.

## The Q-SYS page

`/qsys/manage`, reached from the sidebar's Q-SYS row or the Q-SYS integration's dialog
(**Open Q-SYS panels**):

- **Panels**: a card per panel with its address, its kind and how many binding
  problems it has; its name opens it inside the app, **Settings** edits its panel
  settings, and **New panel** makes a blank one. A panel that names another panel
  (for its cog menu) which does not exist is listed here, with the missing names.
- **Connection**: whether the Core is connected, and a link to its settings.
- **Allowlist**: every allowlisted control, with its limits (blank for none) and
  whether it asks for a hold. Edits are saved together with **Save the allowlist**,
  and only over the list they were made on: if it was saved elsewhere meanwhile,
  nothing is written. The page then reads the list again and shows, beside the
  edits, what changed and the list as it is now; **Save the allowlist** stays off
  until **Keep my edits over this list** (after which a save replaces the new list)
  or **Discard my edits**.
  **Add all controls <panel> uses** adds every control that panel's objects change
  (a fader's level, a mute, a button, a switch, presets, a selector, a strip's gain
  and mute; never a meter, a label or an indicator) that the list lacks, at the
  Core's own range, and leaves every entry already there as it is. It needs the
  Core connected, since the ranges come from it, and says which controls it left
  off (not in the design, or read-only). An invalid stored list is shown with
  **Start a new, empty list**, which keeps the old file beside the new one.
- **Binding check**: each problem with its panel and control, "Every binding
  resolves", "Connect a Core to check the bindings", or why the check could not run.
- **Fader tapers**: the control ranges faders and strip levels are bound to that have
  no measured Q-SYS taper, each with its controls, or "Every fader is on a measured
  range". See [Faders](#faders).
- **Staff PIN**: whether one is set, and a field to set or change it (four digits,
  never shown back), with **Remove PIN**. With none set, a volunteer panel's
  **Open Stage Utility** does not open the app. See
  [Cog menu and staff PIN](#cog-menu-and-staff-pin).
- **Meter rates**: a link to the two rates on the integration.

## Write log

Every write gesture is one entry in a rolling log of the last 2000
(`qsys-write-log.json`, not carried by a config backup; read it at
`GET /api/qsys/write-log`). A drag sends many writes: the client marks every one but
the last `final: false`. Those are checked and sent but recorded only if refused, and
the last is recorded with the value it landed on. A client that never sends a last
write leaves no entry for a drag. A clamp or a read-back mismatch is logged to `/log`
on the same rule.

Each entry holds when, the panel id the client sent, the device (its address and
user agent), the control, the value before, the value sent (after clamping) and the
result: `ok`, `clamped`, `mismatch`, or the reason it was refused (`not-allowed`,
`not-in-design`, `read-only`, `no-range`, `offline`, `bad-value`, `no-lease`,
`core-error`). The value before is the Core's value when the gesture started (its first write from that
address, panel and control, within 10 seconds of the next), as Stage Utility last read
it; it is empty when nothing watches the control. A
successful write goes to the write log, not `/log`.

A refusal made before anything was sent (every reason but `core-error`) that repeats
one already recorded (the same address, panel, control and reason, within a minute of
the last) is counted on that entry (`repeats`, `lastAt`) rather than added, so a
client looping on a refused write cannot push real entries out of the log. The
address is the request's own, not its user agent, which a client can change at will.
A write that reached the Core, including a `core-error` that may have landed, always
keeps its own entry and value.

## Momentary buttons

A button whose **Control type** is Momentary (saved on the button as `press`; absent is a
Trigger), bound to a Boolean control, is a momentary: on while pressed, off on release. A button set to Trigger
fires once, and a Boolean on a switch or a mute is a toggle; neither is a momentary.
The page decides a momentary from the saved press alone, never from what the Core
reports, so a button drawn before the Core's control list has been read is still a
momentary. The release is the page's to send, and a page that cannot send it (an iPad
asleep mid-press, a dropped connection, a closed tab) never sends it later. So the
press is sent with `lease: true` and the page's event-stream id, and when it lands
the server holds a lease on the control. While the button stays down the page
renews it about once a second (`POST /api/qsys/lease`). The server writes the
release itself when no renewal arrives for 2 seconds, or at once when the
connection the press was made on closes: the event stream, or polling client,
carrying the page's id when it pressed. A page keeps its id across reconnects, and
the server can learn that an old connection died some time after the page has
opened a new one, so only that connection's close counts: a late close of one the
page has already replaced releases nothing. The page's own release, or any other
write to the control, ends the lease with no extra write. One lease per control: a
second press takes it over. Renewals count only from the address and event stream
that pressed, so two pages behind one address cannot keep each other's press on.

The server takes a lease only for a momentary button: the panel the press came
from must have a Q-SYS button saved as Momentary on that control, read from the
saved views. A press that asks for a lease it cannot have is refused (`no-lease`)
and nothing is sent: the panel has no such button on the control, or the saved
views cannot be read to tell. A momentary left on with nothing to turn it off is
the outcome the lease exists to prevent. The button stays unlit, the page stops
renewing and sends no release, and on a staff panel a toast says why. A lease
asked on a trigger needs none: a trigger fires and holds nothing on.

A renewal that gets no answer (a network blip, a server error) is tried again a
few hundred milliseconds later, for as long as the 2-second lease has time left;
the page stops renewing when its own finger lets go, the connection breaks, the
panel stops being live, the button can no longer be pressed (a key held down on a
button that goes Unavailable is let go), the press is refused, or the server
answers that it holds no lease once the press itself has answered. A momentary or
hold-to-confirm button does not let the browser take a touch for a scroll, so a
small slide of the finger does not end the press.

If the Core is away when the server's release is due (a drop that also stopped the
page's renewals is the usual reason), the release is owed rather than lost. When
writes are possible again (the Core reconnected and its values have been read
again), the server reads the control and sends the release only if the Core still
reports it on. A release whose send the Core refused, or that was cut off, on a
connection that is still up is owed the same way and tried again within a second
or so. An owed release is dropped, with a line, when the Core it was owed to is no
longer the one configured, the design has changed, the control has left the design
or the allowlist, or after five tries that could not read the control or send. The
Core going away again while it is being settled is not one of those tries: the
release waits for the Core to come back, however often it drops.

A release the server decided to send never lands after a newer write: if anything
else (a fresh press from any page) reaches the control first, the release is not
sent. A press whose write was cut off mid-send (it may have landed) takes its lease
all the same, but a press whose answer arrives after another write was sent to the
control takes none.

The server's release is a write like any other, with every allowlist, type and
range check, and its own write-log entry: device `server (lease expired)`,
`server (stream closed)` or `server (lease owed)`, and `cause` saying which.

## Latency

Stage Utility times how long the Core takes to confirm a write and reports it on
`GET /api/qsys/status` (`latency.write`) as a count, a median (`p50`) and a 95th
percentile (`p95`) in milliseconds over the last 500 writes. With no writes yet
the percentiles are `null`.

| Figure | What it measures | Target |
|---|---|---|
| `latency.write` | Time from sending a write to the Core's reply to it (the reply carries the value the Core now holds). A write the Core refused, or one lost to a dropped connection, is not timed. | 95th percentile under 100 ms |

A change made at the Core reaching `qsys:values` within 250 ms
of the Core pushing it is held by a test against a fake Core, not
reported: the figure a server could time for it (arrival to broadcast) is a
synchronous loop and always reads about zero, and the Core's own poll interval (the
AutoPoll rate) and the network are outside it.

While the Core is connected and writes have been made, `/log` gets one line an hour,
`[qsys] write p95 <n> ms (<count> writes)`. `<n>` is the 95th percentile over the
last 500 confirmed writes, as in `latency.write`; `<count>` is the writes confirmed
since the previous line, so it can exceed 500. Nothing is logged per write. The
hour is timed from the first write after a line (or after a reconnect), no timer
runs while the Core is away or while no write has been made, and writes made before
a disconnect are reported by the next line. The figures start empty after a restart.

A write p95 well above 100 ms points at the Core or the network between it and the
server (a busy Core, Wi-Fi on the path), not at the panel.

## What it never does

It never calls a method that changes the design: no components are added, no designs
loaded, no Core settings changed. It writes the values of allowlisted controls and
nothing else.

## Troubleshooting

Look at `/log` and filter for `[qsys]`.

| Line or message | Meaning |
|---|---|
| `connecting to <host>:<port>` | The service is dialling. If nothing follows, the address or port is wrong, or the machine is not reachable. |
| `<host> connection failed: <reason>` | The Core did not answer. `ECONNREFUSED` usually means nothing listens on that port; a timeout means a network path problem. |
| `logon refused` | The user or password is wrong, or the user lacks access. Test connection reports "The Core refused the user name or password". Logged once; the retries are quiet until it connects. |
| `logon required, and no user is set` | The Core has Access Control on and the card has no User. Test connection reports "The Core requires a logon: set User and Password". |
| `connection lost: <reason>` | The connection dropped. The service reconnects with backoff. |
| `connected to <design> (<n> components, emulator=<bool>)` | Connected and the catalog is read. Few or no components usually means Script Access is not set where it is needed, or no design is running. |
| `design changed, refreshing catalog` | The Core reports a new design code, as after a redeploy or a Core restart. |
| `a QRC message passed <n> bytes without a terminator, dropping the connection` | One message from the Core ran past 32 MiB without ending. Real designs stay far under that; the service reconnects, and if this repeats, the address is probably not a Q-SYS Core. |
| `ignoring QRC message with no matching request (id <n>)` | A reply arrived for a request that had already given up after 5 seconds. Occasional lines mean a busy Core or network; a steady stream means replies are consistently slow. Each id is logged once, then every 15 minutes with a count; past eight ids they share one line. |
| `ignoring unparseable QRC message: <reason>` | The Core sent something that is not JSON. If it was a reply, its request fails 5 seconds later as timed out. |
| `QRC notification handler for <method> threw: <reason>`, `QRC close handler threw: <reason>`, `catalog listener threw: <reason>` | A bug in this app's handling of a message from the Core. The connection carries on; report the line. |
| `momentary <component>/<control> released by the server: <why>` | A momentary's page stopped renewing its press (`no renewal from the pressing page`), or the connection it pressed on closed (`the pressing page's event stream closed`), and the server turned the control off itself. The write log has the entry. |
| `the server's release of <component>/<control> could not be sent (<reason>); it is owed, …` | The Core was away when a momentary's release was due (`offline`), or refused it or dropped mid-send (`core-error`). It is sent once writes are possible again (within a second or so if the connection is still up), if the Core still reports the control on. |
| `the server's release of <component>/<control> failed (<reason>), and another write to it has been sent since; nothing is owed` | The server's release could not be sent, but a newer write (a fresh press) has reached the control since, so nothing is kept to send later. |
| `sending the owed release of <component>/<control>: the Core still reports it on` / `owed release of <component>/<control> not sent: the Core reports it off` | The Core is back and the owed release was settled, one way or the other. |
| `release of <component>/<control> was not sent: another write to it came first` / `owed release of <component>/<control> not sent: another write to it came first` | A press (or any write) reached the control before the server's release did, so the release was not sent and the newer write stands. |
| `owed release of <component>/<control> not settled: <why>; trying again` | An owed release could not be read or sent this time. It is tried again shortly while the Core is connected, else when it reconnects. The Core being offline is not a failed try and writes no line. |
| `owed release of <component>/<control> dropped: <why>; it may still be on at the Core` | An owed release was given up: the Core or its design changed, the control left the design or the allowlist, or five tries failed. Check the control at the Core. |
| `the server's release of <component>/<control> was refused (<reason>); it may still be on at the Core` | The server could not write a momentary's release and will not retry (the control taken off the allowlist, or out of the design). Check the control at the Core. |
| `write refused (no-lease): <component>/<control> was not pressed: the saved views could not be read …` | A momentary press arrived while the saved views could not be read, so the server could not hold its release and sent nothing. See the views store's own line for the cause. |
| `write refused (no-lease): <component>/<control> was not pressed: panel <id> has no momentary button on it, so the server will not hold it on` | A press asked for a lease on a control its panel has no momentary button for (the panel was edited since the page loaded, or a client other than a panel asked). Nothing was sent. Reload the panel; if it persists, check the button's Control type in the editor. |
| `write refused (<reason>): <why>` | A write was refused. Before anything was sent: `not-allowed`, `not-in-design`, `read-only`, `no-range`, `offline`, `bad-value`, `no-lease`; by the Core, or because the connection dropped mid-write: `core-error`. The write log has the device and panel. A refusal checked before sending is logged once per address, then once a minute with ` — still failing after <n> attempts (<m> min)`; past eight addresses they share one line. `offline` is logged once per connection state (none, or each new connection) and starts over once writes are possible again. `core-error` is logged every time. |
| `write p95 <n> ms (<count> writes)` | Once an hour while connected, if writes were made: the 95th percentile over the last 500 confirmed writes and how many were confirmed since the previous line. See [Latency](#latency). |
| `write to <component>/<control> clamped from <a> to <b>` | A write asked for a value outside the allowlist range. |
| `read-back mismatch on <component>/<control>: sent <a>, the Core holds <b>` | The Core holds a different value than the one written, as when a control limits or steps its own value. |
| `allowlist saved: <n> entries`, `allowlist imported: <n> entries` | The allowlist was replaced. |
| `allowlist save refused: <why>`, `allowlist import refused: <why>` | An allowlist broke a rule, or the stored file is invalid and the request did not say `replaceInvalid`; the saved list is unchanged. |
| `qsys-allowlist.json is not a valid allowlist (<why>); nothing is writable, and it is kept until a save says it replaces it` | The stored file breaks a rule, so every write is refused `not-allowed`. Fix the file and restart, or save a list with `replaceInvalid: true`. |
| `kept the invalid allowlist as qsys-allowlist.json.invalid-<time> before replacing it` | A save replaced an invalid stored file; the old file is beside it in the data directory. |
| `could not read the write log; entries are in memory only: <reason>` | The write log file exists but cannot be read. Writes still go through; the log holds only what happens from now, and is not saved over the unreadable file. |
| `could not save the write log; entries since are in memory only` | The write log file cannot be written. Writes still go through; `/api/qsys/write-log` reports `saveError`. Logged once per run of failures. |
| `write log saved again` | A save succeeded after failures. |
| `catalog refresh failed: <reason>` | A catalog refresh asked for over the API failed. |
| `could not read the button names of <component>: <reason>; the editor lists its buttons by number` | The Core refused the `Component.Get` that reads a selector plugin's button names. The connection and the catalog are fine; the editor's browser lists its `Button N` controls without names. |
| `watching <n> values, <n> volunteer meters, <n> staff meters` | What the Core is asked to report. Logged on connect and when it changes; 0 while no panel is open. |
| `binding: <view>/<object> <problem> (<component>/<control>)` | The binding check found a binding that does not resolve: `missing-component`, `missing-control`, `not-allowed` or `read-only` (see Binding check). Logged when it first appears, not again while it stands. |
| `no measured taper for range <min>..<max>; faders on it move linearly in dB, not as the Core's do (<controls>). See /qsys/manage` | A fader or a strip's level is bound to a control whose range has no measured Q-SYS taper, so it moves linearly in dB rather than as the Core's own fader. Logged once per range while the server runs. See [Faders](#faders). |
| `binding check: every binding resolves` | Every problem the check had reported is fixed. |
| `binding check could not run: <reason>` | The views or the allowlist could not be read. `GET /api/qsys/bindings` answers `503` (`code` `check-failed`), and `/qsys/manage` says the check could not run, until a check runs again, never an empty (all clear) list. |
| `staff PIN set by <address>`, `staff PIN removed by <address>; …` | The staff PIN was set, changed or removed from `/qsys/manage` (or `PUT /api/qsys/pin`). |
| `the staff PIN could not be saved: <reason>` | The server could not write `qsys-pin.json` (a full or read-only disk); the PIN is unchanged and `PUT /api/qsys/pin` answered `500`. The page sends the same words, with the page's reason, when it was refused. |
| `qsys-pin.json holds a staff PIN this build cannot read; volunteer panels cannot open Stage Utility until a PIN is set on /qsys/manage` | The stored PIN has a shape or scrypt cost this build will not run (a hand edit, or a newer build's file). It is read as no PIN; the file is kept until a PIN is saved. |
| `PIN check from <address> refused: 1000 other clients are part way to a lock or locked; it can try again in 60 s` | The server is remembering as many devices with wrong tries as it will, so a new device was told to wait. Many addresses guessing at once; at most one line a minute. |
| `PIN locked for <address> after 5 wrong tries; it can try again in 60 s` | A device sent five wrong PINs in a row. It cannot open the app for a minute. Repeated lines from one address mean someone is guessing. |
| `the staff PIN could not be checked: <reason>`, `could not read whether a staff PIN is set: <reason>` | A panel's PIN pad could not reach the server (sent from the page). It said so on the pad, not "wrong PIN". |
| `Q-SYS panel "<name>" address /qsys/<a> was taken here; imported as /qsys/<b>` | An imported panel's address clashed and took a suffix. Tagged `[view-import]`. |
| `Q-SYS panel "<name>" names panels that do not exist here: <slugs>` | An imported panel's sibling list names panels no panel has. Tagged `[view-import]`. |
| `Q-SYS panel "<name>" no longer keeps its old address(es) /qsys/<a>: a panel here has them` | An imported panel's old addresses clashed with this install's; it keeps the rest. Tagged `[view-import]`. |
| `allowlist: added <n> control(s) a panel uses, at the Core's own ranges` | **Add all controls … uses** on `/qsys/manage` added entries. |
| `allowlist add refused: <why>` | **Add all controls … uses** saved nothing: the stored list is invalid, or the result broke a rule. |
| `panel settings for <view> were refused: <why>`, `a new panel was refused: <why>` | From the page: a panel's settings or a new panel were refused, as for an address another panel has. The server's own line is `[stage-controller] setViewQsys … refused` or `createView refused`. |
| `the allowlist save was refused: <why>`, `adding a panel's controls to the allowlist was refused: <why>`, `replacing the invalid allowlist was refused: <why>` | From `/qsys/manage`: the server refused the change; the page shows the same reason. |
| `could not read the allowlist for /qsys/manage`, `… the binding check for /qsys/manage`, `… the Q-SYS connection` (the sidebar's Q-SYS row reads it on every page, so this one is not specific to /qsys/manage; while it has failed, the row is drawn so the page that says so can be reached), `… the panel repairs for /qsys/manage` | A read on the Q-SYS page failed; that section says so. |
| `views.json: "<view>" (<id>) shared /qsys/<slug> with an earlier panel; it opens at /qsys/<new> now` | The saved views (a restored backup, a hand edit) put two panels at one address. The later one was given the next free address; `/qsys/manage` lists it. Said on each load until the views are next saved. |
| `views.json: "<view>" (<id>) had panel settings for /qsys/<slug> but is not a custom console; kept aside, not a panel: <block>` | Panel settings on a display or another kind were kept aside, whole, when the views were loaded. `/qsys/manage` lists them; make the view a custom console and **Restore as panel**. |
| `views.json: "<view>" (<id>) has panel settings this app cannot read (<why>); kept aside, not a panel: <block>` | A panel block the app cannot read (a hand-edited address, a newer build's field) was kept aside, whole. Set the panel up again from the logged block. |
| `views.json: "<view>" (<id>) had kept-aside panel settings that were not a list; kept as a list of one: <value>` | A hand edit left the view's kept-aside settings as something other than a list. Nothing was dropped. |
| `views.json: "<view>" (<id>) no longer keeps its old address(es) /qsys/<a>: another panel has them` | An old address of a renamed panel is now another panel's address (or an earlier panel keeps it), so it no longer leads to this one. |
| `panel "<view>" moved from /qsys/<a> to /qsys/<b>; the old address still leads to it, and <n> other panel(s) list the new one in their cog menus` | A panel's address was changed. `/qsys/<a>` keeps opening it. |
| `"<view>" keeps its last 20 old addresses; /qsys/<a> no longer lead to it` | A rename past 20 old addresses forgot the oldest. |
| `"<view>": its panel settings for /qsys/<a> were kept aside, whole, to restore /qsys/<b>: <block>` | **Restore as panel** on a view that was a panel: its settings went aside in place of the restored ones. |
| `"<view>" (<id>): kept-aside panel settings dismissed by the operator: <block>` | **Dismiss** on `/qsys/manage` forgot kept-aside settings. The line (up to 4096 characters of them) is the only copy left. |
| `an allowlist save was stopped: the list changed since the edits began; the page shows what changed` | From `/qsys/manage`: the list was saved elsewhere after the edits began, so the server refused the save (`409`, `rev-changed`) and nothing was written. The page shows what changed and waits for the operator. |
| `restoring kept-aside panel settings on <view> was refused: <why>`, `dismissing kept-aside panel settings on <view> was refused: <why>` | From `/qsys/manage`: **Restore as panel** or **Dismiss** was refused, as for an address another panel has, or settings already gone. |
| `design changed, rebuilding change groups` | A new design: the watched controls are set up again, and writes wait until their values are read. |
| `ready listener failed: <reason>` | A bug in this app's handling of writes becoming possible again (where an owed release is sent). Writes carry on; report the line. |

The lines below are about watching the controls open panels read.

| Line or message | Meaning |
|---|---|
| `change group update failed: <reason>; retrying in <n> s` | The Core refused a change to what is watched. Retried after 1 s, doubling to 30 s. |
| `rebuilding change groups after a failed update` | A retry after the line above. |
| `change group <id> was not on the Core (<reason>)` | Removing a watch the Core no longer had; harmless. |
| `<component>/<control> is on panel <id> but not in the Core's design; not watched` | A panel names a control the design lacks. |
| `the Core would not watch <component> (<controls>): <reason>; not watched` | The Core refused to report these controls. The rest are watched and writes carry on. |
| `the Core has not resent the values of <groups> <n> s after Invalidate; asking again, and writes wait` | After a reconnect the Core has not sent the current values; writes stay refused until it does. It is asked again after 10 s, then 20 s, doubling to 5 minutes, one line each time. |

These lines come from a panel page or the editor, sent to `/log` with the page's
address.

| Line or message | Meaning |
|---|---|
| `panel <id>: the server did not acknowledge this page's channels in time; reading anyway` | The page could not confirm the server is sending it this panel's changes before it read the panel. Its controls open anyway; a change made in that moment shows only once it changes again. A slow or overloaded server; if it repeats, check `[events]` lines. |
| `panel <id> is not a Q-SYS panel on the server; its objects show Unavailable` | The page asked for a view the server has no Q-SYS objects for: the view was deleted, or its Q-SYS objects removed, since the page loaded. Reload the page. |
| `panel <id>: its values could not be read (<reason>); retrying` | The page's read of its controls failed. Its controls stay greyed, and a press or drag in progress ends, until a read lands; it retries after 1 s, doubling to 8 s. Logged once per run of failures. |
| `panel <id>: the Core's catalog could not be read (<reason>); faders stay Unavailable until it is; retrying` | Without the Core's control list no fader has a range. Usually the Core dropping as the page loaded; it retries. |
| `panel <id>: the allowlist could not be read (<reason>)` | Without it nothing on the page counts as writable, so writing objects read Unavailable. Logged once per run of failures. See the server's allowlist lines. |
| `panel <id>: a write to <component>/<control> did not reach the server (<reason>)` | The page's write request failed on the network or the server; nothing was written. A staff panel also says so in a toast. |
| `could not read the Core's catalog for the control browser: <reason>`, `could not read the allowlist for the control browser: <reason>` | The editor's control browser (or Bind a channel) could not read what it offers; it says so in place of the list. |
