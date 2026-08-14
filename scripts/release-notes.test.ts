import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// A release that needs a manual step needs a sentence no commit range can
// produce. Written into docs/release-notes/<version>.md next to the change that
// made it necessary — because a note remembered at release time is a note
// eventually forgotten, and the release it is forgotten on is the one where an
// operator's box silently stops updating.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "release-notes.mjs");
const NOTES_DIR = path.join(HERE, "..", "docs", "release-notes");

function notesFor(version: string, from: string): string {
  return execFileSync("node", [SCRIPT, version, from], { encoding: "utf8" });
}

describe("release notes", () => {
  it("prepends the notice for a version that has one, above everything generated", () => {
    const version = "9.9.9-notice-test";
    const file = path.join(NOTES_DIR, `${version}.md`);
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(file, "> **Read this first.** One manual step.\n");
    try {
      const out = notesFor(version, "v1.9.4");
      assert.match(out, /Read this first/, "the notice must appear");
      // Above the generated sections, or a reader scrolling past bullets misses it.
      assert.ok(out.indexOf("Read this first") < out.indexOf("## Install"), "notice must come first");
      // And separated from them. The notice is trimmed on read, so without a
      // restored trailing newline the next heading butts onto its last line —
      // every other section is joined with a blank line between.
      assert.doesNotMatch(out, /\S\n## /, "a generated heading must not follow prose without a blank line");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("says nothing extra for an ordinary release", () => {
    const out = notesFor("9.9.8-no-notice", "v1.9.4");
    assert.doesNotMatch(out, /Read this first/);
    assert.match(out, /## Install/, "the ordinary sections still render");
  });

  it("ships a notice for 1.10.0, the release that needs one", () => {
    // Packaged installs on 1.9.x cannot self-update to it — in-app updates for
    // them are new IN 1.10.0 — so it must say so, with the command.
    const file = path.join(NOTES_DIR, "1.10.0.md");
    assert.ok(fs.existsSync(file), "docs/release-notes/1.10.0.md must exist");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /install\.sh/, "must give the Linux/macOS command");
    assert.match(text, /install\.ps1/, "must give the Windows command");
    assert.match(text, /brew upgrade/, "must give the Homebrew command");
    assert.match(text, /checkout/i, "must say a git checkout needs none of it");
  });
});
