# OBS Studio integration

Surfaces OBS's live output state (recording / streaming / virtual cam) on stage
displays via a custom-layout **OBS status** object — red while recording — and
starts and stops those outputs from a rule or a cue.

## How it works

The integration talks to OBS's built-in **obs-websocket v5** server over a
WebSocket (JSON message protocol, default port `4455`, optional password):

- On connect it does the obs-websocket handshake, then seeds state with
  `GetRecordStatus`, `GetStreamStatus` and `GetVirtualCamStatus` (each
  best-effort — older/denied requests fall back to defaults).
- It then stays live on the `Outputs` event group: `RecordStateChanged`,
  `StreamStateChanged` and `VirtualcamStateChanged` fold into the status
  snapshot. `recording` stays true while a recording is paused.
The service broadcasts the snapshot on the `obs:status` channel on change. It
uses a configure/connect/reconnect loop with exponential backoff and goes quiet
when unreachable. The password is stored as an encrypted secret.

### The record timecode

The snapshot carries an **anchor**, not a ticking string: `recordAnchorMs` is
OBS's `outputDuration` (milliseconds recorded) as it stood at `recordSampledAt`,
and each display reads it forward against the server's clock. So a recording
that is simply rolling costs no requests to OBS and no frames to any browser.

The anchor is re-read with `GetRecordStatus`:

- on every `RecordStateChanged`, which is how OBS reports a start, a stop, a
  pause and a resume alike, and
- on a 30-second keepalive, because `outputDuration` counts what was *recorded* —
  it falls behind wall-clock when frames drop or the disk stalls, and a wall
  counting seconds that were never written is worth correcting.

A paused recording holds at its anchor rather than creeping forward, and is not
re-read: OBS stops advancing `outputDuration` while paused, so there is nothing
to correct. An idle OBS is asked nothing at all.

A keepalive that cannot reach OBS logs one `[obs] record anchor` warning per
**outage**, reminds every fifteen minutes while it is still going, and writes one
line when it recovers that accounts for the whole run. A different kind of
failure inside the same run is always a new line, so one cannot mask another. An
OBS that answers every other read is one outage, not one line per miss — the same
rule every other poll in the app follows, described under [Logging an
outage](sensource.md#logging-an-outage).

The timecode keeps running from the last good anchor meanwhile, so it may drift
from OBS until the next successful read.

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

Every recording, stream and virtual-camera start and stop leaves one `[obs]`
line on `/log`, whichever button, cue or hand in OBS caused it, so "did the
recording run" has an answer on Monday.

## Driving OBS from a cue

Three automation actions drive OBS over the connection this integration already
holds: **OBS recording**, **OBS streaming** and **OBS virtual camera**, each with
a Start and a Stop. Nothing else is set up, and no Companion button is involved.

Each is idempotent. Start while OBS is already recording answers `already
recording` and sends nothing; Stop while it is not answers `already stopped`.
The virtual camera answers `already running`.
That is not politeness — obs-websocket rejects a redundant `StartRecord` with a
request error, so without it a cue called twice would be a red line in the
Activity log over a recording that is running perfectly well. With OBS
disconnected the action fails with `OBS is not connected` and sends nothing.

**Those three pairs are already built.** While OBS is switched on in Settings,
Stage Utility offers `obs_record_on` / `obs_record_off`, `obs_stream_on` /
`obs_stream_off` and `obs_virtual_cam_on` / `obs_virtual_cam_off` as
[built-in cues](../automation.md#built-in-cues) — a switch in Home Assistant, a
cue button on a panel, a name to call — with no rule to write and those names
reserved. Each reports what OBS is actually doing, from the
`RecordStateChanged` event OBS pushes the instant it changes, rather than what
the cue asked for: the pair binds itself to `app:obs.recording`,
`app:obs.streaming` or `app:obs.virtualCam`, the last being the output a video
call picks up as a webcam, so a switch in the house says whether the call can
see anything.

Build your own pair from these actions under any other name and it binds itself
the same way. See [State from Stage
Utility](../automation.md#state-from-stage-utility) and [Calling a cue by
name](companion.md#calling-a-cue-by-name).

Each decision is logged on an `[obs]` line — `[obs] record start -> sent
StartRecord`, `[obs] record start -> already recording`, `[obs] record start
refused: OBS is not connected`.

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
