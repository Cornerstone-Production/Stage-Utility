import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DAEMON_LABEL, KNOWN_DAEMON_LABELS, LEGACY_DAEMON_LABELS, resolveDaemonLabel } from "./launchd-label.js";

// Why this exists: install.sh used to register one fixed label, so relaunch.ts
// hardcoded it. Renaming the label for new installs while every existing Mac
// keeps the old one (an in-app update never rewrites the plist) means the running
// code must ask which job it is, or the kickstart after a restart goes to a job
// that does not exist, silently, and launchd parks the respawn.

const LEGACY = LEGACY_DAEMON_LABELS[0];
const neverProbed = (): boolean => {
  throw new Error("must not probe when the environment already names the job");
};

describe("resolveDaemonLabel", () => {
  it("environment names the new label: that is the answer, without probing", () => {
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: DAEMON_LABEL }, neverProbed);
    assert.deepEqual(r, { ok: true, label: DAEMON_LABEL, via: "environment" });
  });

  it("environment names the legacy label: that is the answer, without probing", () => {
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: LEGACY }, neverProbed);
    assert.deepEqual(r, { ok: true, label: LEGACY, via: "environment" });
  });

  it("unrelated environment: probes new then legacy and takes the loaded one", () => {
    const asked: string[] = [];
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: "0" }, (l) => {
      asked.push(l);
      return l === LEGACY;
    });
    assert.deepEqual(r, { ok: true, label: LEGACY, via: "probe" });
    assert.deepEqual(asked, [DAEMON_LABEL, LEGACY], "new is asked first");
  });

  it("no environment at all: probing still works", () => {
    const r = resolveDaemonLabel({}, (l) => l === DAEMON_LABEL);
    assert.deepEqual(r, { ok: true, label: DAEMON_LABEL, via: "probe" });
  });

  it("both loaded (mid-migration): the new label wins", () => {
    const r = resolveDaemonLabel({}, () => true);
    assert.deepEqual(r, { ok: true, label: DAEMON_LABEL, via: "probe" });
  });

  it("another job's name in the environment is not trusted", () => {
    // A string like this must never reach a shell command, and must not be
    // taken for ours: it falls through to the probe.
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: 'x"; rm -rf /; "' }, () => false);
    assert.equal(r.ok, false);
  });

  it("nothing known is loaded: a failure that names what was looked at", () => {
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: "0" }, () => false);
    assert.equal(r.ok, false);
    if (!r.ok) {
      for (const l of KNOWN_DAEMON_LABELS) assert.ok(r.reason.includes(l), `reason must name ${l}`);
    }
  });
});
