// pvp-service.ts — polls ProVideoPlayer's Network API and broadcasts one
// snapshot of every layer on "pvp:status".
//
// PVP exposes no WebSocket, no SSE and no subscribe endpoint — the word does not
// appear anywhere in its API reference — so this polls, which puts it in the same
// family as reaper-service.ts and makes that file the model for the lifecycle.
//
// One request answers everything: GET /transportState/workspace returns every
// layer in ~11.5 KB. There is also /transportState/layer/{id}, but it costs one
// request per layer AND the vendor's own example for it omits playingMedia — the
// single field that says whether a layer holds anything.
//
// TWO THINGS HERE ARE DELIBERATE AND EASY TO UNDO BY ACCIDENT:
//
//   1. emitIfChanged is OVERRIDDEN. The base compares DTO keys with `!==`, and
//      `layers` is a fresh array every poll, so the base implementation would
//      broadcast at the poll rate forever. See shouldEmit below.
//   2. The cadence gates on inDemand, not hasSubscribers. This channel carries
//      automation triggers, and the engine is not a browser — gating on browser
//      subscribers is what silently disabled every SPL rule on an unattended box.

import { errorMessage } from "./errors.js";
import { StatusIntegration } from "./integration-base.js";
import { driftedLayers, isWorkspaceResponse, layerSignature, parseWorkspace } from "./pvp-parse.js";
import { PVP_OFFLINE, hasContent, type PvpLayerDTO, type PvpStatusDTO } from "../types/pvp.js";

/** Active cadence. Governs how fast a cue change reaches a rule, not how smooth
 *  the progress bar is — the bar is interpolated on the client. A 20-second loop
 *  needs 2 s at most; 1 s is chosen so an automation edge is not up to two
 *  seconds late, and 11.5 KB/s on a wired LAN is the same order as REAPER's. */
const POLL_MS = 1000;
/** Nothing is watching and no rule reads the channel. Keeps the badge warm. */
const IDLE_POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;

/** Re-push at least this often even when nothing changed, so a client's anchor
 *  and its clock-skew estimate cannot drift and a just-connected display stays
 *  fresh. The same value, for the same reason, as live-poller's keepalive. */
const KEEPALIVE_MS = 15_000;

/** How far the progress clock may wander from its last anchor before a fresh one
 *  is sent. One second: below the eye's tolerance on a wall, and comfortably
 *  above the jitter of a 1 Hz poll against a video engine's own clock. */
const DRIFT_TOLERANCE_SEC = 1;

/** A verify read is retried rather than slept on once, because nothing has
 *  measured PVP's apply latency — only that there IS one, which is what made the
 *  research's first pass read four working trigger forms as no-ops. Bounded at
 *  4 x 150 ms. */
const VERIFY_ATTEMPTS = 4;
const VERIFY_INTERVAL_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What a command claims it did, and how to tell whether it happened. */
export interface PvpVerify {
  /** Reads back to the operator as the action's detail. Present tense, no
   *  punctuation: "layer Graphics cleared". */
  what: string;
  holds(layers: readonly PvpLayerDTO[]): boolean;
}

export interface PvpTarget {
  host: string;
  port: number;
  https: boolean;
  token: string | null;
}

class PvpService extends StatusIntegration<PvpStatusDTO> {
  private target: PvpTarget | null = null;
  private lastBroadcastAtMs = 0;
  /**
   * When the freshest read that has reached the channel was STARTED.
   *
   * The poll is serial with itself, but command()'s verify reads run beside it,
   * and two requests to the same box can come back out of order. Without this a
   * poll begun before a trigger could resolve after the verify read and
   * broadcast the OLD workspace over the new one — which the automation engine,
   * comparing consecutive frames, would read as a layer clearing and then the
   * same cue starting a second time. One command, one phantom "layer cleared"
   * and one duplicated "cue started".
   */
  private freshestReadAtMs = 0;

  constructor() {
    super("pvp", "pvp:status", PVP_OFFLINE);
  }

  protected get configured(): boolean {
    return !!this.target;
  }

  configure(host: string, port: number, https: boolean, token: string | null): void {
    const h = host?.trim() || null;
    const p = port > 0 ? Math.floor(port) : null;
    this.target = h && p ? { host: h, port: p, https, token: token?.trim() || null } : null;
    this.resetReport();
    this.restart();
  }

  override start(): void {
    if (this.running || !this.target) return;
    // The token is never logged, here or anywhere.
    console.log(`[pvp] polling ${this.origin(this.target)}`);
    super.start();
  }

  private origin(t: PvpTarget): string {
    return `${t.https ? "https" : "http"}://${t.host}:${t.port}`;
  }

  /**
   * One request to PVP.
   *
   * AbortSignal.timeout rather than a hand-rolled controller: the timer cannot be
   * leaked because there is no timer to forget. Every other fetch here does the
   * same.
   */
  private async request(
    t: PvpTarget,
    path: string,
    init?: { method: string; body?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (t.token) headers.Authorization = `Bearer ${t.token}`;
    if (init?.body != null) headers["Content-Type"] = "application/json";
    const res = await fetch(`${this.origin(t)}/api/0${path}`, {
      method: init?.method ?? "GET",
      body: init?.body,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // A 404 does NOT distinguish "wrong path" from "Network API disabled" —
      // PVP returns 404 for both, so the message says so rather than guessing.
      if (res.status === 404) {
        throw new Error(
          "HTTP 404 — either the path is wrong or PVP's Network API is off. Check Preferences -> Network -> Network API, and that the port is the API port, not the documentation port.",
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`HTTP ${res.status} — PVP rejected the API token.`);
      }
      throw new Error(`ProVideoPlayer returned HTTP ${res.status}`);
    }
    return res;
  }

  /** The one read this integration makes. Exposed through readLayers() so an
   *  action can verify itself against exactly the same fold the poll uses. */
  private async fetchWorkspace(t: PvpTarget): Promise<PvpLayerDTO[]> {
    const res = await this.request(t, "/transportState/workspace");
    const body: unknown = await res.json();
    // A 200 is not enough. parseWorkspace answers [] both for a workspace with
    // no layers and for a response that was never a workspace, and treating the
    // second as the first is how "Connected — 0 layers" would be reported for
    // the API DOCUMENTATION port — the exact setup mistake this integration
    // warns about, confirmed as working by the one control meant to catch it.
    if (!isWorkspaceResponse(body)) {
      throw new Error(
        "answered, but the response was not a ProVideoPlayer workspace. Check the port is the Network API port from Preferences -> Network -> Network API, not the port PVP serves its API documentation on.",
      );
    }
    return parseWorkspace(body);
  }

  /**
   * The target an ACTION may use, or null.
   *
   * `running` as well as `target`, and the difference is a real bug rather than
   * belt and braces: switching the integration off calls stop(), which clears
   * `running` but leaves `target` set, because nothing re-runs configure(). A
   * check on `target` alone would let an armed rule go on driving PVP after the
   * operator had switched it off — a switch that appears to do something and
   * does not. RossTalk refuses a disabled target for the same reason.
   *
   * test() deliberately does NOT come through here: it takes its target as
   * arguments, because Test connection has to work before the switch is on.
   */
  private get liveTarget(): PvpTarget | null {
    return this.running ? this.target : null;
  }

  /** Current layer state, straight from PVP. Throws on a transport failure — the
   *  caller decides what to tell the operator. */
  async readLayers(): Promise<PvpLayerDTO[]> {
    const t = this.liveTarget;
    if (!t) throw new Error("ProVideoPlayer is not connected — check it is switched on under Settings -> Integrations");
    return await this.fetchWorkspace(t);
  }

  /** One-shot reachability check for the Integrations "Test connection" button. */
  async test(
    host: string,
    port: number,
    https: boolean,
    token: string | null,
  ): Promise<{ ok: boolean; message?: string }> {
    const t: PvpTarget = { host, port, https, token };
    try {
      const layers = await this.fetchWorkspace(t);
      const withContent = layers.filter(hasContent).length;
      return {
        ok: true,
        message: `Connected to ProVideoPlayer at ${host}:${port} — ${layers.length} layers, ${withContent} with content`,
      };
    } catch (err) {
      const msg = errorMessage(err);
      // PVP's own documentation uses `curl -k` throughout, which implies a
      // self-signed certificate, and Node's fetch will not accept one. Say that
      // rather than letting an operator read a TLS failure as "PVP is down".
      if (https && /certificate|self.signed|TLS|SSL/i.test(msg)) {
        return {
          ok: false,
          message: `${msg}. PVP's HTTPS mode normally uses a self-signed certificate, which this app will not accept. Turn "Use HTTPS Connection" off in PVP unless you have installed a certificate this machine trusts.`,
        };
      }
      return { ok: false, message: msg };
    }
  }

  protected async connect(): Promise<void> {
    const t = this.target;
    if (!this.running || !t) return;
    // Stamped before the request, so a slow poll cannot overwrite a verify read
    // that started later and finished sooner.
    const startedAtMs = Date.now();
    try {
      const layers = await this.fetchWorkspace(t);
      if (!this.running) return;
      if (!this.last.connected) {
        this.resetBackoff();
        this.report("connected", `Connected to ProVideoPlayer at ${t.host}:${t.port}`);
      }
      this.emitFresh(layers, startedAtMs);
      // inDemand, not hasSubscribers: a rule reading this channel is a watcher,
      // and an appliance with no browser attached is exactly where "nobody is
      // looking" is permanent.
      this.scheduleIn(this.inDemand ? POLL_MS : IDLE_POLL_MS);
    } catch (err) {
      const msg = errorMessage(err);
      if (this.attempt === 0) console.warn(`[pvp] ${t.host}:${t.port} unreachable (${msg}) — backing off quietly`);
      this.report("error", `Can't reach ${t.host}:${t.port} — ${msg}`);
      this.goOffline();
      this.scheduleReconnect();
    }
  }

  /**
   * Post a command, then PROVE it happened.
   *
   * PVP answers every POST with HTTP 200 and an empty body whether or not
   * anything happened — no echo of the applied value, no confirmation, nothing
   * to read — and it applies the change a BEAT after the 200. So neither the
   * response nor an immediate re-read is evidence, and an action that reported
   * success on a 200 would be a rule that appears to run, logs a success, and
   * never touches a screen.
   *
   * Never throws. Every outcome — including "the write may have landed but we
   * could not confirm it" — comes back as a result the caller reports to the
   * operator. A catch here that only logged would be the swallowed failure this
   * whole method exists to prevent.
   */
  async command(path: string, body: unknown, verify: PvpVerify): Promise<{ ok: boolean; detail: string }> {
    const t = this.liveTarget;
    if (!t) {
      return { ok: false, detail: "ProVideoPlayer is not connected — check it is switched on under Settings -> Integrations" };
    }

    try {
      await this.request(t, path, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return { ok: false, detail: errorMessage(err) };
    }
    // Re-read rather than sleep once. Nothing has measured PVP's apply latency,
    // and a single guessed sleep would make "no effect" and "read too early"
    // indistinguishable — which is exactly how the research's first pass
    // concluded four working trigger forms were no-ops.
    let lastReadError: string | null = null;
    // Tracked SEPARATELY from the last error, because they answer different
    // questions. If three reads came back clean showing no change and the fourth
    // timed out, we KNOW the write did not land — reporting "could not read the
    // state back" would hand the operator the softer message and point them away
    // from the conclusion three clean reads had already established.
    let sawCleanRead = false;
    for (let i = 0; i < VERIFY_ATTEMPTS; i++) {
      await delay(VERIFY_INTERVAL_MS);
      const readAtMs = Date.now();
      let layers: PvpLayerDTO[];
      try {
        layers = await this.fetchWorkspace(t);
      } catch (err) {
        lastReadError = errorMessage(err);
        continue;
      }
      sawCleanRead = true;
      // The read is free state — fold it back into the channel so a command does
      // not leave every display a poll behind.
      this.emitFresh(layers, readAtMs);
      if (verify.holds(layers)) return { ok: true, detail: verify.what };
    }

    if (lastReadError && !sawCleanRead) {
      // Nothing was ever read back. The write may well have landed; we cannot
      // say, and saying "sent" when we cannot see the result is the failure this
      // path exists to prevent.
      return { ok: false, detail: `sent, but could not read the state back to confirm it: ${lastReadError}` };
    }
    const trailing = lastReadError ? ` (a later read also failed: ${lastReadError})` : "";
    return { ok: false, detail: `PVP answered 200 but ${verify.what} did not take effect${trailing}` };
  }

  /**
   * Fold a read into the channel, unless something newer already got there.
   *
   * `readAtMs` is taken BEFORE the request goes out, so a response that overtook
   * a newer one is dropped rather than broadcast backwards.
   */
  private emitFresh(layers: PvpLayerDTO[], readAtMs: number): void {
    if (readAtMs < this.freshestReadAtMs) return;
    this.freshestReadAtMs = readAtMs;
    this.emitIfChanged({ connected: true, layers, sampledAt: new Date().toISOString() });
  }

  /**
   * PURE, and separated from emitIfChanged so it can be tested without a socket.
   *
   * Three reasons to send a frame, and `nowMs - lastBroadcastAtMs` is the third.
   * `layerSignature` deliberately omits every time-varying field, so ordinary
   * playback produces NO frame at all between cue changes.
   */
  static shouldEmit(prev: PvpStatusDTO, next: PvpStatusDTO, lastBroadcastAtMs: number, nowMs: number): boolean {
    if (prev.connected !== next.connected) return true;
    if (layerSignature(prev.layers) !== layerSignature(next.layers)) return true;
    if (driftedLayers(prev, next, DRIFT_TOLERANCE_SEC).length > 0) return true;
    return nowMs - lastBroadcastAtMs >= KEEPALIVE_MS;
  }

  /**
   * Overrides the base's shallow compare, which cannot be used here at all: it
   * compares DTO keys with `!==`, and `layers` is a fresh array every poll, so
   * the base implementation broadcasts at the poll rate no matter what changed.
   *
   * Deleting this override is the single most expensive mistake available in
   * this file. It is guarded by "the emitIfChanged override decides what reaches
   * the wire" in pvp-service.test.ts, which drives THIS method and counts frames
   * arriving at the broadcaster — not the static shouldEmit helper, which an
   * earlier version of that suite tested instead and which left this line
   * deletable with the whole suite green. On the live device the difference is
   * 2 frames per 30s against 20.
   */
  protected override emitIfChanged(next: PvpStatusDTO): void {
    if (PvpService.shouldEmit(this.last, next, this.lastBroadcastAtMs, Date.now())) this.emit(next);
    else this.last = next;
  }

  /** Stamped here rather than in emitIfChanged so goOffline() — which calls
   *  emit() directly — also resets the keepalive clock. */
  protected override emit(snapshot: PvpStatusDTO): void {
    this.lastBroadcastAtMs = Date.now();
    super.emit(snapshot);
  }
}

export const pvpService = new PvpService();
export { PvpService };
