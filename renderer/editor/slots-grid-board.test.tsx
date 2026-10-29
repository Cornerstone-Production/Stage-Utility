// The Mic slots widget's inspector controls: pick a board, make one, jump to the
// page that edits it. What matters is what a pick WRITES into the widget's config:
// a board id, and none of the fields from before boards, which a layout saved with
// them would keep alive beside the pointer.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see mic-slots-page.test).

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, isPlumbing } from "../test-dom.js";

const teardown = installRenderDom();

let boards: SlotBoardDTO[] = [];
let requests: { url: string; method: string; body: string | null }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (isPlumbing(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  const method = init?.method ?? "GET";
  requests.push({ url, method, body: typeof init?.body === "string" ? init.body : null });
  let out: unknown = {};
  if (url.endsWith("/api/boards") && method === "GET") out = boards;
  else if (url.endsWith("/api/boards") && method === "POST") {
    boards = [...boards, { id: "b-new", name: "Pastors", columnWidthIn: null, createdAt: "", shownOn: [] }];
    out = { id: "b-new", boards };
  }
  return { ok: true, status: 200, statusText: "OK", json: async () => out, text: async () => JSON.stringify(out) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RouterProvider, createMemoryHistory, createRootRoute, createRouter } = await import("@tanstack/react-router");
const { SlotsGridBoard } = await import("./slots-grid-board.js");
const { __resetReplayCacheForTests } = await import("../lib/api.js");

type Config = Extract<LayoutObjectConfig, { type: "slots-grid" }>;

const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

let configs: LayoutObjectConfig[] = [];
async function mount(config: Config) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute({
    component: () => React.createElement(SlotsGridBoard, { objectId: "g-1", config, onConfig: (c: LayoutObjectConfig) => configs.push(c) }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router })));
  await settle();
}

beforeEach(() => {
  cleanup();
  __resetReplayCacheForTests();
  boards = [
    { id: "b-left", name: "Left wall", columnWidthIn: null, createdAt: "", shownOn: [] },
    { id: "b-right", name: "Right wall", columnWidthIn: null, createdAt: "", shownOn: [] },
  ];
  requests = [];
  configs = [];
});
afterEach(async () => {
  cleanup();
  await settle();
});
after(async () => {
  await settle();
  teardown();
});

const board = () => screen.getByLabelText("Board") as HTMLSelectElement;
const pick = async (v: string) => {
  await act(async () => {
    fireEvent.change(board(), { target: { value: v } });
  });
  await settle();
};

describe("the Board picker", () => {
  test("lists every board, and the one the widget shows is selected", async () => {
    await mount({ type: "slots-grid", boardId: "b-right" });
    assert.equal(board().value, "b-right");
    const labels = [...board().querySelectorAll("option")].map((o) => o.textContent);
    assert.deepEqual(labels, ["None", "Left wall", "Right wall", "New board…"]);
  });

  test("picking one writes its id and drops every field from before boards", async () => {
    await mount({
      type: "slots-grid",
      source: "view",
      sourceViewId: "v-old",
      slotsLayout: { displayWidthIn: 30, columnWidthIn: 3.49 },
    } as Config);
    await pick("b-left");
    assert.deepEqual(configs.at(-1), { type: "slots-grid", boardId: "b-left", displayWidthIn: 30 }, "the display width is kept; source, sourceViewId and slotsLayout are not");
  });

  test("New board… asks for a name, creates the board and points the widget at it", async () => {
    await mount({ type: "slots-grid", boardId: "b-left" });
    await pick("__new__");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("New board name"), { target: { value: "Pastors" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    await settle();
    const made = requests.find((r) => r.method === "POST" && r.url.endsWith("/api/boards"));
    assert.deepEqual(JSON.parse(made!.body!), { name: "Pastors" });
    assert.deepEqual(configs.at(-1), { type: "slots-grid", boardId: "b-new" });
  });

  test("links to the Mic slots page on the board it shows", async () => {
    await mount({ type: "slots-grid", boardId: "b-right" });
    const link = screen.getByRole("link", { name: "Edit in Mic slots" });
    assert.equal(link.getAttribute("href"), "/mic-slots?board=b-right");
  });

  test("a widget showing nothing has no link to follow", async () => {
    await mount({ type: "slots-grid", boardId: null });
    assert.equal(screen.queryByRole("link", { name: "Edit in Mic slots" }) !== null, false);
  });
});
