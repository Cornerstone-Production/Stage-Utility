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

## Files

- `main/services/wireless-manager.ts` — connection list, config persistence, meter rate
- `main/services/device-manager.ts` — one provider per connection, channel namespacing
- `main/services/wireless-store.ts` — persisted connection config
- `main/providers/registry.ts` — provider descriptors + `hasDriver` / `createProvider`
- `main/providers/wireless/` — Shure (`shure-*.ts`) and Sennheiser drivers
- `main/services/integration-manager.ts` — `WIRELESS_DESCRIPTOR`, `refreshWirelessSummary()`
- `main/services/remote-server.ts` — `/api/wireless/connections`, `/api/wireless/meter-rate`, `/api/wireless/providers`, `/api/integrations/wireless/channels`
- `renderer/main/layout-renderer.tsx` — `wireless-summary`, `wireless-channel`, `charger-battery` render cases
- `renderer/main/use-wireless-channels.ts` — live channel hook
