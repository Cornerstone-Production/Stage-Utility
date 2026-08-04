// The rule under test is the one that protects a live audio route: a failed
// evaluation records why WITHOUT clearing the value. Everything else here exists
// to stop that guarantee regressing.

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-signals-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { signalStore } = await import("./signal-store.js");

before(async () => {
  await signalStore.init();
});

describe("signalStore", () => {
  it("publishes a value and reports it", async () => {
    await signalStore.set("dante-tb", "Vox 4", { ruleId: "r1" });
    const s = signalStore.all()["dante-tb"];
    assert.equal(s.value, "Vox 4");
    assert.equal(s.error, null);
    assert.equal(s.ruleId, "r1");
  });

  it("a failure does NOT clear the value", async () => {
    // The whole point. An unrelated scheduling mistake must not take talkback off.
    await signalStore.set("dante-tb", "Vox 4");
    await signalStore.fail("dante-tb", "two or more people are marked \"TB\": A, B");
    const s = signalStore.all()["dante-tb"];
    assert.equal(s.value, "Vox 4", "value must survive a failure");
    assert.match(s.error ?? "", /two or more/);
  });

  it("a later success clears the error", async () => {
    await signalStore.fail("dante-tb", "nobody scheduled is marked \"TB\"");
    await signalStore.set("dante-tb", "Vox 2");
    const s = signalStore.all()["dante-tb"];
    assert.equal(s.value, "Vox 2");
    assert.equal(s.error, null);
  });

  it("a signal that has never resolved gets an empty value, not an invented one", async () => {
    await signalStore.fail("never-set", "nobody scheduled is marked \"XX\"");
    const s = signalStore.all()["never-set"];
    assert.equal(s.value, "");
    assert.ok(s.error);
  });

  it("keeps signals independent", async () => {
    await signalStore.set("a", "1");
    await signalStore.set("b", "2");
    await signalStore.fail("a", "boom");
    assert.equal(signalStore.all()["b"].value, "2");
    assert.equal(signalStore.all()["b"].error, null);
  });

  it("ignores a blank name rather than writing an empty key", async () => {
    await signalStore.set("   ", "x");
    assert.ok(!("" in signalStore.all()));
  });

  it("survives a restart", async () => {
    await signalStore.set("persisted", "Vox 3");
    const raw = JSON.parse(await fs.readFile(path.join(TMP, "signals.json"), "utf8"));
    assert.equal(raw["persisted"].value, "Vox 3");
  });
});
