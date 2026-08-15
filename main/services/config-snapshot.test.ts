import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { configFiles, runtimeFiles } from "./config-snapshot.js";
import { allStores } from "./stores.js";

// Every persisted store must be classified as the operator's WORK (restored from
// a backup) or an OBSERVATION (not restored). Both failure directions are silent:
// a forgotten config store is simply missing after a restore, and a history store
// wrongly included fabricates services a box never ran.
//
// Classification is a constructor argument, so "forgot to classify" is now a
// compile error. Two things that still cannot be type-checked are pinned here,
// and both were briefly lost when this file was first rewritten:
//
//   1. the registry must be COMPLETE. It is populated by module construction, so
//      a store whose module nobody imports is absent — and absent means missing
//      from every backup, with nothing to notice. Deleting two lines from
//      stores.ts dropped three config stores and left the suite green.
//   2. WHICH half each store lands in. A sample of five let five one-word
//      classification flips pass.

const SERVICES_DIR = path.dirname(fileURLToPath(import.meta.url));

const STORE_BASE = "(?:DataStore|KeyedRecordStore)";
/**
 * A store DECLARATION. Two forms, and both have to count.
 *
 * `= new DataStore(…)` is the ordinary one. `class X extends KeyedRecordStore`
 * is the other: the subclass constructs one through super(), registering it
 * exactly the same way, but there is no `new` for the first form to find. The
 * moment the SPL history store stopped wrapping and started extending, this
 * counted 22 against 23 registered — the guard working, so it is taught rather
 * than loosened.
 *
 * Both remain shapes prose cannot take: an `=` before the constructor, or the
 * literal `class NAME extends`. Matching a bare constructor name counted three
 * mentions inside comments — including store-registry.ts's own comment
 * explaining the bug — and reported 26 against 23. That is the third guard in
 * this codebase a comment has satisfied.
 */
const CONSTRUCTION_SOURCE = `=\\s*new ${STORE_BASE}\\b|\\bclass\\s+\\w+\\s+extends\\s+${STORE_BASE}\\b`;
/** Fresh each call: a shared /g/ regex carries lastIndex between .test() calls
 *  and silently starts mid-string, which under-counted by two. */
const construction = (): RegExp => new RegExp(CONSTRUCTION_SOURCE, "g");

/**
 * Files under main/ that construct a store, found by walking the tree.
 *
 * Deliberately a plain substring match and a recursive walk. The scan this
 * replaced parsed the generic — `new DataStore<…>(` — and its regex could not
 * cross a `>`, so signal-store's `DataStore<Record<string, SignalState>>` was
 * invisible and it found 22 of 23. It also read one directory, so a store under
 * archive/ or routes/ could never be seen. Counting the constructor call needs
 * neither.
 */
function filesConstructingStores(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    // withFileTypes, not a separate statSync: one syscall instead of two, and no
    // check-then-use gap between asking what an entry is and reading it.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        if (construction().test(readFileSync(full, "utf8"))) out.push(full);
      }
    }
  };
  walk(path.resolve(SERVICES_DIR, ".."));
  // The primitives themselves are not stores.
  return out.filter((f) => !/[/\\](data-store|keyed-record-store)\.ts$/.test(f));
}

/** Count of store constructions on disk, whether or not anything imports them. */
function declaredStoreCount(): number {
  let n = 0;
  for (const f of filesConstructingStores()) {
    const src = readFileSync(f, "utf8");
    n += (src.match(construction()) ?? []).length;
  }
  return n;
}

/**
 * Exactly the stores a config snapshot carries.
 *
 * Spelled out rather than sampled. This is the assertion that pins WHICH half
 * each store lands in — the thing the type checker cannot know and the thing a
 * one-word edit changes. Adding a store here is a deliberate act; changing one
 * that already exists should make a reviewer stop.
 */
const EXPECTED_CONFIG = [
  "automation-rules.json",
  "automation-settings.json",
  "bar-config.json",
  "baptism-triggers.json",
  "layout-groups.json",
  "layout-templates.json",
  // The operator's own work product typed into notes/checklist objects.
  "notes.json",
  "osc-targets.json",
  "patch.json",
  "presets.json",
  "rosstalk-settings.json",
  "rosstalk-targets.json",
  "scriptview-config.json",
  "scriptview-layouts.json",
  "scriptview-roles.json",
  "settings.json",
  "slots.json",
  "views.json",
  "wireless-connections.json",
].sort();

const EXPECTED_RUNTIME = [
  "attendance-history.json",
  "automation-log.json",
  "baptism.json",
  "service-timeline.json",
  "signals.json",
  "spl-history.json",
].sort();

describe("store classification", () => {
  test("every store declared on disk is registered", () => {
    // Catches the barrel in stores.ts falling behind: a store module nobody
    // imports never constructs, never registers, and is silently absent from
    // every backup. An exact count, not a floor — a floor with slack is what let
    // three missing stores through when this was first written.
    const declared = declaredStoreCount();
    assert.equal(
      allStores().length,
      declared,
      `${declared} stores are declared under main/ but ${allStores().length} registered — ` +
        `a store module is probably missing from stores.ts`,
    );
  });

  test("the config half is exactly this set", () => {
    assert.deepEqual(configFiles().slice().sort(), EXPECTED_CONFIG);
  });

  test("the runtime half is exactly this set", () => {
    assert.deepEqual(runtimeFiles().slice().sort(), EXPECTED_RUNTIME);
  });

  test("secrets and the encryption key are never in a snapshot", () => {
    // The snapshot tells the operator it is safe to store.
    for (const forbidden of ["secrets.bin", "encryption.key"]) {
      assert.ok(!configFiles().includes(forbidden), `${forbidden} must never be backed up`);
    }
  });

  test("no config store is a keyed directory", () => {
    // A KeyedRecordStore registers its LEGACY single-document filename, so
    // readFile on it succeeds — it just reads the stale pre-split document and
    // silently omits every per-service file. Backing one up would look like it
    // worked. config-snapshot.build refuses this at runtime; this states it.
    const bad = allStores().filter((s) => s.kind === "directory" && configFiles().includes(s.filename));
    assert.deepEqual(bad, [], "a keyed store cannot be backed up by filename alone");
  });
});
