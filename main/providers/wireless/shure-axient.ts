// shure-axient.ts — DeviceProvider for Shure Axient Digital (AD) wireless receivers.
// Protocol: ASCII-over-TCP on port 2202 (Shure control protocol, AD family).
// Init: GET 0 ALL, then SET 0 METER_RATE 1000 (1 s metering intervals).
// Verified against a physical AD4Q-A (4-ch receiver, FW 1.4.9): the linked
// transmitter's telemetry arrives as channel-level REP fields prefixed `TX_`
// (e.g. TX_BATT_CHARGE_PERCENT, TX_BATT_BARS, TX_AVAILABLE), the frequency is a
// kHz integer that may be 7 digits (e.g. "0543125" = 543.125 MHz), and RF/audio
// come from the per-channel SAMPLE. The `SLOT_`-prefixed fields are the docked
// charging-bay batteries and are intentionally ignored.

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

    // SLOT-level report: `REP {ch} SLOT {n} {field} {value}`. The base parser
    // reaches here with token = "SLOT" and rest = [n, field, value...]. A
    // transmitter (handheld/bodypack) reports its telemetry this way, so unwrap
    // the real field/value and apply it to channel {ch} via the same switch.
    if (token === "SLOT") {
      const slotNum = rest[0];
      const slotField = (rest[1] ?? "").toUpperCase();
      const slotRest = rest.slice(2);
      console.debug(
        `[shure:${this.id}] ch${channel} SLOT ${slotNum} ${slotField} ${slotRest.join(" ")}`,
      );
      if (!slotField) return;
      token = slotField;
      rest = slotRest;
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
        } else {
          // A real transmitter model means a TX is linked on this channel.
          state.online = true;
        }
        break;
      }

      // ── AD4Q transmitter telemetry ────────────────────────────────────────
      // The AD4Q reports the LINKED transmitter's status with a `TX_` prefix
      // (and the docked/charging-bay battery with a `SLOT_` prefix, which we
      // ignore). These arrive whenever a handheld/bodypack links or its state
      // changes, so they're also our presence signal.
      case "TX_AVAILABLE": {
        // STANDARD/ENHANCED/HIGH/etc = a TX is linked; UNKNOWN/NONE = none.
        const v = value.toUpperCase();
        state.online = v !== "UNKNOWN" && v !== "NONE" && v !== "";
        console.debug(`[shure:${this.id}] ch${channel} TX_AVAILABLE: ${value}`);
        break;
      }

      case "TX_BATT_CHARGE_PERCENT": {
        const charge = safeInt(value);
        if (!Number.isNaN(charge)) {
          if (charge === 255 || charge < 0 || charge > 100) {
            state.battery = null; // unknown / no TX
          } else {
            state.battery = clamp(charge, 0, 100);
            state.online = true;
          }
        }
        console.debug(`[shure:${this.id}] ch${channel} TX_BATT_CHARGE_PERCENT: ${value}`);
        break;
      }

      case "TX_BATT_BARS": {
        const bars = safeInt(value);
        if (!Number.isNaN(bars)) {
          if (bars === 255) {
            state.battery = null;
            state.online = false; // 255 = no transmitter linked
          } else {
            // Only a fallback if a precise percent hasn't arrived.
            if (state.battery === null) state.battery = clamp(bars, 0, 5) * 20;
            state.online = true;
          }
        }
        console.debug(`[shure:${this.id}] ch${channel} TX_BATT_BARS: ${value}`);
        break;
      }

      case "INTERFERENCE_STATUS":
      case "RF_INT_DET": {
        // Log RF interference events — not mapped to DeviceStatus shape yet.
        console.log(`[shure:${this.id}] ch${channel} RF interference: ${token}=${value}`);
        break;
      }

      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognized field: ${token}`);
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

    // SLOT-level metering: `SAMPLE {ch} SLOT {n} ALL ...` — everything from "ALL"
    // onward shifts right by two tokens vs. the channel-level `SAMPLE {ch} ALL ...`.
    const off = (tokens[2] ?? "").toUpperCase() === "SLOT" ? 2 : 0;

    const bmA = safeInt(tokens[8 + off]);
    const rfARaw = safeInt(tokens[9 + off]);
    const bmB = safeInt(tokens[10 + off]);
    const rfBRaw = safeInt(tokens[11 + off]);
    const audioRaw = safeInt(tokens[6 + off]);

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
