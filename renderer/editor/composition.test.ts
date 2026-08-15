import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The editor was one 3,333-line file and is being split. A split is where
// behaviour goes missing without anything failing: an extracted part that
// nothing renders still compiles, still lints, and still passes every test —
// it just is not there any more.
//
// This is the same orphan shape wired.test.ts guards for state handlers, applied
// to the editor's own pieces. It has already caught three instances in this
// redesign (withViewTransition, notesStore.forget, handleSetViewSurface), which
// is why it is written before the risky extraction rather than after it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(path.join(HERE, "layout-editor.tsx"), "utf8");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** Parts the shell must actually RENDER, not merely import. */
const RENDERED_PARTS = ["Inspector", "EditorCanvas"];

describe("the editor shell composes its parts", () => {
  test("the scan finds the shell at all, so it cannot pass vacuously", () => {
    assert.ok(shell.length > 5000, "layout-editor.tsx looks too small — this scan is broken");
    assert.match(shell, /export function LayoutEditor/);
  });

  for (const part of RENDERED_PARTS) {
    test(`${part} is rendered, not just imported`, () => {
      const src = stripComments(shell);
      assert.match(
        src,
        new RegExp(`\\b${part}\\b`),
        `${part} is not referenced by the shell at all`,
      );
      assert.match(
        src,
        new RegExp(`<${part}[\\s/>]`),
        `${part} is imported but never rendered — the feature left with the file`,
      );
    });
  }

  test("every extracted module is imported by something", () => {
    // A module nothing imports is dead weight that still type-checks.
    const files = readdirSync(HERE).filter(
      (f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && f !== "layout-editor.tsx",
    );
    assert.ok(files.length >= 3, `only found ${files.length} extracted modules — scan looks broken`);

    const all = readdirSync(HERE)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(path.join(HERE, f), "utf8"))
      .join("\n");

    const orphans = files.filter((f) => {
      const mod = f.replace(/\.tsx?$/, "");
      return !new RegExp(`from "\\./${mod}"`).test(all);
    });
    assert.deepEqual(orphans, [], `these editor modules are imported by nothing:\n    ${orphans.join("\n    ")}`);
  });
});
