// A note's typing reaches the server: after a pause, and when the object goes away
// before the pause is over.
//
// The save waits SAVE_DEBOUNCE_MS so it is a sentence, not a keystroke. Switching
// view, or leaving the page in the app, unmounts the object; a timer that is only
// cleared then drops what was typed in the last moment, with no request and no
// toast. Driven through the real component with fetch stubbed, so what is asserted
// is the request that left.
//
// NOT covered here: closing or reloading the tab. React runs no cleanup then, so
// no unmount flush can catch it, and in Chrome a reload inside the pause does lose
// the text. Sending it on pagehide needs a keepalive request, which api.ts does
// not offer.

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { ok, stubFetchWithLog } from "../test-fixtures/fetch-log.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { NotesObject } = await import("./notes-objects.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => cleanup());

/** Longer than the save's debounce. */
const PAST_DEBOUNCE_MS = 750;
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function note(objectId = "note-1") {
  return React.createElement(NotesObject, { objectId, config: {}, editable: true, all: {}, ts: {} });
}

/** Every POST /api/notes body, in order. */
function captureSaves() {
  const saves: { objectId: string; content: { text?: string } }[] = [];
  const f = stubFetchWithLog((url, init) => {
    if (url.endsWith("/api/notes") && init?.method === "POST") saves.push(JSON.parse(String(init.body)));
    return ok({});
  });
  return { saves, restore: f.restore };
}

const type = (text: string) => fireEvent.change(screen.getByRole("textbox", { name: "Notes" }), { target: { value: text } });

test("typing saves once, the last text, after a pause", async () => {
  const net = captureSaves();
  try {
    render(note());
    type("Wal");
    type("Walk-in");
    assert.equal(net.saves.length, 0, "saved on a keystroke");
    await wait(PAST_DEBOUNCE_MS);
    assert.deepEqual(net.saves, [{ objectId: "note-1", content: { text: "Walk-in" } }]);
  } finally {
    net.restore();
  }
});

test("leaving before the pause is over still saves what was typed", async () => {
  const net = captureSaves();
  try {
    const view = render(note());
    type("Pastor mic on stand");
    view.unmount();
    await settle();
    assert.deepEqual(net.saves, [{ objectId: "note-1", content: { text: "Pastor mic on stand" } }], "the note typed just before leaving was not sent");
    await wait(PAST_DEBOUNCE_MS);
    assert.equal(net.saves.length, 1, "the timer sent it a second time");
  } finally {
    net.restore();
  }
});

test("the save goes to the object the text was typed into", async () => {
  const net = captureSaves();
  try {
    const view = render(note("note-a"));
    type("For A");
    view.rerender(note("note-b"));
    await wait(PAST_DEBOUNCE_MS);
    assert.deepEqual(net.saves, [{ objectId: "note-a", content: { text: "For A" } }]);
  } finally {
    net.restore();
  }
});
