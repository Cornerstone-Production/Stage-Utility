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

import { getUserDataPath } from "./main/services/app-paths.js";
import { deviceManager } from "./main/services/device-manager.js";
import { integrationManager } from "./main/services/integration-manager.js";
import { remoteServer } from "./main/services/remote-server.js";
import { stageController } from "./main/services/stage-controller.js";

// ── Data directory ────────────────────────────────────────────────────────────
//
// Secrets are encrypted with AES-256-GCM via main/services/encryption.ts, using
// a key file auto-generated in this directory on first run.

const DATA_DIR = getUserDataPath();
await fs.mkdir(DATA_DIR, { recursive: true });
console.log(`[server] data directory: ${DATA_DIR}`);

// ── Init services ─────────────────────────────────────────────────────────────

console.log("[server] initialising services...");
await stageController.init();
await integrationManager.init();

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

// Keep the plan fresh — re-fetch from PCO every hour.
stageController.startAutoRefresh();

// Start the LAN HTTP server (also wires SSE broadcast listener internally).
await remoteServer.start();
await deviceManager.start();

console.log(`[server] ready — control panel at ${remoteServer.getLanUrl()}`);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[server] received ${signal}, shutting down...`);
  stageController.stopAutoRefresh();
  await remoteServer.stop();
  await deviceManager.stop();
  console.log("[server] shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => { shutdown("SIGTERM").catch(console.error); });
process.on("SIGINT",  () => { shutdown("SIGINT").catch(console.error); });
