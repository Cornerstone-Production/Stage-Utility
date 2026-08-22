// The operator's kept colours.
//
// Small rules, and each of them is a thing somebody does twice: saving a colour
// they already have, keeping more than the panel can show, and saving one on a
// machine that then restarts.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "saved-colors-"));

const { savedColorsStore, MAX_SAVED_COLORS } = await import("./saved-colors-store.js");

await savedColorsStore.init();

describe("keeping a colour", () => {
  test("newest first, because that is where the eye is", async () => {
    await savedColorsStore.add("#111111");
    const { colors } = await savedColorsStore.add("#222222");
    assert.deepEqual(colors.slice(0, 2), ["#222222", "#111111"]);
  });

  test("saving one already kept moves it to the front instead of doubling it", async () => {
    const { colors } = await savedColorsStore.add("#111111");
    assert.equal(colors[0], "#111111");
    assert.equal(colors.filter((c) => c === "#111111").length, 1, "the colour was kept twice");
  });

  test("a translucent colour is a colour", async () => {
    // The native control could never express one, so this is exactly the kind of
    // value somebody mixes once and wants back.
    const { colors } = await savedColorsStore.add("rgba(45,212,150,0.1)");
    assert.equal(colors[0], "rgba(45,212,150,0.1)");
  });

  test("forgetting removes only that one", async () => {
    await savedColorsStore.add("#333333");
    const colors = await savedColorsStore.remove("#333333");
    assert.ok(!colors.includes("#333333"));
    assert.ok(colors.includes("#111111"), "forgetting one took another with it");
  });
});

describe("the ceiling", () => {
  test("the oldest goes, and the store SAYS which", async () => {
    // "Do not delete an operator's data to tidy something up" — so the caller is
    // told, and can say so, rather than a colour quietly vanishing.
    for (let i = 0; i < MAX_SAVED_COLORS + 2; i++) {
      await savedColorsStore.add(`#0000${i.toString(16).padStart(2, "0")}`);
    }
    const before = savedColorsStore.all();
    assert.equal(before.length, MAX_SAVED_COLORS);
    const oldest = before[before.length - 1];

    const { colors, dropped } = await savedColorsStore.add("#abcdef");
    assert.equal(colors.length, MAX_SAVED_COLORS, "the list grew past its cap");
    assert.equal(colors[0], "#abcdef");
    assert.equal(dropped, oldest, "the dropped colour was not reported");
    assert.ok(!colors.includes(oldest));
  });

  test("under the cap nothing is dropped, and the store says so", async () => {
    const colors = await savedColorsStore.remove(savedColorsStore.all()[0]);
    assert.ok(colors.length < MAX_SAVED_COLORS);
    const { dropped } = await savedColorsStore.add("#feedfa");
    assert.equal(dropped, null);
  });
});

describe("across a restart", () => {
  test("what was saved is still there", async () => {
    // It is a config store — the operator's own work — so this is the whole
    // point of it not living in a browser.
    const before = savedColorsStore.all();
    const fresh = await import(`./saved-colors-store.js?reload=${Date.now()}`);
    await fresh.savedColorsStore.init();
    assert.deepEqual(fresh.savedColorsStore.all(), before);
  });
});
