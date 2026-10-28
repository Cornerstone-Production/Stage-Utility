// One look for every object's settings.
//
// The Lyrics, Timer, Video and Button inspectors each used to lay their own
// controls out (a stacked label over a full-width track), beside the shared rows
// the rest of the inspector uses, so a change to the rows reached half the panels.
// They are built from the shared rows now. This is what notices an inspector
// reaching for the stacked layout again.
//
// It reads source, so it matches JSX opening tags after comments are stripped (a
// comment naming `<StackedField>` must neither satisfy nor fail it) and asserts
// the EXACT list of uses: the one legitimate use of Segmented is the shared
// RowToggle drawing its track.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const EDITOR = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

// Code with block comments (the JSX ones too) and whole-line `//` comments removed.
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("no object inspector draws the stacked layout itself", () => {
  const uses: string[] = [];
  for (const file of sourceFiles(EDITOR)) {
    const code = withoutComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/<(StackedField|StackedSwitch|Segmented|FieldLabel)\b/g)) {
      uses.push(`${relative(EDITOR, file)}:${m[1]}`);
    }
  }
  assert.deepEqual(uses.sort(), ["inspector-rows.tsx:Segmented"]);
});
