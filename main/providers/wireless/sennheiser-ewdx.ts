// SennheiserEwDx — Sennheiser EW-DX digital wireless (EM2 / EM4 receivers and the
// CHG 70N charger) via Sennheiser Sound Control (SSCv2): JSON over UDP, port 45.
//
// Property paths are taken from the Bitfocus Companion EW-DX module (real, working
// code): RX config at `/rx{n}/{name,frequency,mute,warnings}`, RF quality at
// `m.rx{n}.rsqi` (0 = no signal), transmitter battery at `mates.tx{n}.battery.gauge`
// (0–100 %); charger bays at `bays.{bat_gauge,state,bat_health,bat_cycles,device_type}[i]`.
// EW-DX exposes `gain` (a setting) but no live audio VU over SSC → audioLevel stays null.
//
// SSCv2 subscription form: {"osc":{"state":{"subscribe":[{"#":{"lifetime":L}, <paths:null>}]}}}.
// We (re)subscribe on connect and every poll tick (renew before the lifetime lapses);
// the base's device/name ping + watchdog handle liveness. SENNHEISER_DEBUG=1 logs frames.

import { SennheiserSscBase, buildQuery, clampBars, formatSscFrequency, numOrNull, readPath } from "./sennheiser-ssc.js";
import type { ConfigField } from "../../types/integrations.js";

type EwdxModel = "EM2" | "EM4" | "CHG70N";
const SUBSCRIBE_LIFETIME_S = 15; // renewed each poll tick (default 3s) — well within lifetime

export class SennheiserEwDx extends SennheiserSscBase {
  readonly id = "sennheiser-ewdx";
  readonly label = "Sennheiser EW-DX";
  readonly configSchema: ConfigField[] = [
    {
      key: "host",
      label: "Device IP / Hostname",
      type: "text",
      placeholder: "192.168.1.120",
    },
    {
      key: "model",
      label: "Model",
      type: "select",
      options: [
        { value: "EM4", label: "EW-DX EM4 (4 channels)" },
        { value: "EM2", label: "EW-DX EM2 (2 channels)" },
        { value: "CHG70N", label: "CHG 70N charger (2 bays)" },
      ],
    },
  ];
  protected readonly defaultChannels = 4;
  protected readonly defaultDeviceType = "receiver" as const;

  private model: EwdxModel = "EM4";

  async connect(cfg: Record<string, unknown>): Promise<void> {
    const m = typeof cfg.model === "string" ? cfg.model.toUpperCase() : "";
    this.model = m === "EM2" ? "EM2" : m === "CHG70N" ? "CHG70N" : "EM4";
    const channels = this.model === "EM2" ? 2 : this.model === "CHG70N" ? 2 : 4;
    await super.connect({ ...cfg, channels });
  }

  protected initChannels(): void {
    this.channels.clear();
    const type = this.model === "CHG70N" ? "charger" : "receiver";
    for (let n = 1; n <= this.channelCount; n++) {
      this.channels.set(String(n), this.blankChannel(String(n), type));
    }
  }

  protected onConnected(): void {
    this.subscribe();
  }
  protected onPoll(): void {
    this.subscribe(); // renew before the lifetime lapses
  }

  private subscribe(): void {
    const subs: Record<string, unknown>[] = [];
    if (this.model === "CHG70N") {
      const bays: Record<string, unknown> = { "#": { lifetime: SUBSCRIBE_LIFETIME_S } };
      buildQuery(["bays", "bat_gauge"], null, bays);
      buildQuery(["bays", "state"], null, bays);
      buildQuery(["bays", "bat_health"], null, bays);
      buildQuery(["bays", "bat_cycles"], null, bays);
      buildQuery(["bays", "device_type"], null, bays);
      subs.push(bays);
    } else {
      for (let ch = 1; ch <= this.channelCount; ch++) {
        const rx: Record<string, unknown> = { "#": { lifetime: SUBSCRIBE_LIFETIME_S } };
        buildQuery([`rx${ch}`, "name"], null, rx);
        buildQuery([`rx${ch}`, "frequency"], null, rx);
        buildQuery([`rx${ch}`, "warnings"], null, rx);
        subs.push(rx);

        const meter: Record<string, unknown> = { "#": { lifetime: SUBSCRIBE_LIFETIME_S } };
        buildQuery(["m", `rx${ch}`, "rsqi"], null, meter);
        subs.push(meter);

        const mate: Record<string, unknown> = { "#": { lifetime: SUBSCRIBE_LIFETIME_S } };
        buildQuery(["mates", `tx${ch}`, "battery", "gauge"], null, mate);
        buildQuery(["mates", `tx${ch}`, "name"], null, mate);
        subs.push(mate);
      }
    }
    this.send({ osc: { state: { subscribe: subs } } });
  }

  protected handleFrame(frame: Record<string, unknown>): void {
    if (this.model === "CHG70N") {
      this.handleCharger(frame);
      return;
    }
    for (let ch = 1; ch <= this.channelCount; ch++) {
      const st = this.channels.get(String(ch));
      if (!st) continue;
      let touched = false;

      const rx = frame[`rx${ch}`];
      if (rx && typeof rx === "object") {
        const n = rx as Record<string, unknown>;
        touched = true;
        st.online = true;
        if (typeof n.name === "string" && n.name.trim()) st.name = n.name;
        const freq = formatSscFrequency(n.frequency);
        if (freq) st.frequencyLabel = freq;
      }

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
      // Fall back to the transmitter's own name when the RX channel is unnamed.
      const txName = readPath(frame, ["mates", `tx${ch}`, "name"]);
      if (!st.name && typeof txName === "string" && txName.trim()) {
        st.name = txName;
        touched = true;
      }

      if (touched) this.emit(st);
    }
  }

  // CHG 70N reports per-bay arrays under `bays`, indexed 0-based (bay 1 = [0]).
  private handleCharger(frame: Record<string, unknown>): void {
    const gauges = readPath(frame, ["bays", "bat_gauge"]);
    const states = readPath(frame, ["bays", "state"]);
    const health = readPath(frame, ["bays", "bat_health"]);
    const cycles = readPath(frame, ["bays", "bat_cycles"]);
    const types = readPath(frame, ["bays", "device_type"]);
    const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

    for (let bay = 1; bay <= this.channelCount; bay++) {
      const st = this.channels.get(String(bay));
      if (!st) continue;
      const i = bay - 1;
      let touched = false;

      const gauge = numOrNull(arr(gauges)[i]);
      if (gauge != null) {
        st.battery = gauge;
        touched = true;
      }
      const h = numOrNull(arr(health)[i]);
      if (h != null) st.health = h;
      const c = numOrNull(arr(cycles)[i]);
      if (c != null) st.cycles = c;

      const state = arr(states)[i];
      if (typeof state === "string") {
        // A bay with a battery reports NORMAL/UPDATE/…; NONE/UNKNOWN means empty.
        const type = arr(types)[i];
        const present = typeof type === "string" && type !== "NONE" && type !== "UNKNOWN";
        st.online = present;
        st.charging = present && state === "NORMAL" && (gauge == null || gauge < 100);
        if (typeof type === "string" && type !== "NONE") st.name = type;
        touched = true;
      }

      if (touched) this.emit(st);
    }
  }
}
