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

The two meter rates are stored for the Q-SYS panels, which arrive in a later
release. Nothing in this release reads them.

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

A panel can write only the controls on the allowlist. Nothing is on it by default.
Every write is checked by the server, never by the browser.

| Field | Meaning |
|---|---|
| component, control | The control's address: the component's Code Name and the control's name. |
| label | Shown in the editor's picker. Up to 120 characters. |
| min, max | The value range a numeric write may reach, in the control's own units (dB for a gain). Both set, or both empty. |
| confirm | `none`, or `hold`: every object bound to the control asks for hold-to-confirm. |

- A control added from the catalog starts with the Core's own range (`ValueMin` and
  `ValueMax`), so by default a web fader reaches exactly as far as a UCI fader. Set a
  tighter range per control.
- A numeric control the Core reports no range for is added with none, and is not
  writable until a range is set.
- A value outside the range is clamped to it, and the clamp is logged.
- Booleans (mute, switch) and triggers (buttons) carry no range.
- A value of the wrong type is refused: text or `true` to a gain, a number to a mute,
  a number that is not finite.
- A write is refused while the Core is offline or reconnecting, and after a
  reconnect (or a new design) until the Core's current values have been read again.
  A refused write is dropped, never queued and sent later: only a fresh touch writes.
- Every write asks the Core for the resulting value in the same call
  (`Component.Set` with `ResponseValues`). The caller gets the Core's value back; a
  value that differs from the one sent is logged.

The allowlist is saved with the server's config and carried by a config backup. It
also exports and imports as its own file (format `stage-utility-qsys-allowlist`,
version 1), never inside a view bundle: it is safety policy, and is reviewed on its
own. An import, a save or a restore that breaks any rule above (a duplicate address,
`min` above `max`, half a range, an unknown `confirm`) is refused whole, naming the
first entry at fault, and the list already saved is kept.

The allowlist, its limits and the write route are not PIN-gated: anyone who can reach
the server can change them. Restrict the server's port to staff and panel devices.

## Write log

Every write call, refused or not, is one entry in a rolling log of the last 2000
(`qsys-write-log.json`, not carried by a config backup): when, the panel, the device
(its address and user agent), the control, the value before (as the open panels last
read it, or empty when no open panel watches it), the value sent (after clamping) and
the result: `ok`, `clamped`, `mismatch`, or the reason it was refused (`not-allowed`,
`no-range`, `offline`, `bad-value`, `core-error`). A successful write goes to the
write log, not `/log`.

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
| `ignoring QRC message with no matching request (id <n>)` | A reply arrived for a request that had already given up after 5 seconds. Occasional lines mean a busy Core or network; a steady stream means replies are consistently slow. |
| `ignoring unparseable QRC message: <reason>` | The Core sent something that is not JSON. If it was a reply, its request fails 5 seconds later as timed out. |
| `QRC notification handler for <method> threw: <reason>`, `QRC close handler threw: <reason>`, `catalog listener threw: <reason>` | A bug in this app's handling of a message from the Core. The connection carries on; report the line. |
| `write refused (<reason>): <why>` | A write was refused before it reached the Core (`not-allowed`, `no-range`, `offline`, `bad-value`), or the Core refused it or did not answer (`core-error`). The write log has the device and panel. |
| `write to <component>/<control> clamped from <a> to <b>` | A write asked for a value outside the allowlist range. |
| `read-back mismatch on <component>/<control>: sent <a>, the Core holds <b>` | The Core holds a different value than the one written, as when a control limits or steps its own value. |
| `allowlist saved: <n> entries`, `allowlist imported: <n> entries` | The allowlist was replaced. |
| `allowlist save refused: <why>`, `allowlist import refused: <why>` | An allowlist broke a rule; the saved list is unchanged. |
| `could not save the write log; entries since are in memory only` | The write log file cannot be written. Writes still go through; `/api/qsys/write-log` reports `saveError`. |
| `catalog refresh failed: <reason>` | A catalog refresh asked for over the API failed. |
