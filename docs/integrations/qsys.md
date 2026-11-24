# Q-SYS integration

Connects to a Q-SYS Core over QRC (JSON-RPC over TCP, default port 1710) and
reads the design's components and controls.

## How it works

- The service connects to the Core, logs on if a user is set, reads the design
  status and then every component and its controls (the catalog).
- A silent connection is kept alive with a `NoOp` after 30 seconds without a
  request; the Core drops a connection after 60 seconds of silence.
- If the connection drops, the service reconnects with exponential backoff, capped
  by the PCO-time-aware service window. A logon the Core refuses is retried the
  same way and logged.
- When the Core reports a new design (a different design code, as after a redeploy
  or a Core restart), the catalog is read again.
- The integration never calls a method that changes the design.

`/log` shows the decisions, tagged `[qsys]`: `connected to <design> (<n> components,
emulator=<bool>)`, `logon refused`, `connection lost: <reason>` and `design changed,
refreshing catalog`.

Status broadcasts on the `qsys:status` SSE channel: connected, reconnecting or
offline, the design name, whether the Core is an emulator, and when the catalog
was last read.

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
| Volunteer meter rate | Meter updates per second on volunteer panels. Whole number, 1 to 30, default 10. |
| Staff meter rate | Meter updates per second on staff panels. Whole number, 1 to 30, default 20. |

Enable the integration and use **Test connection**. It connects, logs on, and
reports `Connected to <design name>` with the number of components it read, or
the reason it could not. Saving any field, the meter rates included, reconnects to
the Core. A rate outside 1 to 30 is brought into range when it is saved.

### Trying it without a Core

Q-SYS Designer in **Emulate** answers QRC on the machine it runs on, port 1710.
Point **Core host** at that machine to try the integration with no Core. The
status reports `emulator` so it is not mistaken for a live Core.

## What it never does

It reads the design. It never calls a method that changes the design: no components are added, no designs loaded, no Core settings changed.

## Troubleshooting

Look at `/log` and filter for `[qsys]`.

| Line or message | Meaning |
|---|---|
| `connecting to <host>:<port>` | The service is dialling. If nothing follows, the address or port is wrong, or the machine is not reachable. |
| `<host> connection failed: <reason>` | The Core did not answer. `ECONNREFUSED` usually means nothing listens on that port; a timeout means a network path problem. |
| `logon refused` | The user or password is wrong, or the user lacks access. Test connection reports "The Core refused the user name or password". |
| `connection lost: <reason>` | The connection dropped. The service reconnects with backoff. |
| `connected to <design> (<n> components, emulator=<bool>)` | Connected and the catalog is read. Few or no components usually means Script Access is not set where it is needed, or no design is running. |
| `design changed, refreshing catalog` | The Core reports a new design code, as after a redeploy or a Core restart. |
| `meter rates set: volunteer <n>/s, staff <n>/s` | A meter rate was changed. |
| `ignoring a non-numeric <rate>; the stored rate is unchanged` | A save carried a meter rate that was not a number. |
