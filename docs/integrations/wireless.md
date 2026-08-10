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
- **Wireless summary** — online count (`online/total`) plus the lowest battery %.
- **Wireless channel** — one channel's RF bars, battery %, frequency, audio level
  (each toggleable).
- **Charger battery** — a charger bay's battery state.

## Reconnecting

A receiver that drops is retried with a growing back-off, clamped to the service
window — so gear nobody is looking at is not polled hard all week. Opening the
Wireless Gear panel overrides that: while you are watching, retries stay brisk
regardless of the window, so a pack you are waiting on comes back promptly rather
than on the dormant schedule.
