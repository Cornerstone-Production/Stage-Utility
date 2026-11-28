// A failure the operator is told about must also reach /log.
//
// A toast is gone in four seconds, and nothing forwards the browser's console to
// the server (client-log.ts), so a `toast.error(errorMessage(err))` with no
// logging beside it is a failure with no evidence the next morning. Every such
// file reports through the shared reporter (report-failure.ts, client-log.ts,
// optimistic.ts's writers, useFailedReads), or is on the sorted list below.
//
// The scan is syntactic and file-level, and walks the parsed tree: a comment or
// a string that names `logFailure` satisfies nothing, only a CALL does. It does
// not prove each toast has its own line — the helpers' own tests do that at the
// fetch boundary — it stops a file from toasting caught errors with no way to
// log at all, which is how the 36 files this started from were.
//
// The list is the debt: each entry is a file this refactor could not touch, with
// the reason beside it. Shrink it; never add to it without saying why.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, "..");

/** Calls that put a failure on /log. `fail` is useFailedReads'. */
const LOGGING_CALLS = new Set(["logFailure", "logReadFailure", "logToServer", "reportFailure", "reportWrite", "fail", "writeTo", "writeOptimistic"]);

/** Sorted, one file per line. Why each is here is in the report that added this. */
const NOT_YET_LOGGING = [
  "app/mic-slots/saved-layouts.tsx", // mic-slots is held by another branch
  "app/mic-slots/use-mic-slots.ts", // mic-slots is held by another branch
  "components/integrations-panel.tsx", // held by another branch; console.error only
];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const calleeName = (call: ts.CallExpression): string | null => {
  const f = call.expression;
  if (ts.isIdentifier(f)) return f.text;
  if (ts.isPropertyAccessExpression(f)) return `${ts.isIdentifier(f.expression) ? f.expression.text : ""}.${f.name.text}`;
  return null;
};

/** Does the file toast a caught error, and does it log anywhere? */
function scan(source: string): { toastsCaughtError: boolean; logs: boolean } {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let toastsCaughtError = false;
  let logs = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === "toast.error" && n.arguments.some((a) => containsCall(a, "errorMessage"))) toastsCaughtError = true;
      if (name && LOGGING_CALLS.has(name)) logs = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { toastsCaughtError, logs };
}

function containsCall(node: ts.Node, callee: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && calleeName(n) === callee) found = true;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

describe("renderer failures reach /log", () => {
  it("the scan tells a call from prose, and a toast alone from a toast with a line", () => {
    assert.deepEqual(scan('// logFailure("x")\nconst s = "reportFailure(";\ntoast.error(`no: ${errorMessage(e)}`);'), { toastsCaughtError: true, logs: false });
    assert.deepEqual(scan("toast.error(`no: ${errorMessage(e)}`);\nlogFailure(\"x\", \"y\", e);"), { toastsCaughtError: true, logs: true });
    assert.deepEqual(scan('toast.error("Pick a file first.");'), { toastsCaughtError: false, logs: false });
  });

  it("every file that toasts a caught error logs, but the ones named here", () => {
    const silent = walkFiles(RENDERER)
      .filter((f) => {
        const r = scan(fs.readFileSync(f, "utf8"));
        return r.toastsCaughtError && !r.logs;
      })
      .map((f) => path.relative(RENDERER, f).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(silent, NOT_YET_LOGGING);
  });
});
