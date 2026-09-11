// shure-charger.ts — DeviceProvider for Shure SBC-series networked docking
// chargers (SBC220 / SBC240). Protocol: ASCII-over-TCP on port 2202, same
// `< ... >` framing as the other Shure providers, but addressed per BAY rather
// than per RF channel. A bay reports battery charge %, cycle count, health %,
// temperature and charging state for the docked battery/transmitter.
//
// The token set below is confirmed against a live SBC220 on FW 1.4.53: one
// `GET 0 ALL` answers device-level MODEL / FW_VER / DEVICE_ID / FLASH /
// STORAGE_MODE and, per bay, BATT_DETECTED, BATT_TIME_TO_FULL, BATT_STATE,
// BATT_CHARGE, BATT_CURRENT_CAPACITY(_MAX), BATT_CYCLE, BATT_TEMP_F, BATT_TEMP_C,
// BATT_CAPACITY_MAX, BATT_HEALTH, BATT_BARS, BATT_ERROR and BATT_MODULE_TYPE.
// Every raw frame is logged under SHURE_DEBUG=1.

import type { ConfigField } from "../../types/integrations.js";
import type { ChannelState } from "./device-provider-base.js";
import { ShureBaseProvider, batteryMinutesFrom, shureNumber, stripBraces } from "./shure-base.js";

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
  // `GET 0 ALL` dumps every populated bay, so let bays self-discover even if the
  // connection's "Number of Bays" was set too low (e.g. 4 linked units = bays
  // 1–8 over one IP). Capped by maxDynamicChannels in the base.
  protected override allowDynamicChannels = true;

  // Re-poll the bays on a timer — chargers change slowly and may not push.
  // 30s (was 15s) halves the command volume with no practical loss of freshness
  // (battery %, dock/undock change slowly).
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_MS = 30_000;

  /** The unit's own name (DEVICE_ID), e.g. "MA: 5-8". Device-level, so it is held
   *  here and applied to each bay — it arrives once per dump, before or after the
   *  bays depending on frame order, and a bay discovered later still needs it. */
  private deviceId: string | null = null;
  /** Per-bay BATT_STATE and BATT_ERROR. A bay is faulted if EITHER says so, and
   *  the two arrive in separate frames, so the fault is derived from both rather
   *  than written by whichever landed last. */
  private bayState = new Map<number, string>();
  private bayError = new Map<number, number>();
  /** Faults already logged, so a charger left with a dead pack in it does not
   *  reprint the same line every poll for a week. */
  private loggedFaults = new Map<number, string>();

  protected initChannelStates(count: number): void {
    this.bayState.clear();
    this.bayError.clear();
    this.loggedFaults.clear();
    super.initChannelStates(count);
  }

  /** A bay starts named after the unit, not after its index. Overridden HERE
   *  rather than in a loop inside initChannelStates because `GET 0 ALL` dumps
   *  bays past the configured count and those are built by `ensureChannel` — a
   *  per-bay loop misses exactly the bays that self-discover. (RF, audio and
   *  frequency need no clearing: `blankChannel` already leaves them null, and
   *  `defaultDeviceType` already makes this a charger.) */
  protected override buildDefaultChannelState(n: number): ChannelState {
    const state = super.buildDefaultChannelState(n);
    this.applyDeviceId(n, state);
    return state;
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
      this.handleDeviceReport(token, rest.join(" "));
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
        if (!present) this.clearBay(channel, state);
        break;
      }

      // Charge percent (0–100, zero-padded e.g. "087"). An empty or faulted bay
      // answers with a marker at the top of the byte (255 empty, 254 faulted on FW
      // 1.4.53) — must become null, NOT clamp to 100, or the bay shows a bogus full
      // battery. Frame order in `GET 0 ALL` puts BATT_DETECTED before BATT_CHARGE,
      // so without this an empty bay ends up online=false yet battery=100.
      case "BATT_CHARGE": {
        state.battery = shureNumber(value, { width: 8, min: 0, max: 100 });
        break;
      }

      // FULL | CHARGING | ERROR | NO_BATT | … — drives the charging indicator.
      // NO_BATT is the empty-bay marker; treat it like an absent battery.
      //
      // ERROR is NOT absence. The bay still answers BATT_DETECTED YES, so the
      // battery is physically there and must keep reading as docked — reporting
      // it empty would hide the fault behind the same grey "empty" a spare shelf
      // shows. It is recorded as a fault instead, and every numeric reading on a
      // faulted bay is a marker anyway, so the row renders the fault and nothing
      // else.
      case "BATT_STATE": {
        const v = stripBraces(value).toUpperCase();
        this.bayState.set(channel, v);
        if (v === "NO_BATT") {
          state.online = false;
          this.clearBay(channel, state);
        } else {
          state.charging = v === "CHARGING";
          this.applyFault(channel, state);
        }
        break;
      }

      // Charge cycles (zero-padded e.g. "00569"), a 16-bit field. An empty bay
      // answers 65535 and a faulted one 65534 — the old guard here was `>= 65535`,
      // so a faulted bay rendered "65534 cyc" on every display with cycles on.
      case "BATT_CYCLE": {
        state.cycles = shureNumber(value, { width: 16, min: 0 });
        break;
      }

      // State-of-health percent (byte; 255 empty, 254 faulted).
      case "BATT_HEALTH": {
        state.health = shureNumber(value, { width: 8, min: 0, max: 100 });
        break;
      }

      // Temperature: read from Fahrenheit and convert. The SBC220's BATT_TEMP_C
      // field is unreliable on tested firmware (reports e.g. 064 while _F says
      // 115°F ≈ 46°C), so we source from _F. A byte field: 255 empty, 254 faulted
      // — the old guard was `>= 255`, so a faulted bay rendered 123°C.
      case "BATT_TEMP_F": {
        const f = shureNumber(value, { width: 8, min: -40, max: 200 });
        state.tempC = f === null ? null : Math.round(((f - 32) * 5) / 9);
        break;
      }

      // Minutes until this pack is charged — "will it be ready before the
      // service" is the question the charger is actually being looked at for.
      // A full bay answers 65529 ("not applicable") and a faulted one 65534, and
      // both must be null rather than zero: zero reads as "ready now".
      case "BATT_TIME_TO_FULL": {
        state.timeToFullMinutes = batteryMinutesFrom(value);
        break;
      }

      // 000 = healthy. Anything else is the only signal the bay or the battery
      // in it is bad; a faulted bay still reports BATT_DETECTED YES.
      case "BATT_ERROR": {
        this.bayError.set(channel, shureNumber(value, { width: 8, min: 0 }) ?? 0);
        this.applyFault(channel, state);
        break;
      }

      default:
        // Still ignored from the GET 0 ALL dump: BATT_BARS and BATT_TEMP_C (both
        // duplicate a field read above, and BATT_TEMP_C is wrong on this
        // firmware), the three capacity figures, and BATT_MODULE_TYPE.
        break;
    }

    this.emitChannel(channel);
  }

  /**
   * Device-level `REP {FIELD} {value}` — MODEL, FW_VER, DEVICE_ID, FLASH,
   * STORAGE_MODE. This used to return early and log, which threw away both of
   * the two fields an operator can act on.
   */
  private handleDeviceReport(token: string, raw: string): void {
    const value = stripBraces(raw);
    switch (token) {
      // Storage mode charges to about 40% and stops. Without it on screen an
      // operator sees 40% and no charging indicator and nothing to explain it.
      case "STORAGE_MODE": {
        const on = value.toUpperCase() === "ON";
        for (const [n, state] of this.channelStates) {
          state.storageMode = on;
          this.emitChannel(n);
        }
        console.log(`[shure:${this.id}] storage mode ${on ? "ON — bays charge to ~40% and stop" : "off"}`);
        break;
      }

      // The operator's own name for the unit (e.g. "MA: 5-8", meaning it covers
      // mic assignments 5 to 8). Better than the "Ch 1..8" the picker showed.
      case "DEVICE_ID": {
        const id = value || null;
        if (id === this.deviceId) break;
        this.deviceId = id;
        for (const [n, state] of this.channelStates) {
          this.applyDeviceId(n, state);
          this.emitChannel(n);
        }
        console.log(`[shure:${this.id}] device id: ${id ?? "(none)"}`);
        break;
      }

      default:
        console.debug(`[shure:${this.id}] device-level REP: ${token} ${raw}`);
        break;
    }
  }

  /** Name a bay after the unit the operator named, not after its index. */
  private applyDeviceId(bay: number, state: ChannelState): void {
    state.name = this.deviceId ? `${this.deviceId} · Bay ${bay}` : null;
  }

  /**
   * Derive this bay's fault from BATT_STATE and BATT_ERROR together.
   *
   * They arrive in separate frames (BATT_STATE first in a `GET 0 ALL` dump), so
   * writing `fault` from whichever landed last would have BATT_ERROR 000 clear a
   * fault BATT_STATE ERROR had just set. Logged on the EDGE only — a charger left
   * with a dead pack in it is polled every 30s all week.
   */
  private applyFault(bay: number, state: ChannelState): void {
    const code = this.bayError.get(bay) ?? 0;
    const faulted = code > 0 || this.bayState.get(bay) === "ERROR";
    const fault = !faulted ? null : code > 0 ? `Error ${String(code).padStart(3, "0")}` : "Error";
    state.fault = fault;
    if (this.loggedFaults.get(bay) === (fault ?? "")) return;
    this.loggedFaults.set(bay, fault ?? "");
    if (fault) console.warn(`[shure:${this.id}] bay ${bay} faulted: ${fault} (state ${this.bayState.get(bay) ?? "?"})`);
    else console.log(`[shure:${this.id}] bay ${bay} fault cleared`);
  }

  /** Wipe a bay's readings when the battery leaves it. Every field, in one place:
   *  the list was written out twice and the second copy already lagged. */
  private clearBay(bay: number, state: ChannelState): void {
    state.battery = null;
    state.charging = null;
    state.cycles = null;
    state.health = null;
    state.tempC = null;
    state.timeToFullMinutes = null;
    state.fault = null;
    this.bayError.delete(bay);
    this.loggedFaults.delete(bay);
  }

  // Chargers don't send SAMPLE metering frames.
  protected handleSample(channel: number, _tokens: string[]): void {
    console.debug(`[shure:${this.id}] ch${channel} unexpected SAMPLE — ignoring (charger)`);
  }
}
