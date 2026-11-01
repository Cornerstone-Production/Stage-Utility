// companion-browser.test.tsx — Browse buttons, as the Companion dialog's card runs it.
//
// The page dropdown, the arrows and the grid are the shared companion-pages.tsx and are
// tested there; this is what is Browse buttons' own:
//
//  - NOTHING IS READ UNTIL BROWSE IS PRESSED, and Hide buttons puts it away.
//  - AN UNREACHABLE COMPANION SAYS WHY, and a page that cannot be read says so, instead
//    of an empty grid that reads as a Companion with nothing on it.
//  - IT OPENS ON THE FIRST PAGE WITH BUTTONS, steps over empty pages, and draws the page
//    read-only, from the page route, with the extent the server sent.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { eventually, installRenderDom, settle } from "../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { CompanionBrowser } = await import("./companion-browser.js");
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


describe("Browse buttons, end to end", () => {
  test("steps over empty pages and draws the page the server sent, read-only", async () => {
    mount(<CompanionBrowser />);
    await eventually(() => assert.ok(keyAt("p1 r0 c0")));
    await press(screen.getByRole("button", { name: "Next page" }), "next");
    await eventually(() => assert.ok(keyAt("p17 r0 c0")), 3000);
    const grid = document.querySelector('[role="img"]') as HTMLElement;
    assert.equal(grid.children.length, 12 * 5);
    assert.equal(document.querySelectorAll('[role="img"] button, [role="gridcell"]').length, 0, "Browse buttons drew a control");
    assert.match(document.body.textContent ?? "", /page 17 · 12 × 5/);
  });
});
