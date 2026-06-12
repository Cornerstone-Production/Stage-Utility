// shure-axient.ts — DeviceProvider for Shure Axient Digital (AD) wireless receivers.
// Protocol: ASCII-over-TCP on port 2202 (Shure control protocol, AD family).
// Init: GET 0 ALL, then SET 0 METER_RATE 1000 (1 s metering intervals).
// SLOT-level REP messages (REP {ch} SLOT {n} ...) are intentionally ignored in v1.

import type { ConfigField } from "../../types/integrations.js";
import {
  ShureBaseProvider,
  clamp,
  formatFrequency,
  normalisedDb,
  rfBarsFromDbm,
  safeInt,
  stripBraces,
} from "./shure-base.js";

export class ShureAxient extends ShureBaseProvider {
  readonly id = "shure-axient";
  readonly label = "Shure Axient Digital";
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
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }

    // Skip SLOT-level reports (v1 — future enhancement).
    // Detectable because the field token is "SLOT" when the parser reaches here
    // only if the second token was numeric (the channel). If the raw message is
    // `REP {ch} SLOT {n} {field} {value}` then token = "SLOT" here.
    if (token === "SLOT") {
      console.debug(`[shure:${this.id}] ch${channel} SLOT report skipped (v1)`);
      return;
    }

    const state = this.channelStates.get(channel);
    if (!state) return;

    const value = rest.join(" ");

    switch (token) {
      case "CHAN_NAME": {
        // AD CHAN_NAME max 31 chars — strip braces, same protocol.
        state.name = stripBraces(value).slice(0, 31) || null;
        console.log(`[shure:${this.id}] ch${channel} name: ${state.name ?? "(none)"}`);
        break;
      }

      case "BATT_BARS": {
        const bars = safeInt(value);
        if (!Number.isNaN(bars)) {
          if (bars === 255) {
            state.battery = null;
            state.online = false;
          } else {
            // Only use bars as battery fallback if no BATT_CHARGE has arrived yet.
            if (state.battery === null) state.battery = bars * 20;
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

      case "BATT_RUN_TIME": {
        // 65535 = unknown, 65534 = calculating, 65533 = error → null.
        // We store nothing additional for v1 (not part of DeviceStatus shape).
        const minutes = safeInt(value);
        if (!Number.isNaN(minutes) && minutes < 65533) {
          console.debug(`[shure:${this.id}] ch${channel} battery runtime: ${minutes} min`);
        } else {
          console.debug(`[shure:${this.id}] ch${channel} battery runtime: unknown/calculating`);
        }
        break;
      }

      case "FREQUENCY": {
        state.frequencyLabel = formatFrequency(value);
        console.debug(`[shure:${this.id}] ch${channel} freq: ${state.frequencyLabel ?? value}`);
        break;
      }

      case "MUTE_MODE_STATUS": {
        // "ON" = unmuted, "MUTE" = muted — does not affect online status.
        console.debug(`[shure:${this.id}] ch${channel} MUTE_MODE_STATUS: ${value}`);
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

      case "INTERFERENCE_STATUS":
      case "RF_INT_DET": {
        // Log RF interference events — not mapped to DeviceStatus shape yet.
        console.log(`[shure:${this.id}] ch${channel} RF interference: ${token}=${value}`);
        break;
      }

      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognised field: ${token}`);
        break;
    }

    this.emitStatus(channel);
  }

  // ── SAMPLE messages ───────────────────────────────────────────────────────
  // AD SAMPLE format (from Bitfocus shure-axient module):
  // SAMPLE {ch} ALL {quality} {audioLED} {audioPeak} {audioLevel} {antennaStr} {bmA} {rfA} {bmB} {rfB} ...
  // Indices:      0      1    2      3         4           5           6           7        8    9   10   11
  //
  // rfLevelA = tokens[9]  - 120
  // rfLevelB = tokens[11] - 120
  // rfBars   = max(tokens[8], tokens[10]) clamped 0..5 (these are bar values direct from device)
  // audioLvl = (tokens[6] - 120) normalised dB to 0..1

  protected handleSample(channel: number, tokens: string[]): void {
    const state = this.channelStates.get(channel);
    if (!state) return;

    const bmA = safeInt(tokens[8]);
    const rfARaw = safeInt(tokens[9]);
    const bmB = safeInt(tokens[10]);
    const rfBRaw = safeInt(tokens[11]);
    const audioRaw = safeInt(tokens[6]);

    if (!Number.isNaN(bmA) && !Number.isNaN(bmB)) {
      // bmA/bmB are bar-meter values 0–5 from the device.
      state.rfBars = clamp(Math.max(bmA, bmB), 0, 5);
    }

    if (!Number.isNaN(rfARaw) && !Number.isNaN(rfBRaw)) {
      const dbmA = rfARaw - 120;
      const dbmB = rfBRaw - 120;
      const bestDbm = Math.max(dbmA, dbmB);
      state.rfLevelDbm = bestDbm;
      // Derive bars from dBm as a cross-check fallback if bm values were NaN.
      if (state.rfBars === null) {
        state.rfBars = rfBarsFromDbm(bestDbm);
      }
    }

    if (!Number.isNaN(audioRaw)) {
      // tokens[6] - 120 gives audio dB; range approximately -120..0 dB.
      const audioDb = audioRaw - 120;
      state.audioLevel = normalisedDb(audioDb, -60, 0);
    }

    console.debug(
      `[shure:${this.id}] ch${channel} SAMPLE rfDbm=${state.rfLevelDbm} rfBars=${state.rfBars} audio=${state.audioLevel?.toFixed(2)}`,
    );

    this.emitStatus(channel);
  }
}
