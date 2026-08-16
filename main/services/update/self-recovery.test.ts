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

describe("does anything start us again", () => {
  it("yes for the installs we set up ourselves", () => {
    // tarball = systemd Restart=always (Linux), NSSM (Windows), launchd (macOS).
    // homebrew = launchd. These are the only supervisors we can name.
    assert.equal(selfRecovers("tarball"), true);
    assert.equal(selfRecovers("homebrew"), true);
  });

  it("NO for a checkout somebody runs by hand", () => {
    // THE case. `npm run start` from a clone has nothing behind it, and this is
    // what every developer and every trial install is.
    assert.equal(selfRecovers("git"), false);
  });

  it("NO when we cannot tell how it was installed", () => {
    // Pessimistic on purpose: a warning nobody needed costs a sentence, and the
    // opposite mistake turned "restarting" into "off" with no warning at all.
    assert.equal(selfRecovers("unknown"), false);
  });

  it("covers every install kind, so a new one cannot default to optimistic", () => {
    const all: InstallKind[] = ["git", "tarball", "homebrew", "unknown"];
    for (const k of all) assert.equal(typeof selfRecovers(k), "boolean", `${k} unhandled`);
    // An exact split, not a floor: if a fifth kind appears, one of these fails
    // and somebody has to decide which side it is on.
    assert.equal(all.filter((k) => selfRecovers(k)).length, 2);
    assert.equal(all.filter((k) => !selfRecovers(k)).length, 2);
  });
});
