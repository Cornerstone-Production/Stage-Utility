// One handler's source text, cut out of use-stage-settings.ts.
//
// Read as text rather than called, because the handlers this serves are closures
// over a query client inside a hook: what has to hold about them is the ORDER of
// two writes and the fact that both are made at all, and neither survives being
// mocked apart from the hook.
//
// ONE cut rule, in one place. There were two, in two test files, and they
// disagreed: surface-pairing stopped only at the next `async function`, so it
// swallowed the following handler's JSDoc, while surface-swap-order stopped at
// that OR the next block comment. The looser cut is how a source-text assertion
// comes to be satisfied by PROSE — the exact failure CLAUDE.md lists — and today
// it holds only because the trailing comment happens to name no IPC channels.

import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./use-stage-settings.ts", import.meta.url), "utf8");

/**
 * The body of one top-level handler, from its `async function` line to whichever
 * comes first: the next handler, or the block comment introducing it.
 *
 * Stopping at the comment is the point. A JSDoc block belongs to the handler
 * BELOW it, so carrying it into this one's text lets a sentence somebody wrote
 * about the next function satisfy an assertion about this one.
 *
 * Throws rather than returning empty when the handler is gone: a scan that finds
 * nothing must fail loudly, not pass over an empty string.
 */
export function handlerBody(name: string): string {
  const i = SRC.indexOf(`async function ${name}(`);
  if (i < 0) throw new Error(`${name} is gone from use-stage-settings.ts — the rule it carries went with it`);
  const rest = SRC.slice(i + 10);
  const ends = [rest.indexOf("\n  /**"), rest.indexOf("\n  async function ")].filter((n) => n > 0);
  return rest.slice(0, ends.length === 0 ? undefined : Math.min(...ends));
}

/** The whole file, for the few assertions that are about it rather than about
 *  one handler. */
export const SETTINGS_SRC = SRC;
