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
