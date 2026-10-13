import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  DAEMON_LABEL,
  KNOWN_DAEMON_LABELS,
  LEGACY_DAEMON_LABELS,
  probeWith,
  resolveDaemonLabel,
  type LabelProbe,
} from "./launchd-label.js";

// Why this exists: install.sh used to register one fixed label, so relaunch.ts
// hardcoded it. Renaming the label for new installs while every existing Mac
// keeps the old one (an in-app update never rewrites the plist) means the running
// code must ask which job it is, or the kickstart after a restart goes to a job
// that does not exist, silently, and launchd parks the respawn.

const LEGACY = LEGACY_DAEMON_LABELS[0];
const neverProbed: LabelProbe = () => {
  throw new Error("must not probe when the environment already names the job");
};
/** A launchd that has exactly these jobs loaded. */
const loadedOnly =
  (...labels: string[]): LabelProbe =>
  (l) =>
    labels.includes(l) ? "loaded" : "not-loaded";

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
      return loadedOnly(LEGACY)(l);
    });
    assert.deepEqual(r, { ok: true, label: LEGACY, via: "probe" });
    assert.deepEqual(asked, [DAEMON_LABEL, LEGACY], "new is asked first");
  });

  it("no environment at all: probing still works", () => {
    const r = resolveDaemonLabel({}, loadedOnly(DAEMON_LABEL));
    assert.deepEqual(r, { ok: true, label: DAEMON_LABEL, via: "probe" });
  });

  it("both loaded (mid-migration): the new label wins", () => {
    const r = resolveDaemonLabel({}, loadedOnly(DAEMON_LABEL, LEGACY));
    assert.deepEqual(r, { ok: true, label: DAEMON_LABEL, via: "probe" });
  });

  it("another job's name in the environment is not trusted", () => {
    // A string like this must never reach a shell command, and must not be
    // taken for ours: it falls through to the probe.
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: 'x"; rm -rf /; "' }, loadedOnly());
    assert.equal(r.ok, false);
  });

  it("nothing known is loaded: says so, naming what was looked at", () => {
    const r = resolveDaemonLabel({ XPC_SERVICE_NAME: "0" }, loadedOnly());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /is loaded in the system domain/);
      for (const l of KNOWN_DAEMON_LABELS) assert.ok(r.reason.includes(l), `reason must name ${l}`);
    }
  });

  it("launchctl could not run: the failure names that cause, not 'not loaded'", () => {
    const r = resolveDaemonLabel({}, () => ({ error: "ENOENT" }));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /could not say/);
      assert.match(r.reason, /ENOENT/);
      assert.doesNotMatch(r.reason, /is loaded in the system domain/, "must not claim launchd answered");
    }
  });

  it("an unanswered probe on one label still lets the other one be found", () => {
    const r = resolveDaemonLabel({}, (l) => (l === DAEMON_LABEL ? { error: "ETIMEDOUT" } : "loaded"));
    assert.deepEqual(r, { ok: true, label: LEGACY, via: "probe" });
  });
});

describe("probeWith: a launchctl that answered 'no' versus one that never answered", () => {
  // Real child-process failures, not hand-built errors: the classification
  // depends on the exact fields execFileSync puts on what it throws.
  it("exit 0 is loaded", () => {
    assert.equal(probeWith(() => void execFileSync("true", { stdio: "ignore" })), "loaded");
  });

  it("a non-zero exit is an answer: not loaded", () => {
    assert.equal(probeWith(() => void execFileSync("false", { stdio: "ignore" })), "not-loaded");
  });

  it("a missing binary is NOT an answer", () => {
    const r = probeWith(() => void execFileSync("stage-utility-no-such-binary", { stdio: "ignore" }));
    assert.deepEqual(r, { error: "ENOENT" });
  });

  it("a timeout is NOT an answer", () => {
    const r = probeWith(() => void execFileSync("sleep", ["5"], { stdio: "ignore", timeout: 50 }));
    assert.ok(typeof r === "object" && "error" in r, `expected an error result, got ${JSON.stringify(r)}`);
  });
});
