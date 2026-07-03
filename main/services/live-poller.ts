// live-poller.ts — Polls the PCO Services Live countdown and broadcasts it on
// the "pco:live" channel for the dashboard display.
//
// Adaptive cadence: ~1.5s while a service is live (so the countdown is smooth),
// ~20s when idle (just enough to notice a service starting). PCO's rate limit is
// 100 req/20s; even the live cadence (≈13 req/20s) leaves ample headroom. On any
// error we keep the last state and fall back to the idle cadence.

import type { PcoLiveDTO } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { splRecorder } from "./spl-recorder.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { stageController } from "./stage-controller.js";

const LIVE_INTERVAL_MS = 1000;
// Preservice/idle: still poll often enough to notice a service going live quickly
// (the countdown itself ticks client-side, so this is just change detection).
const IDLE_INTERVAL_MS = 4000;

class LivePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log("[live-poller] start");
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let live: PcoLiveDTO | null = null;
    try {
      live = await stageController.fetchLive();
    } catch (err) {
      // Transient (e.g. 429 / network) — keep last client state, slow down.
      console.error("[live-poller] fetch error:", err instanceof Error ? err.message : err);
      this.schedule(IDLE_INTERVAL_MS);
      return;
    }

    if (live) {
      broadcast("pco:live", live);
      // Fold the current SPL reading into the live item's running max/avg.
      void splRecorder.onLiveTick(live);
      // Sample the live attendance/occupancy into the service's trend.
      void attendanceRecorder.onLiveTick(live);
      // Record the actual rundown timing (item starts/durations vs planned).
      void serviceTimelineRecorder.onLiveTick(live);
    }

    // Auto mode: roll to the next event once the current one ended (+1h grace).
    void stageController.maybeAutoAdvance();

    // Fast cadence while a live item is running (so item switches reflect quickly);
    // a calmer cadence for the preservice countdown (it ticks client-side anyway).
    this.schedule(live?.mode === "item" ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
  }
}

export const livePoller = new LivePoller();
