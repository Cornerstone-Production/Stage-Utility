# OSC integration

Sends OSC messages to LAN gear from custom-layout **OSC button** objects and
reflects device state back so buttons can show live feedback.

## How it works

OSC is connectionless UDP, so there is no live link — "connected" here means a
target is configured and active (ready to send). Zero external dependencies: the
manager uses Node's built-in `dgram` plus a hand-rolled OSC codec.

- **Targets** are a separately managed list (like wireless), each with a name,
  host and port, so the integration descriptor itself carries no config fields.
  An optional per-target subscribe/keepalive message (e.g. an X32 `/xremote`)
  can be sent on connect and repeated at an interval.
- **Send:** a button POSTs to `/api/osc/send` with `{ targetId, address, args }`;
  the manager encodes and sends it over one shared UDP socket.
- **Feedback:** one shared UDP socket listens on the feedback port (default
  `9000`). Incoming OSC is stored per `targetId::address` (and under a `*`
  wildcard so a button can match regardless of which target replied) and
  broadcast on the `osc:feedback` channel, throttled to ~200 ms. A button binds
  to a feedback address to reflect the device's current value.

The receive socket is open whether or not the OSC integration is enabled, so
feedback arrives as soon as gear is pointed at the port.

### What a received message becomes

| | |
|---|---|
| Argument 0 | stored under `targetId::address` — the key a button binds to |
| Arguments 1-7 | stored under `targetId::address#1` … `#7`. `#` cannot appear in an OSC address, so a suffix never collides with a real one |
| Argument 8 and up | dropped, with one `[osc]` warning per run |
| No arguments at all | stored as `true` — a bang |
| A null argument (`N`, or a blob) | skipped. The last real value for that slot stands |
| A shorter message than the last one | clears the `#N` keys the longer one left, so nothing stale reads as current |

Every value is stored twice: once under the sending target's id and once under
`*`.

**Which target sent it** is decided by the source address. A target configured
with an IP matches it directly. A target configured by **hostname** is resolved
to its addresses at startup, whenever targets change, and every five minutes
after that — consoles sit on DHCP. A name that will not resolve is logged, and
that target's feedback lands under the wildcard alone, indistinguishable from
any other sender.

Target changes are broadcast on `osc:targets-changed`; targets and the feedback
port persist on disk (no secrets involved).

## Setup

**On the device:** enable OSC and note its OSC receive host/port. To receive
feedback, point the device's OSC send/reply back at this server on the feedback
port (default `9000`).

**In Stage:** Settings → Integrations → **OSC** → add a
**target** (name, host, port; optional subscribe message) → **Test**. Set the
feedback listen port if your gear replies on a non-default port.

**On a layout:** add object → **Control → OSC button**. Set the **target**,
**label**, **address** and **args**, and optionally bind a **feedback** address
so the button reflects live device state.
