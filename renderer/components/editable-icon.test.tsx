// A save that did not land has to say so.
//
// Four call sites over two surfaces stored a chosen glyph with a bare
// `void invoke("icons:setIcon", …)`. The picker closes on the click, so a
// rejected save changed nothing, said nothing, and left an unhandled rejection
// behind — the operator picks an icon, watches the menu shut, and the icon is
// the one it was. All four now go through saveIcon, which is what this drives.
//
// Rendered against the real Toaster rather than a spy: what is being guarded is
// that the operator SEES something, and a spy on the store would pass on a
// message that never reached the screen.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../test-dom.js";

const teardown = installDom();

let failWith: Error | null = null;
/** Every icon write, in order — the migration is an ordering claim about two. */
let writes: { url: string; body: unknown }[] = [];
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  writes.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (failWith) throw failWith;
  return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
};
class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 1;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, cleanup } = await import("@testing-library/react");
const React = (await import("react")).default;
const { Toaster } = await import("./ui/toast.js");
const { saveIcon } = await import("./editable-icon.js");

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  failWith = null;
  writes = [];
});
afterEach(async () => {
  cleanup();
  await settle();
});
after(async () => {
  await settle();
  teardown();
});

describe("storing a chosen glyph", () => {
  test("a refused save reaches the operator", async () => {
    const ui = render(React.createElement(Toaster));
    failWith = new Error("the icon store is read-only");

    saveIcon("display-invented-1", "Star");
    await settle(30);

    assert.match(
      document.body.textContent ?? "",
      /Could not change the icon/,
      "the save was refused and nothing said so — the menu just closed",
    );
    assert.match(
      document.body.textContent ?? "",
      /read-only/,
      "the operator is told a save failed but not what the server said",
    );
    ui.unmount();
  });

  test("a save that lands says nothing, so the surface is quiet in normal use", async () => {
    const ui = render(React.createElement(Toaster));

    saveIcon("display-invented-1", "Star");
    await settle(30);

    assert.equal(
      /Could not change the icon/.test(document.body.textContent ?? ""),
      false,
      "a successful save raised an error toast",
    );
    ui.unmount();
  });
});

describe("a key that moved", () => {
  // A Screens card showing a control surface was re-keyed from the output id to
  // the view id with no fallback and no migration. The operator's glyph stopped
  // being found and the entry they had set was left behind, read by nothing.
  // The read falls back (useEditableIcon); the WRITE is what moves it.
  const glyphWrites = () =>
    writes.filter((w) => w.url === "/api/icon-glyph").map((w) => w.body as { key: string; glyph: string });

  test("the save lands under the new key FIRST, then clears the old one", async () => {
    saveIcon("view-invented-9", "Star", "display-invented-1");
    await settle(30);

    // Exact, and in order. A floor would pass on a clear that never fired, and
    // the order is the whole safety property: clearing first and then failing to
    // write would delete the operator's choice.
    assert.deepEqual(
      glyphWrites(),
      [
        { key: "view-invented-9", glyph: "Star" },
        { key: "display-invented-1", glyph: "" },
      ],
      "the glyph was not migrated off the key it used to live under",
    );
  });

  test("but a save that fails leaves the old entry exactly where it is", async () => {
    const ui = render(React.createElement(Toaster));
    failWith = new Error("the icon store is read-only");

    saveIcon("view-invented-9", "Star", "display-invented-1");
    await settle(30);

    assert.deepEqual(
      glyphWrites(),
      [{ key: "view-invented-9", glyph: "Star" }],
      "a failed save still cleared the old entry — the operator's icon is gone from both keys",
    );
    ui.unmount();
  });

  test("and a legacy key equal to the current one is not cleared straight afterwards", async () => {
    // The non-console card, where the key never moved. Clearing here would erase
    // the entry the same call just wrote.
    saveIcon("display-invented-1", "Star", "display-invented-1");
    await settle(30);

    assert.deepEqual(glyphWrites(), [{ key: "display-invented-1", glyph: "Star" }]);
  });
});
