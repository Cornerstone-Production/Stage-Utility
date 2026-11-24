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

Every Q-SYS panel polls its meters at the staff rate for now; the volunteer rate is
stored and not yet read.

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
the controls on the allowlist. Nothing is on it by default. In this release the
allowlist is set over the API, with `PUT /api/qsys/allowlist` or an allowlist file
import; there is no page for it yet. Every write is checked by the server.

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
  with `true`.
- A text control takes any text up to 1024 characters. It is not checked against
  the control's choices: allowlist a text control only if any text is safe to send.
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

The allowlist, its limits and the write route are not PIN-gated: anyone who can reach
the server can change them. Restrict the server's port to staff and panel devices.

## Binding check

A Q-SYS object stores the address of the control it reads or writes. Any View with
Q-SYS objects (containers' children included) is a panel, and every time the Views
are saved, the catalog is read, or the allowlist is saved, the server checks each
binding against the Core:

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
`GET /api/qsys/bindings`, which answers `503` while the Core is not connected (there
is nothing to compare with), and `[]` only when every binding resolves. A config
restore restarts the server, which reads the restored views and allowlist and
checks them afresh. An unreadable views file stops the check, and says so.

The same step gives the watch its panels: every View with Q-SYS objects, and the
controls its objects read. When two people move one fader, the last write wins, and
each panel shows the Core's value after the next poll, never its own.

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
`not-in-design`, `read-only`, `no-range`, `offline`, `bad-value`, `core-error`). The
value before is the Core's value when the gesture started (its first write from that
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

A button bound to a Boolean control is a momentary: on while pressed, off on
release. The release is the page's to send, and a page that cannot send it (an iPad
asleep mid-press, a dropped connection, a closed tab) never sends it later. So the
press is sent with `lease: true` and the page's event-stream id, and when it lands
the server holds a lease on the control. While the button stays down the page
renews it about once a second (`POST /api/qsys/lease`). The server writes the
release itself when no renewal arrives for 2 seconds, or at once when the pressing
page's event stream closes. The page's own release, or any other write to the
control, ends the lease with no extra write. One lease per control: a second press
takes it over.

The server's release is a write like any other, with every allowlist, type and
range check, and its own write-log entry: device `server (lease expired)` or
`server (stream closed)`, and `cause` saying which.

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
| `momentary <component>/<control> released by the server: <why>` | A momentary's page stopped renewing its press, or its event stream closed, and the server turned the control off itself. The write log has the entry. |
| `the server's release of <component>/<control> was refused (<reason>); it may still be on at the Core` | The server could not write a lapsed momentary's release (the Core offline, the control taken off the allowlist). Check the control at the Core. |
| `write refused (<reason>): <why>` | A write was refused. Before anything was sent: `not-allowed`, `not-in-design`, `read-only`, `no-range`, `offline`, `bad-value`; by the Core, or because the connection dropped mid-write: `core-error`. The write log has the device and panel. A refusal checked before sending is logged once per address, then once a minute with ` — still failing after <n> attempts (<m> min)`; past eight addresses they share one line. `offline` is logged once per connection state (none, or each new connection) and starts over once writes are possible again. `core-error` is logged every time. |
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
| `watching <n> values, <n> volunteer meters, <n> staff meters` | What the Core is asked to report. Logged on connect and when it changes; 0 while no panel is open. |
| `binding: <view>/<object> <problem> (<component>/<control>)` | The binding check found a binding that does not resolve: `missing-component`, `missing-control`, `not-allowed` or `read-only` (see Binding check). Logged when it first appears, not again while it stands. |
| `binding check: every binding resolves` | Every problem the check had reported is fixed. |
| `binding check could not run: <reason>` | The views or the allowlist could not be read. The last report stands until a check runs. |
| `design changed, rebuilding change groups` | A new design: the watched controls are set up again, and writes wait until their values are read. |

The lines below are about watching the controls open panels read.

| Line or message | Meaning |
|---|---|
| `change group update failed: <reason>; retrying in <n> s` | The Core refused a change to what is watched. Retried after 1 s, doubling to 30 s. |
| `rebuilding change groups after a failed update` | A retry after the line above. |
| `change group <id> was not on the Core (<reason>)` | Removing a watch the Core no longer had; harmless. |
| `<component>/<control> is on panel <id> but not in the Core's design; not watched` | A panel names a control the design lacks. |
| `the Core would not watch <component> (<controls>): <reason>; not watched` | The Core refused to report these controls. The rest are watched and writes carry on. |
| `the Core has not resent the values of <groups> <n> s after Invalidate; asking again, and writes wait` | After a reconnect the Core has not sent the current values; writes stay refused until it does. It is asked again after 10 s, then 20 s, doubling to 5 minutes, one line each time. |
|
