// live-poller.ts — Polls the PCO Services Live countdown and broadcasts it on
// the "pco:live" channel for the dashboard display.
//
// Adaptive cadence: ~1.5s while a service is live (so the countdown is smooth),
// ~20s when idle (just enough to notice a service starting). PCO's rate limit is
// 100 req/20s; even the live cadence (≈13 req/20s) leaves ample headroom. On any
// error we keep the last state and fall back to the idle cadence.

import type { PcoLiveDTO } from "../types/stage.js";
import { broadcast } from "./broadcaster.js";
import { stageController } from "./stage-controller.js";

const LIVE_INTERVAL_MS = 1500;
const IDLE_INTERVAL_MS = 20_000;

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
    }

    // Fast cadence only while actually live; otherwise idle.
    this.schedule(live?.isLive ? LIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
  }
}

export const livePoller = new LivePoller();
