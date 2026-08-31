// An icon colour did not survive a restart, and a glyph would have shipped with
// the same defect.
//
// Both setters write to settings.json and both are correct. Neither map was READ
// BACK when the state was built at boot, so the value sat on disk describing an
// icon nothing would ever draw again. Verified against a real server before the
// fix: set a colour, confirm it in /api/state and in settings.json, restart, and
// /api/state comes back with iconColors absent.
//
// Source text, because the alternative is booting a controller with a real data
// directory inside a unit test, and what has to hold is a property of the state
// BUILDER: every persisted map it can write, it also reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const SRC = readFileSync(new URL("./stage-controller.ts", import.meta.url), "utf8");

/** The block that builds the initial state from `settings`. */
function hydrationBlock(): string {
  const m = /appName: settings\.appName[\s\S]*?onboardingDismissed: settings\.onboardingDismissed[^\n]*\n/.exec(SRC);
  assert.ok(m, "could not find the state hydration block in stage-controller.ts");
  return m[0];
}

describe("what the operator set is still there after a restart", () => {
  test("icon colours are read back at boot", () => {
    assert.match(hydrationBlock(), /iconColors: settings\.iconColors/);
  });

  test("icon glyphs are read back at boot", () => {
    assert.match(hydrationBlock(), /iconGlyphs: settings\.iconGlyphs/);
  });

  test("every settings key the controller WRITES is READ somewhere at boot", () => {
    // The rule, rather than two more names to remember: a setter that patches
    // settings.<key> and a boot that never reads settings.<key> anywhere is the
    // defect, whichever key it is.
    //
    // "read somewhere", not "read in the state literal": several keys hydrate
    // through a local computed above it (`outputs`, `showQr`, the plan fields),
    // and pinning the literal's exact spelling would fail on a refactor that
    // changed nothing. What cannot pass is a key the file never reads at all,
    // which is exactly how iconColors was lost.
    //
    // TWO THINGS THIS USED TO MISS, both of which made it green on the defect:
    //
    //   - it read the FIRST key of each patch object only —
    //     `/settingsStore\.patch\(\{\s*([A-Za-z0-9_]+)[:,\s}]/` — so a call
    //     patching several keys at once covered one of them. 21 of the 26 keys
    //     this file writes; checklistNoteTeams, planDates, planSeriesTitle,
    //     planTitle and serviceTypeName were never checked at all.
    //   - the "is it read" search ran over the raw source, COMMENTS INCLUDED, so
    //     a sentence naming the key satisfied it. That is the failure mode
    //     CLAUDE.md lists twice over.
    const { keys, dynamic } = writtenKeys();

    // The defect first, so a failure names the key rather than a number.
    const unread = keys.filter((k) => !new RegExp(String.raw`\.${k}\b`).test(readableSource()));
    assert.deepEqual(unread, [], "written to settings.json but never read back");

    // Then the guard on the guard, EXACT. A floor is how a scan in this repo
    // found 22 of 23 stores and was green by luck; an extraction that broke and
    // returned nothing would make the check above pass on an empty list. A new
    // setting moving either number is the moment to check that boot reads it.
    assert.equal(
      keys.length,
      26,
      `expected 26 keys patched into settings.json, found ${keys.length}: ${keys.join(", ")}`,
    );
    assert.equal(
      dynamic,
      2,
      `expected 2 settingsStore.patch() calls taking a computed object rather than a literal, ` +
        `found ${dynamic} — a new one is a set of keys this scan cannot see`,
    );
  });
});

/** The source with full-line comments blanked. Blanked, not deleted: a
 *  wholesale strip is how a scan in this repo swallowed real code and hid a
 *  route that exists. */
const withoutComments = (src: string): string =>
  src
    .split("\n")
    .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l))
    .join("\n");

const MARK = "settingsStore.patch(";

/**
 * Every `settingsStore.patch({…})` object in the file, as [start, end) spans.
 *
 * A call whose argument is not a literal — `settingsStore.patch(patch)`, from
 * the branding-image migration — is counted instead of read, because its keys
 * are not in the source to find. The count is asserted, so a new one has to be
 * looked at rather than silently widening the blind spot.
 */
function patchSpans(src: string): { spans: [number, number][]; dynamic: number } {
  const spans: [number, number][] = [];
  let dynamic = 0;
  let i = 0;
  while ((i = src.indexOf(MARK, i)) !== -1) {
    let j = i + MARK.length;
    while (/\s/.test(src[j])) j++;
    if (src[j] !== "{") {
      dynamic++;
      i = j;
      continue;
    }
    let depth = 0;
    let quote = "";
    let k = j;
    for (; k < src.length; k++) {
      const c = src[k];
      if (quote) {
        if (c === "\\") k++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    spans.push([j, k + 1]);
    i = k + 1;
  }
  return { spans, dynamic };
}

/** The TOP-LEVEL keys of one object literal — not the ones inside a nested
 *  object, an array or a call, which are not settings keys. */
function topLevelKeys(objText: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote = "";
  let atKey = true;
  let current = "";
  for (let i = 1; i < objText.length - 1; i++) {
    const c = objText[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0 && c === ",") {
      atKey = true;
      current = "";
    } else if (depth === 0 && c === ":") {
      if (atKey && current.trim()) keys.push(current.trim());
      atKey = false;
      current = "";
    } else if (depth === 0 && atKey) current += c;
  }
  return keys.filter((k) => /^[A-Za-z0-9_]+$/.test(k));
}

/** Every settings key the controller writes, and how many patch calls this scan
 *  structurally cannot read. */
function writtenKeys(): { keys: string[]; dynamic: number } {
  const src = withoutComments(SRC);
  const { spans, dynamic } = patchSpans(src);
  const keys = new Set(spans.flatMap(([a, b]) => topLevelKeys(src.slice(a, b))));
  return { keys: [...keys].sort(), dynamic };
}

/**
 * Everything OUTSIDE the patch calls, comments blanked.
 *
 * A key that appears only where it is written is a key nothing ever reads —
 * which is the defect, whatever spelling the read would have used (`settings.x`
 * in the state literal, or `(await settingsStore.get()).x` in a migration). The
 * patch objects are blanked by SPAN rather than by a non-greedy regex, which
 * used to swallow the code between two patch calls and hide a real read.
 */
function readableSource(): string {
  const src = withoutComments(SRC);
  const { spans } = patchSpans(src);
  let out = src;
  for (const [a, b] of [...spans].reverse()) out = out.slice(0, a) + " ".repeat(b - a) + out.slice(b);
  return out;
}