// The colour picker, opened from a swatch that sits inside a modal dialog.
//
// THE BUG. ProdCom's per-channel colours (caption-colors-panel.tsx) live in a
// disclosure inside IntegrationDialog, which is a real, modal `DialogRoot` /
// `DialogContent`. ColorField's own panel is a `createPortal` onto
// `document.body` — see the placement comment on ColorPanel in
// color-field.tsx — so once it opens, it sits OUTSIDE that dialog's own
// Content subtree, as a sibling rather than a descendant. Content's own
// FocusScope treats any focus that lands outside it — including the panel's
// own opening `focus()` — as focus that escaped, and snaps it straight back
// into the dialog: measured in a real browser, a manual `.focus()` call on the
// panel silently failed to move `document.activeElement` at all while a modal
// dialog held it open, which broke Tab, typing, and every slider's own arrow
// keys along with it.
//
// WHAT THIS FILE DOES NOT COVER, AND WHY. The other half of the bug — a click
// AIMED at the panel falling through to the dialog's overlay and closing the
// dialog, because a modal dialog forces `pointer-events: none` onto `<body>`
// and only re-enables it on its own Content — is a CSS hit-testing effect.
// jsdom loads no stylesheet and does no layout, so it cannot compute an
// element's effective `pointer-events` and there is nothing here to assert
// against. Worse, a jsdom guard that instead fires `pointerdown`/`click`
// DIRECTLY at an element inside the panel does not even need that computation
// to pass: React bubbles events from a portal through its OWN component tree,
// not the DOM tree, so the dialog's outside-click check already recognises a
// click actually landing on the panel as a click inside its own React
// subtree — with or without any fix here. An earlier draft of this file
// asserted exactly that and it passed with the fix fully reverted, which is
// the CLAUDE.md failure mode this repo keeps re-learning: a guard that cannot
// go red. That half was instead driven in a real browser, Chromium and WebKit
// both — dragging the saturation square, typing a hex value, and clicking a
// palette swatch, all inside the real ProdCom dialog, with the dialog staying
// open and the swatch showing the picked colour after.
//
// What jsdom CAN say for real is where focus lands, because `document
// .activeElement`, `Node.contains`, and `focusin`/`focusout` dispatch are all
// implemented by jsdom itself, not by a stylesheet. That is the whole of what
// this file asserts.

import assert from "node:assert/strict";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../../test-dom.js";

const teardown = installDom();
// React only act-wraps a render, and only warns when an update escapes one,
// once it is told it is in a test environment. Without this the file reads
// as clean while updates land outside act.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The panel's saved-colour row reads the shared stage state, so a render of it
// opens a request and an SSE stream. Both are answered with nothing: this file
// is about where the dialog and the panel stand relative to each other, not
// what is in either of them.
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => "{}",
});
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

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ColorField } = await import("./color-field.js");
const { DialogRoot, DialogContent, DialogTitle } = await import("./dialog.js");

after(() => unmountAndTeardown(cleanup, teardown));
afterEach(async () => {
  cleanup();
  await settle();
});

const withQuery = (children: React.ReactNode) =>
  React.createElement(
    QueryClientProvider,
    { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }) },
    children,
  );

/**
 * The real modal DialogRoot/DialogContent — the same two components
 * IntegrationDialog builds ProdCom's dialog from — holding one ColorField, the
 * way caption-colors-panel.tsx holds one per channel.
 */
function drawColorFieldInADialog() {
  return render(
    withQuery(
      React.createElement(
        DialogRoot,
        { open: true, onOpenChange: () => {} },
        React.createElement(
          DialogContent,
          { "aria-describedby": undefined },
          React.createElement(DialogTitle, null, "Test dialog"),
          React.createElement(ColorField, {
            value: "#3b82f6",
            onChange: () => {},
            label: "Test colour",
          }),
        ),
      ),
    ),
  );
}

const trigger = (): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  assert.ok(el, "the colour field drew no swatch trigger");
  return el;
};
const panel = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-color-panel]");
  assert.ok(el, "the colour panel is not in the document");
  return el;
};
/** Where focus is, in a few words — see color-field-single.test.tsx for why
 *  this is not a node-identity assert.equal. */
const where = (el: Element | null): string => {
  if (!el) return "nothing";
  if (el === document.body) return "<body>";
  const id = el.id ? `#${el.id}` : "";
  const role = el.getAttribute("role");
  return `<${el.tagName.toLowerCase()}${id}${role ? ` role=${role}` : ""}>`;
};

describe("the colour panel over a modal dialog", () => {
  test("THE GUARD: opening the panel focuses IT, not the dialog reclaiming focus", async () => {
    drawColorFieldInADialog();
    await settle();
    fireEvent.click(trigger());
    await settle();

    assert.ok(
      document.activeElement === panel(),
      `opening the panel inside a dialog left focus on ${where(document.activeElement)} — ` +
        `the dialog's own FocusScope is treating the panel's focus as focus that escaped and reclaiming it`,
    );
  });

  test("THE GUARD: Tab still cycles inside the panel, not out into the dialog behind it", async () => {
    // The same trap color-field-single.test.tsx proves outside a dialog — run
    // again here because a dialog's OWN FocusScope has its own Tab handling,
    // and it is exactly the kind of second copy this repo's guards have missed
    // before: correct standalone, silently overridden once nested.
    drawColorFieldInADialog();
    await settle();
    fireEvent.click(trigger());
    await settle();

    const stops = [
      ...panel().querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);
    assert.ok(stops.length > 1, `the panel has ${stops.length} tab stops, so this asserts nothing`);
    const [first, last] = [stops[0], stops[stops.length - 1]];

    panel().focus();
    fireEvent.keyDown(panel(), { key: "Tab" });
    assert.ok(
      document.activeElement === first,
      `Tab from the panel itself landed on ${where(document.activeElement)} rather than stepping into it`,
    );

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    assert.ok(
      document.activeElement === first,
      `Tab off the last control landed on ${where(document.activeElement)} — it left the panel, into the dialog behind it`,
    );
  });
});
