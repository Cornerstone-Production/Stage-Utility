// The key goes on the element a `.map` callback RETURNS.
//
// A key on a child of the returned element keys nothing: React reads it off the
// array's own children. It is easy to write and invisible in review — the
// History calendar rendered `<Tooltip><button key={dateStr} …>`, so every visit
// to History logged "Encountered two children with the same key" and React was
// free to reuse the wrong day's DOM on the next render. The canvas-shape presets
// in the layout editor had the identical shape.
//
// This walks the TSX with the TypeScript parser rather than reading source text:
// there is no comment, string or identifier a file can contain that satisfies it,
// and it checks the whole tree rather than the two files the bug was found in.
// The count is EXACT and zero — a floor with slack is how this repo has shipped
// vacuous guards before.
//
// Not covered here, deliberately: a key that is unique but unstable (an index),
// which is a correctness question no parser can answer.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const ROOTS = ["renderer", "main"];

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

type Wrapper = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;

function tagName(node: Wrapper): string {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return "<>";
}

function attributesOf(node: ts.Node): ts.JsxAttributes | null {
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  return null;
}

/** A literal `key=` attribute, or a spread that could be carrying one. */
function hasKey(node: ts.Node): boolean {
  const a = attributesOf(node);
  if (!a) return false;
  return a.properties.some(
    (p) => (ts.isJsxAttribute(p) && p.name.getText() === "key") || ts.isJsxSpreadAttribute(p),
  );
}

/** The tag of the first keyed element BELOW `root`, or null. */
function keyedDescendant(root: ts.Node): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && n !== root && hasKey(n)) {
      found = tagName(n as Wrapper);
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

/** Every JSX element a map callback can return — through parens, a ternary, or
 *  a `&&`, each branch of which is its own returned element. */
function returnedJsx(fn: ts.ArrowFunction | ts.FunctionExpression): Wrapper[] {
  const out: Wrapper[] = [];
  const unwrap = (e: ts.Expression): void => {
    if (ts.isParenthesizedExpression(e)) return unwrap(e.expression);
    if (ts.isConditionalExpression(e)) {
      unwrap(e.whenTrue);
      unwrap(e.whenFalse);
      return;
    }
    if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return unwrap(e.right);
    }
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) out.push(e);
  };
  if (ts.isBlock(fn.body)) {
    const visit = (n: ts.Node) => {
      // A nested function's returns are not this callback's.
      if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return;
      if (ts.isReturnStatement(n) && n.expression) unwrap(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
  } else {
    unwrap(fn.body);
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of ROOTS.flatMap((r) => tsxFiles(path.join(ROOT, r)))) {
    const src = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.getText() === "map" &&
        n.arguments.length > 0
      ) {
        const fn = n.arguments[0];
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
          for (const el of returnedJsx(fn)) {
            if (hasKey(el)) continue;
            const inner = keyedDescendant(el);
            if (inner) {
              const { line } = src.getLineAndCharacterOfPosition(el.getStart());
              found.push(
                `${path.relative(ROOT, file)}:${line + 1} — <${tagName(el)}> is returned from .map with no key, but <${inner}> inside it has one`,
              );
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(src, visit);
  }
  return found;
}

test("the scan sees the whole tree, so a zero result means something", () => {
  // A zero offender count is only evidence if files were actually read. 277 TSX
  // files at the time of writing; the floor is deliberately far below that and
  // exists to catch a walk that silently found nothing.
  const files = ROOTS.flatMap((r) => tsxFiles(path.join(ROOT, r)));
  assert.ok(files.length > 100, `only ${files.length} TSX files found — the walk is not reaching the tree`);
  assert.ok(
    files.some((f) => f.endsWith(path.join("components", "history-calendar.tsx"))),
    "the file the bug was found in is not among the files scanned",
  );
});

test("every element returned from a .map carries its own key", () => {
  const found = offenders();
  assert.deepEqual(found, [], `key on the wrong element:\n  ${found.join("\n  ")}`);
});
