// There is ONE fit-to-box measurement, and the objects that fit use it.
//
// This replaces a guard that counted `function useFitScale` in layout-renderer.tsx:
// it passed because of a NAME, and a second implementation under another name
// (Lyrics had one for a day) left it green. So this reads the syntax tree, not the
// text, and asks what a measurement IS: something that observes a box's size and
// reads the size of its content back (scrollWidth, offsetHeight and the like).
//
//  - Every file in renderer/main that does both is on an exact, sorted list, one
//    per line. A new one fails here and has to say why it is not fit-to-box.ts.
//  - `largestFit`, the bisection, is declared once.
//  - FitText, the people panel and Lyrics reach the fit by calling `useBoxFit`.
//
// What this cannot see: a measurement that never observes a resize. The list is the
// check on that too, because the only way onto it is a code review of this file.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import ts from "typescript";

const MAIN = path.dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

const SIZE_READS = new Set(["scrollWidth", "scrollHeight", "offsetWidth", "offsetHeight"]);

/** Whether the file observes a resize AND reads a content size back. */
function measures(file: string): boolean {
  let observes = false;
  let reads = false;
  walk(parse(file), (n) => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "ResizeObserver") observes = true;
    if (ts.isPropertyAccessExpression(n) && SIZE_READS.has(n.name.text)) reads = true;
  });
  return observes && reads;
}

const rel = (file: string) => path.relative(MAIN, file).split(path.sep).join("/");

function declares(file: string, name: string): boolean {
  let found = false;
  walk(parse(file), (n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = true;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = true;
  });
  return found;
}

function callCount(file: string, name: string): number {
  let count = 0;
  walk(parse(file), (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) count++;
  });
  return count;
}

describe("one fit-to-box measurement", () => {
  test("the files that observe a box and read their content's size are exactly these", () => {
    const found = sources(MAIN).filter(measures).map(rel).sort();
    assert.deepEqual(found, [
      "fit-to-box.ts",
      "layout-renderer.tsx",
      "pvp-object.tsx",
      "readout.tsx",
      "rundown-table.tsx",
      "scores-object.tsx",
    ]);
  });

  test("the bisection is declared once, in fit-to-box.ts", () => {
    const where = sources(MAIN).filter((f) => declares(f, "largestFit")).map(rel);
    assert.deepEqual(where, ["fit-to-box.ts"]);
  });

  test("the old back-derived scale hook is gone", () => {
    const where = sources(MAIN).filter((f) => declares(f, "useFitScale")).map(rel);
    assert.deepEqual(where, []);
  });

  test("slide text, the people panel and Lyrics reach the fit by calling it", () => {
    // FitText and the people panel are two calls in layout-renderer.tsx.
    assert.equal(callCount(path.join(MAIN, "layout-renderer.tsx"), "useBoxFit"), 2);
    assert.equal(callCount(path.join(MAIN, "lyrics-object.tsx"), "useBoxFit"), 1);
  });
});
