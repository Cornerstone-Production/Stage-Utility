// server.ts — Server entry point.
//
// Runs the Stage Utility backend: the LAN HTTP/SSE server, device polling, and
// the Planning Center integration. Suitable for a headless host (Proxmox,
// Docker, Raspberry Pi) or a local machine driving the kiosk display.
//
// Usage:
//   npx tsx server.ts
//   STAGE_UTILITY_DATA=/custom/path npx tsx server.ts
//
// Data directory (persists config, secrets, photo cache, encryption key):
//   $STAGE_UTILITY_DATA  — if set
//   ~/.stage-utility     — default

import * as fs from "fs/promises";

import { initLogCapture } from "./main/services/log-buffer.js";
// Capture logs into the ring buffer (exposed at /log) as early as possible.
initLogCapture();

import { initLogPersistence } from "./main/services/log-persist.js";
// Replay the previous run's log tail, then start mirroring new lines to disk, so
// /log spans restarts instead of starting blank after every one.
initLogPersistence();

import { initUpdateLog } from "./main/services/update-log.js";
import { exitForRestart } from "./main/services/update/relaunch.js";
// Replay the last update's persisted activity into the /log buffer (and trim the
// on-disk log) so an update that just restarted us is still visible at /log.
initUpdateLog();

// ── Crash handling ────────────────────────────────────────────────────────────
//
// Registered HERE, above every top-level await below, and not at the foot of the
// module where they started. Module evaluation suspends at each await, so
// handlers declared after them do not exist yet while the whole startup sequence
// runs — the one stretch where a failure is least diagnosable, because the box
// dies before it serves and keeps dying on every supervisor restart. Node's own
// printer writes past the log capture installed above, so /log showed nothing.
//
// The two are deliberately different trades:
//
//   unhandledRejection — keep serving. For an appliance driving live displays,
//   exiting over a failed sample write costs every screen in the building to save
//   one data point. Callers that must not swallow a failure handle it themselves.
//
//   uncaughtException — exit. A synchronous throw can leave a lock held or a
//   socket unpaused, so resuming risks a process that is alive and quietly wrong,
//   and it would stop the supervisor restarting something genuinely wedged. This
//   exists only so the crash reaches /log first.
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandled rejection (kept running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaught exception — exiting so the supervisor restarts us:", err);
  // Through exitForRestart, not a bare exit: "the supervisor restarts us" is not
  // true on launchd, which parks the respawn of a background job that exits
  // ("pended nondemand spawn = inefficient") and leaves the box dark until a
  // human runs kickstart. Same pairing the update and restart paths use.
  exitForRestart(100, 1);
});

import { getUserDataPath } from "./main/services/app-paths.js";
import { deviceManager } from "./main/services/device-manager.js";
import { baptismTimerService } from "./main/services/baptism-timer-service.js";
import { backupScheduler } from "./main/services/backup-scheduler.js";
import { integrationManager } from "./main/services/integration-manager.js";
import { resiService } from "./main/services/resi-service.js";
import { youtubeService } from "./main/services/youtube-service.js";
import { streamStartStore } from "./main/services/stream-start-store.js";
import { livePoller } from "./main/services/live-poller.js";
import { prodcomService } from "./main/services/prodcom-service.js";
import { propresenterService } from "./main/services/propresenter-service.js";
import { sensourceService } from "./main/services/sensource-service.js";
import { tslService } from "./main/services/tsl-service.js";
import { remoteServer } from "./main/services/remote-server.js";
import { stageController } from "./main/services/stage-controller.js";
import { cacheMaintenance } from "./main/services/cache-maintenance.js";
import { reconcileOpenRecords } from "./main/services/reconcile-records.js";

// ── Data directory ────────────────────────────────────────────────────────────
//
// Secrets are encrypted with AES-256-GCM via main/services/encryption.ts, using
// a key file auto-generated in this directory on first run.

const DATA_DIR = getUserDataPath();
await fs.mkdir(DATA_DIR, { recursive: true });
console.log(`[server] data directory: ${DATA_DIR}`);

// ── Init services ─────────────────────────────────────────────────────────────

console.log("[server] initialising services...");
await streamStartStore.init();
await stageController.init();
await integrationManager.init();
await baptismTimerService.init();
// Unattended backups, if the operator has turned them on.
backupScheduler.start();

// Close any history record left open by a prior run (crash / restart mid/after a
// service) before the poller starts — a genuinely-live service reopens on the next tick.
await reconcileOpenRecords().catch((err) => console.error("[server] reconcile failed:", err));

// Wire the remote URL into stage state so clients can see it.
stageController.setRemoteUrl(remoteServer.getLanUrl());

// Fetch current plan on startup if PCO is already configured.
if (stageController.getState().pcoConfigured) {
  try {
    await stageController.refresh();
  } catch (err) {
    console.error("[server] startup PCO refresh failed:", err);
  }
}

// Start the LAN HTTP server (also wires SSE broadcast listener internally).
await remoteServer.start();
await deviceManager.start();

// Start the PCO Services Live poller (dashboard countdown). Self-idles when no
// plan is selected / PCO isn't configured.
livePoller.start();

// Keep the photo + attachment disk caches from growing unbounded over months.
cacheMaintenance.start();

console.log(`[server] ready — control panel at ${remoteServer.getLanUrl()}`);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] received ${signal}, shutting down...`);
  stageController.stopAutoRefresh();
  stageController.stopUpdateChecks();
  stageController.stopDeviceStatusUpdates();
  livePoller.stop();
  cacheMaintenance.stop();
  propresenterService.stop();
  resiService.stop();
  youtubeService.stop();
  prodcomService.stop();
  sensourceService.stop();
  tslService.stop();
  await remoteServer.stop();
  await deviceManager.stop();
  console.log("[server] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(console.error); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(console.error); });

// Crash handlers are registered at the top of this file, above the awaits.
