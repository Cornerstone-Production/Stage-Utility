# Ross MultiViewer (TSL UMD) integration

Pushes a live people count onto a Ross multiviewer tile as on-tile text using the
TSL UMD 3.1 protocol over TCP.

Both Ross integrations share one **Ross** card on the Integrations page. That is a
visual grouping only: each keeps its own id, enable switch, config and connection
state, so layout buttons and automation actions referencing either one are
unaffected.

## How it works

RossTalk can't set arbitrary multiviewer text, so the sender
(`main/services/tsl-service.ts`) uses TSL UMD 3.1 — the protocol that overwrites a
tile's source label — over a persistent TCP socket to the Ross device.

- The sender consumes **`people:count`** broadcasts from the SenSource Vea
  integration: the integration-manager forwards each update to
  `tslService.onPeopleCount()`.
- Each **feed** maps a count (metric `attendance` or `occupancy`; building total,
  or a specific `zoneId`) to a tile's TSL **display address** (0..126), with
  optional prefix/suffix. On every `people:count` update — and on a periodic 5s
  refresh so a tile never goes stale/blank — Stage formats the value and writes an
  18-byte TSL 3.1 packet per feed.
- The packet is hand-built (zero-dep): header `0x80 | address`, a control byte at
  full brightness, then exactly 16 space-padded printable-ASCII bytes
  (`buildTsl31Packet`).
- The socket auto-reconnects with exponential backoff (3s → 30s) if the Ross
  device drops.

## Setup

**In the Ross device:** configure a TSL UMD input (its UMD/TSL setup), note the
TSL input **port**, and note the tile's **TSL display address**.

**In Stage:** Settings → Integrations → **Ross MultiViewer (TSL UMD)** → enter the
**Switcher Host** (IP/hostname on the same network) and **TSL Port**, enable it,
and **Test connection** (opens a TCP socket and sends a probe packet). Then, in
the feeds panel, add one or more **feeds** mapping a count → tile TSL address. The
host/port and feed mappings are all saved as non-secret config (no secret is
stored).
