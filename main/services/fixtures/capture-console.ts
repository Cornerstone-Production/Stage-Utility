// capture-console.ts — what a test's code wrote to the console.

import type { SuiteContext, TestContext } from "node:test";
import { inspect } from "node:util";

type ConsoleMethod = "log" | "warn" | "error" | "info" | "debug";
/** A test's context, or what a beforeEach hook is typed with. The hook is
 *  handed the test's own context at run time, mock included; node's typings
 *  just cannot say so. */
type HookContext = TestContext | SuiteContext;

/** One console argument as text, losslessly: strings as they are, an Error as
 *  "Name: message", anything else through util.inspect so an object's fields
 *  show. String() and Array#join print "[object Object]" for an object, which
 *  is how a credential-leak guard fails to see `console.warn("x", { password })`. */
export function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return String(arg);
  return inspect(arg, { depth: null, breakLength: Infinity });
}

/** Every line the named console methods write until the test ends, joined
 *  the way the console prints them, with every argument shown in full. The
 *  test context puts the real methods back, however the test ends. Also works
 *  from a beforeEach hook, whose context is the test's. */
export function captureConsole(t: HookContext, ...methods: ConsoleMethod[]): string[] {
  const lines: string[] = [];
  for (const method of methods) {
    (t as TestContext).mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(formatConsoleArg).join(" "));
    });
  }
  return lines;
}

/** Every console.log, warn and error call until the test ends, one entry each,
 *  led by its level ("warn [x] ..."), for a suite that asserts on which level a
 *  line went out at. */
export function captureLeveledConsole(t: HookContext): string[] {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    (t as TestContext).mock.method(console, level, (...args: unknown[]) => {
      lines.push(`${level} ${args.map(formatConsoleArg).join(" ")}`);
    });
  }
  return lines;
}
