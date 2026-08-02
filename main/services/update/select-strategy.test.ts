import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectStrategy } from "./select-strategy.js";

const all = () => true;

describe("selectStrategy", () => {
  it("maps each known kind to its strategy", () => {
    assert.equal(selectStrategy("git", "linux", all, "/srv/app")?.kind, "git");
    assert.equal(selectStrategy("tarball", "linux", all, "/opt/stage-utility")?.kind, "tarball");
    assert.equal(selectStrategy("homebrew", "darwin", all, "/opt/homebrew")?.kind, "homebrew");
  });

  it("returns null for an unknown install so the caller can refuse clearly", () => {
    // Not a throw: the caller knows what was detected and owns the wording.
    assert.equal(selectStrategy("unknown", "linux", all, "/srv/app"), null);
  });

  it("passes the platform through to the strategy it builds", () => {
    const win = selectStrategy("git", "win32", all, "C:\\app");
    const plan = win!.plan({ track: "main", checkout: false, deferRestart: false, version: null, env: {} });
    assert.equal(plan.command, "powershell.exe");
  });

  it("builds a strategy that can still refuse when its prerequisites are absent", () => {
    const s = selectStrategy("homebrew", "darwin", () => false, "/opt/homebrew");
    assert.equal(s?.canApply().ok, false);
  });
});
