// SennheiserEwG4 — Sennheiser evolution wireless G4 (EM 300/500 G4 etc.) via the
// Sennheiser Sound Control protocol (SSCv1): JSON over UDP, default port 45.
//
// ⚠️ HARDWARE-UNVERIFIED, best-effort. The exact SSCv1 address tree for G4 isn't
// published outside device-specific PDFs, so parsing stays permissive: it reads the
// classic per-channel `rx{n}` tree AND the verified SSCv2-style paths (`m.rx{n}.rsqi`,
// `mates.tx{n}.battery.gauge`) as fallbacks, so a G4 that answers either shape still
// populates. Transport is UDP (the original TCP version could never reach a device).
// Run with SENNHEISER_DEBUG=1 to log raw datagrams and confirm the real schema on-site.

import { SennheiserSscBase, buildQuery, formatSscFrequency, numOrNull, readPath, clampBars } from "./sennheiser-ssc.js";
import type { ConfigField } from "../../types/integrations.js";

export class SennheiserEwG4 extends SennheiserSscBase {
  readonly id = "sennheiser-ewg4";
  readonly label = "Sennheiser ewG4 (SSC)";
  readonly configSchema: ConfigField[] = [];
  protected readonly defaultChannels = 2;
  protected readonly defaultDeviceType = "receiver" as const;

  // Static per-channel fields, queried once on connect.
  protected onConnected(): void {
    for (let ch = 1; ch <= this.channelCount; ch++) {
      this.send(buildQuery([`rx${ch}`, "name"]));
      this.send(buildQuery([`rx${ch}`, "frequency"]));
    }
  }

  // Changing values (RF / battery / audio), re-queried each poll tick.
  protected onPoll(): void {
    for (let ch = 1; ch <= this.channelCount; ch++) {
      const q: Record<string, unknown> = {};
      buildQuery([`rx${ch}`, "rf", "level"], null, q);
      buildQuery([`rx${ch}`, "rf", "quality"], null, q);
      buildQuery([`rx${ch}`, "bat"], null, q);
      buildQuery([`rx${ch}`, "audio", "level"], null, q);
      this.send(q);
    }
  }

  protected handleFrame(frame: Record<string, unknown>): void {
    for (let ch = 1; ch <= this.channelCount; ch++) {
      const st = this.channels.get(String(ch));
      if (!st) continue;
      const node = frame[`rx${ch}`];
      let touched = false;

      if (node && typeof node === "object") {
        const n = node as Record<string, unknown>;
        touched = true;
        st.online = true;

        if (typeof n.name === "string") st.name = n.name;

        const freq = formatSscFrequency(n.frequency) ?? formatSscFrequency(readPath(n, ["frequency", "mhz"]));
        if (freq) st.frequencyLabel = freq;

        const lvl = numOrNull(readPath(n, ["rf", "level"]));
        const quality = numOrNull(readPath(n, ["rf", "quality"]));
        if (lvl != null) st.rfLevelDbm = lvl;
        if (quality != null) st.rfBars = clampBars(Math.round((quality / 100) * 5));
        else if (lvl != null) st.rfBars = clampBars(Math.round((lvl + 100) / 10));

        const bat = numOrNull(n.bat) ?? numOrNull(readPath(n, ["battery", "gauge"])) ?? numOrNull(n.battery);
        if (bat != null) st.battery = bat <= 5 ? bat * 20 : bat; // 0–5 gauge → %, else already %

        const aLvl = numOrNull(readPath(n, ["audio", "level"])) ?? numOrNull(n.audio);
        if (aLvl != null) st.audioLevel = aLvl;
      }

      // SSCv2-style fallbacks (some G4 firmware / SSC gateways answer these).
      const rsqi = numOrNull(readPath(frame, ["m", `rx${ch}`, "rsqi"]));
      if (rsqi != null) {
        st.rfBars = clampBars(Math.round((rsqi / 100) * 5));
        st.online = true;
        touched = true;
      }
      const gauge = numOrNull(readPath(frame, ["mates", `tx${ch}`, "battery", "gauge"]));
      if (gauge != null) {
        st.battery = gauge;
        touched = true;
      }

      if (touched) this.emit(st);
    }
  }
}
