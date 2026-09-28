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
// it through setEnabled(); it drives the manager's row back through
// setConnectionListener().
//
// Every dependency is injected (constructor default: the real ones), so the
// whole start/stop sequence is testable with fakes — the real download only
// ever happens on the machine where video is actually switched on.

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { errorMessage } from "../errors.js";
import { getLanIp } from "../lan-ip.js";
import type { ConnectionState } from "../../types/integrations.js";
import type { RelayStatus, VideoPorts } from "../../types/video.js";
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

/** RelayStatus -> the integration manager's connection state, the same
 *  mapping for every source (ensureBinary's own progress, a pre-supervisor
 *  failure, or the supervisor's own status) — see reportCurrent() below,
 *  which reads `(await videoService.state()).relay` and hands it here rather
 *  than any caller re-deriving a RelayStatus of its own. Exported and pure,
 *  so the mapping itself is tested without a supervisor, a binary or a
 *  network call anywhere near it. */
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
      return { state: "connected", message: `MediaMTX ${relay.version}` };
    case "failing":
      return { state: "error", message: relay.reason };
  }
}

/** How often relay-lifecycle retries reconcileRelay() after a fresh start,
 *  until the relay's API answers once — see startReadinessPoll()'s own
 *  comment for why this cannot simply wait for videoService's own
 *  subscriber-gated poll. Once a second is frequent enough that an operator
 *  watching the page sees paths appear promptly, and infrequent enough that
 *  a relay taking a while to open its API costs nothing but a few failed,
 *  already-throttled reconcile attempts (OutageLog, under reconcileOnce()'s
 *  own "reconcile" key). */
const RELAY_READINESS_POLL_MS = 1000;
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
  /** Serializes setEnabled()/feedsChanged()/portsChanged()/the retry timer
   *  through one chain, so two calls landing close together (a feed removed
   *  right as the switch is flicked, say) are never interleaved mid-async —
   *  each one's own `wantRunning`/`isUp()` reads are only ever true for the
   *  state as it stood once every earlier call had fully settled. */
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

  private async reportCurrent(): Promise<void> {
    const s = await videoService.state();
    const { state, message } = relayConnectionState(s.relay);
    this.report(state, message);
  }

  /** True while the relay is up, coming up, or a supervisor is holding a
   *  failing/backoff state on our behalf — i.e. while there is something for
   *  a "stop" to undo. `starting` covers the window before any supervisor
   *  exists (ensureBinary, the port check, writing the config); `supervisor
   *  !== null` covers everything after supervisor.start() succeeds,
   *  including its own "failing" backoff — that supervisor is still ours to
   *  stop. */
  private isUp(): boolean {
    return this.starting || this.supervisor !== null;
  }

  private async hasRelayFeeds(): Promise<boolean> {
    const { feeds } = await loadFeedsFile();
    return feeds.some((f) => f.source.kind === "pull" || f.source.kind === "push");
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn);
    return this.chain;
  }

  /** integration-manager.ts's applyVideo(): video's own enabled flag. */
  setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    return this.enqueue(() => this.reconcileWanted());
  }

  /** video-service.ts's feedsChangedListener — a feed was added, changed or
   *  removed. */
  feedsChanged(): Promise<void> {
    return this.enqueue(() => this.reconcileWanted());
  }

  /** video-service.ts's portsChangedListener — PATCH /api/video/ports just
   *  saved a new set. Restarts an already-running relay on them; a stopped
   *  one simply starts on the new ports next time, since startRelay() always
   *  reads them fresh from the store. */
  portsChanged(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.isUp()) return;
      await this.stopRelay();
      await this.reconcileWanted();
    });
  }

  private async reconcileWanted(): Promise<void> {
    const wantRunning = this.enabled && (await this.hasRelayFeeds());
    if (wantRunning && !this.isUp()) {
      await this.startRelay();
    } else if (!wantRunning && this.isUp()) {
      console.log(`[video] relay stopped (${this.enabled ? "no relay feeds" : "video switched off"})`);
      await this.stopRelay();
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopReadinessPoll(): void {
    if (this.readinessTimer) clearInterval(this.readinessTimer);
    this.readinessTimer = null;
  }

  /** A failure before any supervisor exists — nothing to hand a "failing"
   *  SupervisorStatus, so relayStatus() is told directly through
   *  setPreAttachStatus(). Retried on the same backoff schedule the
   *  supervisor itself uses (restartDelayMs) once one is running. */
  private failPreSupervisor(reason: string, placeArchiveAt: string | undefined): void {
    this.starting = false;
    const delay = restartDelayMs(this.attempt);
    this.attempt++;
    videoService.setPreAttachStatus({ state: "failing", reason, retryAt: Date.now() + delay, placeArchiveAt });
    void this.reportCurrent();
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => void this.enqueue(() => this.reconcileWanted()), delay);
    this.retryTimer.unref?.();
  }

  private async startRelay(): Promise<void> {
    this.starting = true;
    this.loggedStartedThisRun = false;
    this.report("connecting", "Starting the video relay");

    let lastProgressAt = 0;
    const onProgress = (received: number, total: number) => {
      const now = Date.now();
      if (received < total && now - lastProgressAt < DOWNLOAD_PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      videoService.setPreAttachStatus({ state: "downloading", receivedBytes: received, totalBytes: total });
      void this.reportCurrent();
    };

    const ensured = await this.deps.ensureBinary({ onProgress });
    if (!ensured.ok) {
      this.failPreSupervisor(ensured.reason, ensured.placeArchiveAt);
      return;
    }

    // Video may have been switched off, or the last relay feed removed,
    // while the download (or an already-cached binary check) ran — recheck
    // before spawning anything.
    if (!(this.enabled && (await this.hasRelayFeeds()))) {
      this.starting = false;
      videoService.setPreAttachStatus(null);
      void this.reportCurrent();
      return;
    }

    const { ports } = await loadFeedsFile();
    const busy = await this.deps.busyPorts(ports);
    if (busy.length > 0) {
      this.failPreSupervisor(busyPortReason(busy), undefined);
      return;
    }

    const configPath = path.join(relayDir(), "mediamtx.yml");
    try {
      const feeds = await videoService.relayFeeds();
      const config = relayConfig({ ports, lanIp: getLanIp(), users: publishUsers(feeds) });
      await fsp.mkdir(relayDir(), { recursive: true });
      await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    } catch (err) {
      this.failPreSupervisor(`could not write the relay's config: ${errorMessage(err)}`, undefined);
      return;
    }

    const supervisor = this.deps.makeSupervisor();
    this.statusListener = (status) => this.onSupervisorStatus(status, ports);
    supervisor.on("status", this.statusListener);

    try {
      await supervisor.start(ensured.path, configPath);
    } catch (err) {
      supervisor.off("status", this.statusListener);
      this.statusListener = null;
      this.failPreSupervisor(`could not start the relay: ${errorMessage(err)}`, undefined);
      return;
    }

    this.attempt = 0;
    this.supervisor = supervisor;
    this.starting = false;
    videoService.attachRelay(this.deps.makeRelay(ports.api), supervisor, ports);
    this.startReadinessPoll(ports);
  }

  /**
   * The supervisor's own status changing — spawn, crash-and-respawn, or a
   * stop this class itself did not initiate directly (there is none today,
   * but the listener is what would see it). Reports the current connection
   * state fresh from videoService.state() rather than mapping `status`
   * itself: videoService.relayStatus() already folds in "not answering" and
   * the attached ports, and re-deriving that switch here would be the exact
   * duplication CLAUDE.md's "fixing a repeated pattern" warns about.
   */
  private onSupervisorStatus(status: SupervisorStatus, ports: VideoPorts): void {
    void this.reportCurrent();
    if (status.state === "running") this.startReadinessPoll(ports);
    else this.stopReadinessPoll();
  }

  /**
   * Retries reconcileRelay() (video-service.ts, public) once a second until
   * it genuinely applies — the relay's API is not necessarily open the
   * moment the supervisor reports "running" (the supervisor marks a process
   * running the instant it spawns, well before MediaMTX has opened
   * anything), and there is nothing else that would ever call reconcile at
   * all if nobody has the Video feeds page open: videoService's own status
   * poll is gated on a subscriber, but a push feed must still become
   * reachable with nobody watching. Kept running for as long as the
   * supervisor reports "running" and reconcile has not yet applied for THIS
   * run — matching the supervisor's own "never give up" philosophy rather
   * than abandoning the relay's paths to a single bounded attempt.
   *
   * Also where "relay started: …" is logged, once — not on the first tick
   * unconditionally, because `supervisor.version()` is null until the
   * relay's own startup banner line has actually been read (asynchronous,
   * after the process starts writing to stdout), which a status of
   * "running" alone does not guarantee has happened yet.
   */
  private startReadinessPoll(ports: VideoPorts): void {
    if (this.readinessTimer) return;
    const tick = async () => {
      if (!this.loggedStartedThisRun) {
        // Read fresh every tick, never a captured local: startRelay()'s own
        // supervisor.start() can emit "running" (onSupervisorStatus, which
        // calls startReadinessPoll()) SYNCHRONOUSLY, before this.supervisor is
        // assigned — the real RelaySupervisor's spawnChild() sets its status
        // the moment it spawns, reached through no further await once
        // killLeftover() resolves. A closed-over `supervisor` local captured
        // at that moment would be stuck on whatever this.supervisor held a
        // MOMENT AGO (null, on a fresh start) forever after: this.readinessTimer
        // being already set blocks every later call to this method from ever
        // replacing it.
        const version = this.supervisor?.version();
        if (version) {
          console.log(
            `[video] relay started: MediaMTX ${version}, RTMP ${ports.rtmp}, SRT ${ports.srt}, ` +
              `video to screens UDP ${ports.webrtcUdp}`,
          );
          this.loggedStartedThisRun = true;
        }
      }
      const applied = await videoService.reconcileRelay();
      if (applied && this.loggedStartedThisRun) this.stopReadinessPoll();
    };
    this.readinessTimer = setInterval(() => void tick(), RELAY_READINESS_POLL_MS);
    this.readinessTimer.unref?.();
    void tick();
  }

  /** supervisor.stop(), then await videoService.detachRelay() — in that
   *  order, per the plan's own start/stop sequence. */
  private async stopRelay(): Promise<void> {
    this.stopReadinessPoll();
    this.clearRetryTimer();
    const supervisor = this.supervisor;
    this.supervisor = null;
    this.starting = false;
    if (supervisor && this.statusListener) supervisor.off("status", this.statusListener);
    this.statusListener = null;
    if (supervisor) await supervisor.stop();
    await videoService.detachRelay();
    videoService.setPreAttachStatus(null);
    await this.reportCurrent();
  }
}

export const relayLifecycle = new RelayLifecycle();
videoService.setFeedsChangedListener(() => void relayLifecycle.feedsChanged());
videoService.setPortsChangedListener(() => void relayLifecycle.portsChanged());
