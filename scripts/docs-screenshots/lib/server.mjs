// lib/server.mjs — start the app under capture, on a scratch data dir, and stop it.
//
// The rules this enforces, because the machine this runs on usually has a real
// install beside it:
//   - the data dir must be new or empty: never an install's, never a copy of one
//   - the server must answer with THIS data dir before anything is written to it
//   - the friendly port (:80) is switched off so a stopped real install cannot be
//     replaced by this one
//   - the kiosk discovery port is moved in settings.json before start, so the Mac
//     output helper's probes on UDP 8789 are never answered
//   - it is stopped by port, never by pattern

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");

/** A port nothing real listens on: not 8788, not 80, not the helper's UDP 8789. */
export const DEFAULT_PORT = 8797;
/** A UDP port nothing real probes (the default is 8789). */
export const DISCOVERY_PORT = 48789;

const REAL_DATA_DIRS = ["/usr/local/var/stage-utility", "/var/lib/stage-utility", "/opt/stage-utility"];

export function assertScratchDir(dir) {
  const resolved = path.resolve(dir);
  const home = process.env.HOME ? path.resolve(process.env.HOME, ".stage-utility") : null;
  if (REAL_DATA_DIRS.some((d) => resolved === d || resolved.startsWith(`${d}/`)) || resolved === home) {
    throw new Error(`${resolved} is a real install's data directory; refusing to use it`);
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) {
    throw new Error(`${resolved} is not empty; the screenshot server only runs on a directory made for it`);
  }
}

/** Anything already listening on the port means a real or stale server; stop before starting. */
export function portHolder(port) {
  try {
    const out = execFileSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" }).trim();
    return out ? out.split("\n").map(Number) : [];
  } catch {
    return [];
  }
}

export function killByPort(port) {
  for (const pid of portHolder(port)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(fn, what, ms = 60_000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/**
 * @param {{ dataDir: string, port: number, now: Date, stateFile: string, logFile: string, preload?: boolean }} opts
 */
export async function startServer(opts) {
  const { dataDir, port, now, stateFile, logFile } = opts;
  if (portHolder(port).length > 0) {
    throw new Error(`port ${port} is already in use; stop whatever holds it (by port) or pass --port`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const settingsFile = path.join(dataDir, "settings.json");
  if (!fs.existsSync(settingsFile)) {
    // Discovery on, so the Screens page has a found-devices banner to show, and on
    // a port nothing real probes.
    fs.writeFileSync(settingsFile, JSON.stringify({ kioskDiscovery: true, kioskDiscoveryPort: DISCOVERY_PORT }, null, 2));
  }
  const log = fs.openSync(logFile, "a");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--import", path.join(here, "../preload.mjs"), path.join(REPO_ROOT, "server.ts")],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        STAGE_UTILITY_DATA: dataDir,
        STAGE_UTILITY_PORT: String(port),
        STAGE_UTILITY_FRIENDLY_PORT: "0",
        DOCS_SHOT_NOW: now.toISOString(),
        DOCS_SHOT_STATE_FILE: stateFile,
      },
    },
  );
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const base = `http://127.0.0.1:${port}`;
  const version = await waitFor(async () => {
    if (exited) throw new Error(`the server exited; see ${logFile}`);
    const res = await fetch(`${base}/api/version`);
    return res.ok ? res.json() : null;
  }, "the server to answer");
  // Verify the server before writing: it must be the one we just started, on the
  // scratch directory, not something that was already on the port.
  if (fs.realpathSync(version.dataDir) !== fs.realpathSync(dataDir)) {
    child.kill("SIGTERM");
    throw new Error(`the server on ${port} uses ${version.dataDir}, not ${dataDir}; refusing to write to it`);
  }
  return {
    base,
    port,
    child,
    stop: async () => {
      child.kill("SIGTERM");
      await waitFor(() => portHolder(port).length === 0, "the port to free", 15_000).catch(() => killByPort(port));
    },
  };
}
