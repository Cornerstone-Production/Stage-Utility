// servicecue-layout-saves.test.tsx — the layouts editor's saves against a server that
// takes its time and applies the real rules.
//
// Every control on the presets page saves the whole list per click, and on a Pi over
// Wi-Fi an answer can take long enough for the next click to land first. The server
// here runs the store's own save rules (prepareLayoutsSave: the name rule, and which
// slug a layout keeps) over what it holds, and answers when the test says so, so the
// page and the server can be compared after every interleaving that matters.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see servicecue-section-reads.test.tsx).

import { strict as assert } from "node:assert";
import { after, afterEach, test } from "node:test";

import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";
import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, reply, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import { LayoutNameRefused, prepareLayoutsSave } from "../../../main/services/servicecue-slug.js";
import type { ServiceCueLayout } from "../../../main/types/pco.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

const { render, renderHook, screen, cleanup, fireEvent, within, act } = await import("@testing-library/react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const React = await import("react");
const { ServiceCueSection } = await import("./servicecue-section.js");
const { useLayoutSaves } = await import("./use-layout-saves.js");
const { TooltipProvider, ConfirmHost } = await import("../../components/ui/index.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  resetStageState();
  resetReplayCache();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A layouts server. Each save is held until `release()` (or for `delayMs`), then judged
 * against what the server holds at that moment, as the real one does.
 */
function fakeServer(initial: ServiceCueLayout[], opts: { delayMs?: number } = {}) {
  let stored = prepareLayoutsSave(initial, []);
  const posts: ServiceCueLayout[][] = [];
  const held: (() => void)[] = [];
  const f = stubFetchWithLog(async (url, init) => {
    if (init?.method === "POST" && url.includes("/api/servicecue/layouts")) {
      const body = JSON.parse(String(init.body)) as { layouts: ServiceCueLayout[] };
      posts.push(body.layouts);
      if (opts.delayMs !== undefined) await sleep(opts.delayMs);
      else await new Promise<void>((r) => held.push(r));
      try {
        stored = prepareLayoutsSave(body.layouts, stored);
      } catch (err) {
        if (err instanceof LayoutNameRefused) return reply(400, { error: err.message });
        throw err;
      }
      return ok(stored);
    }
    if (url.includes("/api/state")) return ok({ pcoConfigured: false, views: [] });
    if (url.includes("/api/servicecue/layouts")) return ok(stored);
    if (url.includes("/api/servicecue/config")) return ok({ serviceTypeIds: [] });
    if (url.includes("/api/servicecue/roles")) return ok([]);
    return ok({});
  });
  return {
    posts,
    stored: () => stored,
    /** Let the oldest held save answer. */
    release: async () => {
      await eventually(() => assert.ok(held.length > 0, "no save is waiting"));
      await act(async () => held.shift()!());
      for (let i = 0; i < 4; i++) await settle();
    },
    restore: f.restore,
  };
}

async function mount(): Promise<void> {
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
      React.createElement(TooltipProvider, null, React.createElement(ServiceCueSection), React.createElement(ConfirmHost)),
    ),
  );
  for (let i = 0; i < 4; i++) await settle();
}

/** The layout names in the order the page draws them. */
const pageNames = () =>
  [...document.querySelectorAll('input[aria-label="Layout name"]')].map((n) => (n as HTMLInputElement).value);
const serverNames = (s: ServiceCueLayout[]) => [...s].sort((a, b) => a.order - b.order).map((l) => l.name);
const nameBox = (name: string) => screen.getByDisplayValue(name) as HTMLInputElement;

const AUDIO_VIDEO: ServiceCueLayout[] = [
  { id: "svl1", name: "Audio", order: 0, columnRoles: [] },
  { id: "svl2", name: "Video", order: 1, columnRoles: [] },
];

test("a refused rename, then a reorder clicked before the refusal arrives: the reorder is kept", async () => {
  const server = fakeServer(AUDIO_VIDEO, { delayMs: 60 });
  try {
    await mount();
    const box = nameBox("Audio");
    fireEvent.change(box, { target: { value: "video" } });
    fireEvent.blur(box);
    await settle();
    // The operator's next click lands while the rename is still on the wire.
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]);
    await eventually(() => assert.equal(server.posts.length, 2), 2000);
    await eventually(() => assert.deepEqual(serverNames(server.stored()), ["Video", "Audio"], "the reorder was lost"), 2000);
    await eventually(() => assert.deepEqual(pageNames(), serverNames(server.stored()), "the page holds a list the server does not"), 2000);
    // The second save carried the old name, not the refused one.
    assert.deepEqual(server.posts[1].map((l) => l.name).sort(), ["Audio", "Video"]);
    // Said at the field it was typed into: inside that layout's card, not at the top.
    const alert = screen.getByRole("alert");
    assert.match(alert.textContent ?? "", /already a layout called "Video"/);
    const atTheField = nameBox("Audio").closest(".rounded-xl")?.contains(alert) ?? false;
    assert.equal(atTheField, true, "the refusal is not beside the name it refused");
  } finally {
    server.restore();
  }
});

test("two quick clicks: the first answer does not undo the second on screen, or on the server", async () => {
  const server = fakeServer(AUDIO_VIDEO);
  try {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Expand" })[0]);
    await settle();
    const rowColor = screen.getByDisplayValue("From PCO") as HTMLSelectElement;
    fireEvent.change(rowColor, { target: { value: "none" } }); // click 1
    await settle();
    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]); // click 2
    await settle();
    assert.deepEqual(pageNames(), ["Video", "Audio"]);

    await server.release(); // the answer to click 1 only
    assert.deepEqual(pageNames(), ["Video", "Audio"], "the first answer put the page back before the second click");

    await server.release();
    await eventually(() => assert.equal(server.posts.length, 2));
    const audio = server.stored().find((l) => l.id === "svl1");
    assert.deepEqual(serverNames(server.stored()), ["Video", "Audio"]);
    assert.equal(audio?.rowColor, "none", "the second save sent a list without the first click");
    assert.deepEqual(pageNames(), ["Video", "Audio"]);
  } finally {
    server.restore();
  }
});

test("Add layout after a delete picks a name no layout has", async () => {
  const server = fakeServer([
    { id: "a", name: "Layout 1", order: 0, columnRoles: [] },
    { id: "b", name: "Layout 2", order: 1, columnRoles: [] },
    { id: "c", name: "Layout 3", order: 2, columnRoles: [] },
  ], { delayMs: 0 });
  try {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]);
    const dialog = await eventually(() => screen.getByRole("alertdialog"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await eventually(() => assert.deepEqual(serverNames(server.stored()), ["Layout 1", "Layout 3"]));
    fireEvent.click(screen.getByRole("button", { name: /Add layout/ }));
    await eventually(() => assert.equal(server.stored().length, 3, "the new layout was refused"));
    assert.deepEqual(serverNames(server.stored()), ["Layout 1", "Layout 3", "Layout 4"]);
    assert.deepEqual(pageNames(), ["Layout 1", "Layout 3", "Layout 4"]);
  } finally {
    server.restore();
  }
});

test("Add layout, then rename it: the address moves to the new name once, and then stays", async () => {
  const server = fakeServer(AUDIO_VIDEO, { delayMs: 0 });
  try {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /Add layout/ }));
    await eventually(() => assert.equal(server.stored().length, 3));
    const slugOf = (name: string) => server.stored().find((l) => l.name === name)?.slug;
    assert.equal(slugOf("Layout 3"), "layout-3");

    const box = nameBox("Layout 3");
    fireEvent.change(box, { target: { value: "Monitors" } });
    fireEvent.blur(box);
    await eventually(() => assert.equal(slugOf("Monitors"), "monitors", "the first rename of a new layout kept its Layout 3 address"));

    const again = nameBox("Monitors");
    fireEvent.change(again, { target: { value: "Wedges" } });
    fireEvent.blur(again);
    await eventually(() => assert.equal(slugOf("Wedges"), "monitors", "a second rename moved the address"));
  } finally {
    server.restore();
  }
});

test("an edit that throws is refused, and the edit queued behind it still saves", async () => {
  const server = fakeServer(AUDIO_VIDEO, { delayMs: 0 });
  try {
    const { result } = renderHook(() => useLayoutSaves());
    await act(async () => result.current.adopt(server.stored()));
    let broken: Promise<unknown> = Promise.resolve();
    let renamed: Promise<unknown> = Promise.resolve();
    await act(async () => {
      broken = result.current.edit(() => { throw new Error("a bug in an edit"); });
      renamed = result.current.edit((list) => list.map((l) => (l.id === "svl2" ? { ...l, name: "Lights" } : l)));
    });
    const outcomes = await Promise.race([
      Promise.all([broken, renamed]),
      sleep(2000).then(() => "stuck"),
    ]);
    assert.deepEqual(outcomes, [{ ok: false, error: "a bug in an edit" }, { ok: true }], "the queue stopped at the edit that threw");
    assert.deepEqual(serverNames(server.stored()), ["Audio", "Lights"]);
    assert.deepEqual(result.current.layouts.map((l) => l.name), ["Audio", "Lights"]);
  } finally {
    server.restore();
  }
});
