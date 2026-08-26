# Wireless Gear integration

Monitors wireless mic / IEM receivers and battery chargers (Shure, Sennheiser)
and surfaces RF, battery, frequency and audio level on stage displays.

## How it works

Unlike the single-host integrations, "wireless" is a master enable toggle over a
list of connections you manage yourself. Each connection picks a provider (driver)
and carries its own host / port / channel-count config:

- `WirelessManager` owns the connection list (persisted via `wirelessStore`) and a
  global metering interval (default 1000 ms) applied to every device.
- `DeviceManager` reconciles one live provider instance per enabled connection,
  namespaces each provider's channels as `${connectionId}::${channelId}`, and feeds
  their status into `StageController`.
- Shure drivers talk ASCII-over-TCP (port 2202 for ULX-D / Axient / PSM); Shure SBC
  chargers, Sennheiser ewG4 / EW-DX / Spectera each have their own driver. Providers
  named "None" (and any not-yet-shipped driver) are placeholders that connect to
  nothing and report "driver arrives in a future update".

State broadcasts on the `wireless:connections-changed` SSE channel (connection
list + runtime status). Charger bays flow through the shared stage state.

Where a driver needs a password — Spectera's base-station API password — it is
kept in the encrypted `secrets.bin`, not in `wireless-connections.json`, so it is
excluded from config snapshots like every other credential. The API and the SSE
channel report it as `••••` when set and `""` when not; saving the mask back
leaves it unchanged, and saving an empty value clears it.

## Setup

**On the gear:** give each receiver / charger a static IP and enable its network
control / telemetry (Shure networked gear uses TCP 2202).

**In Stage:** Settings → Integrations → **Wireless Gear** → enable the master
toggle → **Add connection** → pick the provider, name it, and enter Device IP,
TCP Port, and Number of Channels → enable it → **Test connection**. The global
meter rate is set once and applies to all wireless gear.

**On a layout:** add object → wireless:
- **Wireless summary** — online count (`online/total`), the lowest battery %, and
  optionally the shortest runtime left across the fleet.
- **Wireless channel** — one channel's RF bars, battery %, runtime remaining,
  frequency and audio level (each toggleable).
- **Charger battery** — a charger bay's battery state.

Charger bays are deliberately absent from the first two. A bay is not a mic: an
empty one would drag "lowest battery" to zero, and a shelf of docked spares would
pad the online count.

### Battery percentage and time remaining

Percentage answers "how full"; runtime answers "will it last the service", and the
two do not track each other — the same 60% is three hours on one pack and forty
minutes on another. Wireless Workbench leads with runtime for that reason, and the
widgets can too: turn **Battery %** off and **Time remaining** on to make the
runtime the headline figure.

Runtime is reported by the receiver, not computed here, so it only appears where
the gear provides one:

| Provider | Runtime remaining |
|---|---|
| Shure Axient Digital | yes (`TX_BATT_MINS`) |
| Shure ULX-D | yes (`BATT_RUN_TIME`) |
| Sennheiser EW-DX | yes, where the rack reports `battery/lifetime` |
| Shure PSM, Sennheiser ewG4, Spectera, SBC chargers | no — shows a dash |

The reading is coloured against a service rather than a percentage: green past 90
minutes, amber past 30, red below — enough for a service, enough for one that has
started, and time to go and swap it.

## Reconnecting

A receiver that drops is retried with a growing back-off, clamped to the service
window — so gear nobody is looking at is not polled hard all week. Opening the
Wireless Gear panel overrides that: while you are watching, retries stay brisk
regardless of the window, so a pack you are waiting on comes back promptly rather
than on the dormant schedule.
