// live-poller.ts — Polls the PCO Services Live countdown and broadcasts it on
// the "pco:live" channel for the dashboard display.
//
// Adaptive cadence: 1s while a live item is running (so the countdown is smooth),
// 4s for the pre-service countdown, 5 min outside a service window. On a
// transient error we keep the last state and fall back to the idle cadence; after
// an auth failure we ask every 5 minutes. The chain runs on a Ticker, so there is
// only ever one, and nextDelayMs() is the whole delay table.
//
// This is the single largest PCO consumer in the app: at 1s it is about 20
// requests per 20-second window on its own, roughly a fifth of PCO's DEFAULT
// budget before anything else asks for anything. (The header here used to say
// ~1.5s and "≈13 req/20s"; LIVE_INTERVAL_MS has been 1000 for some time, and the
// arithmetic under the old number was also the wrong shape — 20s ÷ 1.5s is 13,
// but the interval is the gap between requests, so 1s means 20.)
//
// "PCO's rate limit is 100 req/20s" is NOT a fact to plan against. PCO documents
// the limit as dynamic and per-endpoint and says applications should never
// hard-code one. So the cadence backs off from what PCO actually reports on its
// response headers — see pcoService.rateLimitTight() and pco-rate-limit.ts.

import type { PcoLiveDTO } from "../types/stage.js";
import { errorMessage } from "./errors.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { broadcast, channelHasSubscribers } from "./broadcaster.js";
import { splRecorder } from "./spl-recorder.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { PcoAuthError, pcoService } from "./pco-service.js";
import { RepeatLog } from "./repeat-log.js";
import { serviceWindow } from "./service-window.js";
import { stageController } from "./stage-controller.js";
import { Ticker } from "./ticker.js";

/** Fire-and-forget a per-tick side effect, naming it if it fails. */
function fireAndLog(who: string, p: Promise<unknown>): void {
  void p.catch((err) => console.error(`[live-poller] ${who} tick failed:`, err));
}

const LIVE_INTERVAL_MS = 1000;
// Preservice/idle: still poll often enough to notice a service going live quickly
// (the countdown itself ticks client-side, so this is just change detection).
const IDLE_INTERVAL_MS = 4000;
// Outside a service window there is nothing to notice, so stop asking so often.
// At 4s around the clock this poll was ~151,000 PCO requests a week, of which only
// about 5% fell anywhere near a service — and unlike the LAN integrations, which
// have honoured the window for a while, it spends a rate-limited cloud quota.
// serviceWindow never sleeps past the next window opening, and fails open when the
// schedule is unknown, so the ramp-up before rehearsal is unaffected.
const DORMANT_INTERVAL_MS = 5 * 60_000;
// Multiplier on the cadence while PCO reports tight headroom. Four is enough to
// take this poller from about a fifth of a typical window's budget to about a
// twentieth without stopping it: an item change is still noticed inside four
// seconds, which is the pre-service cadence and has always been acceptable there.
const RATE_TIGHT_FACTOR = 4;
// After an auth failure. Slow enough that genuinely wrong credentials cost
// almost nothing and say so once rather than once per tick, fast enough that a
// rotated token or a PCO auth blip heals itself well inside one service.
const AUTH_RETRY_INTERVAL_MS = 5 * 60_000;

// Everything on the live DTO that a client actually reacts to. serverNow is
// deliberately excluded: it changes every tick but the client ticks the countdown
// itself from targetAt/liveStartAt + its own clock, so re-pushing it every second
// is pure overhead. We broadcast only when one of these changes — plus a slow
// keepalive for clock re-sync, which runs on its OWN interval rather than inside
// the tick, because the tick's cadence is Planning Center's and a client's clock
// drift is not (see LIVE_KEEPALIVE_MS).
function liveSignature(l: PcoLiveDTO): string {
  return JSON.stringify([
    l.mode, l.currentItemId, l.label, l.lengthSec, l.liveStartAt, l.targetAt,
    l.serviceTimeId, l.serviceTimeStartsAt, l.currentItemTitle, l.nextItemTitle,
    // The derived item clock changes only when the plan is edited or the service
    // time moves — rare, but automation rules read it, so a stale one would arm
    // them against yesterday's rundown.
    l.itemSchedule,
    // Changes only when the plan or its times change, so this adds no broadcast
    // volume — and omitting it would let a stale copy arm a time-relative trigger
    // against last week's rehearsal.
    l.planTimes,
  ]);
}
// Re-push at least this often even when unchanged, so a client's clock-skew estimate
// can't drift and a just-connected client stays fresh. Still ~15x fewer pushes than 1 Hz.
//
// It is enforced on its OWN interval, not only inside tick(). Outside a service
// window the tick runs every five minutes, so the check below it could not fire
// any sooner than that: a display loaded on a Tuesday sat at a skew of 0 —
// meaning it rendered the host browser's clock, whatever that was — until the
// next tick happened to come round. The keepalive is about the CLIENT's clock,
// which drifts on its own schedule and not on Planning Center's, so it is timed
// on its own. The interval never calls PCO; it re-sends the last DTO with a
// fresh `serverNow`.
const LIVE_KEEPALIVE_MS = 15_000;

/**
 * What one tick did, which is all the delay table needs to know. "superseded"
 * is a tick whose read finished after a start() or stop(): it acts on nothing,
 * and the Ticker does not re-arm it, because the generation moved.
 */
type LiveTick = "item" | "idle" | "failed" | "auth-failed" | "superseded";

class LivePoller {
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Bumped by start() and stop(). A tick that started under another one is
   *  stale: see LiveTick's "superseded". */
  private generation = 0;
  private lastSig: string | null = null;
  private lastBroadcastAt = 0;
  /** Collapses a repeating failure so one outage cannot evict the whole log. */
  private readonly errors = new RepeatLog("[live-poller] fetch error:");
  /** The same, for a throw from the work done with a read that succeeded. */
  private readonly actErrors = new RepeatLog("[live-poller] tick failed after the read:");
  /** The one poll chain: see ticker.ts for why a second cannot start. */
  private readonly ticker = new Ticker<LiveTick>({
    tick: () => this.tick(),
    nextDelayMs: (outcome) => this.nextDelayMs(outcome),
    wanted: () => this.running,
    generation: () => this.generation,
  });

  /**
   * Begin polling, or bring the next tick forward if we are already polling.
   *
   * Never a no-op: an auth failure backs off for minutes rather than stopping,
   * so integration-manager's post-credential-save start() has to take effect
   * at once, or the operator who just fixed their App ID would wait out the
   * backoff wondering whether it had worked. A tick already awaiting fetchLive
   * is superseded: the poller drops its read and it does not re-arm.
   */
  start(): void {
    const wasRunning = this.running;
    this.running = true;
    this.generation++;
    if (!wasRunning) console.log("[live-poller] start");
    if (!this.keepaliveTimer) {
      this.keepaliveTimer = setInterval(() => this.clockKeepalive(), LIVE_KEEPALIVE_MS);
      this.keepaliveTimer.unref?.();
    }
    void this.ticker.run();
  }

  /**
   * Re-send the last live DTO with a fresh `serverNow`, for clock re-sync only.
   *
   * Never touches Planning Center: this is the same object the last fetch
   * produced, restamped. Silent when nothing subscribes to pco:live, so an
   * unattended appliance broadcasts into an empty room 0 times an hour rather
   * than 240.
   */
  private clockKeepalive(): void {
    // No `running` check: stop() clears this interval, so there is no state in
    // which this runs stopped. A check that cannot fail was written here first
    // and would not go red on removal, which is the repo's test for dead code.
    if (!channelHasSubscribers("pco:live")) return;
    const last = stageController.getLastLive();
    if (!last) return;
    const now = Date.now();
    if (now - this.lastBroadcastAt < LIVE_KEEPALIVE_MS) return;
    broadcast("pco:live", { ...last, serverNow: new Date().toISOString() });
    this.lastBroadcastAt = now;
  }

  stop(): void {
    // Running goes false before the cancel, so a tick in flight cannot re-arm.
    this.running = false;
    this.generation++;
    this.ticker.cancel();
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /**
   * Stop, and hand back the undo.
   *
   * start() is called from exactly one place — boot — so anything that stops the
   * poller and does not put it back has stopped it for the life of the process.
   * A config restore did that on its failure path: the box kept serving with
   * nothing polling PCO. See stageController.pauseBackgroundWork.
   */
  pause(): () => void {
    const wasRunning = this.running;
    this.stop();
    return () => {
      if (wasRunning) this.start();
    };
  }

  /** The delay table. */
  private nextDelayMs(outcome: LiveTick | null): number {
    switch (outcome) {
      // Bad credentials are usually a configuration fault, so ask rarely; see
      // the auth branch in tick().
      case "auth-failed":
        return AUTH_RETRY_INTERVAL_MS;
      // Fast cadence while a live item is running (so item switches reflect
      // quickly). A live item means a service is happening whatever the
      // schedule says, so this is the one delay that never goes dormant.
      case "item":
        return LIVE_INTERVAL_MS * this.rateFactor();
      // A calmer cadence for the preservice countdown (it ticks client-side
      // anyway), stretched outside a service window.
      case "idle":
        return serviceWindow.pollDelayMs(IDLE_INTERVAL_MS * this.rateFactor(), DORMANT_INTERVAL_MS);
      // A transient failure (e.g. 429 / network) keeps the last client state
      // and slows down; so does a tick that threw (null). "superseded" is never
      // asked: its generation moved, so the Ticker does not re-arm it.
      default:
        return serviceWindow.pollDelayMs(IDLE_INTERVAL_MS, DORMANT_INTERVAL_MS);
    }
  }

  /**
   * Past PCO's high-water mark, stretch the cadence rather than wait to be
   * refused. This poller is the biggest single consumer, so slowing it is the
   * change that actually returns headroom — the concurrency gate only stops a
   * burst, and this is a steady drip. The countdown ticks client-side from
   * liveStartAt, so a longer poll costs the freshness of an item CHANGE, not
   * the smoothness of the clock. pcoService logs the transition once.
   */
  private rateFactor(): number {
    return pcoService.rateLimitTight() ? RATE_TIGHT_FACTOR : 1;
  }

  /** A read that finished after a start() or stop(); nothing acts on it. */
  private superseded(): LiveTick {
    console.log("[live-poller] dropped a read that finished after the poller restarted or stopped");
    return "superseded";
  }

  /** One poll. Returns what it did; the Ticker arms the next one from that. */
  private async tick(): Promise<LiveTick> {
    const generation = this.generation;
    let live: PcoLiveDTO | null;
    try {
      live = await stageController.fetchLive();
    } catch (err) {
      if (generation !== this.generation) return this.superseded();
      // Bad credentials are usually a CONFIGURATION fault: every retry fails the
      // same way and asking again every 4s writes one line per tick until the
      // log holds nothing else. So back off hard — but do NOT stop.
      //
      // Stopping was worse than the noise it prevented. start() is called from
      // boot and from integration-manager when a credential check passes, and
      // nothing re-verifies on a timer, so a single 401 ended polling for the
      // life of the process. A 401 is not always a typo: a rotated token, an org
      // re-authorisation, or a PCO auth blip produces one too, and fetchLive()
      // fans out to several requests so any one of them is enough. Mid-service
      // that froze the countdown on every display and stopped the SPL,
      // attendance and timeline recorders — which are fed from this tick — with
      // no raw archive to rebuild from and no recovery short of a restart.
      //
      // Saving credentials still restarts the poller, so the fast path is intact;
      // this is only the floor under it.
      const auth = err instanceof PcoAuthError;
      const message = auth ? `${errorMessage(err)} — retrying every 5 minutes` : errorMessage(err);
      const decision = this.errors.fail(message, Date.now());
      if (decision.line) console.error(decision.line);
      return auth ? "auth-failed" : "failed";
    }

    // fetchLive is an HTTP call that can take seconds, and start() or stop()
    // may have landed while it was in flight. The poller acts on nothing it read
    // then: a config restore stops it precisely to keep anything from writing
    // over the files it is about to lay down, and its resume (or a credential
    // save) has already started a fresh tick. (fetchLive itself still caches
    // the read as the controller's last live state; that is its own business.)
    if (generation !== this.generation) return this.superseded();

    const recovered = this.errors.ok(Date.now());
    if (recovered.line) console.log(recovered.line);

    // A throw from here on is a bug in what a read feeds, not a Planning Center
    // failure. It costs what this tick had left to do and says so once per run,
    // rather than once a second as an unhandled rejection would. The read itself
    // was good, so the cadence stays the read's: a live item keeps polling every
    // second, because nothing may slow a live service down to the dormant delay.
    try {
      this.act(live);
      const healed = this.actErrors.ok(Date.now());
      if (healed.line) console.log(healed.line);
    } catch (err) {
      const failed = this.actErrors.fail(errorMessage(err), Date.now());
      if (failed.line) console.error(failed.line);
    }

    return live?.mode === "item" ? "item" : "idle";
  }

  /** Everything one successful read feeds: the broadcast, the recorders and
   *  auto-advance. Synchronous; the side effects run fire-and-forget. */
  private act(live: PcoLiveDTO | null): void {
    if (live) {
      // Poll fast (to detect item switches promptly) but only PUSH when something
      // the client renders actually changed — or every LIVE_KEEPALIVE_MS for clock
      // re-sync. Cuts pco:live from 1 push/sec/client to ~1 per item change.
      const sig = liveSignature(live);
      const now = Date.now();
      if (sig !== this.lastSig || now - this.lastBroadcastAt >= LIVE_KEEPALIVE_MS) {
        broadcast("pco:live", live);
        this.lastSig = sig;
        this.lastBroadcastAt = now;
      }
      // Each recorder is independent: one failing (a full disk, a read-only data
      // dir) must cost that recorder's sample and nothing else. Without these the
      // rejection is unhandled, and Node's default is to take the whole server —
      // and every stage display with it — down mid-service.
      // Fold the current SPL reading into the live item's running max/avg.
      fireAndLog("spl-recorder", splRecorder.onLiveTick(live));
      // Sample the live attendance/occupancy into the service's trend.
      fireAndLog("attendance-recorder", attendanceRecorder.onLiveTick(live));
      // Record the actual rundown timing (item starts/durations vs planned).
      fireAndLog("service-timeline-recorder", serviceTimelineRecorder.onLiveTick(live));
      // Start the baptism timer from the plan, when it has been told how.
      fireAndLog("baptism-timer", baptismTimerService.onLiveTick(live));
    }

    // Auto mode: roll to the next event once the current one ended (+1h grace).
    fireAndLog("auto-advance", stageController.maybeAutoAdvance());
  }
}

export const livePoller = new LivePoller();
