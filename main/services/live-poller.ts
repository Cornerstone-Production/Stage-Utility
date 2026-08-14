// live-poller.ts — Polls the PCO Services Live countdown and broadcasts it on
// the "pco:live" channel for the dashboard display.
//
// Adaptive cadence: ~1.5s while a service is live (so the countdown is smooth),
// ~20s when idle (just enough to notice a service starting). PCO's rate limit is
// 100 req/20s; even the live cadence (≈13 req/20s) leaves ample headroom. On any
// error we keep the last state and fall back to the idle cadence.

import type { PcoLiveDTO } from "../types/stage.js";
import { baptismTimerService } from "./baptism-timer-service.js";
import { broadcast } from "./broadcaster.js";
import { splRecorder } from "./spl-recorder.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { PcoAuthError } from "./pco-service.js";
import { RepeatLog } from "./repeat-log.js";
import { serviceWindow } from "./service-window.js";
import { stageController } from "./stage-controller.js";

/** Fire-and-forget a per-tick side effect, naming it if it fails. */
function tick(who: string, p: Promise<unknown>): void {
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
// After an auth failure. Slow enough that genuinely wrong credentials cost
// almost nothing and say so once rather than once per tick, fast enough that a
// rotated token or a PCO auth blip heals itself well inside one service.
const AUTH_RETRY_INTERVAL_MS = 5 * 60_000;

// Everything on the live DTO that a client actually reacts to. serverNow is
// deliberately excluded: it changes every tick but the client ticks the countdown
// itself from targetAt/liveStartAt + its own clock, so re-pushing it every second
// is pure overhead. We broadcast only when one of these changes (plus a slow
// keepalive for clock re-sync).
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
const LIVE_KEEPALIVE_MS = 15_000;

class LivePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastSig: string | null = null;
  private lastBroadcastAt = 0;
  /** Collapses a repeating failure so one outage cannot evict the whole log. */
  private readonly errors = new RepeatLog("[live-poller] fetch error:");

  /**
   * Begin polling, or bring the next tick forward if we are already polling.
   *
   * The re-arm matters because an auth failure now backs off for minutes rather
   * than stopping. `if (running) return` used to be harmless — a stood-down
   * poller was not running, so start() always took effect — but with the backoff
   * it would make integration-manager's post-credential-save start() a no-op,
   * and the operator who just fixed their App ID would wait out the backoff
   * wondering whether it had worked.
   */
  start(): void {
    const wasRunning = this.running;
    this.running = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!wasRunning) console.log("[live-poller] start");
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
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

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let live: PcoLiveDTO | null;
    try {
      live = await stageController.fetchLive();
    } catch (err) {
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
      if (err instanceof PcoAuthError) {
        const decision = this.errors.fail(`[live-poller] ${err.message} — retrying every 5 minutes`, Date.now());
        if (decision.line) console.error(decision.line);
        this.schedule(AUTH_RETRY_INTERVAL_MS);
        return;
      }
      // Transient (e.g. 429 / network) — keep last client state, slow down.
      const decision = this.errors.fail(err instanceof Error ? err.message : String(err), Date.now());
      if (decision.line) console.error(decision.line);
      this.schedule(serviceWindow.pollDelayMs(IDLE_INTERVAL_MS, DORMANT_INTERVAL_MS));
      return;
    }

    const recovered = this.errors.ok(Date.now());
    if (recovered.line) console.log(recovered.line);

    // fetchLive is an HTTP call that can take seconds. stop() may have landed
    // while it was in flight, and `running` was only checked on entry — so a
    // config restore, which stops the poller precisely to keep anything from
    // writing over the files it is about to lay down, could still have an
    // auto-advance land afterwards and patch settings.json from a stale cache.
    if (!this.running) return;

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
      tick("spl-recorder", splRecorder.onLiveTick(live));
      // Sample the live attendance/occupancy into the service's trend.
      tick("attendance-recorder", attendanceRecorder.onLiveTick(live));
      // Record the actual rundown timing (item starts/durations vs planned).
      tick("service-timeline-recorder", serviceTimelineRecorder.onLiveTick(live));
      // Start the baptism timer from the plan, when it has been told how.
      tick("baptism-timer", baptismTimerService.onLiveTick(live));
    }

    // Auto mode: roll to the next event once the current one ended (+1h grace).
    tick("auto-advance", stageController.maybeAutoAdvance());

    // Fast cadence while a live item is running (so item switches reflect quickly);
    // a calmer cadence for the preservice countdown (it ticks client-side anyway).
    const active = live?.mode === "item" ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    // A live item means a service is happening whatever the schedule says — only
    // the idle cadence is allowed to go dormant.
    this.schedule(
      live?.mode === "item" ? active : serviceWindow.pollDelayMs(active, DORMANT_INTERVAL_MS),
    );
  }
}

export const livePoller = new LivePoller();
