// An integration's description says WHAT IT DOES, in a sentence or two, and its
// setup steps live in docs/integrations/.
//
// They did not. Every description walked the operator through the other
// application's preferences — "Turn it on under ProVideoPlayer → Preferences →
// Network → Network API, note the port shown there" — which ran to 88 words for
// PVP and 83 for YouTube. Sixteen of those in a card grid is a wall nobody
// reads, and the same steps were already written, better, in docs/.
//
// Both halves are checked here, because cutting the descriptions without the
// docs link would have deleted the steps rather than moved them: every
// descriptor must name a docs page, and every page it names must exist.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { INTEGRATION_DESCRIPTORS } from "./integration-manager.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, "..", "..", "docs", "integrations");

/** Two sentences. Three is a paragraph, and a paragraph is what this replaced. */
const MAX_SENTENCES = 2;
/** Long enough for two real sentences, short enough that steps will not fit. */
const MAX_CHARS = 220;

const ALL = [...INTEGRATION_DESCRIPTORS];

describe("an integration's blurb is a blurb", () => {
  // Guards the list. A scan over an empty array passes every assertion below it,
  // which is how a check like this goes green while reading nothing.
  it("reads every integration the app ships", () => {
    assert.equal(ALL.length, 16, `expected 16 integrations, read ${ALL.length}`);
  });

  for (const d of ALL) {
    it(`${d.id} says what it does, not how to set it up`, () => {
      const text = d.description ?? "";
      assert.ok(text, `${d.id} has no description at all`);

      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
      assert.ok(
        sentences <= MAX_SENTENCES,
        `${d.id} runs to ${sentences} sentences — setup steps belong in docs/integrations/${d.docs}.md: ${text}`,
      );
      assert.ok(
        text.length <= MAX_CHARS,
        `${d.id} is ${text.length} characters; a card grid of sixteen of these is a wall nobody reads: ${text}`,
      );

      // The tell of a setup step: it names a menu path in the other application.
      assert.ok(
        !text.includes("→"),
        `${d.id} walks through another application's menus — that is what the docs page is for: ${text}`,
      );
    });
  }
});

describe("the setup steps are still reachable", () => {
  for (const d of ALL) {
    it(`${d.id} points at a docs page that exists`, () => {
      assert.ok(d.docs, `${d.id} names no docs page`);
      const file = path.join(DOCS, `${d.docs}.md`);
      assert.ok(
        existsSync(file),
        `${d.id} points at docs/integrations/${d.docs}.md, which is not there — the dialog's Setup guide link would 404`,
      );
    });
  }
});
