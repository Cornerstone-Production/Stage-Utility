// main/services/video/relay-lifecycle.ts — getting a MediaMTX relay running
// when video is switched on and at least one feed needs it, and taking it
// away again.
//
// video-service.ts owns the relay ONCE it exists: attachRelay/detachRelay,
// polling its paths, reconciling on every feed change. This module owns
// getting it there and taking it away — the binary (acquire.ts), the port
// check (port-check.ts), the config file (mediamtx-config.ts), the
// supervisor (supervisor.ts), and reacting to an enable/disable flip, a feed
// appearing or disappearing, or a ports save. integration-manager.ts drives
// it through setEnabled(); the manager's own row is driven back through
// setConnectionListener(), but the MAPPING from a RelayStatus to that row
// lives in exactly one place — relayConnectionState() below, fed by
// video-service.ts's own setRelayStatusListener() hook, called on every
// publish(). That is deliberate: video-service's status POLL can discover
// "the relay stopped answering" (and recover from it) with no supervisor
// event of its own to hang a report on, and the integration row has to learn
// that the same way the Video feeds page's own status line does — from the
// one published RelayStatus, not from a second, independently-triggered copy
// of the same judgement.
//
// Every dependency is injected (constructor default: the real ones), so the
// whole start/stop sequence is testable with fakes — the real download only
// ever happens on the machine where video is actually switched on.
//
// Every public entry point (setEnabled, feedsChanged, portsChanged) returns
// at once: the actual start/stop sequence — the download above all — runs
// in the background and reports itself through the relay status and the
// connection row. A caller that awaited the full sequence used to make
// integration-manager.ts's boot wait up to five minutes for a first-ever
// download, and made the switch's own HTTP request outlive the renderer's
// timeout. Internally, every call is still serialized through one chain, so
// a feed removed the instant the switch is flicked is never raced against
// the flick itself.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { errorMessage } from "../errors.js";
import { getLanIp } from "../lan-ip.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import type { ConnectionState } from "../../types/integrations.js";
import type { RelayStatus, VideoPorts } from "../../types/video.js";
import { atomicWrite } from "../write-queue.js";
import { ensureBinary, relayDir, type EnsureBinaryOptions } from "./acquire.js";
import { loadFeedsFile } from "./feed-store.js";
import { relayConfig } from "./mediamtx-config.js";
import { MediaMtxRelay } from "./mediamtx-relay.js";
import { MEDIAMTX_VERSION } from "./mediamtx-pin.js";
import { busyPorts, type BusyPort } from "./port-check.js";
import { publishUsers } from "./reconcile-plan.js";
import type { VideoRelay } from "./relay.js";
import { RelaySupervisor, restartDelayMs, type SupervisorStatus } from "./supervisor.js";
import { videoService, type RelaySupervisorLike } from "./video-service.js";

/** RelayStatus -> the integration manager's connection state, in exactly one
 *  place (see the file header). Exported and pure, so the mapping itself is
 *  tested without a supervisor, a binary or a network call anywhere near it.
 *  `running` shows no version at all until one is genuinely known — a
 *  supervisor mid-spawn, its banner not yet read, must never read as
 *  "connected: MediaMTX " with nothing after it. */
export function relayConnectionState(relay: RelayStatus): { state: ConnectionState; message: string | null } {
  switch (relay.state) {
    case "off":
      return { state: "disconnected", message: null };
    case "downloading": {
      const pct = relay.totalBytes > 0 ? Math.round((relay.receivedBytes / relay.totalBytes) * 100) : 0;
      return { state: "connecting", message: `Downloading MediaMTX ${MEDIAMTX_VERSION} (${pct}%)` };
    }
    case "starting":
      return { state: "connecting", message: "Starting the relay" };
    case "running":
      return { state: "connected", message: relay.version ? `MediaMTX ${relay.version}` : null };
    case "failing":
      return { state: "error", message: relay.reason };
  }
}

/** onProgress fires once per network chunk — several times a second on a
 *  fast link. Throttled to this so a 27 MB download does not turn into a
 *  video:state broadcast, and a feed-store re-read, on every chunk. */
const DOWNLOAD_PROGRESS_THROTTLE_MS = 500;

/**
 * RelaySupervisorLike (video-service.ts) plus the two lifecycle methods
 * video-service.ts never calls itself — it only ever receives an
 * ALREADY-STARTED supervisor through attachRelay(), and the plan's own start/
 * stop sequence ("supervisor.start(...)", "supervisor.stop(), then await
 * videoService.detachRelay()") makes THIS class the one caller of both. A
 * real RelaySupervisor satisfies this structurally, same as RelaySupervisorLike.
 */
export interface RelayLifecycleSupervisor extends RelaySupervisorLike {
  start(binary: string, configPath: string): Promise<void>;
  stop(): Promise<void>;
}

export interface RelayLifecycleDeps {
  ensureBinary: (opts?: EnsureBinaryOptions) => ReturnType<typeof ensureBinary>;
  busyPorts: (ports: VideoPorts) => Promise<BusyPort[]>;
  makeSupervisor: () => RelayLifecycleSupervisor;
  makeRelay: (apiPort: number) => VideoRelay;
}

const REAL_DEPS: RelayLifecycleDeps = {
  ensureBinary,
  busyPorts,
  makeSupervisor: () => new RelaySupervisor(),
  makeRelay: (apiPort) => new MediaMtxRelay(apiPort),
};

/** The one busy port named in a failing reason — see port-check.ts's own
 *  comment for why every one of the six is worth checking even though only
 *  the first is ever shown; an operator fixes one collision at a time. */
function busyPortReason(busy: BusyPort[]): string {
  const first = busy[0]!;
  return `Port ${first.port} is in use by ${first.holder}.`;
}

export class RelayLifecycle {
  private readonly deps: RelayLifecycleDeps;
  private onConn: ((state: ConnectionState, message: string | null) => void) | null = null;

  private enabled = false;
  /** True from the moment startRelay() is called until either a supervisor
   *  exists (this.supervisor !== null) or the attempt has failed and a retry
   *  is scheduled — see isUp()'s own comment. */
  private starting = false;
  private supervisor: RelayLifecycleSupervisor | null = null;
  /** The ports the CURRENT supervisor was started with — for the readiness
   *  poll's own "relay started" log line. Not threaded through every call
   *  as a parameter: the poll is armed from two places (a fresh start, and
   *  the supervisor's own "running" status event) and both already know it
   *  by the time they need it. */
  private currentPorts: VideoPorts | null = null;
  private statusListener: ((status: SupervisorStatus) => void) | null = null;
  /** Pre-supervisor failure backoff (a busy port, a failed download, a
   *  config write that could not be written) — reset once those checks pass
   *  and a supervisor is created; the supervisor's OWN crash-loop backoff
   *  (supervisor.ts's own `attempt`) is separate and none of this class's
   *  business. */
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private readinessTimer: NodeJS.Timeout | null = null;
  /** Set once the started-relay log line has fired for the CURRENT
   *  startRelay() call — see startReadinessPoll()'s own comment. Reset only
   *  by startRelay() itself, never by a mere crash-and-respawn: the
   *  supervisor's own exit/restart lines already say that happened, and
   *  announcing "relay started" again on every crash loop would be exactly
   *  the noise CLAUDE.md's logging rule warns against. */
  private loggedStartedThisRun = false;
  /** One failure, one line, one recovery line — for everything that can go
   *  wrong before any supervisor exists (a busy port, a failed download, a
   *  config write that could not be written). Keyed by nothing but its own
   *  single run: a fresh streak starts once startRelay() reaches the
   *  supervisor successfully, or the desire to run goes away entirely. */
  private readonly prelaunchOutage = new OutageLog();
  /** Serializes setEnabled()/feedsChanged()/portsChanged()/the retry timer
   *  through one chain, so two calls landing close together (a feed removed
   *  right as the switch is flicked, say) are never interleaved mid-async —
   *  each one's own `wantRunning`/`isUp()` reads are only ever true for the
   *  state as it stood once every earlier call had fully settled. Never
   *  awaited by a PUBLIC caller (see the file header) — only chained onto
   *  internally, so the actual work always runs in order without ever
   *  making setEnabled()/feedsChanged()/portsChanged() block on it. */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: RelayLifecycleDeps = REAL_DEPS) {
    this.deps = deps;
  }

  setConnectionListener(cb: (state: ConnectionState, message: string | null) => void): void {
    this.onConn = cb;
  }

  private report(state: ConnectionState, message: string | null): void {
    this.onConn?.(state, message);
  }

  /** video-service.ts's setRelayStatusListener hook — the ONE place a
   *  published RelayStatus becomes the integration manager's connection row.
   *  Public because it is wired from a callback registered outside this
   *  class (module scope in production, a test's own `activate()` in
   *  relay-lifecycle.test.ts). */
  handleRelayStatus(relay: RelayStatus): void {
    const { state, message } = relayConnectionState(relay);
    this.report(state, message);
  }

  /** True while the relay is up, coming up, or a supervisor is holding a
   *  failing/backoff state on our behalf — i.e. while there is something for
   *  a "stop" to undo. `starting` covers the window before any supervisor
   *  exists (ensureBinary, the port check, writing the config); `supervisor
   *  !== null` covers everything after supervisor.start() succeeds,
   *  including its own "failing" backoff — that supervisor is still ours to
   *  stop. Does NOT cover a pre-supervisor failure's own backoff wait (no
   *  supervisor, `starting` already false) — callers that also care about
   *  THAT check `this.retryTimer` themselves; folding it in here made
   *  isUp() true for a state startRelay() itself does not consider "up",
   *  which is a different question than "is there a pending retry to
   *  cancel". */
  private isUp(): boolean {
    return this.starting || this.supervisor !== null;
  }

  private async hasRelayFeeds(): Promise<boolean> {
    const { feeds } = await loadFeedsFile();
    return feeds.some((f) => f.source.kind === "pull" || f.source.kind === "push");
  }

  /** Appends `fn` to the internal chain and returns at once — see the file
   *  header for why no public caller ever awaits the chain itself. A
   *  rejection is not expected (every pre-supervisor step startRelay() takes
   *  is inside its own try/catch — see item 3's own comment there), but a
   *  caught one here is what keeps a hypothetical future one from wedging
   *  every later call behind a permanently-rejected chain. */
  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn, (err: unknown) => {
      console.error(`[video] an internal relay-lifecycle step failed unexpectedly: ${scrub(errorMessage(err))}`);
    });
  }

  /** integration-manager.ts's applyVideo(): video's own enabled flag. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.enqueue(() => this.reconcileWanted());
  }

  /** video-service.ts's feedsChangedListener — a feed was added, changed or
   *  removed. */
  feedsChanged(): void {
    this.enqueue(() => this.reconcileWanted());
  }

  /**
   * video-service.ts's portsChangedListener — PATCH /api/video/ports just
   * saved a DIFFERENT set (video-service.ts's own setPorts() already skips
   * calling this when nothing changed). Restarts an already-running relay on
   * them; retries at once, rather than waiting out whatever backoff was
   * already scheduled, when the relay was mid pre-supervisor failure (a busy
   * port, most usefully — the operator just changed the ports to fix
   * exactly that); does nothing at all when the relay is simply off, since
   * a future start reads the new ports fresh from the store anyway.
   */
  portsChanged(): void {
    this.enqueue(async () => {
      const failingBackoff = !this.isUp() && this.retryTimer !== null;
      if (!this.isUp() && !failingBackoff) return;

      const stillWanted = this.enabled && (await this.hasRelayFeeds());
      if (!stillWanted) {
        // Not actually about the ports — video was switched off or the last
        // feed removed at the same moment. The ordinary path names the
        // real reason.
        await this.reconcileWanted();
        return;
      }

      console.log("[video] relay restarting on new ports");
      if (this.isUp()) {
        await this.stopRelay();
      } else {
        this.clearRetryTimer();
        videoService.setPreAttachStatus(null);
      }
      this.attempt = 0;
      await this.startRelay();
    });
  }

  private async reconcileWanted(): Promise<void> {
    const wantRunning = this.enabled && (await this.hasRelayFeeds());
    if (wantRunning) {
      if (!this.isUp()) await this.startRelay();
      return;
    }
    // Always run, whether or not isUp() is true: a pre-supervisor failure's
    // own backoff wait (a busy port, say) already has `starting` false and
    // no supervisor, so isUp() alone would miss it entirely — switching off,
    // or removing the last feed, during exactly that wait used to leave the
    // failing status and its retry timer running forever. stopRelay() is
    // safe to call unconditionally; it is a no-op past its own cleanup when
    // there is truly nothing to stop.
    const wasActive = this.isUp() || this.retryTimer !== null;
    await this.stopRelay();
    if (wasActive) console.log(`[video] relay stopped (${this.enabled ? "no relay feeds" : "video switched off"})`);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopReadinessPoll(): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
  }

  /** A failure before any supervisor exists — nothing to hand a "failing"
   *  SupervisorStatus, so relayStatus() is told directly through
   *  setPreAttachStatus(). Retried on the same backoff schedule the
   *  supervisor itself uses (restartDelayMs) once one is running. Routed
   *  through prelaunchOutage so a port conflict or a download failure logs
   *  once per outage — first failure, a reminder past its own floor, one
   *  recovery line — never once per retry. */
  private failPreSupervisor(reason: string, placeArchiveAt: string | undefined, assetName: string | undefined): void {
    this.starting = false;
    const delay = restartDelayMs(this.attempt);
    this.attempt++;
    videoService.setPreAttachStatus({ state: "failing", reason, retryAt: Date.now() + delay, placeArchiveAt, assetName });
    const decision = this.prelaunchOutage.fail("relay-prelaunch", reason, Date.now());
    if (decision.log) console.warn(`[video] ${scrub(reason)}${scrub(decision.note)}`);
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => this.enqueue(() => this.reconcileWanted()), delay);
    this.retryTimer.unref?.();
  }

  /**
   * The start sequence, in order: ensureBinary -> busyPorts -> the config
   * file -> supervisor.start() -> attachRelay() -> the readiness poll.
   *
   * The WHOLE body is one try/catch: a throw from busyPorts, from
   * hasRelayFeeds()'s own feed-store read, or from anywhere else that is not
   * one of the three steps with their own more specific catch below, used to
   * leave `starting` stuck true forever — no supervisor was ever created to
   * undo it, and nothing else resets the flag. That wedged the whole
   * lifecycle: every later setEnabled()/feedsChanged() saw isUp() already
   * true and never tried again.
   */
  private async startRelay(): Promise<void> {
    this.starting = true;
    this.loggedStartedThisRun = false;
    // The one moment nothing else has anything to say yet: no supervisor,
    // no download in progress. Reusing "starting" (rather than a new wire
    // state) is deliberate — a real supervisor's own "starting" status
    // (below, once one exists) means the same thing to an operator, and
    // relayConnectionState() already renders both the same way.
    videoService.setPreAttachStatus({ state: "starting", version: null });

    try {
      let lastProgressAt = 0;
      const onProgress = (received: number, total: number) => {
        const now = Date.now();
        if (received < total && now - lastProgressAt < DOWNLOAD_PROGRESS_THROTTLE_MS) return;
        lastProgressAt = now;
        videoService.setPreAttachStatus({ state: "downloading", receivedBytes: received, totalBytes: total });
      };
      const onDownloadStart = () => {
        // Once per download STREAK, not once per retry: attempt is only
        // ever 0 on the first pre-supervisor try since the last success (or
        // the last time the desire to run went away entirely).
        if (this.attempt === 0) console.log(`[video] downloading MediaMTX ${MEDIAMTX_VERSION}`);
      };

      const ensured = await this.deps.ensureBinary({ onProgress, onDownloadStart });
      if (!ensured.ok) {
        this.failPreSupervisor(ensured.reason, ensured.placeArchiveAt, ensured.assetName ?? undefined);
        return;
      }

      // Video may have been switched off, or the last relay feed removed,
      // while the download (or an already-cached binary check) ran —
      // recheck before spawning anything.
      if (!(this.enabled && (await this.hasRelayFeeds()))) {
        this.starting = false;
        videoService.setPreAttachStatus(null);
        return;
      }

      const { ports } = await loadFeedsFile();
      const busy = await this.deps.busyPorts(ports);
      if (busy.length > 0) {
        this.failPreSupervisor(busyPortReason(busy), undefined, undefined);
        return;
      }

      const configPath = path.join(relayDir(), "mediamtx.yml");
      try {
        const feeds = await videoService.relayFeeds();
        const config = relayConfig({ ports, lanIp: getLanIp(), users: publishUsers(feeds) });
        await fsp.mkdir(relayDir(), { recursive: true });
        // 0o600, as secrets.ts's own atomicWrite() calls write: the config
        // holds every push feed's live publish password in the clear.
        await atomicWrite(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
      } catch (err) {
        this.failPreSupervisor(`could not write the relay's config: ${errorMessage(err)}`, undefined, undefined);
        return;
      }

      const supervisor = this.deps.makeSupervisor();
      this.statusListener = (status) => this.onSupervisorStatus(status);
      supervisor.on("status", this.statusListener);
      try {
        await supervisor.start(ensured.path, configPath);
      } catch (err) {
        supervisor.off("status", this.statusListener);
        this.statusListener = null;
        this.failPreSupervisor(`could not start the relay: ${errorMessage(err)}`, undefined, undefined);
        return;
      }

      this.attempt = 0;
      this.supervisor = supervisor;
      this.currentPorts = ports;
      this.starting = false;
      const recovered = this.prelaunchOutage.ok("relay-prelaunch", Date.now());
      if (recovered.log) console.log(`[video] the relay's pre-launch checks are passing again${recovered.note}`);
      videoService.attachRelay(this.deps.makeRelay(ports.api), supervisor, ports);
      this.startReadinessPoll();
    } catch (err) {
      this.failPreSupervisor(`could not start the relay: ${errorMessage(err)}`, undefined, undefined);
    }
  }

  /** The supervisor's own status changing — spawn, crash-and-respawn, or a
   *  stop. Manages the readiness poll only: the connection row is driven
   *  entirely off video-service.ts's own publish() (handleRelayStatus,
   *  above), which a status change reaches through video-service's OWN
   *  listener (registered in attachRelay(), and — for every transition
   *  after the very first — always in time to see it). */
  private onSupervisorStatus(status: SupervisorStatus): void {
    if (status.state === "running") this.startReadinessPoll();
    else this.stopReadinessPoll();
  }

  /**
   * Retries reconcileRelay() (video-service.ts, public) until it genuinely
   * applies — the relay's API is not necessarily open the moment the
   * supervisor reports "running" (the supervisor marks a process running the
   * instant it spawns, well before MediaMTX has opened anything), and there
   * is nothing else that would ever call reconcile at all if nobody has the
   * Video feeds page open: video-service's own status poll is gated on a
   * subscriber, but a push feed must still become reachable with nobody
   * watching. The FIRST attempt runs immediately; every one after backs off
   * with restartDelayMs, the same schedule the supervisor's own crash loop
   * uses, rather than hammering a relay that is simply slow to open its API.
   * Stops on a successful reconcile ALONE — not gated on the "started" log
   * line below, which is a separate concern that piggybacks on the same
   * tick. In practice the two are never in tension: MediaMTX's own startup
   * banner (which sets the supervisor's version()) is the FIRST line it
   * ever prints, always before "[API] started with listener" (relay-facts.md),
   * so the version is already known by the time reconcile can possibly
   * succeed.
   */
  private startReadinessPoll(): void {
    if (this.readinessTimer) return;
    let attempt = 0;
    const tick = async () => {
      this.readinessTimer = null;
      if (!this.loggedStartedThisRun) {
        const version = this.supervisor?.version();
        const ports = this.currentPorts;
        if (version && ports) {
          console.log(
            `[video] relay started: MediaMTX ${version}, RTMP ${ports.rtmp}, SRT ${ports.srt}, ` +
              `video to screens UDP ${ports.webrtcUdp}`,
          );
          this.loggedStartedThisRun = true;
        }
      }
      const applied = await videoService.reconcileRelay();
      if (applied) return; // the API has answered — nothing left to retry
      attempt++;
      this.readinessTimer = setTimeout(() => void tick(), restartDelayMs(attempt));
      this.readinessTimer.unref?.();
    };
    void tick();
  }

  /** supervisor.stop(), then await videoService.detachRelay() — in that
   *  order, per the plan's own start/stop sequence. Idempotent: safe to call
   *  with nothing running (reconcileWanted()'s own !wantRunning branch
   *  always calls this, whether or not isUp() is true — see its comment). */
  private async stopRelay(): Promise<void> {
    this.stopReadinessPoll();
    this.clearRetryTimer();
    const supervisor = this.supervisor;
    this.supervisor = null;
    this.currentPorts = null;
    this.starting = false;
    this.attempt = 0;
    if (supervisor && this.statusListener) supervisor.off("status", this.statusListener);
    this.statusListener = null;
    if (supervisor) await supervisor.stop();
    await videoService.detachRelay();
    videoService.setPreAttachStatus(null);
  }
}

export const relayLifecycle = new RelayLifecycle();
videoService.setFeedsChangedListener(() => relayLifecycle.feedsChanged());
videoService.setPortsChangedListener(() => relayLifecycle.portsChanged());
videoService.setRelayStatusListener((relay) => relayLifecycle.handleRelayStatus(relay));
