// `import { } from "…"` imports nothing and means nothing.
//
// Ten had accumulated — nine in layout-editor.tsx and one in inspector.tsx —
// left behind by a refactor that moved the bindings out and the tooling that
// removed them stopped at the braces. They cost nothing at runtime, which is
// why they survived: nothing failed, nothing warned, and each one looked
// deliberate enough that the next person left it alone too. One of them named a
// module that was later renamed, and the only reason anybody noticed was that
// the rename broke the build.
//
// Not a lint rule, because ESLint cannot tell these apart from the imports that
// DO matter: `import "./styles.css"` and the twenty in stores.ts that exist
// purely to register a store with the config-snapshot machinery. Both are
// `specifiers.length === 0` in the AST; only the source text distinguishes an
// empty pair of braces from no braces at all. A blanket rule would have to be
// suppressed in the one file where side-effect imports are load-bearing, which
// is the file where a mistake would cost the most.
//
// So: a scan, matching a shape prose cannot satisfy — an import STATEMENT — and
// asserting an exact count of zero.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["renderer", "main", "scripts"];
const SKIP = new Set(["node_modules", "dist", ".git", "superpowers"]);

/** Every source file under the given roots, walked rather than globbed. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const r of ROOTS) walk(path.join(ROOT, r));
  return out;
}

/** `import {} from "x"` and `import { } from "x"`, with or without whitespace. */
const EMPTY_IMPORT = /^\s*import\s*\{\s*\}\s*from\s*["'][^"']+["']/gm;

describe("no import binds nothing", () => {
  const files = sources();

  test("the scan reads a real tree", () => {
    // Guards the walk. A silently-empty file list would make this vacuous, which
    // is how a coverage check in this repo once went green while finding 22 of
    // 23 stores.
    assert.ok(files.length > 200, `only walked ${files.length} files; the tree layout changed`);
  });

  test("there are none, anywhere", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const hits = readFileSync(file, "utf8").match(EMPTY_IMPORT);
      if (hits) offenders.push(`${path.relative(ROOT, file)} (${hits.length})`);
    }
    assert.deepEqual(
      offenders,
      [],
      `an import with empty braces binds nothing — delete the line:\n  ${offenders.join("\n  ")}`,
    );
  });

  test("and a side-effect import is still allowed, because some are load-bearing", () => {
    // stores.ts imports every store for its side effect: the import IS the
    // registration, and a store that is never imported is missing from every
    // config backup with the suite green. If this file ever grows into a lint
    // rule, that is the case it must not break.
    const stores = readFileSync(path.join(ROOT, "main", "services", "stores.ts"), "utf8");
    const sideEffects = stores.match(/^\s*import\s*["'][^"']+["']/gm) ?? [];
    assert.ok(
      sideEffects.length > 10,
      `expected stores.ts to register stores by side-effect import; found ${sideEffects.length}`,
    );
  });
});
