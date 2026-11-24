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

Status broadcasts on the `qsys:status` SSE channel: connected, reconnecting or
offline, the design name, whether the Core is an emulator, and when the catalog
was last read.

## Setup

**In Stage:** Settings → Integrations → **Q-SYS** → enter the **Core Host**, the
**QRC Port** if it is not 1710, and a **User** and **Password** only if the Core
requires a logon. Enable it and use **Test connection**, which reports the design
name and how many components it found. The password is stored encrypted on this
machine.

Q-SYS Designer in Emulate answers QRC on the machine it runs on, port 1710, so the
integration can be tried without a Core.
