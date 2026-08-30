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
