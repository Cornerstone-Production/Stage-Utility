// companion-browser.test.tsx — Browse buttons: the page dropdown, the arrows, and
// the read-only grid in Companion's own colours.
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - EMPTY PAGES ARE LEFT OUT of the dropdown AND the arrows. A real install has
//    99 pages and more than half are empty; an arrow that stopped on one, or a
//    dropdown that listed 59 pages of nothing, is the control it replaces.
//  - THE FILTER TAKES A NUMBER OR A NAME, so "17" and "proj" both find page 17.
//  - THE GRID IS COMPANION'S: each key's own background and text colour, its icon,
//    a reference marked as one, a page control drawn blank. A grid that drew every
//    key the same is a picture of nothing.
//  - THE GRID DRAWS THE PAGE'S USED EXTENT as the server sends it, and keeps the
//    keys in their own rows and columns.
//  - NOTHING IS READ UNTIL BROWSE IS PRESSED, and an unreachable Companion says
//    why instead of drawing an empty grid.
//  - READ-ONLY: nothing in the grid is a control.
//
// NOT unit-tested here, and driven in a browser instead: the keys' square size, the
// sideways scroll of a page wider than the card, and the dropdown's stacking over
// the grid. jsdom loads no stylesheet and reports every offsetWidth as 0.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle } from "../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CompanionBrowser, listedPages, filterPages, neighbour } = await import("./companion-browser.js");
const { CompanionOutboundCard } = await import("./companion-outbound-card.js");

type Key = {
  row: number;
  col: number;
  kind: "button" | "reference" | "page-control";
  label: string;
  bg: string | null;
  fg: string | null;
  icon: string | null;
  pickable: boolean;
  target?: { page: number; row: number; col: number };
};
const key = (row: number, col: number, over: Partial<Key> = {}): Key => ({
  row,
  col,
  kind: "button",
  label: "Key",
  bg: null,
  fg: null,
  icon: null,
  pickable: true,
  ...over,
});

const PAGES = [
  { page: 1, name: "Main", labelled: 3 },
  { page: 2, name: "", labelled: 0 },
  { page: 3, name: "Spare", labelled: 0 },
  { page: 17, name: "Projectors", labelled: 12 },
  { page: 20, name: "FOH Playback", labelled: 5 },
];
const PAGE_KEYS: Record<number, { name: string; cols: number; rows: number; keys: Key[] }> = {
  1: { name: "Main", cols: 8, rows: 4, keys: [key(0, 0, { label: "Start" })] },
  17: {
    name: "Projectors",
    cols: 12,
    rows: 5,
    keys: [
      key(0, 0, { label: "Lamp on", bg: "#aa0000", fg: "#ffff00" }),
      key(0, 1, { label: "Lamp off", icon: "data:image/png;base64,AAAA" }),
      key(1, 3, { kind: "reference", label: "Shutter", target: { page: 20, row: 2, col: 1 } }),
      key(2, 0, { kind: "page-control", label: "PAGE UP", pickable: false }),
      key(4, 11, { label: "Far right" }),
    ],
  },
  20: { name: "FOH Playback", cols: 8, rows: 4, keys: [key(2, 1, { label: "Walk-in" })] },
};

let fetched: string[] = [];
let REPLY: "ok" | "unreachable" | "page-fails" = "ok";

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
  const url = String(input);
  const path = url.split("?")[0]!;
  if (url.includes("/api/events/subscribe")) return reply(200, {});
  fetched.push(path);
  if (path === "/api/companion/buttons") {
    return REPLY === "unreachable" ? reply(200, { ok: false, reason: "Companion host is not configured" }) : reply(200, { ok: true, buttons: [], pages: PAGES, cachedAt: 1 });
  }
  const m = /^\/api\/companion\/pages\/(\d+)$/.exec(path);
  if (m) {
    if (REPLY === "page-fails") return reply(503, { error: "Companion went away" });
    const p = PAGE_KEYS[Number(m[1])];
    return p ? reply(200, { ok: true, page: Number(m[1]), ...p }) : reply(404, { error: `Companion has no page ${m[1]}` });
  }
  return reply(200, {});
};
function reply(status: number, body: unknown) {
  return { ok: status < 400, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) };
}

let client: InstanceType<typeof QueryClient> | null = null;
function mount(node: React.ReactNode) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(React.createElement(QueryClientProvider, { client }, node));
}
async function press(el: Element | null | undefined, what: string) {
  assert.ok(el, `nothing to press: ${what}`);
  await act(async () => {
    fireEvent.click(el as HTMLElement);
  });
  await settle();
}
const pageButton = () => screen.getByRole("button", { name: "Companion page" });
const optionNumbers = () => [...document.querySelectorAll("[data-page-option]")].map((o) => o.getAttribute("data-page-option"));
const keyAt = (where: string) => document.querySelector(`[data-companion-key="${where}"]`) as HTMLElement | null;

beforeEach(() => {
  fetched = [];
  REPLY = "ok";
});
afterEach(async () => {
  cleanup();
  client?.clear();
  await settle();
});
after(async () => {
  cleanup();
  await settle();
  teardown();
});

describe("the page list", () => {
  test("listedPages leaves out the empty pages and sorts by page number", () => {
    assert.deepEqual(listedPages([...PAGES].reverse()).map((p) => p.page), [1, 17, 20]);
  });

  test("filterPages takes a number, as a prefix or whole, or any part of a name", () => {
    const listed = listedPages(PAGES);
    assert.deepEqual(filterPages(listed, "17").map((p) => p.page), [17]);
    assert.deepEqual(filterPages(listed, "2").map((p) => p.page), [20]);
    assert.deepEqual(filterPages(listed, "PROJ").map((p) => p.page), [17]);
    assert.deepEqual(filterPages(listed, "playback").map((p) => p.page), [20]);
    assert.deepEqual(filterPages(listed, "  ").map((p) => p.page), [1, 17, 20]);
    assert.deepEqual(filterPages(listed, "zzz"), []);
  });

  test("neighbour steps over the listed pages only, and stops at the ends", () => {
    const listed = listedPages(PAGES);
    assert.equal(neighbour(listed, 1, 1), 17, "the arrow stopped on an empty page");
    assert.equal(neighbour(listed, 17, -1), 1);
    assert.equal(neighbour(listed, 20, 1), null);
    assert.equal(neighbour(listed, 1, -1), null);
  });
});

describe("Browse buttons", () => {
  test("nothing is read until it is pressed, and Hide buttons puts it away again", async () => {
    mount(
      <CompanionOutboundCard testing={false} result={null} onTest={() => {}} dirty={false}>
        <span />
      </CompanionOutboundCard>,
    );
    await settle();
    assert.deepEqual(fetched, [], "Companion was read before Browse buttons was pressed");
    await press(screen.getByRole("button", { name: "Browse buttons" }), "Browse buttons");
    await eventually(() => assert.ok(document.querySelector("[data-companion-browser]")));
    assert.ok((fetched as string[]).includes("/api/companion/buttons"));
    await press(screen.getByRole("button", { name: "Hide buttons" }), "Hide buttons");
    assert.equal(document.querySelector("[data-companion-browser]") === null, true);
  });

  test("an unreachable Companion says why, and draws no grid", async () => {
    REPLY = "unreachable";
    mount(<CompanionBrowser />);
    await eventually(() => assert.match(document.body.textContent ?? "", /Companion host is not configured/));
    assert.equal(document.querySelector("[data-companion-key]") === null, true);
  });

  test("a page that cannot be read says so, with the reason", async () => {
    REPLY = "page-fails";
    mount(<CompanionBrowser />);
    await eventually(() => assert.match(document.body.textContent ?? "", /Could not read page 1: Companion went away/));
  });

  test("opens on the first page that has buttons", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    assert.match(pageButton().textContent ?? "", /1\s*Main/);
  });
});

describe("the dropdown and the arrows", () => {
  test("the dropdown lists only pages with buttons, with how many, and says empty pages are left out", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    await press(pageButton(), "the page dropdown");
    assert.deepEqual(optionNumbers(), ["1", "17", "20"]);
    assert.match(document.body.textContent ?? "", /3 pages with buttons · empty pages left out/);
  });

  test("the filter finds a page by number or name, and Enter picks the highlighted one", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    await press(pageButton(), "the page dropdown");
    const filter = screen.getByRole("textbox", { name: "Filter pages" });
    await act(async () => {
      fireEvent.change(filter, { target: { value: "proj" } });
    });
    assert.deepEqual(optionNumbers(), ["17"]);
    await act(async () => {
      fireEvent.keyDown(filter, { key: "Enter" });
    });
    await eventually(() => assert.ok(keyAt("p17 r0 c0")));
    assert.equal(document.querySelector("[data-page-option]") === null, true, "the dropdown stayed open after a pick");
    assert.match(pageButton().textContent ?? "", /17\s*Projectors/);
  });

  test("a filter that matches nothing says so", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    await press(pageButton(), "the page dropdown");
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Filter pages" }), { target: { value: "zzz" } });
    });
    assert.match(document.body.textContent ?? "", /No page matches/);
  });

  test("Escape closes the dropdown without changing the page", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    await press(pageButton(), "the page dropdown");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Filter pages" }), { key: "Escape" });
    });
    assert.equal(document.querySelector("[data-page-option]") === null, true);
    assert.match(pageButton().textContent ?? "", /1\s*Main/);
  });

  test("the arrows skip empty pages, and each is dead at its end", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    assert.equal((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled, true);
    await press(screen.getByRole("button", { name: "Next page" }), "next");
    // Pages 2 and 3 are empty, so next from 1 is 17.
    await eventually(() => assert.ok(keyAt("p17 r0 c0")));
    await press(screen.getByRole("button", { name: "Next page" }), "next");
    await eventually(() => assert.ok(keyAt("p20 r2 c1")));
    assert.equal((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled, true);
    await press(screen.getByRole("button", { name: "Previous page" }), "previous");
    await eventually(() => assert.ok(keyAt("p17 r0 c0")));
  });
});

describe("the grid", () => {
  async function onPage17() {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    await press(screen.getByRole("button", { name: "Next page" }), "next");
    await eventually(() => assert.ok(keyAt("p17 r0 c0")));
  }

  test("each key carries Companion's own background and text colour, and a key with none takes the default", async () => {
    await onPage17();
    const lamp = keyAt("p17 r0 c0")!;
    assert.equal(lamp.style.backgroundColor, "rgb(170, 0, 0)");
    assert.equal(lamp.style.color, "rgb(255, 255, 0)");
    const plain = keyAt("p17 r4 c11")!;
    assert.equal(plain.style.backgroundColor, "", "a key with no colour of its own was given one");
  });

  test("an icon is drawn above its label", async () => {
    await onPage17();
    const withIcon = keyAt("p17 r0 c1")!;
    assert.equal(withIcon.querySelector("img")?.getAttribute("src"), "data:image/png;base64,AAAA");
    assert.match(withIcon.textContent ?? "", /Lamp off/);
    assert.equal(keyAt("p17 r0 c0")!.querySelector("img") === null, true);
  });

  test("a reference is drawn as the key it points at, and marked as a reference", async () => {
    await onPage17();
    const ref = keyAt("p17 r1 c3")!;
    assert.equal(ref.getAttribute("data-key-kind"), "reference");
    assert.match(ref.textContent ?? "", /Shutter/);
    assert.match(ref.getAttribute("title") ?? "", /a reference to p20 r2 c1/);
  });

  test("a page control is a blank key: no label, nothing to read", async () => {
    await onPage17();
    assert.equal(keyAt("p17 r2 c0") === null, true, "a page control drew as a key");
    assert.ok(!(document.body.textContent ?? "").includes("PAGE UP"));
  });

  test("draws the extent the server sent, with every key in its own row and column", async () => {
    await onPage17();
    const grid = document.querySelector('[role="img"] > div') as HTMLElement;
    assert.equal(grid.style.gridTemplateColumns, "repeat(12, minmax(2.75rem, 1fr))");
    assert.equal(grid.children.length, 12 * 5, "the grid is not cols x rows cells");
    // r4 c11 is the last cell; r1 c3 sits one row and three cells in.
    assert.equal(grid.children[4 * 12 + 11] === keyAt("p17 r4 c11"), true, "the last key is not in the last cell");
    assert.equal(grid.children[1 * 12 + 3] === keyAt("p17 r1 c3"), true, "a key is not in its own row and column");
    assert.match(document.body.textContent ?? "", /page 17 · 12 × 5/);
  });

  test("is read-only: no key is a control", async () => {
    await onPage17();
    assert.equal(document.querySelectorAll('[role="img"] button, [role="img"] [role="button"], [role="img"] a').length, 0);
    const before = fetched.length;
    await press(keyAt("p17 r0 c0"), "a key");
    assert.equal(fetched.length, before, "pressing a key did something");
  });
});
