// server.ts — Standalone headless server entry point.
//
// Runs the Stage Monitor backend without any Glaze/Electron dependencies.
// Suitable for running on a headless server (e.g. Proxmox, Docker, Raspberry Pi).
//
// Usage:
//   npx tsx server.ts
//   STAGE_MONITOR_DATA=/custom/path npx tsx server.ts
//
// Data directory (persists config, secrets, photo cache):
//   $STAGE_MONITOR_DATA  — if set
//   ~/.stage-monitor     — default

import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { setUserDataPath } from "./main/services/app-paths.js";
import { setEncryptionBackend } from "./main/services/encryption.js";
import { deviceManager } from "./main/services/device-manager.js";
import { integrationManager } from "./main/services/integration-manager.js";
import { remoteServer } from "./main/services/remote-server.js";
import { stageController } from "./main/services/stage-controller.js";

// ── Data directory ────────────────────────────────────────────────────────────

const DATA_DIR =
  process.env.STAGE_MONITOR_DATA ?? path.join(os.homedir(), ".stage-monitor");

await fs.mkdir(DATA_DIR, { recursive: true });
console.log(`[server] data directory: ${DATA_DIR}`);
setUserDataPath(DATA_DIR);

// ── AES-256-GCM encryption backend ───────────────────────────────────────────
//
// Key is a 32-byte random value stored at $DATA_DIR/encryption.key (mode 0o600).
// Generated automatically on first run.
//
// Ciphertext layout: [ 12-byte IV ][ 16-byte authTag ][ encrypted bytes ]
//
// NOTE: Secrets encrypted by Glaze's safeStorage are NOT compatible with this
// backend. If migrating from Glaze mode, you will need to re-enter credentials.

const KEY_FILE = path.join(DATA_DIR, "encryption.key");

async function loadOrCreateKey(): Promise<Buffer> {
  try {
    const key = await fs.readFile(KEY_FILE);
    if (key.length !== 32) {
      throw new Error(`[server] encryption key at ${KEY_FILE} is ${key.length} bytes; expected 32`);
    }
    console.log(`[server] loaded encryption key from ${KEY_FILE}`);
    return key;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Key file doesn't exist yet — generate and save.
    const key = crypto.randomBytes(32);
    await fs.writeFile(KEY_FILE, key, { mode: 0o600 });
    console.log(`[server] generated new encryption key → ${KEY_FILE}`);
    return key;
  }
}

const encryptionKey = await loadOrCreateKey();

setEncryptionBackend({
  isAvailable: async () => true,

  encrypt: async (plaintext: string): Promise<Buffer> => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag(); // always 16 bytes
    return Buffer.concat([iv, authTag, encrypted]);
  },

  decrypt: async (ciphertext: Buffer): Promise<string> => {
    if (ciphertext.length < 28) {
      throw new Error("[server] decrypt: ciphertext too short (< 28 bytes)");
    }
    const iv = ciphertext.subarray(0, 12);
    const authTag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
  },
});

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
