// tsconfig-coverage.test.ts — every file tsconfig.json includes is one
// `npm run type-check` actually checks.
//
// When foo.ts and foo.tsx sit side by side, TypeScript keeps only one of them
// in the program and says nothing: the other is never type-checked, so a type
// error in it ships with type-check green. A Baptisms header test lived that
// way. Asked of the TypeScript API that tsc itself uses, not of a filename
// pattern, so any other way a file drops out of the program fails here too.

import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every .ts/.tsx file under `dir` whose path passes `keep`. */
function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, keep, out);
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") && keep(full)) {
      out.push(full);
    }
  }
  return out;
}

test("tsc checks every .ts and .tsx file tsconfig.json includes", () => {
  const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  assert.equal(config.error, undefined, "tsconfig.json did not parse");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const checked = new Set(parsed.fileNames.map((f) => path.resolve(f)));

  // What tsconfig.json's `include` names: all of renderer/, and main's tests
  // (the rest of main/ is pulled in through their imports).
  const included = [
    ...walk(path.join(ROOT, "renderer"), () => true),
    ...walk(path.join(ROOT, "main"), (f) => /\.test\.tsx?$/.test(f)),
  ];
  assert.ok(included.length > 500, `sanity: found only ${included.length} included files`);

  const dropped = included
    .filter((f) => !checked.has(path.resolve(f)))
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .sort();
  assert.deepEqual(dropped, [], "files tsconfig.json includes that tsc never checks");
});
