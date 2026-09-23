// past-sessions.test.tsx — the Past sessions card's empty and load-failed
// states, its per-row figures (via baptismStats, never people.length), the
// delete confirmation gate, and the guard that a row's link is exactly
// historyServiceHref(serviceKey) while a keyless session renders none.
//
// Driven through a REAL TanStack router (RouterContextProvider +
// createMemoryHistory), the same mechanism history-service-url.test.tsx uses,
// so what is proved is AppLink actually resolving `to` through the router's
// own href logic — not a hand-built string compared against itself.
//
// NOT proved here: that CLICKING the rendered anchor drives an SPA navigation.
// jsdom logs "Not implemented: navigation to another Document" on that click —
// intercepting a real <a> click is Link's own job and this harness has no
// browser to exercise it in, the same kind of gap
// history-service-url.test.tsx's own header names for the reverse (Back)
// direction. What IS checked is the rendered anchor's `href` attribute,
// computed by the real AppLink/Link, against historyServiceHref's own output.

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installDom, settle, unmountAndTeardown } from "../../../test-dom.js";

const teardown = installDom();

const { render, cleanup, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { TooltipProvider, ConfirmHost } = await import("../../../components/ui/index.js");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterContextProvider } =
  await import("@tanstack/react-router");
const { PastSessionsCard } = await import("./past-sessions.js");
const { historyServiceHref } = await import("../service-history-section.js");

afterEach(cleanup);
after(() => unmountAndTeardown(cleanup, teardown));

const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => text(b) === label) as HTMLElement | undefined;

/** A row figure's own value, found by its label span — RowFigure's own DOM
 *  shape (label span, then value span), rather than a scrape of the row's
 *  whole text, which cannot tell "Baptized 1" from a "1" that belongs to a
 *  neighbouring figure or the date. */
function figureValue(root: ParentNode, label: string): string | null {
  const spans = [...root.querySelectorAll("span")];
  const labelSpan = spans.find((s) => text(s) === label);
  return labelSpan?.nextElementSibling ? text(labelSpan.nextElementSibling) : null;
}

function session(overrides: Partial<BaptismSession> = {}): BaptismSession {
  return {
    id: "bap-1",
    startedAt: "2026-09-20T15:00:00.000Z",
    finishedAt: "2026-09-20T15:17:23.000Z",
    people: [
      { testimonyMs: 108_000, baptizeMs: 42_000 },
      { testimonyMs: 96_000, baptizeMs: 0 }, // mid-testimony, never baptized
    ],
    title: "Sunday Gathering",
    serviceTypeId: null,
    planId: null,
    serviceKey: "weekend:plan-1:1100",
    ...overrides,
  };
}

/** Mounts the card under a real (memory-history) router plus the tooltip and
 *  confirm hosts every button here depends on. */
function mount(props: { sessions: readonly BaptismSession[]; loadError?: boolean; onDelete?: (id: string) => void }) {
  const rootRoute = createRootRoute({});
  const historyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/history/manage", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([historyRoute]),
    history: createMemoryHistory({ initialEntries: ["/baptism"] }),
  });
  const view = render(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(RouterContextProvider, {
        router,
        children: React.createElement(PastSessionsCard, {
          sessions: props.sessions,
          loadError: props.loadError ?? false,
          onDelete: props.onDelete ?? (() => {}),
        }),
      }),
      React.createElement(ConfirmHost),
    ),
  );
  return { view, router };
}

describe("PastSessionsCard — empty and failed states", () => {
  test("no finished sessions says so plainly", () => {
    const { view } = mount({ sessions: [] });
    assert.ok(text(view.container).includes("No finished sessions yet"));
  });

  test("a load failure reads as a failure, never as an empty list", () => {
    const { view } = mount({ sessions: [], loadError: true });
    const alert = view.container.querySelector('[role="alert"]');
    assert.ok(alert, "expected a role=alert failure state");
    assert.ok(text(alert).includes("could not be loaded"));
    assert.equal(text(view.container).includes("No finished sessions yet"), false);
  });
});

describe("PastSessionsCard — figures come from baptismStats, never people.length", () => {
  test("Baptized counts only people with a real baptism, not everyone who testified", () => {
    // Two entries: one baptized, one mid-testimony (baptizeMs 0). people.length
    // would read 2; baptismStats must read 1.
    const { view } = mount({ sessions: [session()] });
    assert.equal(figureValue(view.container, "Baptized"), "1", "must count only the person actually baptized, not both entries");
  });

  test("Avg testimony, Avg baptism and Total format as clocks", () => {
    const { view } = mount({ sessions: [session()] });
    assert.equal(figureValue(view.container, "Avg testimony"), "1:42", "(108+96)/2 = 102s, averaged over both who testified");
    assert.equal(figureValue(view.container, "Avg baptism"), "0:42", "42s over the one person actually baptized, not both");
    assert.equal(figureValue(view.container, "Total"), "4:06", "108+42+96+0 = 246s summed");
  });
});

describe("PastSessionsCard — link guard: a row's link is historyServiceHref(serviceKey)", () => {
  test("a keyed session's link resolves to exactly historyServiceHref(serviceKey)", () => {
    const KEY = "weekend:plan-1:1100";
    const { view } = mount({ sessions: [session({ serviceKey: KEY })] });
    const link = [...view.container.querySelectorAll("a")].find((a) => text(a).includes("open in History"));
    assert.ok(link, "expected an 'open in History' link for a keyed session");
    // The REAL AppLink/Link's own href resolution, not a hand-built string —
    // see the file header for why a click is not driven here instead.
    assert.equal(link!.getAttribute("href"), historyServiceHref(KEY));
  });

  test("a session with no serviceKey renders no link at all", () => {
    const { view } = mount({ sessions: [session({ serviceKey: null })] });
    const link = [...view.container.querySelectorAll("a")].find((a) => text(a).includes("open in History"));
    // A boolean, never the node itself: asserting a raw jsdom element as the
    // "actual" value makes a failure's util.inspect walk the live DOM tree,
    // which hangs for ~22s instead of reporting the mismatch.
    assert.equal(link != null, false, "a keyless session has nothing to link to and must not render a broken link");
  });
});

describe("PastSessionsCard — delete, behind a confirmation", () => {
  test("cancelling the confirm leaves the session alone", async () => {
    let deleted: string | null = null;
    const { view } = mount({ sessions: [session({ id: "bap-9" })], onDelete: (id) => (deleted = id) });
    fireEvent.click(view.container.querySelector('button[aria-label="Delete session"]')!);
    await settle();
    const cancel = button(document.body, "Cancel");
    assert.ok(cancel, "expected a Cancel button on the confirm dialog");
    fireEvent.click(cancel!);
    await settle();
    assert.equal(deleted, null, "onDelete must not fire when the confirm is dismissed");
  });

  test("confirming deletes the session", async () => {
    let deleted: string | null = null;
    const { view } = mount({ sessions: [session({ id: "bap-9" })], onDelete: (id) => (deleted = id) });
    fireEvent.click(view.container.querySelector('button[aria-label="Delete session"]')!);
    await settle();
    const del = button(document.body, "Delete");
    assert.ok(del, "expected a Delete button on the confirm dialog");
    fireEvent.click(del!);
    await settle();
    assert.equal(deleted, "bap-9");
  });
});
