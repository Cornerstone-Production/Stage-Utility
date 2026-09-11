# OBS Studio integration

Surfaces OBS's live output state (recording / streaming / virtual cam) on stage
displays via a custom-layout **OBS status** object — red while recording.

## How it works

The integration talks to OBS's built-in **obs-websocket v5** server over a
WebSocket (JSON message protocol, default port `4455`, optional password):

- On connect it does the obs-websocket handshake, then seeds state with
  `GetRecordStatus`, `GetStreamStatus` and `GetVirtualCamStatus` (each
  best-effort — older/denied requests fall back to defaults).
- It then stays live on the `Outputs` event group: `RecordStateChanged`,
  `StreamStateChanged` and `VirtualcamStateChanged` fold into the status
  snapshot. `recording` stays true while a recording is paused.
- While recording, a 1 Hz poll (`GetRecordStatus`) refreshes the record
  timecode, trimmed from `HH:MM:SS.mmm` to whole seconds.

The service broadcasts the snapshot on the
`obs:status` channel on change (and each second while recording, to tick the
timecode). It uses a configure/connect/reconnect loop with exponential backoff
and goes quiet when unreachable. The password is stored as an encrypted secret.

### When it stops trying

Three obs-websocket close codes end the connection for good rather than starting
a retry, because retrying cannot change the answer:

| | |
|---|---|
| `4011` | OBS ended the session — this is what the **Kick** button in OBS's session list sends, and obs-websocket documents it as "you must not automatically reconnect" |
| `4009` | the password was rejected |
| `4010` | OBS refused this obs-websocket RPC version |

Each is logged on a `[obs]` line and shown on the Integrations page. Everything
else — a network drop, OBS restarting, OBS not running yet — reconnects as
before. Saving or testing the OBS integration starts it again.

## Setup

**In OBS:** Tools → **WebSocket Server Settings** → tick *Enable WebSocket
server* → note the **Server Port** (default `4455`) → copy the **Server
Password** (or turn authentication off and leave it blank).

**In Stage:** Settings → Integrations → **OBS Studio** →
enter the **Host** (the machine running OBS), **WebSocket Port** and **Server
Password**, enable it, and **Test connection**.

**On a layout:** add object → **OBS → OBS status**. Options: **mode**
(recording / streaming / virtualcam), recording/idle/offline text overrides,
show-timecode (recording mode only), fill-red-when-recording, hide-when-idle
(pure tally-light — nothing on screen unless the chosen output is active).
