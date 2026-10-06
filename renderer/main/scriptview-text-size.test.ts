// The ServiceCue text size's arithmetic: the steps, the typed-value rules and the
// per-screen storage. Pure functions, no DOM. The control and the screens that
// use them are driven in scriptview-text-size-control.test.tsx and
// script-view-text-size.test.tsx.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  clampTextSize,
  displayTextSizeKey,
  PAGE_TEXT_SIZE_KEY,
  parseTextSize,
  readStoredSize,
  stepTextSize,
  textSizeFromSearch,
  writeStoredSize,
} from "./scriptview-text-size.js";

describe("stepping", () => {
  test("A+ and A- move by ten from a multiple of ten", () => {
    assert.equal(stepTextSize(100, 1), 110);
    assert.equal(stepTextSize(100, -1), 90);
    assert.equal(stepTextSize(50, 1), 60);
    assert.equal(stepTextSize(300, -1), 290);
  });

  test("from an off-grid value they land on the next multiple of ten, not ten away", () => {
    assert.equal(stepTextSize(137, 1), 140);
    assert.equal(stepTextSize(137, -1), 130);
    assert.equal(stepTextSize(101, 1), 110);
    assert.equal(stepTextSize(101, -1), 100);
    assert.equal(stepTextSize(99, 1), 100);
    assert.equal(stepTextSize(99, -1), 90);
  });

  test("they stop at 50 and 300", () => {
    assert.equal(stepTextSize(50, -1), 50);
    assert.equal(stepTextSize(52, -1), 50);
    assert.equal(stepTextSize(300, 1), 300);
    assert.equal(stepTextSize(297, 1), 300);
  });
});

describe("a typed value", () => {
  test("is rounded to a whole percent", () => {
    assert.equal(parseTextSize("137.4"), 137);
    assert.equal(parseTextSize("137.5"), 138);
    assert.equal(parseTextSize("100."), 100);
    assert.equal(parseTextSize(".5e"), null);
  });

  test("is held between 50 and 300", () => {
    assert.equal(parseTextSize("10"), 50);
    assert.equal(parseTextSize("-20"), 50);
    assert.equal(parseTextSize("0"), 50);
    assert.equal(parseTextSize("999"), 300);
    assert.equal(clampTextSize(Infinity), 300);
  });

  test("takes a percent sign and spaces", () => {
    assert.equal(parseTextSize("150%"), 150);
    assert.equal(parseTextSize("  150 % "), 150);
  });

  test("anything that is not a number reverts (null)", () => {
    for (const bad of ["", "   ", "abc", "150abc", "1,5", "1e3", "0x10", "%", "NaN", "Infinity", "15 0"]) {
      assert.equal(parseTextSize(bad), null, `"${bad}" should not be a size`);
    }
    assert.equal(parseTextSize(null), null);
    assert.equal(parseTextSize(undefined), null);
  });
});

describe("the ?text= param", () => {
  test("reads a size, and nothing for a missing or unusable one", () => {
    assert.equal(textSizeFromSearch("?text=150"), 150);
    assert.equal(textSizeFromSearch("?kiosk=1&text=75"), 75);
    assert.equal(textSizeFromSearch("?text=9000"), 300);
    assert.equal(textSizeFromSearch("?text=big"), null);
    assert.equal(textSizeFromSearch("?plan=1"), null);
    assert.equal(textSizeFromSearch(""), null);
  });
});

describe("remembering a size", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  test("the page and each display keep their own, so they do not fight", () => {
    assert.notEqual(PAGE_TEXT_SIZE_KEY, displayTextSizeKey("display-1"));
    assert.notEqual(displayTextSizeKey("display-1"), displayTextSizeKey("display-2"));
  });

  test("a written size reads back", () => {
    const s = memory();
    assert.equal(writeStoredSize("k", 150, s), true);
    assert.equal(readStoredSize("k", s), 150);
    assert.equal(readStoredSize("other", s), null);
  });

  test("a hand-edited value cannot put the rundown out of range", () => {
    const s = memory();
    s.m.set("k", "9000");
    assert.equal(readStoredSize("k", s), 300);
    s.m.set("k", "junk");
    assert.equal(readStoredSize("k", s), null);
  });

  test("storage that throws reads as nothing remembered, and a write says it did not stick", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readStoredSize("k", broken), null);
    assert.equal(writeStoredSize("k", 150, broken), false);
  });
});
