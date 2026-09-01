// The page's name, now that it lives in the context bar.
//
// Merging the header band into the strip put a shrinkable element on a row whose
// whole design is about what may and may not give way. Three things have to stay
// true, and each of them was a real bug before it was a rule:
//
//   1. The name never shortens to nothing. That is #383's blank heading arrived
//      at from a different direction — not "no route matched" but "the row ran
//      out of width" — and it looks identical to an operator.
//   2. No name the SHELL owns is ever ellipsised. A destination is not the
//      operator's prose; if "Integrations" comes out as "Integratio…" the floor
//      is set wrong, and the floor is a number somebody has to keep honest as
//      destinations are added.
//   3. The name is not a bar item. It must not appear in BAR_ITEMS, or the
//      ladder's "never drop an item the operator chose" quietly becomes a
//      promise about the shell's own chrome that the shell then breaks.
//
// The labels are read from the REAL destination table and the real router route
// tree, not a list kept here — a destination added with a long name has to fail
// this file rather than ship a clipped heading.

import { strict as assert } from "node:assert";
import { after, describe, test } from "node:test";

// The DOM must exist before the component modules are evaluated — a `before`
// hook runs after the module body, so a static import would render into nothing.
import { installDom } from "../test-dom.js";

const teardown = installDom();

const { render, cleanup } = await import("@testing-library/react");
const { ALL_DESTINATIONS, NESTED_ROUTES } = await import("./destinations.js");
const { consolePages, resolvePage } = await import("./active-page.js");
const { PageTitle, PageActionsEnd, TITLE_FLOOR_CH, titleMinWidth } = await import("./page-title.js");
const { PageActionsProvider, usePageActions } = await import("./page-actions.js");
const { BAR_ITEMS } = await import("./bar-items.js");

after(() => {
  cleanup();
  teardown();
});

/** Invented, as everything in this repo's fixtures is. */
const CONSOLE_ID = "view-monitor-world";
const CONSOLE_NAME = "Monitor World";
/** Longer than the floor on purpose: a console name is the operator's own prose
 *  and is the one page name with no length at all. */
const LONG_CONSOLE_ID = "view-broadcast-gallery";
const LONG_CONSOLE_NAME = "Broadcast Gallery Left";

const VIEWS = [
  { id: CONSOLE_ID, name: CONSOLE_NAME, kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: LONG_CONSOLE_ID, name: LONG_CONSOLE_NAME, kind: "custom", surface: "console", createdAt: "2026-01-01T00:00:00.000Z" },
] as unknown as NonNullable<Parameters<typeof consolePages>[0]>;

const CONSOLES = consolePages(VIEWS);

/**
 * Every page name the SHELL owns, from the tables the shell actually resolves
 * against. A console's name is the operator's and is deliberately not in here.
 */
const SHELL_LABELS: string[] = [
  ...ALL_DESTINATIONS.map((d) => d.label),
  ...NESTED_ROUTES.flatMap((r) => (r.label ? [r.label] : [])),
];

describe("the floor the page name shortens to", () => {
  test("the label list really is the shell's, and it is not empty", () => {
    // If this reads empty, every assertion below passes vacuously.
    assert.ok(SHELL_LABELS.length >= 11, `only ${SHELL_LABELS.length} shell labels`);
    for (const expected of ["Home", "Integrations", "ScriptView", "History"]) {
      assert.ok(SHELL_LABELS.includes(expected), `${expected} is not in the shell's label tables`);
    }
  });

  test("no name the shell owns can ever be ellipsised", () => {
    // The REASON for the number 14. A shell label at or under the floor is
    // pinned to `max-content` and cannot shrink at all, so this is not an
    // approximation about font metrics — it is the branch the name takes.
    const overLong = SHELL_LABELS.filter((label) => label.length > TITLE_FLOOR_CH);
    assert.deepEqual(
      overLong,
      [],
      `these page names are longer than the ${TITLE_FLOOR_CH}-character floor and would ` +
        "come out with an ellipsis in the context bar — shorten the label, or raise " +
        "TITLE_FLOOR_CH and re-measure the strip at 1024px with a maxed bar",
    );
  });

  test("the longest shell label is named, so raising it is a decision", () => {
    // An EXACT reading, not a bound. "Integrations" is the one with the least
    // room to spare, and a longer destination arriving should have to come
    // through here rather than through a floor with slack in it.
    const longest = [...SHELL_LABELS].sort((a, b) => b.length - a.length)[0];
    assert.equal(longest, "Integrations");
    assert.equal(longest.length, 12);
    assert.equal(TITLE_FLOOR_CH, 14);
  });

  test("a short name is pinned to its own width and cannot shrink", () => {
    assert.equal(titleMinWidth("Home"), "max-content");
    assert.equal(titleMinWidth("Integrations"), "max-content");
    // Exactly at the floor is still pinned — the boundary belongs to the branch
    // that cannot lose a character.
    assert.equal(titleMinWidth("x".repeat(TITLE_FLOOR_CH)), "max-content");
  });

  test("a console name longer than the floor shrinks to the floor, never to nothing", () => {
    assert.equal(titleMinWidth(LONG_CONSOLE_NAME), `${TITLE_FLOOR_CH}ch`);
    assert.equal(titleMinWidth("x".repeat(200)), `${TITLE_FLOOR_CH}ch`);
  });

  test("no name resolves to a zero floor, whatever its length", () => {
    // The blank-heading bug, guarded at the width where it could come back.
    // Walked over every real page name plus the degenerate ones.
    for (const label of [...SHELL_LABELS, CONSOLE_NAME, LONG_CONSOLE_NAME, "", "x"]) {
      const min = titleMinWidth(label);
      assert.notEqual(min, "0", `"${label}" may shrink to nothing`);
      assert.notEqual(min, "0ch", `"${label}" may shrink to nothing`);
      assert.ok(
        min === "max-content" || min === `${TITLE_FLOOR_CH}ch`,
        `"${label}" got an unexpected floor: ${min}`,
      );
    }
  });
});

describe("the name is the shell's, not an item the operator placed", () => {
  test("it is not in BAR_ITEMS, and BAR_ITEMS is still exactly the nine readings", () => {
    // "Never drop an item the operator chose" holds only while the thing the
    // ladder shortens first is NOT one of them. Asserted as an exact set: an id
    // for the page name added here later fails this rather than quietly making
    // the invariant false.
    const ids = Object.keys(BAR_ITEMS).sort();
    assert.deepEqual(ids, [
      "clock",
      "current-item",
      "integration-health",
      "live-timer",
      "plan",
      "recording",
      "scores",
      "service-type",
      "streaming",
    ]);
    for (const forbidden of ["page-title", "title", "page-name", "page"]) {
      assert.equal(forbidden in BAR_ITEMS, false, `the page name became a configurable bar item as "${forbidden}"`);
    }
  });
});

describe("what the strip renders, and on which surface", () => {
  const draw = (pathname: string) =>
    render(
      <PageActionsProvider>
        <PageTitle active={resolvePage(pathname, CONSOLES)} />
      </PageActionsProvider>,
    );

  test("a long console name carries the floor, not max-content", () => {
    const { container } = draw(`/consoles/${LONG_CONSOLE_ID}`);
    const h1 = container.querySelector("h1");
    assert.equal(h1?.textContent, LONG_CONSOLE_NAME);
    assert.equal(h1?.style.minWidth, `${TITLE_FLOOR_CH}ch`);
    cleanup();
  });

  test("the name is hidden below 640px, so a phone's strip is the one it always was", () => {
    // The phone merge was measured 3px past the floor with nothing left to
    // ellipsise. `display: none` contributes no width, so the fitter sees the
    // phone bar unchanged — and that is only true while this class is here.
    const { container } = draw("/");
    const h1 = container.querySelector("h1");
    assert.equal(h1?.textContent, "Home");
    assert.ok(
      h1?.classList.contains("max-sm:hidden"),
      "the page name would render on a phone, on top of the top bar that already shows it",
    );
    cleanup();
  });

  test("the name is the only thing on the row allowed to shrink", () => {
    // `.bar-item` is shrink-0 and prose opts in at the floor only, so the name
    // must NOT carry shrink-0 — if it did, the strip would jump straight to
    // giving up the operator's words instead of the shell's.
    const { container } = draw("/");
    assert.equal(container.querySelector("h1")?.classList.contains("shrink-0"), false);
    cleanup();
  });
});

describe("the route's own controls", () => {
  function Fixture({ pathname }: { pathname: string }) {
    usePageActions(<button type="button">Edit</button>, []);
    return <PageActionsEnd active={resolvePage(pathname, CONSOLES)} />;
  }
  const draw = (pathname: string) =>
    render(
      <PageActionsProvider>
        <Fixture pathname={pathname} />
      </PageActionsProvider>,
    );

  test("a page that supplies controls still gets them, in the strip", () => {
    // Home's Edit control is the only thing in this slot today, and losing it to
    // the merge would take edit mode with it.
    const { container } = draw("/");
    assert.equal(container.querySelector("button")?.textContent, "Edit");
    cleanup();
  });

  test("they are desktop-only; the phone's top bar carries its own copy", () => {
    const { container } = draw("/");
    assert.ok(container.querySelector("div")?.classList.contains("max-sm:hidden"));
    cleanup();
  });

  test("a child route draws its own heading, and its own controls with it", () => {
    const { container } = draw(`/screens/${CONSOLE_ID}/edit`);
    assert.equal(!!container.querySelector("button"), false);
    cleanup();
  });
});
