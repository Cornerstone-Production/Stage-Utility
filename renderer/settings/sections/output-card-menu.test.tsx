// A screen card's overflow menu is ACTIONS ONLY. Every setting it used to hold —
// the role, the lock, the top bar, HLS, the message groups, the friendly link —
// moved into the Screen settings panel (screen-settings-panel.test.tsx), and the
// menu is now the card's way in: open it, rename its view, copy its address,
// refresh it, remove it, and "Screen settings…".
//
// Driven through the real card with a real click on the real trigger. The list is
// asserted EXACTLY and in order, and the removed items are asserted gone by name:
// a menu that quietly kept a setting would pass a test that only looked for the
// new ones.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";

const teardown = installDom();

class StubEventSource {
  static readonly CONNECTING = 0;
  readyState = 0;
  onmessage: unknown = null;
  onerror: unknown = null;
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

(globalThis as unknown as { fetch: unknown }).fetch = async () => {
  const payload = { scanning: false, seen: [], matches: {}, bound: [], error: null };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { OutputRow } = await import("./outputs-section.js");
type OutputRowProps = import("./outputs-section.js").OutputRowProps;
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); });
afterEach(async () => { cleanup(); await settle(); });

const noop = () => {};
const asyncNoop = async () => {};

const VIEW: View = { id: "v1", name: "The view", kind: "custom", createdAt: "2026-01-01T00:00:00.000Z" };

function card(over: Partial<OutputRowProps> = {}, routed = true) {
  const props: OutputRowProps = {
    output: { id: "display-1", name: "Stage left", viewId: routed ? "v1" : null },
    views: routed ? [VIEW] : [],
    baseUrl: "http://display.invalid",
    online: false,
    struggles: [],
    lags: [],
    canRemove: true,
    iconKey: "display-1",
    onRename: noop,
    onSetView: noop,
    onRenameView: noop,
    messageGroups: { groups: [], known: true, failed: false },
    onSetMode: asyncNoop,
    onOpenSettings: noop,
    onRefresh: noop,
    onRemove: noop,
    onRequestNewView: noop,
    ...over,
  };
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, React.createElement(OutputRow, props)),
    ),
  );
}

async function openMenu(): Promise<void> {
  const trigger = screen.getByLabelText(/more actions/i);
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settle();
  });
}

/** The menu's rows in order: item labels, and "—" for a separator. */
function rows(): string[] {
  const menu = document.querySelector("[data-radix-menu-content]");
  assert.ok(menu, "the menu did not open");
  return [...menu.children].map((el) => (el.getAttribute("role") === "separator" ? "—" : (el.textContent ?? "").trim()));
}

const select = async (el: Element) => {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(el, { button: 0, ctrlKey: false });
    fireEvent.click(el);
    await settle();
  });
};

describe("the card's menu", () => {
  test("is the actions and nothing else, in order, with Screen settings between two separators", async () => {
    card();
    await openMenu();
    assert.deepEqual(rows(), [
      "Open display",
      "Rename view",
      "Copy URL",
      "Refresh display",
      "—",
      "Screen settings…",
      "—",
      "Remove display",
    ]);
  });

  test("offers Rename view only when a view is assigned", async () => {
    card({}, false);
    await openMenu();
    assert.deepEqual(rows(), ["Open display", "Copy URL", "Refresh display", "—", "Screen settings…", "—", "Remove display"]);
  });

  test("no longer holds any setting", async () => {
    card();
    await openMenu();
    const text = document.body.textContent ?? "";
    for (const gone of [
      "Use as a control surface",
      "Use as a display",
      "Lock display",
      "Unlock display",
      "Hide top bar",
      "Show top bar",
      "Use HLS on this screen",
      "Groups",
      "URLs and friendly link",
    ]) {
      assert.equal(text.includes(gone), false, `"${gone}" is still in the card's menu`);
    }
  });

  test("Screen settings… opens THIS screen's panel", async () => {
    let opened = 0;
    card({ onOpenSettings: () => { opened++; } });
    await openMenu();
    await select(screen.getByRole("menuitem", { name: "Screen settings…" }));
    assert.equal(opened, 1);
  });

  test("Remove display is still refused for the last screen", async () => {
    card({ canRemove: false });
    await openMenu();
    assert.equal(screen.getByRole("menuitem", { name: "Remove display" }).getAttribute("aria-disabled"), "true");
  });

  test("Copy URL keeps the menu open across the copy, so the plain-HTTP fallback has a selection to copy", async () => {
    // Prod is plain HTTP, where navigator.clipboard does not exist and the copy
    // falls back to a textarea plus execCommand. Radix closes a menu on select
    // and returns focus to its trigger, which discards the textarea's selection:
    // the copy then does nothing at all. The item says preventDefault() to stop
    // the close, and the copy's textarea is mounted INSIDE the menu, where
    // Radix's focus trap cannot take it away.
    let textareaInMenu = false;
    (document as unknown as { execCommand: () => boolean }).execCommand = () => {
      textareaInMenu = document.querySelector("[data-radix-menu-content] textarea") !== null;
      return true;
    };
    try {
      card();
      await openMenu();
      const copy = screen.getByRole("menuitem", { name: "Copy URL" });
      // Synchronous on purpose: the menu closes itself once the copy is done, so
      // the moment that matters is the one straight after the click.
      fireEvent.pointerDown(copy, { button: 0, ctrlKey: false });
      fireEvent.pointerUp(copy, { button: 0, ctrlKey: false });
      fireEvent.click(copy);
      assert.ok(document.querySelector("[data-radix-menu-content]"), "the menu closed on select; the copy has nothing to select");
      assert.ok(textareaInMenu, "the copy's textarea was not inside the menu, where focus cannot be taken from it");
    } finally {
      delete (document as unknown as { execCommand?: unknown }).execCommand;
      await act(async () => { await settle(); });
    }
  });
});

// The selected card's accent border is a stylesheet fact jsdom cannot see; it is
// checked in a browser, not here.
describe("the card keeps what an operator reaches for while working", () => {
  test("the name, its view picker and the Open link are on the card, not in the menu", () => {
    card();
    assert.ok(screen.getByLabelText("Display name"));
    assert.ok(screen.getByText("The view"));
    assert.ok(screen.getByRole("link", { name: /^Open/ }));
  });
});
