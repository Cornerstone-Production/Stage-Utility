// uid() over plain HTTP, and the guard that keeps every other id on it.
//
// crypto.randomUUID exists only in a secure context. Production is served over
// plain HTTP, so there it is undefined and calling it throws. localhost IS a
// secure context, so a call that works in development fails only on the real
// box: every slot-creating control on /mic-slots once threw this way. jsdom and
// Node both provide randomUUID, so the tests below delete it to stand in for prod.
//
// The walk parses every renderer source with the TypeScript parser and lists the
// files that touch `.randomUUID` (a property access or an element access with
// that literal name, through any receiver, so an alias like `c.randomUUID` is
// caught). A comment or string cannot satisfy it. The list is EXACT and sorted:
// the one file allowed to touch it is the helper that guards it.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import ts from "typescript";

import { uid } from "./uid.js";

const ROOT = path.resolve(import.meta.dirname, "../..");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function touchesRandomUUID(file: string): boolean {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let hit = false;
  const visit = (n: ts.Node) => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(n) && n.name.text === "randomUUID") hit = true;
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "randomUUID") hit = true;
    else if (ts.isBindingElement(n) && (n.propertyName ?? n.name).getText() === "randomUUID") hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit;
}

describe("crypto.randomUUID in the renderer", () => {
  test("only lib/uid.ts touches it", () => {
    const found = sources(path.join(ROOT, "renderer"))
      .filter(touchesRandomUUID)
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(found, ["renderer/lib/uid.ts"]);
  });
});

describe("uid() with no randomUUID, as over plain HTTP", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  });
  afterEach(() => {
    if (real) Object.defineProperty(globalThis.crypto, "randomUUID", real);
    else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  });

  test("still returns distinct prefixed ids", () => {
    const a = uid("slot");
    const b = uid("slot");
    assert.ok(a.startsWith("slot-"), a);
    assert.notEqual(a, b);
  });
});
