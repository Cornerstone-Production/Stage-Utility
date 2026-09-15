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
 * The result of reading `/_/TRANSPORT`.
 *
 * `read` is the whole point: it separates "REAPER answered and said stopped"
 * from "something answered and I could not read it". They used to be the same
 * value — an unreadable body produced `recording: false` — and `transport`
 * below presses a TOGGLE on that answer, so a captive portal, a reverse proxy
 * or a login page in front of REAPER's web interface turned "start recording"
 * into "stop the recording of the service", reported as success.
 *
 * A separate field rather than `recording: boolean | null` on the DTO: the DTO
 * is broadcast to every display and read by automation conditions, and "false"
 * is the right thing for all of them (nothing may act as if a machine it cannot
 * read is rolling). Only the thing that presses a toggle needs the distinction,
 * and a value it has to destructure is harder to ignore than a nullable field
 * that compares falsy anyway.
 */
export interface TransportRead {
  /** True only when a well-formed TRANSPORT line was found in the body. */
  read: boolean;
  /** The snapshot. All-offline-but-connected when `read` is false. */
  status: ReaperStatusDTO;
}

/**
 * Fold one `/_/TRANSPORT` response body into a status snapshot. Pure + exported
 * so the parse can be unit-tested without a live REAPER. `connected` is true
 * because the HTTP request landed; whether REAPER itself answered is `read`.
 */
export function parseTransport(body: string): TransportRead {
  const line = body.split("\n").find((l) => l.startsWith("TRANSPORT")) ?? "";
  const f = line.split("\t");
  if (f[0] !== "TRANSPORT" || f.length < 2) return { read: false, status: { ...OFFLINE, connected: true } };
  const playstate = Number(f[1]);
  const recording = (playstate & 4) === 4;
  const secs = f.length > 2 && f[2] !== "" ? Number(f[2]) : NaN;
  return {
    read: true,
    status: {
      connected: true,
      recording,
      recordPaused: recording && (playstate & 2) === 2, // playstate 6
      playing: (playstate & 1) === 1 && !recording,
      positionSeconds: Number.isFinite(secs) ? secs : null,
      positionString: f.length > 4 && f[4] ? f[4] : null,
    },
  };
}

/** The web interface answered and REAPER did not — a 200 carrying something that
 *  is not a TRANSPORT line. Its own type so the poll can word it correctly while
 *  still taking the single failure path connect() already has. */
class UnreadableTransport extends Error {
  constructor() {
    super("answered, but the reply was not REAPER's transport — is the web interface enabled?");
    this.name = "UnreadableTransport";
  }
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
      // Through the parser, not a second `startsWith` of its own: "is this
      // REAPER's transport" must have ONE answer, or Test and the poll disagree
      // about a body with the line in second place, or with no tab after the tag.
      if (!parseTransport(await this.fetchTransport(host, port)).read) {
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
   *
   * AND AN UNREADABLE ANSWER REFUSES. `parseTransport` reports `read: false` for
   * any 200 whose body is not a TRANSPORT line — a captive-portal redirect on a
   * re-DHCPed VLAN, a reverse proxy, a REAPER build answering a login page on
   * `/_/`. That used to parse as `recording: false`, so "start recording" sent
   * 1013 into a machine that was already rolling and reported `ok: true` with
   * `[reaper] transport record -> sent 1013` on the log. Refusing is the correct
   * direction: a cue that did nothing and said so costs a retry, a cue that
   * ended the recording costs the service.
   */
  async transport(command: ReaperTransportCommand): Promise<{ ok: boolean; detail: string }> {
    const { host, port } = this;
    if (!host || !port) return { ok: false, detail: "REAPER is not configured" };
    try {
      if (command === "record") {
        const { read, status } = parseTransport(await this.fetchTransport(host, port));
        if (!read) {
          const detail =
            `could not read REAPER's transport at ${host}:${port} — refusing to press Record, ` +
            "which is a toggle and would stop a recording already running. Is REAPER's web " +
            "interface enabled, and is anything (a proxy, a captive portal) in front of it?";
          console.warn(`[reaper] transport record refused: ${detail}`);
          return { ok: false, detail };
        }
        // The read is fresher than `last`, whatever the poll cadence is — keep
        // it, so the indicator and the cue state do not wait for the next tick.
        // Past the refusal, so an unreadable answer never publishes a confident
        // "not recording" over a machine that may well be.
        if (this.running) this.emitIfChanged(status);
        if (status.recording) {
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
      const { read, status } = parseTransport(body);
      // Reached SOMETHING, but not REAPER. A green badge over a machine whose
      // transport cannot be read is the same lie `transport` now refuses to act
      // on, and `test()` has always called this out — so the poll says it too,
      // rather than publishing a confident "not recording" and reporting
      // "Connected".
      //
      // THROWN rather than handled here, so it takes the one failure path this
      // function already has: reporting, going offline, backing off and the
      // first-failure gate are written once. A second copy of that block would
      // be a second `attempt === 0` gate in a release whose whole point was that
      // there are already twelve too many.
      if (!read) throw new UnreadableTransport();
      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", `Connected to REAPER at ${this.host}:${this.port}`);
      }
      this.emitIfChanged(status);
      // Poll fast while anything is consuming this channel — a display OR an
      // in-process reader the SSE check cannot see, such as an automation rule
      // carrying the "REAPER is recording" condition. Asking only about browsers
      // left that condition reading a snapshot up to IDLE_POLL_MS stale on the
      // unattended box that is the whole point of automation.
      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      // "Unreachable" is the wrong word for a box that answered, so the two
      // causes word themselves and share everything else.
      const where = `${this.host}:${this.port}`;
      const detail =
        err instanceof UnreadableTransport
          ? `${where} ${err.message}`
          : `Can't reach ${where} — ${fetchFailureMessage(err, where)}`;
      if (this.attempt === 0) console.warn(`[reaper] ${detail} — backing off quietly`);
      this.report("error", detail);
      this.goOffline();
      this.scheduleReconnect();
    }
  }

  /**
   * Overrides the base's shallow compare: while recording, tick EVERY poll so a
   * timecode display advances, which a change-only broadcast would freeze.
   *
   * THIS IS THE SHAPE obs-service.ts NO LONGER HAS, and it was left here on
   * purpose rather than overlooked. OBS's record clock was the same 1 Hz frame
   * to every connected browser; it now ships an ANCHOR and the display reads it
   * forward. REAPER cannot copy that as it stands, for a reason about the
   * number rather than about the transport:
   *
   * `outputDuration` is the RECORDING's own elapsed time, and OBS's DTO carries
   * a complete rate for it — `recordPaused` is 0 or 1. `positionSeconds` is the
   * TIMELINE CURSOR, and nothing in a `/_/TRANSPORT` line says how fast it is
   * moving: REAPER's play rate is a project setting the line does not report,
   * and `isRepeatOn` (field 3, which parseTransport discards) means the cursor
   * can wrap backwards mid-recording. Interpolating from it would be guessing.
   * `positionString` is also REAPER's own text, so reading it forward means
   * this app formats the number instead — a visible change to two widgets, not
   * a quiet saving.
   *
   * So it is a design question about REAPER, not a mechanical copy of the OBS
   * change, and it wants a real REAPER to answer. The 1 Hz frame is gated on
   * `inDemand` meanwhile, so nothing is paying for it with no display attached.
   */
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
