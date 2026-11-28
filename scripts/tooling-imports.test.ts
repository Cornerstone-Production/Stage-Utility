// Every relative import in the plain-node tooling names a file that exists.
//
// The plain-node tooling is what tsconfig.tooling.json includes, minus what it excludes, and
// everything those files import by a relative path. tsc cannot hold them to this: under
// nodenext it resolves `./x.js` to x.ts, so both type-check projects pass while bare `node`
// throws ERR_MODULE_NOT_FOUND. So the files are walked from that config, each one's import and
// export specifiers are read by TypeScript's own preprocessor (not a regex, so a comment that
// names a path is not an import), and each relative specifier must be a file on disk as written.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

/** Every import, export-from, side-effect import and dynamic import() a file makes. */
function specifiers(text: string): string[] {
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
}

/** The files tsconfig.tooling.json type-checks for plain node: its include minus its exclude. */
function roots(): string[] {
  const file = path.join(ROOT, "tsconfig.tooling.json");
  const read = ts.readConfigFile(file, ts.sys.readFile);
  assert.equal(read.error, undefined, "tsconfig.tooling.json does not parse");
  return ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT, undefined, file).fileNames.map((f) => path.resolve(f));
}

/** Walk from the roots through relative imports: the edges seen, and the specifiers that name no file. */
function walk(): { edges: Set<string>; missing: string[] } {
  const edges = new Set<string>();
  const missing: string[] = [];
  const seen = new Set<string>();
  const queue = roots();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(fs.readFileSync(file, "utf8"))) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        missing.push(`${rel(file)}: ${spec}`);
        continue;
      }
      edges.add(`${rel(file)} -> ${rel(target)}`);
      if (target.endsWith(".ts") && !target.endsWith(".d.ts")) queue.push(target);
    }
  }
  return { edges, missing: missing.sort() };
}

describe("the plain-node tooling's relative imports", () => {
  it("are read the way node reads them, dynamic import() and export-from included", () => {
    assert.deepEqual(specifiers('import "./a.ts";\nexport { b } from "./b.ts";\n// import "./c.ts";\nawait import("./d.ts");\n'), ["./a.ts", "./b.ts", "./d.ts"]);
  });

  const { edges, missing } = walk();

  it("each name a file that exists, exactly as written", () => {
    assert.deepEqual(missing, []);
  });

  it("are walked, from the config's own files and on through what they import", () => {
    assert.ok(edges.has("scripts/verified-tree.ts -> scripts/is-main.ts"), "the walk did not see verified-tree.ts import is-main.ts");
    assert.ok(
      edges.has("publish/servicecue/scripts/deploy.ts -> main/types/servicecue-publish.ts"),
      "the walk did not follow deploy.ts into main/, which the config does not name",
    );
  });
});
