import { strict as assert } from "node:assert";
import { test, describe } from "node:test";

import { configFiles, runtimeFiles } from "./config-snapshot.js";
import { allStores } from "./stores.js";

// Every persisted store must be classified as the operator's WORK (restored from
// a backup) or an OBSERVATION (not restored). Getting it wrong is silent both
// ways: a forgotten config store is simply missing after a restore, and a history
// store wrongly included fabricates services a box never ran.
//
// This used to scan the source for `new DataStore<…>(` and check the result
// against two hand-maintained arrays. That scan had holes it could not see past —
// its regex could not cross a `>`, so signal-store's nested generic was invisible
// and it found 22 of 23 stores; CI was green only because someone had
// independently classified that one. It also read the directory non-recursively.
//
// Classification is now a constructor argument, so the type checker enforces what
// the regex approximated and the list is derived from what exists. What is left
// to test is that the derivation is wired up and the two halves stay disjoint.

describe("store classification", () => {
  test("the registry is populated, so nothing here is vacuous", () => {
    // If the barrel in stores.ts stops importing the store modules, every
    // assertion below would pass over an empty set.
    assert.ok(allStores().length >= 20, `only ${allStores().length} stores registered`);
  });

  test("every registered store lands in exactly one half", () => {
    const config = new Set(configFiles());
    const runtime = new Set(runtimeFiles());
    for (const s of allStores()) {
      const inConfig = config.has(s.filename);
      const inRuntime = runtime.has(s.filename);
      assert.ok(inConfig || inRuntime, `${s.filename} is in neither half`);
      assert.ok(!(inConfig && inRuntime), `${s.filename} is in both halves`);
    }
  });

  test("secrets and the encryption key are never in a snapshot", () => {
    // The snapshot tells the operator it is safe to store. These must never
    // appear whatever the registry says.
    for (const forbidden of ["secrets.bin", "encryption.key"]) {
      assert.ok(!configFiles().includes(forbidden), `${forbidden} must never be backed up`);
    }
  });

  test("recorded history is not restored onto another machine", () => {
    for (const h of ["spl-history.json", "attendance-history.json", "service-timeline.json", "baptism.json"]) {
      assert.ok(!configFiles().includes(h), `${h} must not be in a config snapshot`);
      assert.ok(runtimeFiles().includes(h), `${h} should be declared runtime`);
    }
  });

  test("the operator's work IS restored", () => {
    for (const c of ["settings.json", "views.json", "slots.json", "patch.json", "presets.json"]) {
      assert.ok(configFiles().includes(c), `${c} must survive a restore`);
    }
  });

  test("a keyed store is recorded as a directory, not a file", () => {
    // config-snapshot reads a file store with readFile; doing that to a directory
    // throws EISDIR inside a bare catch, which would silently drop it from every
    // backup while this test passed on the name alone.
    const keyed = allStores().filter((s) => s.kind === "directory").map((s) => s.filename);
    assert.deepEqual(
      keyed.sort(),
      ["attendance-history.json", "service-timeline.json", "spl-history.json"],
      "keyed stores are not being registered as directories",
    );
  });
});
