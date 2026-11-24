// The plot editor's clipboard: what a copy keeps, where each paste lands, and what
// is read back from browser storage. Storage is anything another tab, an older build
// or a person put there, so a value that is not an item the server would save is
// ignored, and the check that decides is held to the server's own (checkItems) over
// one table of items, both ways.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

import { SYMBOL_KINDS, TEXT_KINDS, type PlotItem } from "@main/types/stageplots";
import { validateItems } from "@main/services/stageplots-store";

import { CLIPBOARD_KEY, canPaste, clearClipboard, copyItems, takePaste } from "./clipboard";
import { DUPLICATE_OFFSET, editorReducer, initialEditorState, type AddKind } from "./editor-state";

/** The page's localStorage, in memory; `throwing` makes every touch of it refuse, as a private window does. */
function installStorage(throwing = false): Map<string, string> {
  const data = new Map<string, string>();
  const refuse = (): never => {
    throw new Error("SecurityError: storage is blocked");
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = throwing
    ? { getItem: refuse, setItem: refuse, removeItem: refuse }
    : { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
  return data;
}

function item(over: Partial<PlotItem> = {}): PlotItem {
  return { id: "i-1", type: "box", x: 100, y: 120, w: 80, h: 60, rotation: 0, label: "Drums", color: null, notes: "", inputs: [], ...over };
}

let stored: Map<string, string>;
beforeEach(() => {
  stored = installStorage();
  clearClipboard();
});
afterEach(() => {
  clearClipboard();
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});

describe("copy and paste", () => {
  test("nothing is copied to begin with", () => {
    assert.equal(canPaste(), false);
    assert.equal(takePaste(), null);
  });

  test("a copy pastes with new ids, and each paste of it lands a step further on", () => {
    copyItems([item(), item({ id: "i-2", label: "Bass" })]);
    assert.equal(canPaste(), true);
    const first = takePaste()!;
    assert.deepEqual(first.items.map((i) => i.label), ["Drums", "Bass"]);
    assert.ok(first.items.every((i, n) => i.id !== ["i-1", "i-2"][n] && /^[A-Za-z0-9_-]{1,80}$/.test(i.id)), "the pasted items have new ids");
    assert.equal(new Set(first.items.map((i) => i.id)).size, 2);
    assert.equal(first.offset, DUPLICATE_OFFSET);
    assert.equal(takePaste()!.offset, 2 * DUPLICATE_OFFSET);
    assert.equal(takePaste()!.offset, 3 * DUPLICATE_OFFSET);
  });

  test("a cut's first paste lands where the item was, and the next a step on", () => {
    copyItems([item()], { cut: true });
    assert.equal(takePaste()!.offset, 0);
    assert.equal(takePaste()!.offset, DUPLICATE_OFFSET);
  });

  test("a copy is a snapshot: changing the item afterwards does not change what pastes", () => {
    const it = item();
    copyItems([it]);
    it.label = "Changed";
    assert.equal(takePaste()!.items[0].label, "Drums");
  });

  test("a new copy starts the count again", () => {
    copyItems([item()]);
    takePaste();
    takePaste();
    copyItems([item({ id: "i-9" })]);
    assert.equal(takePaste()!.offset, DUPLICATE_OFFSET);
  });

  test("the copy is kept in browser storage, so another tab of the browser can paste it", () => {
    copyItems([item()]);
    assert.ok(stored.get(CLIPBOARD_KEY), "nothing was stored");
    assert.equal(JSON.parse(stored.get(CLIPBOARD_KEY)!).items[0].label, "Drums");
  });
});

describe("when storage refuses", () => {
  test("a copy is kept for this page, and pastes", () => {
    installStorage(true);
    clearClipboard();
    copyItems([item()]);
    assert.equal(canPaste(), true);
    assert.equal(takePaste()!.offset, DUPLICATE_OFFSET);
    assert.equal(takePaste()!.offset, 2 * DUPLICATE_OFFSET);
  });
});

describe("a stored value that is not a clipboard", () => {
  test("is ignored: nothing to paste", () => {
    for (const raw of [
      "{not json",
      "null",
      "42",
      JSON.stringify({ items: "no", pastes: 0 }),
      JSON.stringify({ items: [], pastes: 0 }),
      JSON.stringify({ items: [item()], pastes: "0" }),
      JSON.stringify({ items: [item()], pastes: 1.5 }),
      JSON.stringify({ items: [{ ...item(), type: "pyramid" }], pastes: 0 }),
      JSON.stringify({ items: [{ ...item(), w: "wide" }], pastes: 0 }),
      JSON.stringify({ items: [item(), "an item"], pastes: 0 }),
    ]) {
      stored.set(CLIPBOARD_KEY, raw);
      assert.equal(canPaste(), false, raw);
      assert.equal(takePaste(), null, raw);
    }
  });

  test("leaves this page's own copy to paste", () => {
    copyItems([item()]);
    stored.set(CLIPBOARD_KEY, "{not json");
    assert.equal(takePaste()!.items[0].label, "Drums");
  });
});

// One table, two verdicts. `ok: true` is an item the server saves; every other row is one it
// refuses, by the field named. The clipboard must agree with the server on each, or a paste
// puts something in the draft that Save will be refused for.
const SERVER_HEIGHT = 2000;
const cable: Partial<PlotItem> = { type: "cable", points: [[10, 10], [200, 10]], dashed: true, x: 0, y: 0, w: 0, h: 0 };
const TABLE: { name: string; ok: boolean; it: unknown }[] = [
  { name: "a box", ok: true, it: item() },
  { name: "a symbol", ok: true, it: item({ type: "symbol", symbol: "drumkit" }) },
  { name: "a text label", ok: true, it: item({ type: "text", textKind: "label", label: "Note" }) },
  { name: "a coloured box with inputs and notes", ok: true, it: item({ color: "#e5484d", notes: "Stage left", inputs: ["Kick", "Snare"] }) },
  { name: "a linked connection point", ok: true, it: item({ type: "conn", patchLink: { sheetId: "s1", deviceId: "d1", lastName: "SB-1", lastColor: null } }) },
  { name: "a cable", ok: true, it: { ...item(), ...cable } },
  { name: "an unknown type", ok: false, it: item({ type: "pyramid" as PlotItem["type"] }) },
  { name: "a symbol with no symbol", ok: false, it: item({ type: "symbol" }) },
  { name: "a symbol that is not one", ok: false, it: item({ type: "symbol", symbol: "tuba" as never }) },
  { name: "text with no kind", ok: false, it: item({ type: "text" }) },
  { name: "a width that is not a number", ok: false, it: { ...item(), w: "80" } },
  { name: "a width below the least", ok: false, it: item({ w: 1 }) },
  { name: "a height above the most", ok: false, it: item({ h: 5000 }) },
  { name: "a non-finite x", ok: false, it: { ...item(), x: null } },
  { name: "a rotation of -180", ok: false, it: item({ rotation: -180 }) },
  { name: "a rotation past 180", ok: false, it: item({ rotation: 270 }) },
  { name: "a colour that is not a swatch", ok: false, it: item({ color: "#123456" }) },
  { name: "a label that is not text", ok: false, it: { ...item(), label: 7 } },
  { name: "a label too long", ok: false, it: item({ label: "x".repeat(61) }) },
  { name: "notes too long", ok: false, it: item({ notes: "x".repeat(501) }) },
  { name: "inputs that are not a list", ok: false, it: { ...item(), inputs: "Kick" } },
  { name: "an input that is not text", ok: false, it: { ...item(), inputs: [1] } },
  { name: "an input too long", ok: false, it: item({ inputs: ["x".repeat(41)] }) },
  { name: "a patch link on a box", ok: false, it: item({ patchLink: { sheetId: "s1", deviceId: "d1", lastName: "SB-1", lastColor: null } }) },
  { name: "a patch link with no device", ok: false, it: item({ type: "conn", patchLink: { sheetId: "s1", lastName: "SB-1", lastColor: null } as never }) },
  { name: "a cable with one point", ok: false, it: { ...item(), ...cable, points: [[10, 10]] } },
  { name: "a cable point that is not a pair", ok: false, it: { ...item(), ...cable, points: [[10, 10], [200]] } },
  { name: "a cable point that is not numbers", ok: false, it: { ...item(), ...cable, points: [[10, 10], ["a", "b"]] } },
  { name: "a cable with no dashed flag", ok: false, it: { ...item(), ...cable, dashed: undefined } },
  { name: "not an object", ok: false, it: "an item" },
];

describe("the clipboard's check agrees with the server's", () => {
  for (const { name, ok, it } of TABLE) {
    test(name, () => {
      assert.equal(validateItems([it], SERVER_HEIGHT) === null, ok, `the server's verdict on the table's own claim: ${validateItems([it], SERVER_HEIGHT)}`);
      stored.set(CLIPBOARD_KEY, JSON.stringify({ items: [it], pastes: 0 }));
      assert.equal(canPaste(), ok, ok ? "a valid item was refused by the clipboard" : "an item the server refuses was accepted by the clipboard");
    });
  }
});

describe("what the editor copies", () => {
  test("every kind the palette adds, copied in one tab and read back in another, pastes whole and is what the server saves", () => {
    // Made by the editor's own add, as the palette makes them: not a table written to match the check.
    const kinds: AddKind[] = ["box", "circle", "zone", "cable", "conn", ...TEXT_KINDS, ...SYMBOL_KINDS.map((k) => `sym:${k}` as const)];
    const H = 562.5;
    let state = initialEditorState([], H);
    kinds.forEach((kind, i) => (state = editorReducer(state, { type: "add", kind, at: { x: 100 + i * 20, y: 150 }, id: `i-${i}` })));
    assert.equal(state.items.length, kinds.length);
    assert.equal(validateItems(state.items, H), null, "the editor made an item the server refuses");
    copyItems(state.items);
    // Another tab: nothing in memory, only what storage holds.
    const raw = stored.get(CLIPBOARD_KEY)!;
    clearClipboard();
    stored.set(CLIPBOARD_KEY, raw);
    const pasted = takePaste();
    assert.ok(pasted, "the copy was refused when read back");
    assert.deepEqual(new Set(pasted.items.map((it) => it.type)), new Set(["box", "circle", "zone", "cable", "conn", "text", "symbol"]));
    assert.equal(pasted.items.length, kinds.length);
    assert.equal(validateItems(pasted.items, H), null);
  });
});
