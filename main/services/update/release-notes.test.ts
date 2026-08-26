import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseReleaseIntro, parseReleaseSections, SECTION_ORDER } from "./release-notes.js";

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

// The prose a release opens with — the part no commit range can produce.
//
// It was reaching GitHub and stopping there. The dialog rendered only bullets,
// so "nothing to do to install this", "every view comes across as it was" and
// "the settings window has moved" were invisible to the operator who most needs
// them: the one who did not start the update and is now looking at an app whose
// navigation has changed.
describe("the release's opening prose", () => {
  /** A body shaped like a real release: notice, sections, install commands. */
  const BODY = `> **Nothing to do to install this.** No manual step and no config
> migration — update the way you normally would.

Stage Utility is now one app. The settings window is gone.

## Changed

- The settings window is gone
- Views and Displays are one page

## Fixed

- Alignments stay put

## Install

Two supported ways in.

\`\`\`bash
curl -fsSL https://example.invalid/install.sh | sudo bash
\`\`\`
`;

  test("is returned, having been dropped entirely before", () => {
    const intro = parseReleaseIntro(BODY);
    assert.ok(intro, "no intro — the reassurance never reaches the dialog");
    assert.match(intro, /Nothing to do to install this/);
    assert.match(intro, /Stage Utility is now one app/);
  });

  test("stops at the first heading, so install commands stay out", () => {
    // The specific hazard: a shell command rendered as a paragraph in a dialog
    // is something an operator might try to type.
    const intro = parseReleaseIntro(BODY) ?? "";
    assert.doesNotMatch(intro, /curl/, "the install command leaked into the dialog");
    assert.doesNotMatch(intro, /Two supported ways/);
    assert.doesNotMatch(intro, /##/);
  });

  test("does not repeat the change lines", () => {
    // Those are rendered as sections. Saying them twice in one dialog is worse
    // than saying them once.
    const intro = parseReleaseIntro(BODY) ?? "";
    assert.doesNotMatch(intro, /Views and Displays are one page/);
  });

  test("strips the markdown the dialog would otherwise print literally", () => {
    const intro = parseReleaseIntro(BODY) ?? "";
    assert.doesNotMatch(intro, /^>/m, "a blockquote marker survived");
    assert.doesNotMatch(intro, /\*\*/, "bold markers survived");
  });

  test("keeps paragraphs apart", () => {
    const intro = parseReleaseIntro(BODY) ?? "";
    assert.ok(intro.includes("\n\n"), "the two paragraphs ran together");
  });

  test("a body with no headings has no intro", () => {
    // A git checkout's changelog is bare commit subjects. Treating those as
    // prose would put the whole changelog in the dialog a second time, above
    // the list of the same lines.
    assert.equal(parseReleaseIntro("fix(home): a thing\nfeat(editor): another"), null);
  });

  test("a release with sections but no prose has no intro", () => {
    assert.equal(parseReleaseIntro("## New\n\n- Something\n"), null);
  });

  test("nothing at all is null, not a crash", () => {
    assert.equal(parseReleaseIntro(null), null);
    assert.equal(parseReleaseIntro(""), null);
  });

  test("an essay is truncated rather than filling the dialog", () => {
    const long = `${"word ".repeat(400)}\n\n## New\n\n- x\n`;
    const intro = parseReleaseIntro(long) ?? "";
    assert.ok(intro.length <= 901, `intro is ${intro.length} characters`);
    assert.match(intro, /…$/, "truncation is not signalled");
  });
});

describe("the cap is big enough for the notices actually written", () => {
  test("a two-paragraph overview survives whole", () => {
    // The regression this exists for: the first cap was 600 and cut the real
    // 1.11.0 notice off mid-sentence, losing the last thing it had to say.
    const real = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "release-notes", "1.11.0.md"),
      "utf8",
    );
    const intro = parseReleaseIntro(`${real}\n## Install\n\ncurl …\n`) ?? "";
    assert.ok(intro, "the shipped notice produces no intro at all");
    assert.doesNotMatch(intro, /…$/, "the shipped notice is being truncated");
    assert.match(intro, /Resi and\s+YouTube now sit alongside/, "the closing sentence was cut");
  });
});
