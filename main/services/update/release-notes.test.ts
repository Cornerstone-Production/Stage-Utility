import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseReleaseSections, SECTION_ORDER } from "./release-notes.js";

// What an operator reads once, after an update they may not have watched happen.
// The section a line came from is the part the old parser threw away, and it is
// the part that separates "we renamed a button" from "your displays will break".

describe("release notes, by section", () => {
  test("keeps each line under the heading it came from", () => {
    const out = parseReleaseSections(`
## New
- Export a layout
- Find a server by name

## Fixed
- Duplicating a console no longer makes a display
`);
    assert.deepEqual(out, [
      { section: "New", lines: ["Export a layout", "Find a server by name"] },
      { section: "Fixed", lines: ["Duplicating a console no longer makes a display"] },
    ]);
  });

  test("Breaking comes first, whatever order the body used", () => {
    // The one an operator must not scroll past. Release bodies are written in
    // whatever order suits the author; a dialog read once is not.
    const out = parseReleaseSections(`
## Fixed
- a fix

## Breaking
- displays without a slug now redirect
`);
    assert.deepEqual(out.map((s) => s.section), ["Breaking", "Fixed"]);
  });

  test("the full precedence is stable", () => {
    const body = SECTION_ORDER.slice().reverse().map((s) => `## ${s}\n- line for ${s}`).join("\n\n");
    assert.deepEqual(parseReleaseSections(body).map((s) => s.section), [...SECTION_ORDER]);
  });

  test("a heading's case is normalised, so two releases do not render differently", () => {
    const out = parseReleaseSections("## BREAKING\n- one\n\n## fixed\n- two\n");
    assert.deepEqual(out.map((s) => s.section), ["Breaking", "Fixed"]);
  });

  test("a heading used twice is merged rather than rendered twice", () => {
    const out = parseReleaseSections("## New\n- one\n\n## Install\n- ignored\n\n## New\n- two\n");
    assert.deepEqual(out, [{ section: "New", lines: ["one", "two"] }]);
  });

  test("markdown emphasis and code ticks are stripped", () => {
    const out = parseReleaseSections("## New\n- **Bold** and `code`\n");
    assert.deepEqual(out[0].lines, ["Bold and code"]);
  });

  test("the notes generator's own truncation marker is dropped", () => {
    const out = parseReleaseSections("## Fixed\n- real one\n- …and 12 more\n");
    assert.deepEqual(out[0].lines, ["real one"]);
  });

  test("prose outside a change section is ignored", () => {
    // The upgrade notice is a blockquote, Highlights are paragraphs, and Install
    // is shell commands. None belongs in a list of what changed.
    const out = parseReleaseSections(`
> Upgrade note: back up first.

## Highlights
- not a change section

## Install
- brew upgrade stage-utility

## Fixed
- the real one
`);
    assert.deepEqual(out, [{ section: "Fixed", lines: ["the real one"] }]);
  });

  test("a body with no recognised sections yields nothing, not one blob", () => {
    // Better an empty dialog body than a heading over unrelated prose.
    assert.deepEqual(parseReleaseSections("Some prose.\n- a bullet\n"), []);
  });

  test("a heading with no lines under it is dropped", () => {
    assert.deepEqual(parseReleaseSections("## New\n\n## Fixed\n- one\n").map((s) => s.section), ["Fixed"]);
  });

  test("null and empty bodies are answers, not throws", () => {
    assert.deepEqual(parseReleaseSections(null), []);
    assert.deepEqual(parseReleaseSections(""), []);
  });

  test("the cap bounds TOTAL lines, and keeps the most important sections", () => {
    // Truncating alphabetically or by body order could drop Breaking entirely.
    const body = "## Fixed\n" + Array.from({ length: 30 }, (_, i) => `- f${i}`).join("\n")
      + "\n\n## Breaking\n- the one that matters\n";
    const out = parseReleaseSections(body, 5);
    assert.equal(out.reduce((n, s) => n + s.lines.length, 0), 5);
    assert.equal(out[0].section, "Breaking");
    assert.deepEqual(out[0].lines, ["the one that matters"]);
  });

  test("a line that is only emphasis markers does not become an empty bullet", () => {
    assert.deepEqual(parseReleaseSections("## New\n- ****\n- real\n")[0].lines, ["real"]);
  });
});
