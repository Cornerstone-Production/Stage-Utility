# Ross MultiViewer (TSL UMD) integration

Pushes a live people count onto a Ross multiviewer tile as on-tile text using the
TSL UMD 3.1 protocol over TCP.

This and [RossTalk](rosstalk.md) are separate cards, side by side on the Integrations
page, each with its own enable switch, config and connection state.

## How it works

RossTalk can't set arbitrary multiviewer text, so the sender
(`main/services/tsl-service.ts`) uses TSL UMD 3.1 — the protocol that overwrites a
tile's source label — over a persistent TCP socket to the Ross device.

- The sender consumes **`people:count`** broadcasts from the SenSource Vea
  integration: the integration-manager forwards each update to
  `tslService.onPeopleCount()`.
- Each **feed** maps a count (metric `attendance` or `occupancy`; building total,
  or a specific `zoneId`) to a tile's TSL **display address** (0..126), with
  optional prefix/suffix (the feed row's **TSL #** is the address, with **Building total** or a zone, and **prefix** and **suffix** fields). On every `people:count` update — and on a periodic 5s
  refresh so a tile never goes stale/blank — Stage formats the value and writes an
  18-byte TSL 3.1 packet per feed.
- The packet is hand-built (zero-dep): header `0x80 | address`, a control byte at
  full brightness, then exactly 16 space-padded printable-ASCII bytes
  (`buildTsl31Packet`): the text is cut at 16 characters and anything outside printable
  ASCII becomes a space. A count with no reading yet (no SenSource data, or a zone that
  is not in it) is sent as the prefix and suffix around a blank.
- The socket auto-reconnects with exponential backoff (3s → 30s) if the Ross
  device drops. The 30 s ceiling is fixed: nothing subscribes to a tally output, so the
  service-window cap the other integrations use would read it as dormant and leave a
  switcher powered on mid-week dark for half an hour.
- While the socket is connected and a feed exists, SenSource keeps polling even with no
  browser watching, so the tile keeps moving.
- `/log` carries `[tsl] connecting <host>:<port>` when it starts and `[tsl] write error:
  …` if a packet cannot be written. A refused or dropped connection shows on the card as
  *Can't reach <host>:<port>* and retries quietly.

## Setup

**In the Ross device:** configure a TSL UMD input (its UMD/TSL setup), note the
TSL input **port**, and note the tile's **TSL display address**.

**In Stage:** Settings → Integrations → **Ross MultiViewer (TSL UMD)** → enter the
**Switcher Host** (IP/hostname on the same network) and **TSL Port**, enable it,
and **Test connection** (opens a TCP socket and sends nothing, so a test
cannot overwrite a tile). Then, in
the feeds panel, add one or more **feeds** mapping a count → tile TSL address. The
host/port and feed mappings are all saved as non-secret config (no secret is
stored).

**TSL Port** has no default — it is whatever the Ross is set to — so it starts
**blank**, showing `Not set` in grey. Blank means the integration is not
configured: nothing connects, and the card stays under "Not set up". Anything
outside **1–65535** is rejected as you type; a value already stored outside that
range is left alone until you type in the field.
