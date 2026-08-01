# RossTalk integration (Carbonite / Ultrix)

Sends RossTalk commands to Ross Video gear — custom controls and switching on a
**Carbonite** switcher, routing and salvos on an **Ultrix** router.

Both Ross integrations share one **Ross** card on the Integrations page. That is a
visual grouping only: each keeps its own id, enable switch, config and connection
state, so layout buttons and automation actions referencing either one are
unaffected.

Distinct from the [Ross MultiViewer (TSL UMD)](ross-tsl.md) integration, which writes
*text* onto multiviewer tiles. RossTalk issues *commands*; it cannot set tile text.

> **Send-only.** Neither device reports status, so Stage cannot show what state your
> switcher is in and cannot tell a successful command from one the device ignored. A
> button is a trigger, never an indicator.

## How it works

RossTalk is a plain-text protocol over TCP:

- Port **7788** on both devices.
- Commands are ASCII, terminated **CR/LF**, and are **case sensitive**.
- Nothing is ever sent back. Incoming bytes are drained and discarded.

Stage keeps one persistent TCP socket per enabled target. Because it is TCP, the
connection badge is honest — a successful connect really does prove the device is
reachable, unlike OSC where "connected" can only mean "configured".

Commands come from a **catalogue** (`rosstalk-commands.ts`) — pure formatters with
typed parameters, so the UI renders a form and the wire string is validated before a
socket is touched. That matters more than usual here: a malformed command produces no
error from the device, it simply does nothing.

## The two device families are not interchangeable

This is the most important thing to get right when adding a target.

| | Carbonite | Ultrix |
|---|---|---|
| `XPT` | `XPT vid-dest:vid-source` | `XPT D:5 S:16 I:7 L:1,6,10-13` |
| `GPI` | fires a GPI **output** | fires a **salvo** |

Same verb, different syntax, different meaning. Every command therefore belongs to
exactly one family, and each target declares which family it is. Pick the wrong one and
Stage refuses the command rather than sending nonsense — the UI only ever offers
commands for that target's family, and the server checks again before writing.

### Commands available

**Carbonite:** custom control (`CC`), GPI output, key cut/auto, ME cut/auto, memory
recall/save, transition rate/type, crosspoint, clip load, fade to black, sequencer.

**Ultrix:** route crosspoint, fire salvo, clock control (run/stop/pause/end).

Plus a **raw** escape hatch on both, for anything Ross adds later. Raw input has its
line terminators stripped, so one raw entry is always exactly one command — a pasted
string containing CR/LF cannot smuggle a second command onto the wire.

## Simulate mode

A global switch, **on by default**. With it on, commands are validated, formatted,
logged and reported back — but nothing is written to the socket.

Leave it on while you build. The failure it protects against is not a wrong command so
much as an untested one: because the device never replies, the only way to know what
Stage will send is to read the line it reports in simulate.

The panel shows simulate in amber precisely because it is the *abnormal* state — the
one that silently does nothing. Forgetting to turn it off before a service is the
likelier mistake than leaving it off.

**Test connection** connects and sends nothing. On a device where a probe packet would
itself be a command, there is no safe probe — so Test proves the socket opens and no
more.

## Setup

**On the device:** enable RossTalk. On a Carbonite it is under the network/comms setup;
the default device address is `192.168.0.123`. Note the IP; the port is 7788.

**In Stage:** Settings → Integrations → **RossTalk (Carbonite / Ultrix)** → **Add
target** → name it, set host and port, choose **Carbonite switcher** or **Ultrix
router**, enable it, and press **Test**.

The integration ships **disabled**, so nothing is dialled until you turn a target on.

**On a layout:** add object → **Control → RossTalk button**. Choose the target, then a
command; the parameter fields follow the command you picked. The button only fires on a
real display or operator surface — never in the editor or the live preview.

## First contact with real hardware

Do this off-air.

1. Add the target, leave **simulate on**, press **Test**. Confirms reachability without
   sending anything.
2. Fire the button with simulate still on. Read the exact line from the toast and the
   server log; confirm it character for character.
3. Turn simulate off and fire **something harmless** — a spare custom control on an
   unused bank, never `FTB` or `MECUT`.
4. Only then wire up buttons that do real work.


## API

`POST /api/rosstalk/send` is the entry point for the layout button, Bitfocus Companion
and (in future) automation rules alike:

```json
{ "targetId": "…", "commandId": "cc", "params": { "bank": 1, "cc": 5 } }
```

or `{ "targetId": "…", "raw": "CC 1:05" }`. It replies with the line that was sent —
or would have been, in simulate:

```json
{ "ok": true, "line": "CC 1:05", "simulated": true }
```

A rejected command returns **400** with the reason. That is operator error, not a
server fault.
