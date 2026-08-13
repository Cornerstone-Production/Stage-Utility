import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { HomebrewStrategy, BREW_PATHS } from "./homebrew-strategy.js";
import { TarballStrategy } from "./tarball-strategy.js";
import { GitStrategy } from "./git-strategy.js";

// The bug, observed on a real Homebrew box (v1.10.0-beta.29 -> .30):
//
//   Removing: /opt/homebrew/Cellar/stage-utility-beta/1.10.0-beta.29...
//   shell-init: error retrieving current directory: getcwd: cannot access
//     parent directories: No such file or directory
//   Error: The current working directory must exist to run brew.
//
// updater.ts spawned the update script with cwd = the install root, which on a
// packaged install is the very directory the update replaces. `brew cleanup`
// deleted the old keg, the script's cwd ceased to exist, and every subsequent
// brew command refused to run — including `brew services restart`, AFTER
// bootout had already unregistered the label. Keg upgraded, service gone.

const base = { track: "main", checkout: false, deferRestart: false, version: null, env: {} };
const brewAt = (want: string) => (p: string) => p === want;

/** Every packaged strategy, with the platform it would run on. */
const PACKAGED = [
  { name: "homebrew", plan: () => new HomebrewStrategy(brewAt(BREW_PATHS[0])).plan(base) },
  { name: "tarball/linux", plan: () => new TarballStrategy("linux").plan(base) },
  { name: "tarball/darwin", plan: () => new TarballStrategy("darwin").plan(base) },
  { name: "tarball/win32", plan: () => new TarballStrategy("win32").plan(base) },
];

describe("update spawn cwd", () => {
  it("every packaged strategy runs from a directory the update cannot delete", () => {
    for (const { name, plan } of PACKAGED) {
      const cwd = plan().cwd;
      assert.ok(cwd, `${name} must declare a cwd — the default is the install root, which it replaces`);
      // A filesystem root: nothing an installer or brew does can remove it.
      assert.match(cwd!, /^([/]|[A-Za-z]:\\)$/, `${name} cwd must be a filesystem root, got ${cwd}`);
    }
  });

  it("the declared cwd is nowhere near the install root it is replacing", () => {
    for (const { name, plan } of PACKAGED) {
      const cwd = plan().cwd!;
      assert.ok(!cwd.includes("Cellar"), `${name} must not run from inside the keg`);
      assert.ok(!cwd.includes("stage-utility"), `${name} must not run from inside the install`);
    }
  });

  it("a git checkout still runs from the repository, which its commands need", () => {
    // git needs the worktree; nothing deletes it, so the default is correct here.
    const p = new GitStrategy("/srv/stage-utility", "linux", fs.existsSync).plan(base);
    assert.equal(p.cwd, undefined, "the git strategy must keep the install root");
  });
});

describe("why a deleted cwd is fatal (the mechanism, reproduced)", () => {
  // Not a test of our code — a test of the assumption the fix rests on. If a
  // future reader doubts that "just run it from the keg" is fine, this fails
  // in front of them.
  it("a child whose working directory is deleted cannot resolve a relative path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwd-gone-"));
    const doomed = path.join(dir, "keg");
    fs.mkdirSync(doomed);

    const run = (cwd: string) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        // Sleep past the deletion, then call getcwd() — which is precisely
        // what failed in production ("error retrieving current directory:
        // getcwd"). /bin/pwd, not the bash builtin: the builtin answers from
        // $PWD and `ls .` still resolves through the open vnode, so neither
        // notices. Every new process brew starts calls getcwd, so this is the
        // faithful reproduction, and it fails deterministically.
        const child = spawn("bash", ["-c", "sleep 0.4; /bin/pwd"], {
          cwd,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("close", (code) => resolve({ code, err }));
      });

    const doomedRun = run(doomed);
    const safeRun = run("/");
    fs.rmSync(doomed, { recursive: true, force: true }); // what `brew cleanup` does

    const gone = await doomedRun;
    const safe = await safeRun;

    // Exit status only. The WORDING is platform-specific — BSD/macOS says "No
    // such file or directory", GNU/Linux says "couldn't find directory entry in
    // '..' with matching i-node" — and asserting on it failed CI on the first
    // attempt. What matters, and what is portable, is that the call fails.
    assert.notEqual(gone.code, 0, `getcwd in a deleted cwd must fail — this is the bug (stderr: ${gone.err.trim()})`);
    assert.equal(safe.code, 0, "the same call from a filesystem root must succeed — this is the fix");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
