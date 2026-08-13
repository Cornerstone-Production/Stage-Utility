import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { computeServerVersion } from "./server-version.js";

// The regression this guards: `git rev-parse` walks UP the tree, and a Homebrew
// keg lives inside /opt/homebrew — a git repository. computeServerVersion
// reported HOMEBREW'S commit as this server's version, and since displays
// reload when the id changes, every `brew update` reloaded every screen.

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sv-test-"));
}

/** A throwaway checkout with one commit, so HEAD resolves. */
function tmpRepo(): string {
  const dir = tmpdir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
  });
  return dir;
}

describe("computeServerVersion", () => {
  it("never reports the sha of a repository the install merely sits inside", () => {
    // parent/ is a git repo (like /opt/homebrew); parent/keg/ is the install.
    const parent = tmpRepo();
    const keg = path.join(parent, "keg");
    fs.mkdirSync(path.join(keg, "build", "renderer"), { recursive: true });
    fs.writeFileSync(path.join(keg, "build", "renderer", "index.html"), "<html>bundle</html>");

    const v = computeServerVersion(keg);
    assert.match(v, /^b[0-9a-f]{8}$/, `must fall back to the bundle hash, got "${v}"`);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("still reports the sha when the install root IS the checkout", () => {
    const repo = tmpRepo();
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo }).toString().trim();
    assert.equal(computeServerVersion(repo), sha);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("reports 'unknown' when there is neither a checkout nor a build", () => {
    const bare = tmpdir();
    assert.equal(computeServerVersion(bare), "unknown");
    fs.rmSync(bare, { recursive: true, force: true });
  });
});
