// The guard on the two guards.
//
// log-injection.test.ts and pco-link-safety.test.ts both hold log sites to
// scrub() by reading source text, and every hole either of them has had was a
// hole in the READING, not in the rule: a per-line scan that could not see a
// wrapped call, a `startsWith` that could not see a concatenation. So the shapes
// the scanner has to get right are asserted here, on hand-written source, where
// a wrong answer is visible instead of merely absent.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONSOLE_LEVELS,
  consoleArguments,
  consoleCalls,
  isLiteralExpression,
  logOffenders,
} from "./console-scan.js";

describe("consoleCalls", () => {
  it("captures a call wrapped over several lines, body and all", () => {
    // The hole that made the old scan report 0 offenders in a file with 22:
    // `console.log(` and the interpolation are never on the same line.
    const source = ["console.log(", "  `[x] plan ${title}`,", ");", ""].join("\n");
    const calls = consoleCalls(source);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].line, 1);
    assert.match(calls[0].text, /\$\{title\}/, "the block was captured without its body");
  });

  it("does not stop at a `)` inside a string or a nested template", () => {
    const source = 'console.warn(`a) ${x ? `b)` : ")"} c`, second);\n';
    const calls = consoleCalls(source);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /second/, "the call ended early on a `)` inside a literal");
  });

  it("ignores a console call that is only mentioned in a comment", () => {
    assert.deepEqual(consoleCalls("// console.log(`${secret}`);\n"), []);
    assert.deepEqual(consoleCalls(" * console.log(`${secret}`);\n"), []);
  });

  it("sees every level log-buffer captures, and debug", () => {
    assert.deepEqual([...CONSOLE_LEVELS], ["log", "info", "warn", "error", "debug"]);
    for (const level of CONSOLE_LEVELS) {
      assert.equal(consoleCalls(`console.${level}(\`\${x}\`);\n`).length, 1, `console.${level} was invisible`);
    }
  });

  it("starts at the console call's own paren, not the `if (` in front of it", () => {
    const calls = consoleCalls("if (DEBUG) console.log(`${url}`);\n");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text[0], "(");
    assert.doesNotMatch(calls[0].text, /DEBUG/, "the guard was captured as part of the call");
  });
});

describe("consoleArguments", () => {
  it("splits on separators only, not on commas inside a nested call or literal", () => {
    assert.deepEqual(consoleArguments('("a, b", scrub(c, 2), `${d}, e`)'), [
      '"a, b"',
      "scrub(c, 2)",
      "`${d}, e`",
    ]);
  });

  it("finds the bare argument the interpolation rule never looked at", () => {
    assert.deepEqual(consoleArguments('("[pco] failed:", err)'), ['"[pco] failed:"', "err"]);
  });

  it("survives a template inside a template", () => {
    assert.deepEqual(consoleArguments('(`a ${x ? `b, c` : "d"} e`, second)'), [
      '`a ${x ? `b, c` : "d"} e`',
      "second",
    ]);
  });
});

describe("isLiteralExpression", () => {
  it("accepts literals, and literals joined by +", () => {
    assert.equal(isLiteralExpression('"plain"'), true);
    assert.equal(isLiteralExpression("`[x] ${scrub(a)}`"), true);
    assert.equal(isLiteralExpression('`[x] one ` + `two ${scrub(a)}`'), true);
  });

  it("rejects the concatenation the old `startsWith` rule waved through", () => {
    // `/^[`'"]/` asked only how the argument STARTS, so this passed and put a
    // provider's own text, newlines and all, on /log.
    assert.equal(isLiteralExpression('"[pco] failed: " + err'), false);
  });

  it("rejects a bare value, a call and an object", () => {
    assert.equal(isLiteralExpression("err"), false);
    assert.equal(isLiteralExpression("Object.keys(config)"), false);
    assert.equal(isLiteralExpression('{ id: "a" }'), false);
  });
});

describe("logOffenders", () => {
  it("reports the wrapped, unscrubbed interpolation and nothing else", () => {
    const source = [
      "console.log(",
      "  `[x] plan=${plan.id} (${scrub(plan.title)})`,",
      ");",
      "",
    ].join("\n");
    assert.deepEqual(
      logOffenders(source).map((o) => `${o.kind} ${o.text}`),
      ["interpolation ${plan.id}"],
    );
  });

  it("reports the argument forms as well as the interpolations", () => {
    const source = ['console.error("[x] failed:", err);', 'console.warn("[x] " + err);', ""].join("\n");
    assert.deepEqual(
      logOffenders(source).map((o) => `${o.line} ${o.kind} ${o.text}`),
      ["1 argument err", '2 argument "[x] " + err'],
    );
  });

  it("is satisfied by scrub() and by scrubError(), and by nothing that is only prose", () => {
    const source = [
      "// console.log(`${plan.title}`) — scrub() this if you add it back",
      'console.error("[x] failed:", scrubError(err));',
      "console.log(`[x] ${scrub(plan.title)}`);",
      "",
    ].join("\n");
    assert.deepEqual(logOffenders(source), []);
  });
});
