// A "restart" that nothing comes back from.
//
// Every restart in this app is exit(0) plus a service manager. On an install we
// did not set up there is no service manager, so a config restore applied every
// file, answered `{ ok: true, restarting: true }`, exited zero, and stopped. The
// log ended mid-sentence with no error, so it read as a crash. It was not a
// crash — nothing was watching.
//
// Reproduced against the real controller in config-restore-restart.test.ts; this
// pins the rule itself.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selfRecovers } from "./relaunch.js";
import type { InstallKind } from "./install-kind.js";

/** A shell someone typed `npm run start` into. */
const BARE: NodeJS.ProcessEnv = {};

describe("does anything start us again", () => {
  it("yes for the installs we set up ourselves", () => {
    // tarball = systemd Restart=always (Linux), NSSM (Windows), launchd (macOS).
    // homebrew = launchd.
    assert.equal(selfRecovers("tarball", BARE), true);
    assert.equal(selfRecovers("homebrew", BARE), true);
  });

  it("NO for a checkout somebody runs by hand", () => {
    // THE case. `npm run start` from a clone has nothing behind it, and this is
    // what every developer and every trial install is.
    assert.equal(selfRecovers("git", BARE), false);
  });

  it("NO when we cannot tell how it was installed", () => {
    assert.equal(selfRecovers("unknown", BARE), false);
  });

  it("covers every install kind, so a new one cannot default to optimistic", () => {
    const all: InstallKind[] = ["git", "tarball", "homebrew", "unknown"];
    for (const k of all) assert.equal(typeof selfRecovers(k, BARE), "boolean", `${k} unhandled`);
    // An exact split, not a floor: if a fifth kind appears, one of these fails
    // and somebody has to decide which side it is on.
    assert.equal(all.filter((k) => selfRecovers(k, BARE)).length, 2);
    assert.equal(all.filter((k) => !selfRecovers(k, BARE)).length, 2);
  });
});

describe("a supervisor in the environment beats the file layout", () => {
  it("a GIT CHECKOUT under systemd self-recovers", () => {
    // THE correction, and the expensive one. The production box is a git
    // checkout run by systemd. Judging by install kind alone would have warned
    // that restoring a config there shuts the server off permanently — a false
    // alarm on the one machine where a false alarm costs the most.
    assert.equal(selfRecovers("git", { INVOCATION_ID: "5f2c…" }), true);
    assert.equal(selfRecovers("git", { JOURNAL_STREAM: "8:12345" }), true);
  });

  it("a git checkout under launchd self-recovers", () => {
    assert.equal(selfRecovers("git", { XPC_SERVICE_NAME: "com.cornerstone.stage-utility" }), true);
  });

  it("XPC_SERVICE_NAME=0 does NOT count", () => {
    // That is what a plain login shell inherits on macOS. Treating it as a
    // supervisor would silence the warning on exactly the machine that needs it.
    assert.equal(selfRecovers("git", { XPC_SERVICE_NAME: "0" }), false);
  });

  it("an unrecognised install under systemd still self-recovers", () => {
    assert.equal(selfRecovers("unknown", { INVOCATION_ID: "abc" }), true);
  });
});
