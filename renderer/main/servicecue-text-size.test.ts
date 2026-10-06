// The ServiceCue text size's arithmetic: the steps, the typed-value rules and the
// per-screen storage. Pure functions, no DOM. The control and the screens that
// use them are driven in servicecue-text-size-control.test.tsx and
// servicecue-view-text-size.test.tsx.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  adoptLegacyStoredSize,
  clampTextSize,
  displayTextSize,
  displayTextSizeKey,
  PAGE_TEXT_SIZE_KEY,
  parseTextSize,
  readStoredSize,
  stepTextSize,
  textSizeFromSearch,
  writeStoredSize,
} from "./servicecue-text-size.js";

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

describe("a size remembered before ServiceCue was renamed", () => {
  const memory = (seed: Record<string, string> = {}) => {
    const m = new Map(Object.entries(seed));
    return { storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }, m };
  };
  const OLD_PAGE = "scriptview-text-size:page";

  test("is read when the current key has nothing", () => {
    const { storage } = memory({ [OLD_PAGE]: "130" });
    assert.equal(readStoredSize(PAGE_TEXT_SIZE_KEY, storage), 130);
  });

  test("never wins over the current key", () => {
    const { storage } = memory({ [OLD_PAGE]: "130", [PAGE_TEXT_SIZE_KEY]: "90" });
    assert.equal(readStoredSize(PAGE_TEXT_SIZE_KEY, storage), 90);
  });

  test("applies to a display's key as well as the page's", () => {
    const { storage } = memory({ "scriptview-text-size:display:display-3": "70" });
    assert.equal(readStoredSize(displayTextSizeKey("display-3"), storage), 70);
  });

  test("reading writes nothing; adopting copies it once and leaves the old key", () => {
    const { storage, m } = memory({ [OLD_PAGE]: "130" });
    readStoredSize(PAGE_TEXT_SIZE_KEY, storage);
    assert.equal(m.has(PAGE_TEXT_SIZE_KEY), false, "a read wrote");
    assert.equal(adoptLegacyStoredSize(PAGE_TEXT_SIZE_KEY, storage), true);
    assert.equal(m.get(PAGE_TEXT_SIZE_KEY), "130");
    assert.equal(m.get(OLD_PAGE), "130", "the old key was removed");
    assert.equal(adoptLegacyStoredSize(PAGE_TEXT_SIZE_KEY, storage), false, "it copied twice");
  });

  test("adopting does not overwrite a current size, and does nothing with no old one", () => {
    const { storage, m } = memory({ [OLD_PAGE]: "130", [PAGE_TEXT_SIZE_KEY]: "90" });
    assert.equal(adoptLegacyStoredSize(PAGE_TEXT_SIZE_KEY, storage), false);
    assert.equal(m.get(PAGE_TEXT_SIZE_KEY), "90");
    assert.equal(adoptLegacyStoredSize(PAGE_TEXT_SIZE_KEY, memory().storage), false);
  });

  test("a hand-edited old value is clamped like any other", () => {
    const { storage } = memory({ [OLD_PAGE]: "9999" });
    assert.equal(readStoredSize(PAGE_TEXT_SIZE_KEY, storage), 300);
  });
});

describe("displayTextSize: what a display draws and what it asks the server to keep", () => {
  const base = { isPreview: false, fromAddress: null, server: null, remembered: null };

  test("the address wins over the server, and is kept when the server holds something else", () => {
    assert.deepEqual(displayTextSize({ ...base, fromAddress: 150, server: 80, remembered: 120 }), { show: 150, save: 150 });
    assert.deepEqual(displayTextSize({ ...base, fromAddress: 150 }), { show: 150, save: 150 });
  });

  test("the address the server already holds is not written again", () => {
    assert.deepEqual(displayTextSize({ ...base, fromAddress: 150, server: 150 }), { show: 150, save: null });
  });

  test("with no address, the server's size is drawn and nothing is written", () => {
    assert.deepEqual(displayTextSize({ ...base, server: 80, remembered: 120 }), { show: 80, save: null });
  });

  test("a device's remembered size is handed to a server that holds none, and only then", () => {
    assert.deepEqual(displayTextSize({ ...base, remembered: 120 }), { show: 120, save: 120 });
    assert.deepEqual(displayTextSize({ ...base, server: 100, remembered: 120 }), { show: 100, save: null }, "a server size of 100 is a size");
  });

  test("with nothing anywhere it is 100 and writes nothing", () => {
    assert.deepEqual(displayTextSize(base), { show: 100, save: null });
  });

  test("a size the server holds outside the range (a hand-edited file) is drawn clamped", () => {
    assert.deepEqual(displayTextSize({ ...base, server: 900 }), { show: 300, save: null });
  });

  test("a preview draws the server's size and never reads the address or the device, or writes", () => {
    assert.deepEqual(displayTextSize({ isPreview: true, fromAddress: 150, server: 200, remembered: 80 }), { show: 200, save: null });
    assert.deepEqual(displayTextSize({ isPreview: true, fromAddress: 150, server: null, remembered: 80 }), { show: 100, save: null });
  });
});
