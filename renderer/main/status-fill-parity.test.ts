// The status widgets that watch a thing and go loud when it happens must go
// loud the SAME way.
//
// OBS status, REAPER status and Streaming status already shared a composition —
// caption, the state as a word, the ticking number underneath — and still read
// as two different widgets on a wall, because their defaults disagreed:
// `fillWhenRecording` fell back to true and `fillWhenLive` fell back to false.
// Four tiles in a row came out as two red slabs and two lines of grey text, and
// the two that said whether the stream was going out were the quiet ones.
//
// The renderer now falls back to one constant. This guards the other half — the
// default CONFIG each widget is created with, which is what a newly added
// object carries and what an operator sees first.
//
// The count is EXACT, not a floor. A floor with slack is how a fourth status
// widget would join the family with the old default and nothing would notice.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";

import { LAYOUT_OBJECTS } from "./layout-objects.js";

/** The widgets in this family, and the key each one calls its fill setting. */
const FILL_KEY: Record<string, "fillWhenRecording" | "fillWhenLive"> = {
  "obs-status": "fillWhenRecording",
  "reaper-status": "fillWhenRecording",
  // The any-recorder widget. It was not in the first version of this list, and
  // the exact-count assertion below is what produced it — which is the argument
  // for an exact count rather than "at least three".
  "record-status": "fillWhenRecording",
  "stream-status": "fillWhenLive",
};

/** Any object type whose config can carry a fill-when-active setting at all. */
function typesWithAFillSetting(): string[] {
  const found: string[] = [];
  for (const [type, entry] of Object.entries(LAYOUT_OBJECTS)) {
    const cfg = entry.config() as Record<string, unknown>;
    if ("fillWhenRecording" in cfg || "fillWhenLive" in cfg) found.push(type);
  }
  return found.sort();
}

describe("status widgets fill on the same terms", () => {
  test("every widget with a fill setting is in the family list", () => {
    // Exact, both ways. A new status widget whose default config declares a
    // fill setting fails here until it is named above and given the same
    // default — which is the drift this file exists to stop.
    assert.deepEqual(
      typesWithAFillSetting(),
      Object.keys(FILL_KEY).sort(),
      "a widget declares a fill-when-active setting but is not held to the family default",
    );
  });

  test("all four default to filled", () => {
    for (const [type, key] of Object.entries(FILL_KEY)) {
      const cfg = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS].config() as Record<string, unknown>;
      assert.equal(
        cfg[key],
        true,
        `${type} defaults ${key} to ${String(cfg[key])} — it will not match its neighbours on a wall`,
      );
    }
  });

  test("and they all state it, rather than leaning on the renderer's fallback", () => {
    // Stating it is what makes the inspector's switch show the truth the moment
    // the object is dropped, instead of an unchecked box beside a filled widget.
    for (const [type, key] of Object.entries(FILL_KEY)) {
      const cfg = LAYOUT_OBJECTS[type as keyof typeof LAYOUT_OBJECTS].config() as Record<string, unknown>;
      assert.ok(key in cfg, `${type} leaves ${key} unset in its default config`);
    }
  });
});

// ── And they must not resize themselves when they go loud ────────────────────
//
// The other half of "the same way". A status widget's sub-line — a recorder's
// timecode, a stream's elapsed clock — appears only while the thing is
// happening, and the value's size is a share of whatever the other lines leave.
// So the word grew a third line at the exact moment it started mattering, and
// LIVE shrank and lifted while RECORDING beside it held its size, because a
// recorder's timecode line is off by default and a stream's clock is on.
// Reported as the streaming widget "losing its styling" when it went live.
//
// `uniform` sizes the value as though all three lines were always there, so the
// tile is the same before and after. This reads the source because the decision
// is a PROP PASSED at two call sites inside a component that jsdom cannot lay
// out — every readout is 0px tall there, so a render proves nothing about size.
// It matches on the prop being passed, which a comment cannot satisfy, and
// asserts an exact count both ways.

const RENDERER_SRC = readFileSync(new URL("./layout-renderer.tsx", import.meta.url), "utf8");

/** The builders that compose a status widget: caption, state word, sub-line. */
const STATUS_BUILDERS = ["statusReadout", "streamingReadout"];

/**
 * The body of a `const <name> = (` arrow, to whichever closer comes FIRST.
 *
 * Both shapes exist here and the difference is not cosmetic: `statusReadout`
 * returns JSX directly and closes on `\n  );`, while `streamingReadout` has a
 * block body and closes on `\n  };`. Bounding on `);` alone ran 40,000
 * characters past the end of the block-bodied one, swallowing most of the file
 * — so the scan found `uniform` somewhere else and passed with the prop
 * deleted. Caught by proving BOTH halves red rather than one.
 *
 * The length assertion is the backstop: a builder body is tens of lines, so
 * anything approaching the file's size means the bound slipped again.
 */
function builderBody(name: string): string {
  const start = RENDERER_SRC.indexOf(`const ${name} = (`);
  assert.notEqual(start, -1, `${name} is gone from the renderer — this scan cannot run`);
  const ends = ["\n  );", "\n  };"]
    .map((close) => RENDERER_SRC.indexOf(close, start))
    .filter((i) => i !== -1);
  assert.ok(ends.length, `could not find the end of ${name}`);
  const end = Math.min(...ends);
  const body = RENDERER_SRC.slice(start, end);
  assert.ok(
    body.length < 4000,
    `the scan captured ${body.length} characters for ${name} — the bound slipped and this test is reading the wrong code`,
  );
  return body;
}

describe("status widgets keep their size when they go live", () => {
  test("every status builder passes uniform", () => {
    for (const name of STATUS_BUILDERS) {
      const body = builderBody(name);
      // The prop or the object key, either spelling — but PASSED, not mentioned.
      assert.match(
        body,
        /(^|[\s{])uniform(\s*[:=]|\s*[,}\n])/m,
        `${name} does not pass uniform — its value will shrink when its sub-line appears`,
      );
    }
  });

  test("no status builder was added without being held to the rule", () => {
    // Exact, both ways. A fourth status composition added later fails here
    // until it is named above — the same argument the fill list makes, and the
    // same drift: the first version of this family missed record-status.
    const found = [...RENDERER_SRC.matchAll(/const (\w*[Rr]eadout) = \(/g)]
      .map((m) => m[1])
      .filter((n) => n !== "readout");
    assert.deepEqual(
      found.sort(),
      [...STATUS_BUILDERS].sort(),
      "a readout builder exists that this rule does not cover",
    );
  });
});
