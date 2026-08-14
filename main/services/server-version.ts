// server-version.ts — the id advertised to kiosks on every SSE connect.
//
// Lives on its own so both the server and the state route can read it without
// the routes importing the server back (which would close an import cycle).

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { APP_ROOT } from "./app-root.js";

/**
 * A stable id for the currently-running code, advertised to kiosks on every SSE
 * connect (the "server:hello" event). A display that reconnects after a restart
 * and sees a *different* version reloads itself, so updates roll out to screens
 * automatically. Git short SHA when available (changes only on a real update,
 * not a plain crash-restart); else a hash of the built index.html (changes when
 * the frontend bundle changes). "unknown" disables the auto-reload (never false).
 *
 * Resolved against the install root, not cwd — a packaged install runs from
 * wherever the operator launched it, and a cwd-relative path silently resolves
 * to nothing. The parameter exists so tests can point it at a fixture.
 */
export function computeServerVersion(root: string = APP_ROOT): string {
  try {
    // Is THIS DIRECTORY a checkout — not merely inside somebody's? `git
    // rev-parse` walks UP the tree, and a Homebrew keg lives inside
    // /opt/homebrew, which is a git repository. Without the toplevel check a
    // brew install advertised HOMEBREW'S commit as its version — and since
    // displays reload when this id changes, every `brew update` (of anything)
    // reloaded every screen in the building. Same trap, same fix as updater.ts.
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    // realpath, not resolve: --show-toplevel dereferences symlinks (macOS's
    // /var IS one), so a literal comparison calls a real checkout foreign.
    const top = git(["rev-parse", "--show-toplevel"]);
    if (top && fs.realpathSync(top) === fs.realpathSync(root)) {
      const sha = git(["rev-parse", "--short", "HEAD"]);
      if (sha) return sha;
    }
  } catch {
    // not a git checkout — fall through
  }
  try {
    const html = fs.readFileSync(path.join(root, "build", "renderer", "index.html"));
    return "b" + crypto.createHash("sha1").update(html).digest("hex").slice(0, 8);
  } catch {
    // no build present
  }
  return "unknown";
}
export const SERVER_VERSION = computeServerVersion();
