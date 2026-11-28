// capture-console.ts — what a test's code wrote to the console.

import { mock, type SuiteContext, type TestContext } from "node:test";
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

/** The same capture for a helper that has no test context to hand: the named
 *  methods are captured while `fn` runs and put back when it ends, however it
 *  ends. Returns the lines. For a local `captured(() => ...)` wrapper. */
export function captureConsoleDuring(methods: ConsoleMethod[], fn: () => void): string[] {
  const lines: string[] = [];
  const installed = methods.map((method) =>
    mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(formatConsoleArg).join(" "));
    }),
  );
  try {
    fn();
  } finally {
    for (const m of installed) m.mock.restore();
  }
  return lines;
}

/** captureConsoleDuring for a callback that returns a promise: the console is
 *  put back once it settles. */
export async function captureConsoleDuringAsync(
  methods: ConsoleMethod[],
  fn: () => Promise<unknown>,
): Promise<string[]> {
  const lines: string[] = [];
  const installed = methods.map((method) =>
    mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(formatConsoleArg).join(" "));
    }),
  );
  try {
    await fn();
  } finally {
    for (const m of installed) m.mock.restore();
  }
  return lines;
}
