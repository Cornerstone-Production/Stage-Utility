// The snapshot allowlist is the whole backup contract, and it fails silently: a
// store that is missing is excluded from BOTH export and import, so nothing looks
// wrong until someone restores a backup and finds their work gone. Eight stores had
// drifted out of it before this test existed — patch sheets, automation rules,
// RossTalk targets and ScriptView layouts among them.
//
// So rather than trusting the list to be maintained by hand, this scans the source
// for every DataStore and KeyedRecordStore and requires each one to be classified:
// backed up, or
// deliberately runtime. Adding a store without deciding which is a CI failure.

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CONFIG_FILES, RUNTIME_FILES } from "./config-snapshot.js";

const SERVICES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Every `new DataStore<…>("name.json"` declared under main/services. */
function declaredStores(): { file: string; store: string }[] {
  const out: { file: string; store: string }[] = [];
  for (const f of readdirSync(SERVICES_DIR)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(path.join(SERVICES_DIR, f), "utf8");
    // KeyedRecordStore is the other persistence primitive: it takes the legacy
    // single-document filename as its second argument, which is the name that has
    // to be classified. A store added through it must not slip past this scan.
    for (const m of src.matchAll(/new KeyedRecordStore<[^>]*>\(\s*"[^"]+",\s*"([^"]+\.json)"/g)) {
      out.push({ file: f, store: m[1] });
    }
    for (const m of src.matchAll(/new DataStore<[^>]*>\(\s*"([^"]+\.json)"/g)) {
      out.push({ file: f, store: m[1] });
    }
  }
  return out;
}

describe("every persisted store is classified", () => {
  test("the scan finds the stores at all", () => {
    // Guards the regex itself — a silently-empty scan would make this file vacuous.
    const found = declaredStores();
    assert.ok(found.length >= 15, `expected to find DataStore declarations, found ${found.length}`);
  });

  test("no store is missing from both the backup list and the runtime list", () => {
    const classified = new Set<string>([...CONFIG_FILES, ...RUNTIME_FILES]);
    const missing = declaredStores().filter((s) => !classified.has(s.store));
    assert.deepEqual(
      missing,
      [],
      `these stores are neither backed up nor declared runtime — add each to CONFIG_FILES ` +
        `(operator's work, must survive a restore) or RUNTIME_FILES (recorded history):\n` +
        missing.map((m) => `  ${m.store}  (${m.file})`).join("\n"),
    );
  });

  test("nothing is in both lists", () => {
    const runtime = new Set<string>(RUNTIME_FILES);
    const both = CONFIG_FILES.filter((f) => runtime.has(f));
    assert.deepEqual(both, [], `classified as both config and runtime: ${both.join(", ")}`);
  });
});

describe("what must never be backed up", () => {
  test("secrets never enter a snapshot", () => {
    // A downloaded snapshot is meant to be safe to email or drop in cloud storage.
    for (const forbidden of ["secrets.bin", "encryption.key"]) {
      assert.ok(
        !(CONFIG_FILES as readonly string[]).includes(forbidden),
        `${forbidden} must never be in CONFIG_FILES`,
      );
    }
  });

  test("recorded history stays out, so a restore cannot fabricate services", () => {
    for (const h of ["spl-history.json", "attendance-history.json", "service-timeline.json"]) {
      assert.ok(
        !(CONFIG_FILES as readonly string[]).includes(h),
        `${h} is recorded history — restoring it onto another install would invent services`,
      );
    }
  });
});

describe("the stores that regressed", () => {
  test("the eight that had drifted out are covered", () => {
    // Named explicitly: each of these was silently absent from every backup taken
    // before 2026-07-29.
    for (const f of [
      "scriptview-layouts.json",
      "scriptview-config.json",
      "patch.json",
      "automation-rules.json",
      "automation-settings.json",
      "rosstalk-targets.json",
      "rosstalk-settings.json",
      "layout-groups.json",
    ]) {
      assert.ok((CONFIG_FILES as readonly string[]).includes(f), `${f} must be backed up`);
    }
  });
});
