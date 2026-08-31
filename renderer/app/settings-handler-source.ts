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
//
// "Today it holds only because" was the whole problem. Cutting at the right
// boundary is not the same as removing comments, and this helper removed none:
// `// await writeState("views:setSurface", …)` on its own line inside a handler
// satisfied `assert.match(src, /views:setSurface/)` with the write it names
// deleted. Verified by doing exactly that. Comments are blanked now, so no
// assertion here can be answered by prose wherever the cut happens to land.

import { readFileSync } from "node:fs";

import { withoutComments } from "../lib/source-comments.js";

const RAW = readFileSync(new URL("./use-stage-settings.ts", import.meta.url), "utf8");
/** The same text with every comment blanked — character for character, so an
 *  index found in RAW cuts this in the same place. */
const SRC = withoutComments(RAW);

/**
 * The body of one top-level handler, from its `async function` line to whichever
 * comes first: the next handler, or the block comment introducing it. Comments
 * blanked.
 *
 * Stopping at the comment is still the point, even with the blanking. A JSDoc
 * block belongs to the handler BELOW it, and carrying its span into this one's
 * text would put the next function's code within reach of an assertion about
 * this one.
 *
 * Throws rather than returning empty when the handler is gone: a scan that finds
 * nothing must fail loudly, not pass over an empty string.
 */
export function handlerBody(name: string): string {
  const [from, to] = handlerSpan(name);
  return SRC.slice(from, to);
}

/** The same cut, comments and all — for the guard that checks WHERE the cut
 *  lands, which has nothing to look at once they are blanked. */
export function handlerBodyRaw(name: string): string {
  const [from, to] = handlerSpan(name);
  return RAW.slice(from, to);
}

/**
 * The [start, end) of one handler in the file.
 *
 * Found in the RAW text, because the next handler is introduced by a JSDoc block
 * that no longer exists in the blanked copy. Blanking preserves every offset, so
 * the same indices cut either copy in the same place.
 */
function handlerSpan(name: string): [number, number] {
  const i = RAW.indexOf(`async function ${name}(`);
  if (i < 0) throw new Error(`${name} is gone from use-stage-settings.ts — the rule it carries went with it`);
  const from = i + 10;
  const rest = RAW.slice(from);
  const ends = [rest.indexOf("\n  /**"), rest.indexOf("\n  async function ")].filter((n) => n > 0);
  return [from, ends.length === 0 ? RAW.length : from + Math.min(...ends)];
}

/** The whole file, comments blanked, for the few assertions that are about it
 *  rather than about one handler. */
export const SETTINGS_SRC = SRC;
