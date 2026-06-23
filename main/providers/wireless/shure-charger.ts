// shure-charger.ts — DeviceProvider for Shure SBC-series networked docking
// chargers (SBC220 / SBC240). Protocol: ASCII-over-TCP on port 2202, same
// `< ... >` framing as the other Shure providers, but addressed per BAY rather
// than per RF channel. A bay reports battery charge %, cycle count, health %,
// temperature and charging state for the docked battery/transmitter.
//
// NOTE: the exact command tokens below are the documented SBC220/240 set as best
// determined without the unit on the bench. They are parsed defensively (several
// aliases accepted) and every raw frame is logged under SHURE_DEBUG=1, so the
// token names can be confirmed/adjusted against a live charger the same way the
// Axient handheld fields were locked in.

import type { ConfigField } from "../../types/integrations.js";
import { ShureBaseProvider, clamp, safeInt, stripBraces } from "./shure-base.js";

export class ShureCharger extends ShureBaseProvider {
  readonly id = "shure-charger";
  readonly label = "Shure SBC Charger";
  readonly configSchema: ConfigField[] = [
    { key: "host", label: "Device IP / Hostname", type: "text", placeholder: "192.168.1.110" },
    { key: "port", label: "TCP Port", type: "number", placeholder: "2202" },
    // One SBC220 = 2 bays; up to 4 can be linked behind one IP, reporting bays
    // 1–8. Set this to 2 × (number of linked units).
    { key: "channels", label: "Number of Bays", type: "number", placeholder: "8" },
  ];

  protected readonly defaultChannels = 8;
  protected readonly defaultDeviceType = "charger" as const;

  // Re-poll the bays on a timer — chargers change slowly and may not push.
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_MS = 15_000;

  protected initChannelStates(count: number): void {
    super.initChannelStates(count);
    for (let n = 1; n <= count; n++) {
      const state = this.channelStates.get(n);
      if (state) {
        // Chargers have no RF / audio / frequency.
        state.rfBars = null;
        state.rfLevelDbm = null;
        state.frequencyLabel = null;
        state.audioLevel = null;
        state.deviceType = "charger";
      }
    }
  }

  protected onConnected(): void {
    console.log(`[shure:${this.id}] sending init commands`);
    this.pollAllBays();
    if (this.pollTimer) clearInterval(this.pollTimer);
    // send() is a no-op while disconnected, so a lingering interval is harmless;
    // re-created on each (re)connect.
    this.pollTimer = setInterval(() => this.pollAllBays(), ShureCharger.POLL_MS);
  }

  private pollAllBays(): void {
    // One command dumps every field for all bays (+ device info). Confirmed
    // against a live SBC220 (FW 1.4.53): per-bay BATT_DETECTED/CHARGE/STATE/
    // CYCLE/HEALTH/TEMP_F, device-level MODEL/FW_VER/DEVICE_ID.
    this.send("GET 0 ALL");
  }

  protected handleReport(channel: number, token: string, rest: string[]): void {
    if (channel === 0) {
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }
    const state = this.channelStates.get(channel);
    if (!state) return;
    const value = rest.join(" ");

    switch (token) {
      // Occupancy: a battery is docked in the bay. Clears stale readings when removed.
      case "BATT_DETECTED": {
        const present = stripBraces(value).toUpperCase() === "YES";
        state.online = present;
        if (!present) {
          state.battery = null;
          state.charging = null;
          state.cycles = null;
          state.health = null;
          state.tempC = null;
        }
        break;
      }

      // Charge percent (0–100, zero-padded e.g. "087").
      case "BATT_CHARGE": {
        const n = safeInt(value);
        if (!Number.isNaN(n)) state.battery = clamp(n, 0, 100);
        break;
      }

      // FULL | CHARGING | … — drives the charging indicator.
      case "BATT_STATE": {
        const v = stripBraces(value).toUpperCase();
        state.charging = v === "CHARGING";
        break;
      }

      // Charge cycles (zero-padded e.g. "00569").
      case "BATT_CYCLE": {
        const n = safeInt(value);
        state.cycles = Number.isNaN(n) ? null : n;
        break;
      }

      // State-of-health percent.
      case "BATT_HEALTH": {
        const n = safeInt(value);
        state.health = Number.isNaN(n) ? null : clamp(n, 0, 100);
        break;
      }

      // Temperature: read from Fahrenheit and convert. The SBC220's BATT_TEMP_C
      // field is unreliable on tested firmware (reports e.g. 062 while _F says
      // 111°F ≈ 44°C), so we source from _F.
      case "BATT_TEMP_F": {
        const f = safeInt(value);
        state.tempC = Number.isNaN(f) ? null : Math.round(((f - 32) * 5) / 9);
        break;
      }

      default:
        // Other fields in the GET 0 ALL dump (BATT_BARS, BATT_TEMP_C, capacities,
        // BATT_MODULE_TYPE, BATT_ERROR, device-level MODEL/FW_VER/…) are ignored.
        break;
    }

    this.emitStatus(channel);
  }

  // Chargers don't send SAMPLE metering frames.
  protected handleSample(channel: number, _tokens: string[]): void {
    console.debug(`[shure:${this.id}] ch${channel} unexpected SAMPLE — ignoring (charger)`);
  }
}
