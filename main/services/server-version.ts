// server-version.ts — the id advertised to kiosks on every SSE connect.
//
// Lives on its own so both the server and the state route can read it without
// the routes importing the server back (which would close an import cycle).

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RENDERER_BUILD_DIR = path.join(process.cwd(), "build", "renderer");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A stable id for the currently-running code, advertised to kiosks on every SSE
 * connect (the "server:hello" event). A display that reconnects after a restart
 * and sees a *different* version reloads itself, so updates roll out to screens
 * automatically. Git short SHA when available (changes only on a real update,
 * not a plain crash-restart); else a hash of the built index.html (changes when
 * the frontend bundle changes). "unknown" disables the auto-reload (never false).
 */
export function computeServerVersion(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // not a git checkout — fall through
  }
  try {
    const html = readFileSync(path.join(RENDERER_BUILD_DIR, "index.html"));
    return "b" + crypto.createHash("sha1").update(html).digest("hex").slice(0, 8);
  } catch {
    // no build present
  }
  return "unknown";
}
export const SERVER_VERSION = computeServerVersion();
