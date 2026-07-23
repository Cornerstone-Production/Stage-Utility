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

The service (`main/services/obs-service.ts`) broadcasts the snapshot on the
`obs:status` channel on change (and each second while recording, to tick the
timecode). It uses a configure/connect/reconnect loop with exponential backoff
and goes quiet when unreachable. The password is stored as an encrypted secret.

## Setup

**In OBS:** Tools → **WebSocket Server Settings** → tick *Enable WebSocket
server* → note the **Server Port** (default `4455`) → copy the **Server
Password** (or turn authentication off and leave it blank).

**In Stage:** Settings → Integrations → **Control & output → OBS Studio** →
enter the **Host** (the machine running OBS), **WebSocket Port** and **Server
Password**, enable it, and **Test connection**.

**On a layout:** add object → **OBS → OBS status**. Options: **mode**
(recording / streaming / virtualcam), recording/idle/offline text overrides,
show-timecode (recording mode only), fill-red-when-recording, hide-when-idle
(pure tally-light — nothing on screen unless the chosen output is active).

## Files

- `main/services/obs-service.ts` — connect/reconnect loop, `reduceObsEvent()`, timecode poll
- `main/services/obs-protocol.ts` — obs-websocket v5 adapter (handshake, events, requests)
- `main/services/integration-manager.ts` — `OBS_DESCRIPTOR` (host/port/password)
- `main/services/remote-server.ts` — `GET /api/obs/status` + SSE hydrate (`obs:status`)
- `renderer/main/use-obs-state.ts` — live hook (`obs:status`)
- `renderer/main/layout-renderer.tsx` — `obs-status` render case
- `renderer/settings/sections/layout-editor.tsx` — object palette + inspector
