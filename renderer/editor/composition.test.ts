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

/** Controls the inspector must render. A responsive model nothing can configure
 *  is a model nobody uses — three helpers in this redesign were written, tested
 *  and reachable from no UI, so this checks the last mile. */
const INSPECTOR_PARTS = ["ResponsiveControls"];

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

  for (const part of INSPECTOR_PARTS) {
    test(`${part} is rendered by the inspector`, () => {
      const src = stripComments(readFileSync(path.join(HERE, "inspector.tsx"), "utf8"));
      assert.match(src, new RegExp(`<${part}[\\s/>]`), `${part} is imported but never rendered`);
    });
  }

  test("every extracted module is imported by something", () => {
    // A module nothing imports is dead weight that still type-checks.
    const files = readdirSync(HERE).filter(
      // .test.tsx as well as .test.ts — a component test is a test, and the
      // first one written here was reported as an orphaned module.
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "layout-editor.tsx",
    );
    assert.ok(files.length >= 3, `only found ${files.length} extracted modules — scan looks broken`);

    // Scan the WHOLE renderer, not just this directory: an editor module can
    // legitimately be imported from app/ — can-edit.ts is, by the console route.
    // Scoping this to the folder reported a wired module as an orphan.
    const RENDERER = path.join(HERE, "..");
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
        else if (/\.tsx?$/.test(entry.name)) all.push(readFileSync(full, "utf8"));
      }
    };
    walk(RENDERER);
    const sources = all.join("\n");

    const orphans = files.filter((f) => {
      const mod = f.replace(/\.tsx?$/, "");
      // Matches "./mod", "../editor/mod" and "@renderer/editor/mod" alike.
      return !new RegExp(`from "[^"]*\\b${mod}"`).test(sources);
    });
    assert.deepEqual(orphans, [], `these editor modules are imported by nothing:\n    ${orphans.join("\n    ")}`);
  });
});
