// capture-console.ts — what a test's code wrote to the console.

import type { TestContext } from "node:test";
import { inspect } from "node:util";

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
export function captureConsole(t: TestContext, ...methods: ("log" | "warn" | "error")[]): string[] {
  const lines: string[] = [];
  for (const method of methods) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(formatConsoleArg).join(" "));
    });
  }
  return lines;
}
