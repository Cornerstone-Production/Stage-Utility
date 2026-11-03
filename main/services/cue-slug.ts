// cue-slug.ts — the text-to-cue-name step, with nothing else attached.
//
// PURE. The Companion export parser, the cue namer and the server's own routes
// all slug a label the same way; this is the one copy, kept apart from the parser
// so naming a cue does not mean loading it.

/**
 * Whitespace collapsed, INCLUDING the literal two-character `\n` Companion
 * stores for a line break.
 *
 * Not a nicety: a button reads `PVP:\nLyrics ON` in the export, with a real
 * backslash and a real `n`. Collapsing only real whitespace leaves that
 * backslash in the middle of the label, which then becomes part of a cue name
 * and part of the ON/OFF comparison — so the ON and OFF halves of a two-line
 * button still pair up, but under a name nobody could say out loud.
 */
export function collapse(text: string): string {
  return text.replace(/\\[rn]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * A cue name from a button label: lower snake_case, letters/digits/underscore.
 *
 * The name is said out loud to a voice assistant and typed into a Home Assistant
 * config, so it has to survive both. Anything else collapses to a single
 * underscore, and a name that reduces to nothing returns "" for the caller to
 * reject rather than a cue called `_`.
 */
export function slugForCue(text: string): string {
  return collapse(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
