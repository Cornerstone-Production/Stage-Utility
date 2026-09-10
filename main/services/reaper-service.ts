// reaper-service.ts — Connects to REAPER's built-in Web Interface (Preferences →
// Control/OSC/web → "Web browser interface") and broadcasts live transport state
// on "reaper:status" for the custom-layout "REAPER status" object.
//
// REAPER has no external scripting socket (ReaScript is in-process only), so the
// integration polls the web interface's `GET /_/TRANSPORT` endpoint over HTTP.
// The response is one tab-separated line:
//   TRANSPORT \t playstate \t position_seconds \t isRepeatOn \t position_string \t position_beats
// playstate is a bitmask (bit0 playing, bit1 paused, bit2 recording), so REAPER
// reports 0=stopped, 1=playing, 2=paused, 5=recording, 6=record-paused.
//
// The same interface RUNS an action — `GET /_/<command id>` — which is what the
// `reaper.transport` automation action drives through `transport()` below.
//
// Lifecycle mirrors the other LAN integrations (obs-service.ts): a single timer
// polls while running, steps to a slower cadence when nobody's watching the
// channel, and backs off exponentially while REAPER is unreachable.

import { fetchFailureMessage } from "./errors.js";
import type { ReaperStatusDTO } from "../types/stage.js";
import { StatusIntegration } from "./integration-base.js";

/**
 * The web interface also RUNS an action: `GET /_/<command id>`. These three are
 * REAPER's own transport commands, and Record (1013) is a TOGGLE — pressed while
 * recording it stops the recording, which is why `transport("record")` reads the
 * transport before it sends anything. See `transport`.
 */
const COMMAND_IDS = { record: 1013, stop: 1016, play: 1007 } as const;

/** What `reaper.transport` can ask for. */
export type ReaperTransportCommand = keyof typeof COMMAND_IDS;

export function isReaperTransportCommand(value: string): value is ReaperTransportCommand {
  return Object.hasOwn(COMMAND_IDS, value);
}

/** The one seam: tests drive the transport commands without a REAPER. */
export const reaperDeps: { fetch: typeof fetch } = {
  fetch: (input, init) => fetch(input, init),
};

const POLL_MS = 1000; // active cadence (someone is watching the channel)
const IDLE_POLL_MS = 5000; // no subscribers — keep the connection badge warm, cheaply
const REQUEST_TIMEOUT_MS = 4000;

const OFFLINE: ReaperStatusDTO = {
  connected: false,
  recording: false,
  recordPaused: false,
  playing: false,
  positionSeconds: null,
  positionString: null,
};

/**
 * Fold one `/_/TRANSPORT` response body into a status snapshot. Pure + exported
 * so the parse can be unit-tested without a live REAPER. `connected` is true for
 * any well-formed TRANSPORT line (the HTTP request reaching REAPER is the link).
 */
export function parseTransport(body: string): ReaperStatusDTO {
  const line = body.split("\n").find((l) => l.startsWith("TRANSPORT")) ?? "";
  const f = line.split("\t");
  if (f[0] !== "TRANSPORT" || f.length < 2) return { ...OFFLINE, connected: true };
  const playstate = Number(f[1]);
  const recording = (playstate & 4) === 4;
  const secs = f.length > 2 && f[2] !== "" ? Number(f[2]) : NaN;
  return {
    connected: true,
    recording,
    recordPaused: recording && (playstate & 2) === 2, // playstate 6
    playing: (playstate & 1) === 1 && !recording,
    positionSeconds: Number.isFinite(secs) ? secs : null,
    positionString: f.length > 4 && f[4] ? f[4] : null,
  };
}

class ReaperService extends StatusIntegration<ReaperStatusDTO> {
  private host: string | null = null;
  private port: number | null = null;

  constructor() {
    super("reaper", "reaper:status", OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.host && !!this.port;
  }

  configure(host: string, port: number): void {
    this.host = host?.trim() || null;
    this.port = port > 0 ? Math.floor(port) : null;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.configured) return;
    console.log(`[reaper] polling ${this.host}:${this.port}`);
    super.start();
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(host: string, port: number): Promise<{ ok: boolean; message?: string }> {
    try {
      const body = await this.fetchTransport(host, port);
      if (!body.startsWith("TRANSPORT")) {
        return { ok: false, message: "Reached the server, but it didn't return TRANSPORT data — is REAPER's web interface enabled?" };
      }
      return { ok: true, message: `Connected to REAPER at ${host}:${port}` };
    } catch (err) {
      return { ok: false, message: fetchFailureMessage(err, `${host}:${port}`) };
    }
  }

  private async fetchTransport(host: string, port: number): Promise<string> {
    return this.get(host, port, "TRANSPORT");
  }

  /** One `GET /_/<path>` against the web interface. Throws on anything but 2xx. */
  private async get(host: string, port: number, path: string): Promise<string> {
    // AbortSignal.timeout rather than a hand-rolled controller-plus-clearTimeout:
    // the timer cannot be leaked, because there is no timer to forget. Every
    // other fetch in this codebase already does it this way.
    const res = await reaperDeps.fetch(`http://${host}:${port}/_/${path}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`REAPER returned HTTP ${res.status}`);
    return await res.text();
  }

  /**
   * Run one transport command, for the `reaper.transport` action.
   *
   * NEVER THROWS: the action reports a failure rather than raising it, exactly
   * as osc.send does, so one unreachable REAPER cannot stop the engine.
   *
   * RECORD IS A TOGGLE. REAPER's 1013 is "Transport: Record", which STOPS a
   * recording that is already running — so a cue called twice, or a Home
   * Assistant switch that repeats `turn_on`, would end the recording of the
   * service. The transport is read first and 1013 is sent only when REAPER is
   * not already recording. Stop and Play are idempotent in REAPER itself and go
   * out unconditionally.
   */
  async transport(command: ReaperTransportCommand): Promise<{ ok: boolean; detail: string }> {
    const { host, port } = this;
    if (!host || !port) return { ok: false, detail: "REAPER is not configured" };
    try {
      if (command === "record") {
        const state = parseTransport(await this.fetchTransport(host, port));
        // The read is fresher than `last`, whatever the poll cadence is — keep
        // it, so the indicator and the cue state do not wait for the next tick.
        if (this.running) this.emitIfChanged(state);
        if (state.recording) {
          console.log("[reaper] transport record -> already recording");
          return { ok: true, detail: "already recording" };
        }
      }
      const id = COMMAND_IDS[command];
      await this.get(host, port, String(id));
      console.log(`[reaper] transport ${command} -> sent ${id}`);
      // Poll NOW rather than at the idle cadence: the recording indicator and a
      // bound cue pair both read the poll's snapshot. scheduleIn reuses the one
      // timer this integration has — a second timer would double the poll rate.
      if (this.running) this.scheduleIn(0);
      return { ok: true, detail: `sent ${id}` };
    } catch (err) {
      // NOT errorMessage: Node says "fetch failed" for every network failure and
      // puts ECONNREFUSED and the address on `cause`. "REAPER transport failed:
      // fetch failed" is a line an operator can do nothing with at 9am.
      const detail = fetchFailureMessage(err, `${host}:${port}`);
      console.warn(`[reaper] transport ${command} failed: ${detail}`);
      return { ok: false, detail };
    }
  }

  protected async connect(): Promise<void> {
    if (!this.running || !this.host || !this.port) return;
    try {
      const body = await this.fetchTransport(this.host, this.port);
      if (!this.running) return;
      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", `Connected to REAPER at ${this.host}:${this.port}`);
      }
      this.emitIfChanged(parseTransport(body));
      // Poll fast while anything is consuming this channel — a display OR an
      // in-process reader the SSE check cannot see, such as an automation rule
      // carrying the "REAPER is recording" condition. Asking only about browsers
      // left that condition reading a snapshot up to IDLE_POLL_MS stale on the
      // unattended box that is the whole point of automation.
      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = fetchFailureMessage(err, `${this.host}:${this.port}`);
      if (this.attempt === 0) console.warn(`[reaper] ${this.host}:${this.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${this.host}:${this.port} — ${msg}`);
      this.goOffline();
      this.scheduleReconnect();
    }
  }

  // Overrides the base's shallow compare: while recording, tick EVERY poll so a
  // timecode display advances, which a change-only broadcast would freeze.
  protected override changed(p: ReaperStatusDTO, next: ReaperStatusDTO): boolean {
    const stateChanged =
      p.connected !== next.connected ||
      p.recording !== next.recording ||
      p.recordPaused !== next.recordPaused ||
      p.playing !== next.playing;
    const tick = next.recording && p.positionString !== next.positionString;
    return stateChanged || tick;
  }

}

export const reaperService = new ReaperService();
