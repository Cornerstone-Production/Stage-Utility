# RossTalk control — design

**Status:** approved 2026-07-26. Scope is the *foundation* slice only.

Adds outbound RossTalk control of Ross Video gear — specifically a **Carbonite**
switcher and an **Ultrix** router — alongside the existing Ross TSL UMD integration
(which is unrelated: TSL writes multiviewer tile text, RossTalk issues commands).

## Scope

**In:** the transport, a command catalogue for both device families, a managed target
list, a `rosstalk-button` layout object, a send API that Bitfocus Companion can call,
and a global simulate mode.

**Out, deliberately:** firing commands automatically from service events (PCO going
live, plan advancing, ProPresenter sections) and on a schedule. Both were asked for
and both are wanted — they are a **rule engine**, a separate subsystem with its own
event model, edit UI and misfire risk, and they get their own spec. Scheduling is a
time-triggered rule, so it belongs with automation rather than here.

**Prerequisite:** this design builds on `ConnectionLifecycle`
(`main/services/integration-base.ts`) and the layout-object registry
(`renderer/main/layout-objects.ts`). Neither is on `beta` yet — both land with PRs
#128–#130. Implementation should start after those merge. If they slip, the transport
can hand-roll its lifecycle as the pre-refactor services did, and the button can be
added via the old seven-structure route, but neither fallback is preferred.

## Protocol facts

Verified against Ross's published documentation, not from memory:

- Both devices listen on **TCP 7788**.
- Commands are **plain ASCII, terminated CR/LF**.
- Commands are **case sensitive**.
- The protocol is **send-only** — neither device documents a status response.

Sources:
[Carbonite commands](https://help.rossvideo.com/carbonite-device/Topics/Protocol/RossTalk/CNT/RT-CNT-Comm.html),
[Ultrix commands](https://help.rossvideo.com/carbonite-device/Topics/Protocol/RossTalk/UT/RT-UT-Comm.html)

### The two families are not interchangeable

This is the single most important constraint in the design.

| | Carbonite | Ultrix |
|---|---|---|
| `XPT` | `XPT vid-dest:vid-source` | `XPT D:5 S:16 I:7 L:1,6,10-13` |
| `GPI` | fires a GPI **output** | fires a **salvo** |

Same verb, different syntax and different meaning. A command is therefore always
bound to a device family, and a target declares which family it is. Sending a
Carbonite `XPT` to an Ultrix must be impossible by construction, not by care.

### Commands in scope

**Carbonite:** `CC b:cc`, `GPI xx`, `KEYAUTO`, `KEYCUT`, `MEAUTO`, `MECUT`,
`MEM b:m:ME-source:ME-number`, `MEMSAVE`, `TRANSRATE`, `TRANSTYPE`,
`XPT vid-dest:vid-source`, `CLIPLOAD clip-name`, `FTB`, `SEQI sequencer:seq`

**Ultrix:** `GPI xx` (salvo), `TIMER xx:RUN|STOP|PAUSE|END`,
`XPT D:d S:s I:id L:levels` (levels optional; comma-separated with ranges)

Plus a **raw** escape hatch on both, for anything Ross adds or this misses.

## Architecture

Five new modules, mirroring how OSC is structured (`osc-manager` / `osc-store` /
`osc-codec`), because "send commands to LAN gear from a layout button" is the same
shape and should not invent a second pattern.

```
main/types/rosstalk.ts              types (target, command, param)
main/services/rosstalk-commands.ts  the command catalogue — PURE, no I/O
main/services/rosstalk-store.ts     persisted targets + simulate flag
main/services/rosstalk-manager.ts   target list, TCP connections, send()
main/services/routes/rosstalk-routes.ts  /api/rosstalk/*
```

Renderer: a `rosstalk-button` entry in the layout-object registry, a button
component beside `osc-button.tsx`, and a targets panel in Integrations.

### Targets

```ts
interface RossTalkTargetConfig {
  id: string;
  name: string;                 // "Carbonite PGM", "Ultrix Router"
  enabled: boolean;
  config: {
    host?: string;
    port?: number;              // default 7788
    family?: "carbonite" | "ultrix";
  };
}
```

Managed as a list like OSC targets, so the integration descriptor carries no config
fields of its own. `family` gates the command list offered in the UI and selects the
formatter.

### Command catalogue

```ts
type RossTalkFamily = "carbonite" | "ultrix";

interface RossTalkParam {
  key: string;
  label: string;
  type: "number" | "string" | "enum";
  min?: number;                 // number
  max?: number;
  pad?: number;                 // zero-pad width, e.g. CC's 2
  options?: string[];           // enum
  optional?: boolean;
}

interface RossTalkCommand {
  id: string;                   // "cc", "xpt-ultrix", "timer" …
  label: string;                // "Custom control"
  family: RossTalkFamily;       // exactly one — see the XPT divergence
  params: RossTalkParam[];
  /** Build the wire line WITHOUT the CR/LF terminator. */
  format(values: Record<string, string | number>): string;
}

const ROSSTALK_COMMANDS: Record<string, RossTalkCommand>;
```

`format` is pure, so every wire string is unit-testable with no device and no socket.

**Every command belongs to exactly one family**, so anything that differs across the
two becomes two entries rather than one branching function — the divergence stays
visible in the data:

- `xpt-carbonite` / `xpt-ultrix` — different syntax entirely.
- `gpi-carbonite` / `gpi-ultrix` — *identical* syntax (`GPI xx`), but they are still
  separate entries because they mean different things. Carbonite fires a GPI output;
  Ultrix fires a salvo. They therefore need different labels and different help text
  in the UI, and an operator picking "Fire salvo" should never see it offered for a
  switcher.

This is why the id and the label carry the meaning, not the verb.

Zero-padding is declared (`pad: 2`) rather than done by each formatter, so `CC 1:5`
always goes out as `CC 1:05`.

### Transport

One `RossTalkConnection extends ConnectionLifecycle` per enabled target: a persistent
TCP socket, CR/LF framing on write, nothing parsed on read (the protocol never
replies; incoming bytes are drained and discarded).

It **overrides `scheduleReconnect()` to keep its own fixed cap**, for the same reason
Ross TSL does: nothing subscribes to an output channel, so the shared window-aware cap
reads it as dormant and stretches retries toward 30 minutes — meaning a switcher
powered on mid-week could sit unreachable for half an hour.

Because this is TCP, the connection badge is honest: a successful connect really does
prove the device is reachable. That is a genuine improvement over OSC, where
"connected" can only ever mean "configured".

### Send path

```
button tap / Companion  →  POST /api/rosstalk/send
                        →  manager.send(targetId, commandId, params | raw)
                        →  validate params against the command spec
                        →  format() → "CC 1:05"
                        →  simulate?  log + broadcast, return         [no socket]
                        →  else       socket.write(line + "\r\n")
```

Validation failures return 400 with the reason and never reach a socket. This matters
more than usual: the protocol is send-only, so a malformed command produces no error
from the device — it simply does nothing, silently.

## Safety

The operator-facing behaviour is deliberately **unguarded**: no per-button
confirmation, no service-window gating. A switcher panel does not ask twice, and
adding friction to a live operator's path is its own hazard.

The protection is instead a single global switch.

**Simulate mode** — persisted, default **on** for a fresh install. When on, `send()`
performs every step *except* the write: it validates, formats, logs the exact line,
broadcasts it for the UI, and returns success. No bytes reach the device.

Two decisions worth stating explicitly:

1. **Simulate blocks sends, not connections.** A TCP connect to 7788 does not alter
   switcher state, and blocking it would make host/port impossible to validate —
   which is most of the value of simulate mode. If zero-traffic is ever required,
   disabling the integration achieves it absolutely.
2. **"Test connection" connects and sends nothing.** The TSL integration's test sends
   a probe packet; here a probe *is* a command, so it cannot. Test proves the socket
   opens and nothing more.

**The integration ships disabled**, so a fresh install and an unconfigured upgrade
both produce zero traffic.

**Raw command sanitising.** A raw string containing CR or LF would smuggle multiple
commands onto the wire in one send. Raw input has its line terminators stripped and
is rejected if what remains is empty, so one raw entry is always exactly one command.

## Surfaces

### API

| Route | Purpose |
|---|---|
| `GET /api/rosstalk/targets` | list targets |
| `POST /api/rosstalk/targets` | add |
| `PATCH /api/rosstalk/targets/:id` | update (name, enabled, host, port, family) |
| `DELETE /api/rosstalk/targets/:id` | remove |
| `POST /api/rosstalk/targets/:id/test` | connect only, send nothing |
| `GET /api/rosstalk/commands` | the catalogue, for the UI to render forms from |
| `POST /api/rosstalk/send` | `{ targetId, commandId, params }` or `{ targetId, raw }` |
| `GET/POST /api/rosstalk/simulate` | read / set the global simulate flag |

`/api/rosstalk/send` is also Companion's entry point — no separate mechanism.

Target changes broadcast on `rosstalk:targets-changed`; simulated sends broadcast on
`rosstalk:simulated` so the UI can show what would have gone out.

### Layout object

`rosstalk-button`, one registry entry in `renderer/main/layout-objects.ts`:

- group: `Control` (beside the OSC button)
- config: `{ targetId, commandId, params, label }`
- style: the shared `PILL` preset, matching `osc-button`
- integration: `{ id: "rosstalk", label: "RossTalk" }` so it dims until set up
- **no feedback binding** — the protocol cannot report state

In simulate mode the button renders with a visible simulate affordance, so an operator
can never mistake a simulated tap for a real one.

## Testing

The catalogue is pure and the transport is socket-shaped, so both are testable without
touching a device. **No test may ever open a socket to a real switcher.**

**Command catalogue** — for every command: exact wire string, zero-padding
(`CC 1:5` → `CC 1:05`), both `XPT` dialects side by side, optional params omitted
cleanly (Ultrix `L:` levels), out-of-range and wrong-type rejection, and that
`format()` never emits CR or LF itself.

**Raw sanitising** — `"FTB\r\nMECUT 1:1"` must become one command, and a raw string
that is only whitespace or terminators must be rejected.

**Family gating** — a Carbonite command against an Ultrix target is rejected before
formatting.

**Transport** — against a **local fake TCP server** that captures bytes: the line is
written with exactly one trailing CR/LF; simulate mode writes nothing at all; a
disconnected target queues nothing and reports the failure; reconnect uses the fixed
cap rather than the window-aware one.

## Risks

- **Silent failure is the norm.** Send-only means a wrong-but-well-formed command is
  indistinguishable from a correct one. Validation and the command catalogue are the
  only defence, which is why the raw escape hatch is a deliberate, narrow exception
  rather than the primary interface.
- **Wrong-target sends.** Family gating prevents syntax mismatches but cannot prevent
  firing a valid command at the wrong Carbonite if two are configured. Target naming
  is the only mitigation; worth revisiting if a second switcher ever appears.
- **First real send is untested by definition.** Everything here is verified against a
  fake server. The first command to touch actual hardware must be done off-air, with
  simulate mode used first to confirm the exact line, and something harmless — a spare
  custom control, not `FTB`.
