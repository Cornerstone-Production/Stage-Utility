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

import { installDom, settle, unmountAndTeardown } from "../test-dom.js";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while 8 updates land outside act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const { render, cleanup, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { Toaster } = await import("./ui/toast.js");
const { saveIcon } = await import("./editable-icon.js");
const { until } = await import("../test-fixtures/integrations-harness.js");

beforeEach(() => {
  failWith = null;
  writes = [];
});
afterEach(async () => {
  cleanup();
  await settle();
});
after(() => unmountAndTeardown(cleanup, teardown));

describe("storing a chosen glyph", () => {
  test("a refused save reaches the operator", async () => {
    const ui = render(React.createElement(Toaster));
    failWith = new Error("the icon store is read-only");

    saveIcon("display-invented-1", "Star");
    // NOT until(): that polls document.body.textContent, and the toast's own
    // state update is what WOULD satisfy it — wrapped in one continuous act()
    // scope, that update is queued rather than flushed, so the poll waits on
    // exactly the paint act() is holding back and times out at 5000ms every
    // time. A fixed wait works here because the fake fetch above rejects
    // through a plain .then()/.catch() chain — microtasks only — so one
    // act()-wrapped macrotask turn is well past when the toast lands.
    await settle();

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
    // Proving an ABSENCE cannot poll for it directly — "not yet" and "never"
    // look the same. Waiting for the write instead is enough: nothing on the
    // success path can call toast.error(), so once the (fake) server has seen
    // the write, no later toast is coming.
    await act(async () => {
      await until(() => writes.length >= 1, () => "the icon save never reached the (fake) server");
    });

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
    await until(
      () => glyphWrites().length >= 2,
      () => `the migration did not write both keys — saw ${JSON.stringify(glyphWrites())}`,
    );

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
    // A negative claim (the clear must NEVER fire) again — waiting for the
    // first write is enough: it fails, so the .then() that would clear the
    // legacy key is skipped for good, not merely not-yet-run.
    await act(async () => {
      await until(() => writes.length >= 1, () => "the icon save never reached the (fake) server");
    });

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
    // Same shape: legacyKey === key means saveIcon's own check returns before a
    // second write is even attempted, so the first write settling is enough.
    await until(() => writes.length >= 1, () => "the icon save never reached the (fake) server");

    assert.deepEqual(glyphWrites(), [{ key: "display-invented-1", glyph: "Star" }]);
  });
});
