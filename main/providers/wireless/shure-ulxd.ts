// shure-ulxd.ts — DeviceProvider for Shure ULX-D wireless receivers.
// Protocol: ASCII-over-TCP on port 2202 (Shure control protocol, ULX family).
// Init: GET 0 ALL, then SET 0 METER_RATE 1000 (1 s metering intervals).

import type { ConfigField } from "../../types/integrations.js";
import {
  ShureBaseProvider,
  batteryMinutesFrom,
  clamp,
  formatFrequency,
  normalisedDb,
  rfBarsFromDbm,
  safeInt,
  stripBraces,
} from "./shure-base.js";

export class ShureUlxd extends ShureBaseProvider {
  readonly id = "shure-ulxd";
  readonly label = "Shure ULX-D";
  readonly configSchema: ConfigField[] = [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.100",
    },
    {
      key: "port",
      label: "TCP Port",
      type: "number",
      placeholder: "2202",
    },
    {
      key: "channels",
      label: "Number of Channels",
      type: "number",
      placeholder: "4",
    },
  ];

  protected readonly defaultChannels = 4;
  protected readonly defaultDeviceType = "receiver" as const;

  // ── Init commands ─────────────────────────────────────────────────────────

  protected onConnected(): void {
    console.log(`[shure:${this.id}] sending init commands`);
    this.send("GET 0 ALL");
    this.send(`SET 0 METER_RATE ${this.meterRateMs}`);
  }

  // ── REP / REPORT messages ─────────────────────────────────────────────────

  protected handleReport(channel: number, token: string, rest: string[]): void {
    if (channel === 0) {
      // Device-level reports — nothing to persist at channel level.
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }

    const state = this.channelStates.get(channel);
    if (!state) return;

    const value = rest.join(" ");

    switch (token) {
      case "CHAN_NAME": {
        state.name = stripBraces(value) || null;
        console.log(`[shure:${this.id}] ch${channel} name: ${state.name ?? "(none)"}`);
        break;
      }

      case "BATT_BARS": {
        const bars = safeInt(value);
        if (!Number.isNaN(bars)) {
          if (bars === 255) {
            // 255 = no TX present
            state.battery = null;
            state.online = false;
          } else {
            state.battery = state.battery ?? bars * 20; // fallback if no BATT_CHARGE
            state.online = true;
          }
        }
        console.debug(`[shure:${this.id}] ch${channel} BATT_BARS: ${value}`);
        break;
      }

      case "BATT_CHARGE": {
        const charge = safeInt(value);
        if (!Number.isNaN(charge)) {
          state.battery = charge === 255 ? null : clamp(charge, 0, 100);
        }
        console.debug(`[shure:${this.id}] ch${channel} BATT_CHARGE: ${value}`);
        break;
      }

      // Runtime remaining. BATT_RUN_TIME is the ULX-D name; TX_BATT_MINS is
      // accepted too because it is what the AD family sends and a mixed rack is
      // not the place to discover which of two spellings a receiver uses.
      case "BATT_RUN_TIME":
      case "TX_BATT_MINS": {
        state.batteryMinutes = batteryMinutesFrom(value);
        console.debug(
          `[shure:${this.id}] ch${channel} ${token}: ${state.batteryMinutes ?? "unknown/calculating"}`,
        );
        break;
      }

      case "FREQUENCY": {
        state.frequencyLabel = formatFrequency(value);
        console.debug(`[shure:${this.id}] ch${channel} freq: ${state.frequencyLabel ?? value}`);
        break;
      }

      case "MUTE_STATUS": {
        // Stored for completeness; does not affect online flag.
        console.debug(`[shure:${this.id}] ch${channel} MUTE_STATUS: ${value}`);
        break;
      }

      case "TX_TYPE":
      case "TX_MODEL": {
        if (value === "UNKNOWN" || value === "UNKN") {
          state.online = false;
          console.log(`[shure:${this.id}] ch${channel} TX absent (${token}=${value})`);
        }
        break;
      }

      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognized field: ${token}`);
        break;
    }

    this.emitChannel(channel);
  }

  // ── SAMPLE messages ───────────────────────────────────────────────────────
  // Format: SAMPLE {ch} ALL {antenna} {rfRaw} {audioRaw}
  // rfLevelDbm = rfRaw - 128; audioRaw - 50 gives audio dB (range ~-50..0).

  protected handleSample(channel: number, tokens: string[]): void {
    const state = this.channelStates.get(channel);
    if (!state) return;

    // tokens[0]=SAMPLE tokens[1]=ch tokens[2]=ALL tokens[3]=antenna tokens[4]=rfRaw tokens[5]=audioRaw
    const rfRaw = safeInt(tokens[4]);
    const audioRaw = safeInt(tokens[5]);

    if (!Number.isNaN(rfRaw)) {
      const dbm = rfRaw - 128;
      state.rfLevelDbm = dbm;
      state.rfBars = rfBarsFromDbm(dbm);
    }

    if (!Number.isNaN(audioRaw)) {
      // audioRaw - 50 maps raw value to dB; range approximately -50..0 dB
      const audioDb = audioRaw - 50;
      state.audioLevel = normalisedDb(audioDb, -50, 0);
    }

    console.debug(
      `[shure:${this.id}] ch${channel} SAMPLE rfDbm=${state.rfLevelDbm} rfBars=${state.rfBars} audio=${state.audioLevel?.toFixed(2)}`,
    );

    this.emitChannel(channel);
  }
}
