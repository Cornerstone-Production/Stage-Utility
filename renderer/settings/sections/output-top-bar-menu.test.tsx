// The two Screens-card menu items that are only about the kiosk top bar, and
// the rule that neither is offered on a display that draws no bar.
//
// This exists because "Lock display" shipped for months as a no-op. Its ONLY
// effect is inside KioskTopBar — it strips the home link and hides the QR —
// so on a calendar or a script wall, which draw no bar, choosing it persisted a
// flag, turned its icon accent, and changed nothing an operator could see. A
// locked-looking display that is not locked is worse than no lock at all.
//
// So the assertion is about what is IN THE MENU, driven through the real
// component with a real click on the real trigger. A test over the predicate
// alone would have passed on the shipped bug: the predicate was right, and
// nothing consulted it.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installDom } from "../../test-dom.js";
import { KIND_DRAWS_TOP_BAR, type ViewKind } from "@main/types/views";

const teardown = installDom();

/**
 * jsdom ships no EventSource, and the card's bound-device strip subscribes to
 * "kiosk:devices". A stub that connects to nothing is right here: this file is
 * about what is in a menu, and a live stream would make it depend on a server.
 */
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

// No network. The card's bound-device strip refreshes on mount; an empty but
// WELL-SHAPED payload is the point — `useDevices` publishes whatever comes back
// verbatim, so a bare {} makes ScreenDevice crash on `bound.find` and the whole
// file fails for a reason that has nothing to do with the menu.
(globalThis as unknown as { fetch: unknown }).fetch = async () => {
  const payload = { scanning: false, seen: [], matches: {}, bound: [], error: null };
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup, fireEvent, act } = await import("@testing-library/react");
const React = (await import("react")).default;
const { OutputRow } = await import("./outputs-section.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
// retry:false — a bound-device query that fails must fail once, not keep the
// file alive retrying after teardown has removed `window`.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => { await settle(); teardown(); });
beforeEach(() => { cleanup(); });
afterEach(async () => { cleanup(); await settle(); });

const noop = () => {};
const asyncNoop = async () => {};

/** The card for one display routed to a View of `kind` (null = unrouted). */
function cardFor(kind: ViewKind | null) {
  const views = kind ? [{ id: "v1", name: "The view", kind }] : [];
  return React.createElement(OutputRow, {
    output: { id: "display-1", name: "Stage left", viewId: kind ? "v1" : null },
    views,
    baseUrl: "http://display.invalid",
    online: false,
    canRemove: true,
    iconKey: "display-1",
    onRename: noop,
    onSetSlug: asyncNoop,
    onSetView: noop,
    onRenameView: noop,
    onSetLocked: noop,
    onSetHideTopBar: noop,
    onSetMode: asyncNoop,
    onRefresh: noop,
    onRemove: noop,
    onRequestNewView: noop,
  } as never);
}

/** Open this card's hamburger and return the words in the menu. */
async function menuText(kind: ViewKind | null): Promise<string> {
  // The card reaches up to the settings shell for both of these: a tooltip
  // provider, and the query client its bound-device strip reads.
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TooltipProvider, null, cardFor(kind)),
    ),
  );
  const trigger = screen.getByLabelText(/more|menu|options/i);
  await act(async () => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settle();
  });
  return document.body.textContent ?? "";
}

describe("the top-bar menu items follow the bar", () => {
  for (const [kind, draws] of Object.entries(KIND_DRAWS_TOP_BAR) as [ViewKind, boolean][]) {
    test(`${kind}: ${draws ? "offers" : "hides"} the lock and the top-bar toggle`, async () => {
      const text = await menuText(kind);
      // Sanity: the menu really opened. Without this the whole file passes by
      // asserting an empty string does not contain the words.
      assert.ok(text.includes("Use as a control surface"), `the menu did not open: ${text}`);
      assert.equal(
        text.includes("Lock display"),
        draws,
        draws
          ? `${kind} draws a bar but its lock is gone`
          : `${kind} draws no bar and still offers "Lock display" — the shipped no-op`,
      );
      assert.equal(
        text.includes("Hide top bar"),
        draws,
        draws
          ? `${kind} draws a bar but cannot hide it`
          : `${kind} draws no bar and still offers "Hide top bar"`,
      );
    });
  }

  test("an unrouted display keeps both: its placeholder draws a bar", async () => {
    // The rule is about the BAR, not about having a view. Gate on `assignedView`
    // being present instead and this is the case that breaks: an unrouted screen
    // shows the "not routed" placeholder, which draws a bar like any other.
    const text = await menuText(null);
    assert.ok(text.includes("Lock display"), "an unrouted display lost its lock");
    assert.ok(text.includes("Hide top bar"), "an unrouted display lost its top-bar toggle");
  });
});
