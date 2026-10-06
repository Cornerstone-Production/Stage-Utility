// capture-console.ts — what a test's code wrote to the console.

import type { TestContext } from "node:test";

/** Every line the named console methods write until the test ends, joined
 *  the way the console prints them. The test context puts the real methods
 *  back, however the test ends. */
export function captureConsole(t: TestContext, ...methods: ("log" | "warn" | "error")[]): string[] {
  const lines: string[] = [];
  for (const method of methods) {
    t.mock.method(console, method, (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return lines;
}
