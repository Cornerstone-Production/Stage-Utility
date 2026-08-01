# Smaart (SPL) integration

Surfaces live FOH SPL readings from Rational Acoustics Smaart on dashboards and a
custom-layout **SPL meter** object.

## How it works

Stage connects to Smaart's modern JSON-over-WebSocket API (default port 26000,
Smaart 8.3+). Legacy V1 (Smaart 7.2–8.2, a binary C-SDK protocol) is intentionally
not supported.

- `ModernSmaartAdapter` opens one control connection, negotiates the API version
  (SDK V3 covers 8.3–9.0.1, V4 covers 9.5+ — only the `/api/vN/` path differs),
  authenticates if the server requires it, and lists the calibrated inputs.
- `SmaartService` then opens one SPL Metric Stream per input, each pushing readings
  up to 8 fps; it requests ~4 fps and trailing-throttles broadcasts to 4 Hz so an
  8 fps meter never re-renders every display 8×/sec.
- Readings are keyed `deviceName::channelName` with Smaart's own metric names
  (e.g. `SPL Fast`, `SPL A Slow`, `LAeq 10`). The connect/reconnect loop uses
  exponential backoff, capped by the PCO-time-aware service window, and only pushes
  when a display is subscribed.

State broadcasts on the `spl:metrics` SSE channel. The latest snapshot is also read
by the SPL history recorder (independent of whether any display is watching).

## Setup

**In Smaart:** Options → Preferences → API → enable the API (default port 26000);
set a password only if you want authentication.

**In Stage:** Settings → Integrations → **Smaart (SPL)** → enter the **Host** and
**Port**, optionally the **API Password**, enable it, and **Test connection** (it
reports the app version and how many calibrated inputs it found). The password is
stored encrypted on this machine.

**On a layout:** add object → **Smaart SPL → SPL meter** → pick the meter
(`deviceName::channelName`) and metric key; optional peak-hold shows the highest
value seen for that meter/metric.
