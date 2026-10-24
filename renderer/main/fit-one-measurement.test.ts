// There is ONE fit-to-box measurement, and the objects that fit use it.
//
// This replaces a guard that counted `function useFitScale` in layout-renderer.tsx:
// it passed because of a NAME, and a second implementation under another name
// (Lyrics had one for a day) left it green. So this reads the syntax tree, not the
// text, and asks what a measurement IS: something that observes a box's size and
// reads the size of its content back (scrollWidth, offsetHeight and the like).
//
//  - Every declaration in renderer/ that does both (observes a resize and reads a
//    content size) is on an exact, sorted list, one `file:name` per line. A new one
//    fails here and has to say why it is not fit-to-box.ts.
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

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(RENDERER, "main");

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

const isFunctionLike = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

/** `new ResizeObserver(...)` and `new window.ResizeObserver(...)`. */
function isResizeObserver(n: ts.Node): n is ts.NewExpression {
  if (!ts.isNewExpression(n)) return false;
  const e = n.expression;
  return (ts.isIdentifier(e) && e.text === "ResizeObserver") || (ts.isPropertyAccessExpression(e) && e.name.text === "ResizeObserver");
}

/** The nearest named declaration around a node: the component or hook an effect lives in. */
function declaration(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFunctionLike(n.initializer)) return n;
  }
  return undefined;
}

function declaredName(node: ts.Node): string {
  const d = declaration(node) as (ts.Node & { name?: ts.Node }) | undefined;
  return d?.name?.getText() ?? "(top level)";
}

const rel = (file: string) => path.relative(RENDERER, file).split(path.sep).join("/");

/**
 * Every place that observes a box AND reads a content size back, as `file:name`.
 *
 * Per DECLARATION, not per file: a second fit added as one more function inside a
 * file that already measures (layout-renderer.tsx has three observers) is a new
 * entry, where a per-file list would not notice. For each `new ResizeObserver`, the
 * declaration around it counts when anything inside it (the measure callbacks live
 * in closures) reads a size property. A second observer in one declaration is
 * `file:name#2`.
 *
 * What it cannot see: a fit that reads a size and never observes a resize, a read
 * of clientHeight alone (a box's own size is not a content size), and a size read
 * in a helper the observing declaration only calls (useBoxFit itself, whose
 * default test lives in `boxFits`, is the one place that is on purpose).
 */
function measurements(file: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  walk(parse(file), (n) => {
    if (!isResizeObserver(n)) return;
    const around = declaration(n);
    if (!around) return;
    let reads = false;
    walk(around, (m) => {
      if (ts.isPropertyAccessExpression(m) && SIZE_READS.has(m.name.text)) reads = true;
    });
    if (!reads) return;
    const key = `${rel(file)}:${declaredName(n)}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    out.push(count === 1 ? key : `${key}#${count}`);
  });
  return out;
}

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
  test("the declarations that observe a box and read their content's size are exactly these", () => {
    const found = sources(RENDERER).flatMap(measurements).sort();
    assert.deepEqual(found, [
      "app/bar-fit.ts:useBarFit",
      "lib/use-element-width.ts:useElementTier",
      "main/layout-renderer.tsx:ServiceOrderObject",
      "main/pvp-object.tsx:useClippedRows",
      "main/readout.tsx:useBoxSize",
      "main/readout.tsx:useShrinkToWidth",
      "settings/brand-header.tsx:BrandHeader",
    ]);
  });

  test("the bisection is declared once, in fit-to-box.ts", () => {
    const where = sources(MAIN).filter((f) => declares(f, "largestFit")).map(rel);
    assert.deepEqual(where, ["main/fit-to-box.ts"]);
  });

  test("the old back-derived scale hook is gone", () => {
    const where = sources(RENDERER).filter((f) => declares(f, "useFitScale")).map(rel);
    assert.deepEqual(where, []);
  });

  test("slide text, the people panel and Lyrics reach the fit by calling it", () => {
    // FitText and the people panel are two calls in layout-renderer.tsx.
    assert.equal(callCount(path.join(MAIN, "layout-renderer.tsx"), "useBoxFit"), 2);
    assert.equal(callCount(path.join(MAIN, "lyrics-object.tsx"), "useBoxFit"), 1);
  });
});
