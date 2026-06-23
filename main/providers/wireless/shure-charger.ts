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
    { key: "channels", label: "Number of Bays", type: "number", placeholder: "2" },
  ];

  protected readonly defaultChannels = 2;
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
    const count = this.channelStates.size;
    for (let bay = 1; bay <= count; bay++) {
      this.send(`GET ${bay} BATT_CHARGE`);
      this.send(`GET ${bay} BATT_CYCLE_COUNT`);
      this.send(`GET ${bay} BATT_HEALTH`);
      this.send(`GET ${bay} BATT_TEMP_C`);
      this.send(`GET ${bay} CHARGE_STATUS`);
      this.send(`GET ${bay} BATT_TYPE`);
      this.send(`GET ${bay} CHAN_NAME`);
    }
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
      case "CHAN_NAME":
      case "BATT_NAME": {
        state.name = stripBraces(value).slice(0, 12) || null;
        break;
      }

      // Charge percent. Shure reports 0–100; some firmwares use 0–255 — scale.
      case "BATT_CHARGE":
      case "BATT_CHARGE_PERCENT":
      case "BATT_CHARGE_PERC": {
        const n = safeInt(value);
        if (!Number.isNaN(n)) {
          const pct = n > 100 ? Math.round((n / 255) * 100) : n;
          state.battery = clamp(pct, 0, 100);
          state.online = true; // a charge reading means a battery is docked
        }
        break;
      }

      case "BATT_CYCLE_COUNT":
      case "BATT_CYCLE": {
        const n = safeInt(value);
        state.cycles = Number.isNaN(n) ? null : n;
        break;
      }

      case "BATT_HEALTH":
      case "BATT_HEALTH_PERCENT": {
        const n = safeInt(value);
        state.health = Number.isNaN(n) ? null : clamp(n, 0, 100);
        break;
      }

      case "BATT_TEMP_C":
      case "BATT_TEMP": {
        const n = safeInt(value);
        state.tempC = Number.isNaN(n) ? null : n;
        break;
      }
      case "BATT_TEMP_F": {
        const f = safeInt(value);
        state.tempC = Number.isNaN(f) ? null : Math.round(((f - 32) * 5) / 9);
        break;
      }

      case "CHARGE_STATUS":
      case "BATT_CHARGE_STATUS": {
        const v = value.toUpperCase();
        state.charging = v.includes("CHARGING") && !v.includes("NOT");
        // An explicit empty/uninserted status marks the bay offline.
        if (v.includes("EMPTY") || v.includes("UNINSERTED") || v.includes("NONE")) {
          state.online = false;
          state.battery = null;
        }
        break;
      }

      case "BATT_TYPE": {
        const v = stripBraces(value).toUpperCase();
        if (v === "" || v === "UNKNOWN" || v === "NONE" || v === "EMPTY") {
          state.online = false;
          state.battery = null;
        } else {
          state.online = true;
        }
        break;
      }

      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognised field: ${token}`);
        break;
    }

    this.emitStatus(channel);
  }

  // Chargers don't send SAMPLE metering frames.
  protected handleSample(channel: number, _tokens: string[]): void {
    console.debug(`[shure:${this.id}] ch${channel} unexpected SAMPLE — ignoring (charger)`);
  }
}
