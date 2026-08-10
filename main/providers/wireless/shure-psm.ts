// shure-psm.ts — DeviceProvider for Shure PSM series In-Ear Monitor transmitters.
// Protocol: ASCII-over-TCP on port 2202 (Shure control protocol, PSM family).
// PSM is a TRANSMITTER: no battery telemetry, no SAMPLE messages.
// online = socket connected && channel not RF-muted.
// Audio metering arrives as periodic REP {ch} AUDIO_IN_LVL {value} messages.

import type { ConfigField } from "../../types/integrations.js";
import {
  ShureBaseProvider,
  clamp,
  formatFrequency,
  normalisedDb,
  safeInt,
  stripBraces,
} from "./shure-base.js";

export class ShurePsm extends ShureBaseProvider {
  readonly id = "shure-psm";
  readonly label = "Shure PSM (In-Ear)";
  readonly configSchema: ConfigField[] = [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.101",
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
      placeholder: "2",
    },
  ];

  protected readonly defaultChannels = 2;
  protected readonly defaultDeviceType = "iem" as const;

  // RF-mute state tracked per channel to correctly derive online flag.
  private rfMuted = new Map<number, boolean>();

  protected initChannelStates(count: number): void {
    super.initChannelStates(count);
    this.rfMuted.clear();
    for (let n = 1; n <= count; n++) {
      this.rfMuted.set(n, false);
      // PSM channels have no battery.
      const state = this.channelStates.get(n);
      if (state) {
        state.battery = null;
        state.rfBars = null;
        state.deviceType = "iem";
      }
    }
  }

  // ── Init commands ─────────────────────────────────────────────────────────

  protected onConnected(): void {
    console.log(`[shure:${this.id}] sending init commands`);
    const count = this.channelStates.size;
    for (let ch = 1; ch <= count; ch++) {
      this.send(`GET ${ch} CHAN_NAME`);
      this.send(`GET ${ch} FREQUENCY`);
      this.send(`GET ${ch} RF_MUTE`);
      this.send(`GET ${ch} AUDIO_IN_LVL`);
      this.send(`GET ${ch} RF_TX_LEVEL`);
      this.send(`SET ${ch} METER_RATE ${this.meterRateMs}`);
    }
  }

  // ── REP / REPORT messages ─────────────────────────────────────────────────

  protected handleReport(channel: number, token: string, rest: string[]): void {
    if (channel === 0) {
      console.debug(`[shure:${this.id}] device-level REP: ${token} ${rest.join(" ")}`);
      return;
    }

    const state = this.channelStates.get(channel);
    if (!state) return;

    const value = rest.join(" ");

    switch (token) {
      case "CHAN_NAME": {
        // PSM CHAN_NAME max 8 chars.
        state.name = stripBraces(value).slice(0, 8) || null;
        console.log(`[shure:${this.id}] ch${channel} name: ${state.name ?? "(none)"}`);
        break;
      }

      case "FREQUENCY": {
        state.frequencyLabel = formatFrequency(value);
        console.debug(`[shure:${this.id}] ch${channel} freq: ${state.frequencyLabel ?? value}`);
        break;
      }

      case "RF_MUTE": {
        // "0" = not muted (TX is on); "1" = muted (TX is off).
        const muted = value === "1";
        this.rfMuted.set(channel, muted);
        state.online = !muted;
        console.log(
          `[shure:${this.id}] ch${channel} RF_MUTE: ${muted ? "muted (offline)" : "active (online)"}`,
        );
        break;
      }

      case "AUDIO_IN_LVL": {
        // Range -67..0 dB; normalise to 0..1.
        const db = safeInt(value);
        if (!Number.isNaN(db)) {
          state.audioLevel = normalisedDb(clamp(db, -67, 0), -67, 0);
        }
        console.debug(`[shure:${this.id}] ch${channel} AUDIO_IN_LVL: ${value} dB`);
        break;
      }

      case "RF_TX_LEVEL": {
        // Transmit power level (10/50/100 mW) — informational only.
        console.debug(`[shure:${this.id}] ch${channel} RF_TX_LEVEL: ${value} mW`);
        break;
      }

      default:
        console.debug(`[shure:${this.id}] ch${channel} unrecognized field: ${token}`);
        break;
    }

    this.emitChannel(channel);
  }

  // ── SAMPLE messages ───────────────────────────────────────────────────────
  // PSM does not send SAMPLE messages. If one arrives unexpectedly, ignore it.

  protected handleSample(channel: number, _tokens: string[]): void {
    console.debug(`[shure:${this.id}] ch${channel} unexpected SAMPLE — ignoring (PSM is TX-only)`);
  }
}
