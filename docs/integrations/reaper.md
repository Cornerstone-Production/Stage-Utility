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
