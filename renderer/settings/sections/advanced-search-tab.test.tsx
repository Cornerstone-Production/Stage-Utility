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
const { AdvancedSection, offersServerLog } = await import("./advanced-section.js");
const { __resetHostNamesForTests } = await import("../../app/host-names-query.js");
const { VIDEO_PORTS_FLASH_ID } = await import("./video-relay-ports.js");
const { flashTarget, pendingFlashTarget } = await import("../../app/flash.js");
const { TooltipProvider } = await import("../../components/ui/index.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(() => {
  cleanup();
  // The shared client below would hand one test's host names and update status to the next.
  queryClient.clear();
  __resetReplayCacheForTests();
});

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

/** `extra` answers a route first; returning undefined falls through to the defaults. */
function stubFetch(extra?: (url: string) => unknown) {
  return stubFetchWithLog((url) => {
    const mine = extra?.(url);
    if (mine !== undefined) return mine;
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

type Props = {
  tab?: string;
  onTabChange?: (t: Tab) => void;
  stageState?: Partial<StageState>;
  justUpdated?: { version: string } | null;
};

function tree(props: Props) {
  return React.createElement(
    QueryClientProvider,
    { client: queryClient },
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AdvancedSection, {
        ...props,
        stageState: { timezone: null, hostTimezone: "UTC", ...props.stageState } as unknown as StageState,
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

describe("the tab strip's keyboard", () => {
  const tabs = () => screen.getAllByRole("tab") as HTMLButtonElement[];
  const press = (el: Element, key: string) => fireEvent.keyDown(el, { key });

  test("only the selected tab is in the tab order", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "network", onTabChange: () => {} });
      await settle();
      assert.deepEqual(tabs().map((t) => [text(t), t.tabIndex]), [
        ["General", -1],
        ["Updates", -1],
        ["Schedule", -1],
        ["Network", 0],
        ["Data", -1],
        ["Video relay", -1],
        ["Search", -1],
      ]);
    } finally {
      f.restore();
    }
  });

  test("Left and Right, Home and End move focus and select, wrapping at the ends", async () => {
    const f = stubFetch();
    try {
      const asked: string[] = [];
      mount({ tab: "general", onTabChange: (t) => asked.push(t) });
      await settle();
      const at = (name: string) => tabs().find((t) => text(t) === name) as HTMLButtonElement;

      press(at("General"), "ArrowRight");
      assert.deepEqual(asked, ["updates"]);
      assert.ok(document.activeElement === at("Updates"), "focus did not follow the arrow");

      press(at("General"), "ArrowLeft");
      assert.equal(asked.at(-1), "search", "Left from the first tab did not wrap to Search");
      assert.ok(document.activeElement === at("Search"));

      press(at("General"), "End");
      assert.equal(asked.at(-1), "search");
      press(at("Search"), "ArrowRight");
      assert.equal(asked.at(-1), "general", "Right from Search did not wrap to General");
      press(at("Network"), "Home");
      assert.equal(asked.at(-1), "general");

      const before = asked.length;
      press(at("General"), "a");
      assert.equal(asked.length, before, "a letter moved a tab");
    } finally {
      f.restore();
    }
  });

  test("arrowing onto Search leaves focus on the strip, while clicking it focuses the box", async () => {
    const f = stubFetch();
    try {
      const view = mount({ tab: "video", onTabChange: () => {} });
      await settle();
      const search = tabs().find((t) => text(t) === "Search") as HTMLButtonElement;
      press(tabs().find((t) => text(t) === "Video relay") as Element, "ArrowRight");
      view.rerenderWith({ tab: "search", onTabChange: () => {} });
      await settle();
      assert.ok(document.activeElement === search, "arrowing onto Search stole focus into the box");

      cleanup();
      mount();
      await settle();
      fireEvent.click(screen.getByRole("tab", { name: "Search" }));
      await eventually(() => assert.ok(document.activeElement === searchBox(), "clicking Search did not focus the box"));
    } finally {
      f.restore();
    }
  });
});

describe("marks on the tab strip", () => {
  const UPDATE_WAITING = { tagBased: true, releasesBehind: 2, version: "1.0.0", targetTag: "v1.1.0" };
  const waitingName = (name: string) => ({ name, firstSeen: "", lastSeen: "", count: 1, lastFrom: "192.0.2.10", client: "Chrome" });
  const view = (waiting: unknown[]) => ({ enforce: false, seeded: false, automatic: [], accepted: [], waiting, dismissed: [] });

  test("a dot on Updates while an update waits, a count on Network while names wait", async () => {
    __resetHostNamesForTests();
    const f = stubFetch((url) => {
      if (url.includes("/api/update/status")) return ok(UPDATE_WAITING);
      if (url.includes("/api/security/host-names")) return ok(view([waitingName("stage.example.org"), waitingName("panel.example.org")]));
      return undefined;
    });
    try {
      mount();
      await eventually(() => assert.equal(document.querySelectorAll("[data-signal]").length, 2));
      const updates = screen.getByRole("tab", { name: "Updates, update available" });
      assert.ok(updates.querySelector('[data-signal="update"]'));
      const network = screen.getByRole("tab", { name: "Network, 2 host names waiting" });
      assert.equal(network.querySelector('[data-signal="host-names"]')?.textContent, "2");
      for (const other of ["General", "Schedule", "Data", "Video relay", "Search"]) {
        assert.equal(screen.getByRole("tab", { name: other }).querySelector("[data-signal]"), null, `${other} carries a mark`);
      }
    } finally {
      f.restore();
    }
  });

  test("no marks when nothing waits", async () => {
    __resetHostNamesForTests();
    const f = stubFetch((url) => (url.includes("/api/security/host-names") ? ok(view([])) : undefined));
    try {
      mount();
      await settle();
      assert.equal(document.querySelectorAll("[data-signal]").length, 0);
    } finally {
      f.restore();
    }
  });
});

describe("the post-update banner", () => {
  test("is drawn above the tabs on every tab, not only Updates", async () => {
    const f = stubFetch();
    try {
      for (const tab of ["general", "network", "search"]) {
        mount({ tab, justUpdated: { version: "1.2.3" } });
        await settle();
        const banner = document.querySelector("[data-just-updated]");
        assert.ok(banner, `no banner on the ${tab} tab`);
        assert.match(text(banner), /Update installed successfully\./);
        // Above the strip: the banner comes first in document order.
        const strip = screen.getByRole("tablist");
        assert.ok(banner.compareDocumentPosition(strip) & 4, "the banner is not above the tab strip");
        cleanup();
      }
    } finally {
      f.restore();
    }
  });

  test("is absent when nothing was just installed", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "updates" });
      await settle();
      assert.equal(document.querySelector("[data-just-updated]"), null);
    } finally {
      f.restore();
    }
  });
});

describe("the Server log offer", () => {
  test("lo, log, logs and server log offer it; a lone letter does not", () => {
    for (const q of ["lo", "log", "logs", "server log", "Server Logs", "debug"]) assert.equal(offersServerLog(q), true, q);
    for (const q of ["s", "e", "l", "", "  ", "log s", "logger", "server x"]) assert.equal(offersServerLog(q), false, JSON.stringify(q));
  });

  test("typing a lone s does not offer the Server log on the page", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      type("s");
      assert.equal(screen.queryByText("Server log", { selector: "span" }), null);
      type("lo");
      assert.ok(screen.getByText("Server log", { selector: "span" }));
    } finally {
      f.restore();
    }
  });
});

describe("result order", () => {
  const headings = () => [...document.querySelectorAll("h3")].map(text);

  test("a card with a name match is drawn above an earlier card with only a description match", async () => {
    const f = stubFetch();
    try {
      mount({ tab: "search" });
      await settle();
      // Backups mentions the archive in its description; Records has the Data archive row. Backups is first on the page.
      type("archive");
      // Backups draws once its schedule has been read.
      await eventually(() => assert.ok(drawn("data-archive") && drawn("auto-backups"), "a match is not drawn"));
      assert.deepEqual(headings(), ["Data › Records", "Data › Backups"]);
    } finally {
      f.restore();
    }
  });
});

describe("a setting the page is not drawing is not searched", () => {
  // Each timing's own name, which no other setting's name, card or keywords contain.
  const TIMINGS: [string, string][] = [
    ["reconnect-lead", "lead time before rehearsal"],
    ["reconnect-tail", "keep active after service ends"],
    ["reconnect-idle", "idle retry interval"],
  ];

  test("reconnect timings with Wake off: not drawn on the tab, not found in Search", async () => {
    const f = stubFetch();
    try {
      const off = { reconnectSchedule: { enabled: false, leadMin: 120, tailMin: 60, dormantMin: 30 } };
      mount({ tab: "schedule", stageState: off });
      await settle();
      assert.ok(drawn("reconnect-wake"));
      for (const [id] of TIMINGS) assert.ok(!drawn(id), `${id} drawn with Wake off`);
      cleanup();

      mount({ tab: "search", stageState: off });
      await settle();
      for (const [id, query] of TIMINGS) {
        type(query);
        assert.ok(!drawn(id), `${id} searched and drawn with Wake off`);
      }
      // Only the idle interval's own name matches this query, so a search that still counted it would say "1 setting matches".
      type("idle retry interval");
      assert.match(text(screen.getByRole("tabpanel")), /No setting matches/, "a hidden row was still counted as a match");
      cleanup();

      // The control: the same queries find the rows once Wake is on.
      mount({ tab: "search" });
      await settle();
      for (const [id, query] of TIMINGS) {
        type(query);
        assert.ok(drawn(id), `${id} not found with Wake on`);
      }
    } finally {
      f.restore();
    }
  });
});

describe("Cmd-F steps aside", () => {
  test("while a dialog is open the tab is left alone and the key is not taken", async () => {
    const f = stubFetch();
    try {
      mount();
      await settle();
      for (const role of ["dialog", "alertdialog"]) {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", role);
        document.body.appendChild(dialog);
        try {
          const e = pressFind({ metaKey: true });
          assert.equal(e.defaultPrevented, false, `${role}: the key was taken`);
          assert.equal(selectedTab(), "General", `${role}: the tab moved`);
        } finally {
          dialog.remove();
        }
      }
      // Control: with the dialog gone the same key opens Search.
      assert.equal(pressFind({ metaKey: true }).defaultPrevented, true);
      await eventually(() => assert.equal(selectedTab(), "Search"));
    } finally {
      f.restore();
    }
  });

  test("a key something else already handled is not taken", async () => {
    const f = stubFetch();
    try {
      mount();
      await settle();
      const e = new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true });
      const first = (ev: Event) => ev.preventDefault();
      // Capture phase on window runs before the page's own bubble listener on window.
      window.addEventListener("keydown", first, { capture: true, once: true });
      act(() => {
        window.dispatchEvent(e);
      });
      assert.equal(selectedTab(), "General", "the page navigated on a key that was already handled");
    } finally {
      f.restore();
    }
  });
});
