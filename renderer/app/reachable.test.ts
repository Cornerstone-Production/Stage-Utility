import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every settings section used to be reachable because settings-view.tsx rendered
// all twelve in one switch. Routing replaced that switch, and a section that no
// route names is simply gone — no import error, no failing test, no missing
// file. It renders nowhere and nothing says so.
//
// That is not hypothetical. Dissolving Settings orphaned TWO editors: the patch
// editor and the ScriptView column presets. Both had been correctly identified
// as surfaces distinct from their viewers, and then only the viewers were
// routed. The parity inventory missed it because it was built from the settings
// TAB list, where each pair looked like one entry.
//
// So this walks the section files and asserts each one is either named by
// something under renderer/app/, or listed below with the reason it is not.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECTIONS_DIR = path.join(HERE, "..", "settings", "sections");
const APP_DIR = HERE;

/** Sections deliberately not routed, and why. Adding an entry is a decision. */
const NOT_ROUTED = new Map([
  [
    "BaptismsSection",
    "a 15-line wrapper around BaptismOperator, which /baptism routes directly — the wrapper is the duplicate, not the feature",
  ],
]);

function sectionComponents(): string[] {
  const out: string[] = [];
  for (const file of readdirSync(SECTIONS_DIR)) {
    if (!file.endsWith("-section.tsx")) continue;
    const src = readFileSync(path.join(SECTIONS_DIR, file), "utf8");
    // An exported component, not a mention: prose cannot satisfy this.
    for (const m of src.matchAll(/export function (\w+Section)\b/g)) out.push(m[1]);
  }
  return out;
}

function appSources(): string {
  let all = "";
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
        all += readFileSync(full, "utf8");
      }
    }
  };
  walk(APP_DIR);
  return all;
}

describe("every settings section is still reachable", () => {
  test("the scan finds the sections at all, so it cannot pass vacuously", () => {
    // If the export shape changes, the test below would pass by finding nothing.
    const found = sectionComponents();
    assert.ok(found.length >= 10, `only found ${found.length} section components — scan looks broken`);
    assert.ok(found.includes("PatchSection"), "expected PatchSection among them");
  });

  test("each section is routed, or listed with a reason", () => {
    const app = appSources();
    const orphans = sectionComponents().filter(
      (name) => !NOT_ROUTED.has(name) && !new RegExp(`\\b${name}\\b`).test(app),
    );
    assert.deepEqual(
      orphans,
      [],
      `these sections are not reachable from any route — route them, or add them to NOT_ROUTED with the reason:\n    ${orphans.join("\n    ")}`,
    );
  });

  test("nothing sits in NOT_ROUTED that is actually routed", () => {
    // A stale exemption hides the next real orphan behind it.
    const app = appSources();
    for (const [name] of NOT_ROUTED) {
      assert.equal(
        new RegExp(`\\b${name}\\b`).test(app),
        false,
        `${name} IS routed — remove it from NOT_ROUTED so the list keeps meaning something`,
      );
    }
  });

  test("every NOT_ROUTED entry gives a reason", () => {
    for (const [name, reason] of NOT_ROUTED) {
      assert.ok(reason.length > 20, `${name} needs a real reason, not a placeholder`);
    }
  });
});
