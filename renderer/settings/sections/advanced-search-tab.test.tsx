// advanced-search-tab.test.tsx — the Advanced page's tabs, its Search tab and
// Cmd-F, driven through the real component.
//
// Not covered here, by design: how the tab strip and cards are laid out (jsdom
// loads no stylesheet) and the two-column grid at `lg`. Those were checked in a
// browser. NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert
// inspects `actual` for its failure message, and a live jsdom element does not
// finish printing in useful time.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { ok, stubFetchWithLog } from "../../test-fixtures/fetch-log.js";
import type { SectionHandlers } from "../types.js";

const teardown = installRenderDom();

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { AdvancedSection } = await import("./advanced-section.js");
const { VIDEO_PORTS_FLASH_ID } = await import("./video-relay-ports.js");
const { flashTarget, pendingFlashTarget } = await import("../../app/flash.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  __resetReplayCacheForTests();
});

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

function stubFetch() {
  return stubFetchWithLog((url) => {
    if (url.includes("/api/backup/schedule")) {
      return ok({ enabled: false, intervalDays: 7, keep: 5, includeArchive: false, destination: "" });
    }
    if (url.includes("/api/config/snapshots")) return ok([]);
    if (url.includes("/api/history/milestones")) return ok([]);
    return ok({});
  });
}

type Tab = import("./advanced-settings.js").AdvancedPageTab;

// gcTime: 0, or the client's 5-minute garbage collection keeps a real timer alive
// and `node --test` waits for it long after the last assertion.
const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retry: false } } });

type Props = { tab?: string; onTabChange?: (t: Tab) => void };

function tree(props: Props) {
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AdvancedSection, {
        ...props,
        stageState: { timezone: null, hostTimezone: "UTC" } as unknown as StageState,
        updateStatus: null,
        handlers: {} as unknown as SectionHandlers,
      }),
    ),
  );
}

function mount(props: Props = {}) {
  const view = render(tree(props));
  return { ...view, rerenderWith: (next: Props) => view.rerender(tree(next)) };
}

const selectedTab = () => text(screen.getByRole("tab", { selected: true }));
const searchBox = () => screen.getByRole("searchbox", { name: "Search Advanced settings" }) as HTMLInputElement;
const drawn = (id: string) => document.querySelector(`[data-setting-id="${id}"]`) !== null;

function type(value: string) {
  fireEvent.change(searchBox(), { target: { value } });
}

function pressFind(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

describe("tabs", () => {
  test("opens on General, and an unknown tab segment falls back to it", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "no-such-tab", onTabChange: () => {} });
      await settle();
      assert.equal(selectedTab(), "General");
      assert.ok(drawn("timezone"));
      assert.ok(!drawn("public-address"));
    } finally {
      f.restore();
    }
  });

  test("the strip lists the tabs in order with Search last", async () => {
    const f = stubFetch();
    try {
      mount();
      await settle();
      assert.deepEqual(
        screen.getAllByRole("tab").map(text),
        ["General", "Updates", "Schedule", "Network", "Data", "Video relay", "Search"],
      );
    } finally {
      f.restore();
    }
  });

  test("picking a tab asks the route to change it, and shows what the route hands back", async () => {
    const f = stubFetch();
    try {
      const asked: string[] = [];
      const view = mount({ tab: "general", onTabChange: (t) => asked.push(t) });
      await settle();
      fireEvent.click(screen.getByRole("tab", { name: "Network" }));
      assert.deepEqual(asked, ["network"]);
      // Still General until the URL says otherwise.
      assert.equal(selectedTab(), "General");
      view.rerenderWith({ tab: "network", onTabChange: (t) => asked.push(t) });
      await settle();
      assert.equal(selectedTab(), "Network");
      assert.ok(drawn("public-address"));
    } finally {
      f.restore();
    }
  });

  test("the Server log button opens /log in a new tab", async () => {
    const f = stubFetch();
    const real = window.open;
    const calls: unknown[][] = [];
    window.open = ((...args: unknown[]) => {
      calls.push(args);
      return null;
    }) as typeof window.open;
    try {
      mount();
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Server log" }));
      assert.deepEqual(calls, [["/log", "_blank", "noreferrer"]]);
    } finally {
      window.open = real;
      f.restore();
    }
  });

  test("searching log offers the Server log, which opens it", async () => {
    const f = stubFetch();
    const real = window.open;
    const calls: unknown[][] = [];
    window.open = ((...args: unknown[]) => {
      calls.push(args);
      return null;
    }) as typeof window.open;
    try {
      mount({ tab: "search" });
      await settle();
      type("log");
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      assert.deepEqual(calls, [["/log", "_blank", "noreferrer"]]);
      assert.equal(screen.queryByText(/No setting matches/), null, "log read as no match");
    } finally {
      window.open = real;
      f.restore();
    }
  });

  test("a flash target on another tab opens that tab", async () => {
    const f = stubFetch();
    try {
      const asked: string[] = [];
      const view = mount({ tab: "general", onTabChange: (t) => asked.push(t) });
      await settle();
      act(() => flashTarget(VIDEO_PORTS_FLASH_ID));
      assert.deepEqual(asked, ["video"]);
      // The route hands the new tab back, the card appears, and the flash finds it.
      view.rerenderWith({ tab: "video", onTabChange: (t) => asked.push(t) });
      await eventually(() => assert.equal(pendingFlashTarget(), null));
      assert.ok(document.querySelector(`[data-flash-id="${VIDEO_PORTS_FLASH_ID}"]`) !== null);
    } finally {
      f.restore();
    }
  });
});

describe("Search", () => {
  test("an empty box says what to do", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      assert.match(text(screen.getByRole("tabpanel")), /Type to search every Advanced setting\./);
      assert.ok(!text(screen.getByRole("tabpanel")).includes("settings match"));
    } finally {
      f.restore();
    }
  });

  test("results are the real controls, in cards headed Tab > Card, with a count", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      type("restore backup");
      const panel = text(screen.getByRole("tabpanel"));
      assert.match(panel, /1 setting matches “restore backup”/);
      assert.ok(drawn("config-snapshot"));
      assert.ok(!drawn("timezone"));
      assert.equal(text(document.querySelector("h3") as Element), "Data › Backups");
      // The live button, not a copy of its label.
      assert.ok(screen.getByRole("button", { name: /Upload & restore/ }));
    } finally {
      f.restore();
    }
  });

  test("a card named like its tab is headed by the tab alone, and its tab name jumps there", async () => {
    const f = stubFetch();
    try {
      const asked: string[] = [];
      mount({ tab: "search", onTabChange: (t) => asked.push(t) });
      await settle();
      type("clock");
      const heading = document.querySelector("h3") as Element;
      assert.equal(text(heading), "General");
      fireEvent.click(screen.getByRole("button", { name: "General" }));
      assert.deepEqual(asked, ["general"]);
    } finally {
      f.restore();
    }
  });

  test("no match says so, quoting the query", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      type("zzzzzz");
      assert.match(text(screen.getByRole("tabpanel")), /No setting matches “zzzzzz”\./);
    } finally {
      f.restore();
    }
  });

  test("hidden keywords and typos in names find settings", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      type("tz");
      assert.ok(drawn("timezone"));
      type("timzone");
      assert.ok(!drawn("timezone"), "a typo reached a keyword");
      type("clok");
      assert.ok(drawn("clock-format"));
    } finally {
      f.restore();
    }
  });

  test("the query survives a trip to another tab and back", async () => {
    const f = stubFetch();
    try {
      mount();
      await settle();
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));
      type("snapshot");
      fireEvent.click(screen.getByRole("tab", { name: "Network" }));
      assert.ok(drawn("public-address"));
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));
      assert.equal(searchBox().value, "snapshot");
      assert.ok(drawn("config-snapshot"));
    } finally {
      f.restore();
    }
  });

  test("no result term is highlighted", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      type("snapshot");
      assert.equal(document.querySelectorAll("mark").length, 0);
    } finally {
      f.restore();
    }
  });
});

describe("Cmd-F", () => {
  test("opens Search from another tab, focuses the box and selects what is in it", async () => {
    const f = stubFetch();
    try {
      mount();
      await settle();
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));
      type("backup");
      fireEvent.click(screen.getByRole("tab", { name: "Video relay" }));
      assert.equal(selectedTab(), "Video relay");

      const e = pressFind({ metaKey: true });
      assert.equal(e.defaultPrevented, true);
      await eventually(() => assert.equal(selectedTab(), "Search"));
      await eventually(() => assert.ok(document.activeElement === searchBox(), "the search box is not focused"));
      assert.equal(searchBox().selectionStart, 0);
      assert.equal(searchBox().selectionEnd, "backup".length);
    } finally {
      f.restore();
    }
  });

  test("Ctrl-F does the same, and a bare F or Shift-Cmd-F does not", async () => {
    const f = stubFetch();
    try {
      mount();
      await settle();
      assert.equal(pressFind({}).defaultPrevented, false);
      assert.equal(pressFind({ metaKey: true, shiftKey: true }).defaultPrevented, false);
      assert.equal(selectedTab(), "General");
      assert.equal(pressFind({ ctrlKey: true }).defaultPrevented, true);
      await eventually(() => assert.equal(selectedTab(), "Search"));
    } finally {
      f.restore();
    }
  });

  test("is released when the page unmounts", async () => {
    const f = stubFetch();
    try {
      const view = mount();
      await settle();
      view.unmount();
      assert.equal(pressFind({ metaKey: true }).defaultPrevented, false);
    } finally {
      f.restore();
    }
  });
});
