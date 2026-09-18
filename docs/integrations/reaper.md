# REAPER integration

Surfaces REAPER's live recording state on stage displays via a custom-layout
**REAPER status** object (mirrors the OBS status object — red while recording).

## How it works

REAPER has no external scripting socket (ReaScript runs in-process only), so the
integration polls REAPER's built-in **Web Interface** over HTTP:

- `GET http://<host>:<port>/_/TRANSPORT` returns one tab-separated line:
  `TRANSPORT \t playstate \t position_seconds \t isRepeatOn \t position_string \t position_beats`
- `playstate` is a bitmask: bit0 playing, bit1 paused, **bit2 recording**. REAPER
  reports `0` stopped, `1` playing, `2` paused, `5` recording, `6` record-paused.
- Recording = `(playstate & 4) === 4`.

The poller polls ~1 s while a display is
watching the `reaper:status` channel, drops to ~5 s when nobody is, and backs off
exponentially while REAPER is unreachable. It broadcasts on change (and each
second while recording, to tick the position display). No secret is stored — the
LAN web interface runs without auth in the common setup.

## Setup

**In REAPER:** Preferences → Control/OSC/web → Add → **Web browser interface** →
tick *Run web server on port* (e.g. `8080`) → leave *Username:password* blank →
**Apply settings** (status must read "running"). Note the Access URL's IP.

**In Stage:** Settings → Integrations → **REAPER** → enter the
**Host** (that IP) and **Port**, enable it, and **Test connection**.

**On a layout:** add object → **REAPER → REAPER status**. Options: recording/idle/
offline text overrides, fill-red-when-recording, show-position, hide-when-idle.

## Driving the transport

The same web interface runs an action, so an automation rule can start and stop a
recording: the **REAPER transport** action (Record, Stop, Play) needs nothing set
up beyond this integration's host and port. REAPER's Record is a toggle, so the
action reads the transport first and sends nothing when REAPER is already
recording.

**Record refuses when the transport cannot be read.** Anything that answers the
request with an HTTP 200 that is not a TRANSPORT line — a captive-portal
redirect, a reverse proxy, a login page on `/_/` — is *unknown*, not *stopped*,
and pressing a toggle on an unknown is how "start recording" ends the recording
of the service. The action fails with a message naming the host instead, and the
poll reports the same thing on the REAPER row rather than a green badge over a
machine it cannot read. Stop and Play are idempotent in REAPER itself and still
go out.

A `_on`/`_off` cue pair built from Record and Stop reports its real state to Home
Assistant, read from this poll rather than from Companion. See
[Automation](../automation.md#state-from-stage-utility).

**That pair is already built.** While REAPER is switched on in Settings,
`reaper_record_on` / `reaper_record_off` is a
[built-in cue](../automation.md#built-in-cues) — a switch in Home Assistant, a
cue button on a panel — with no rule to write, and those two names are reserved.

The transport is also readable: **REAPER starts recording** and **REAPER stops
recording** are triggers, and **REAPER is recording** is a condition. An enabled
rule using any of them holds the poll at its active cadence with no browser
open. The stop trigger does not fire when REAPER simply becomes unreachable —
that is unknown, not stopped.
