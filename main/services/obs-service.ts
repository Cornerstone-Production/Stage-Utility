// obs-service.ts — Connects to OBS Studio (obs-websocket v5, default port 4455)
// and broadcasts live output state on "obs:status" for the custom-layout
// "OBS status" object.
//
// Lifecycle mirrors the other LAN integrations (smaart-service.ts): a
// configure/connect/reconnect loop with exponential backoff. One WebSocket does
// the handshake, seeds state with GetRecordStatus/GetStreamStatus/
// GetVirtualCamStatus, then stays live on events.
//
// THE RECORD CLOCK IS AN ANCHOR, NOT A TICK. `GetRecordStatus` used to be polled
// at 1 Hz while recording, purely to refresh a "HH:MM:SS" string, and the service
// emitted whenever that string changed -- one request a second to OBS and one SSE
// frame a second to every connected browser, for the whole length of a recording.
// The same response already carries `outputDuration` in milliseconds, so the
// snapshot carries that plus the moment it was read and the display interpolates
// (obs-record-clock.ts). The anchor is re-read on RecordStateChanged -- which is
// also how OBS reports a pause and a resume -- and on a slow keepalive, so the
// poll is gone and the frame rate collapses to twice a minute.

import { errorMessage } from "./errors.js";
import type { ObsStatusDTO } from "../types/stage.js";
import { StatusIntegration } from "./integration-base.js";
import { recordElapsedMs } from "./obs-record-clock.js";
import {
  closeCodeOf,
  ObsWebSocketAdapter,
  standDownReason,
  type ObsClose,
  type ObsEvent,
} from "./obs-protocol.js";

/**
 * How often the record anchor is re-read while recording.
 *
 * Not a poll for a timecode -- the display already knows the timecode. It is a
 * drift correction: OBS's `outputDuration` counts what was RECORDED, which falls
 * behind wall-clock when frames are dropped or the disk stalls, and a wall
 * counting seconds that were never written is worth correcting. Thirty seconds
 * for the same reason PVP re-anchors at fifteen, halved again because a recorder
 * drifts slower than a video engine.
 */
const ANCHOR_KEEPALIVE_MS = 30_000;

const OFFLINE: ObsStatusDTO = {
  connected: false,
  recording: false,
  recordPaused: false,
  streaming: false,
  virtualCam: false,
  recordAnchorMs: null,
  recordSampledAt: null,
};

/**
 * OBS's "HH:MM:SS.mmm" timecode as milliseconds, or null.
 *
 * Only reached when `GetRecordStatus` answers without a usable `outputDuration`.
 * Both fields have been in obs-websocket v5 since 5.0, so this is insurance
 * rather than a path anyone has seen -- but an OBS that sends one and not the
 * other should lose a millisecond of precision, not the whole clock.
 */
export function timecodeToMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(v.trim());
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] ?? "0").padEnd(3, "0"));
}

/**
 * The record anchor from a `GetRecordStatus` response, stamped at `at`.
 *
 * Pure + exported: this is where the 1 Hz poll used to be, and reading the wrong
 * field here would put a stopped clock on a wall with nothing else going wrong.
 *
 * `recording` is passed in rather than read off the response because the caller
 * has already folded the event that changed it, and the two must agree — an
 * anchor on a snapshot that says it is not recording is a number nothing reads.
 */
export function recordAnchorFrom(
  rec: Record<string, unknown>,
  recording: boolean,
  at: number = Date.now(),
): Pick<ObsStatusDTO, "recordAnchorMs" | "recordSampledAt"> {
  if (!recording) return { recordAnchorMs: null, recordSampledAt: null };
  const raw = rec.outputDuration;
  const ms =
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : timecodeToMs(rec.outputTimecode);
  return ms == null
    ? { recordAnchorMs: null, recordSampledAt: null }
    : { recordAnchorMs: ms, recordSampledAt: new Date(at).toISOString() };
}

/**
 * Fold one OBS event into the status snapshot. Pure + exported so the event→DTO
 * mapping can be unit-tested without a live OBS. RecordStateChanged keeps
 * `recording` true while paused (OBS still has a recording in progress).
 *
 * `at` is the moment the event arrived. RecordStateChanged ROLLS THE ANCHOR
 * FORWARD to it rather than leaving the old one in place: the service asks OBS
 * for a fresh `outputDuration` on this same event, but that is a round trip away,
 * and between a resume and its answer an untouched anchor would replay the whole
 * pause as recorded time. Rolling forward is the display's own formula applied
 * once on the server, so the two never disagree about where the recording is.
 */
export function reduceObsEvent(prev: ObsStatusDTO, evt: ObsEvent, at: number = Date.now()): ObsStatusDTO {
  const d = evt.eventData;
  switch (evt.eventType) {
    case "RecordStateChanged": {
      const active = d.outputActive === true;
      const state = typeof d.outputState === "string" ? d.outputState : "";
      const rolled = active ? recordElapsedMs(prev, at) : null;
      return {
        ...prev,
        recording: active,
        recordPaused: state.endsWith("PAUSED"),
        recordAnchorMs: rolled,
        recordSampledAt: rolled == null ? null : new Date(at).toISOString(),
      };
    }
    case "StreamStateChanged":
      return { ...prev, streaming: d.outputActive === true };
    case "VirtualcamStateChanged":
      return { ...prev, virtualCam: d.outputActive === true };
    default:
      return prev;
  }
}

class ObsService extends StatusIntegration<ObsStatusDTO> {
  private host: string | null = null;
  private port: number | null = null;
  private password: string | null = null;

  private adapter: ObsWebSocketAdapter | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive failed anchor reads, so a flapping OBS says so once. */
  private anchorFailures = 0;

  constructor() {
    super("obs", "obs:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  configure(host: string, port: number, password: string | null): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.password = password?.trim() || null;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[obs] connecting ${this.host}:${this.port}`);
    super.start();
  }

  /** Close the socket and the timecode poll; the base clears the retry timer
   *  and drops the snapshot to OFFLINE. */
  protected override teardown(): void {
    this.clearPoll();
    this.adapter?.close();
    this.adapter = null;
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(
    host: string,
    port: number,
    password: string | null,
  ): Promise<{ ok: boolean; message?: string }> {
    const adapter = new ObsWebSocketAdapter(host, port);
    try {
      await adapter.connect({ password });
      const ver = await adapter.request("GetVersion");
      const obsVer = typeof ver.obsVersion === "string" ? ver.obsVersion : "?";
      const wsVer = typeof ver.obsWebSocketVersion === "string" ? ver.obsWebSocketVersion : "?";
      return { ok: true, message: `Connected to OBS ${obsVer} (obs-websocket ${wsVer})` };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    } finally {
      adapter.close();
    }
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    const adapter = new ObsWebSocketAdapter(this.host, this.port);
    this.adapter = adapter;
    adapter.onEvent((e) => this.onEvent(adapter, e));
    adapter.onClose((close) => this.onClose(adapter, close));
    try {
      await adapter.connect({ password: this.password });
      if (!this.running) {
        adapter.close();
        return;
      }
      // Seed state from OBS's current outputs (best-effort per request).
      const snap: ObsStatusDTO = { ...OFFLINE, connected: true };
      try {
        const rec = await adapter.request("GetRecordStatus");
        snap.recording = rec.outputActive === true;
        snap.recordPaused = rec.outputPaused === true;
        Object.assign(snap, recordAnchorFrom(rec, snap.recording));
      } catch {
        /* older OBS or denied — leave defaults */
      }
      try {
        const stream = await adapter.request("GetStreamStatus");
        snap.streaming = stream.outputActive === true;
      } catch {
        /* ignore */
      }
      try {
        const vcam = await adapter.request("GetVirtualCamStatus");
        snap.virtualCam = vcam.outputActive === true;
      } catch {
        /* ignore */
      }
      if (this.adapter !== adapter) return; // superseded while awaiting
      this.resetBackoff();
      this.report("connected", `Connected to OBS at ${this.host}:${this.port}`);
      this.emit(snap);
      this.startKeepalive();
    } catch (err) {
      const msg = errorMessage(err);
      adapter.close();
      if (this.adapter === adapter) this.adapter = null;
      this.goOffline();

      // 4009 and 4010 arrive here rather than in onClose(): they close the
      // socket BEFORE the handshake completes, so the only thing this sees is a
      // rejected promise carrying the code.
      const reason = standDownReason(closeCodeOf(err));
      if (reason) {
        this.standDown(reason, closeCodeOf(err));
        return;
      }

      if (this.attempt === 0) console.warn(`[obs] ${this.host}:${this.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${msg}`);
      this.scheduleReconnect();
    }
  }

  private onEvent(adapter: ObsWebSocketAdapter, evt: ObsEvent): void {
    if (this.adapter !== adapter) return;
    // emitIfChanged, NOT `if (next !== this.last) emit(next)`. That was a
    // REFERENCE comparison against a fold that returns a fresh object for every
    // RecordStateChanged, so it was always true: OBS sends STARTING then
    // STARTED, and STOPPING then STOPPED, and each pair put two identical
    // frames on the wire. The same mistake the 1 Hz poll made, one event apart.
    this.emitIfChanged(reduceObsEvent(this.last, evt));
    // RecordStateChanged is the ONLY thing that moves the record clock, and it
    // covers all four transitions OBS has — started, stopped, paused, resumed.
    // The fold above rolled the anchor forward from what we already knew; this
    // replaces it with what OBS actually recorded. Nothing to do with the answer
    // but publish it, which is why it is not awaited.
    if (evt.eventType === "RecordStateChanged") void this.anchor(adapter, evt.eventType);
  }

  private onClose(adapter: ObsWebSocketAdapter, close: ObsClose): void {
    if (!this.running || this.adapter !== adapter) return;
    this.clearPoll();
    if (this.adapter === adapter) this.adapter = null;

    const reason = standDownReason(close.code);
    if (reason) {
      this.standDown(reason, close.code);
      return;
    }

    if (this.attempt === 0) console.warn("[obs] connection closed — reconnecting");
    this.report("error", "OBS connection dropped — reconnecting");
    this.goOffline();
    this.scheduleReconnect();
  }

  /**
   * Stop trying, and say why.
   *
   * obs-websocket documents 4011 as "you must not automatically reconnect" — it
   * is what OBS's own **Kick** button sends — and reconnecting through it turned
   * one deliberate kick into a loop that kicked itself back in for as long as the
   * operator kept pressing the button. 4009 and 4010 are here for a duller
   * reason: retrying cannot change their answer, so the loop was only noise in
   * the log and traffic on the wire.
   *
   * `stop()` is the whole stand-down: it clears the retry timer, closes the
   * socket, drops the snapshot to OFFLINE, and leaves `running` false so nothing
   * schedules another attempt. Saving or testing the OBS integration calls
   * `configure()`, which restarts it — so the way back is an operator action,
   * which is the point.
   */
  private standDown(reason: string, code: number | null): void {
    console.warn(
      `[obs] ${this.host}:${this.port} ${reason} (close code ${code ?? "none"}) — not reconnecting; save or test the OBS integration to try again`,
    );
    this.report("error", `OBS ${reason}. Not reconnecting — save or test the OBS integration to try again.`);
    this.stop();
  }

  /** How often the anchor is re-read while recording. An own accessor shadows
   *  this in obs-record-clock.test.ts, the same seam `reconnectBaseMs` gives
   *  obs-close-code.test.ts, so the guard can run a keepalive in a second
   *  instead of thirty. */
  protected get anchorKeepaliveMs(): number {
    return ANCHOR_KEEPALIVE_MS;
  }

  /** Correct the anchor's drift from wall-clock while recording. No-op otherwise
   *  — an idle OBS is asked nothing at all, where the old poll ran regardless. */
  private startKeepalive(): void {
    this.clearPoll();
    this.pollTimer = setInterval(() => {
      const adapter = this.adapter;
      // A PAUSED recording has nothing to drift. OBS stops advancing
      // `outputDuration` while paused, so a re-read can only return the number
      // already published -- but it would carry a fresh `recordSampledAt`, and
      // the shallow compare would call that a change and put a frame on the wire
      // for every keepalive of a pause. The pause's OWN event still re-anchors
      // (see onEvent), which is where the exact recorded duration is banked.
      if (adapter && !this.last.recordPaused) void this.anchor(adapter, "keepalive");
    }, this.anchorKeepaliveMs);
  }

  /**
   * Re-read `outputDuration` and publish it as the new anchor.
   *
   * @returns null, or why the anchor could not be refreshed.
   *
   * The failure is returned AND said once per streak, because neither on its own
   * is enough here: the callers are a timer tick and an event handler, so there
   * is nobody to hand it to who could act — and a display that quietly stops
   * agreeing with OBS about how long it has been recording is exactly the kind of
   * thing whose only evidence must not be a widget that looks fine. The clock
   * does NOT freeze meanwhile: it keeps running from the last good anchor, which
   * is right unless OBS's recorded duration is drifting.
   */
  private async anchor(adapter: ObsWebSocketAdapter, why: string): Promise<string | null> {
    if (this.adapter !== adapter || !this.last.connected || !this.last.recording) return null;
    try {
      const rec = await adapter.request("GetRecordStatus");
      if (this.adapter !== adapter) return null;
      this.emitIfChanged({ ...this.last, ...recordAnchorFrom(rec, this.last.recording) });
      if (this.anchorFailures) {
        console.log(`[obs] record anchor recovered after ${this.anchorFailures} miss(es)`);
        this.anchorFailures = 0;
      }
      return null;
    } catch (err) {
      const msg = errorMessage(err);
      if (this.anchorFailures++ === 0) {
        console.warn(
          `[obs] record anchor (${why}) failed: ${msg} — the timecode keeps running from the last anchor and may drift from OBS`,
        );
      }
      return msg;
    }
  }

  private clearPoll(): void {
    this.anchorFailures = 0;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

export const obsService = new ObsService();
