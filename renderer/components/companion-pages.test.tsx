// companion-pages.test.tsx — the shared Companion page picker: the page list, the
// dropdown and its arrows, and the grid in both of its modes (read-only, and picking).
//
// What is guarded, and why each is a bug rather than a nicety:
//
//  - EMPTY PAGES ARE LEFT OUT of the dropdown AND the arrows. A real install has 99
//    pages and more than half are empty; an arrow that stopped on one, or a dropdown
//    that listed 59 pages of nothing, is the control it replaces. A page that has since
//    gone empty still steps to the nearest listed one.
//  - THE FILTER TAKES A NUMBER OR A NAME, so "17" and "proj" both find page 17.
//  - ESCAPE IN THE LIST CLOSES THE LIST AND NOTHING BEHIND IT: a bubble-phase listener
//    (the layout editor's) never hears it, and the list is marked for a capture-phase
//    one (the integration dialog's). Focus goes back to the button that opened it.
//  - THE GRID IS COMPANION'S: each key's own background and text colour, its icon, a
//    reference marked "ref", a page control drawn blank, in the --su-companion-* look.
//  - THE GRID DRAWS THE PAGE'S USED EXTENT as the server sends it, each key in its own
//    row and column.
//  - READ-ONLY MEANS NO CONTROLS; PICKING MEANS A KEY THAT CAN BE PICKED IS A BUTTON,
//    a reference picks what it points at, the picked key says so, and a key that cannot
//    be picked (a page control, an unresolved reference) is not a control at all.
//
// NOT unit-tested here, and driven in a browser instead: the keys' square size, the
// sideways scroll of a page wider than its box, and the dropdown's stacking over the
// grid. jsdom loads no stylesheet and reports every offsetWidth as 0.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND (see test-dom.ts).

import { strict as assert } from "node:assert";
import { after, afterEach, describe, test } from "node:test";

import { installRenderDom, settle } from "../test-dom.js";

const teardown = installRenderDom();

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CompanionPageGrid, CompanionPageSelect, filterPages, listedPages, neighbourPage, pageName } = await import("./companion-pages.js");

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
const VIEW = {
  page: 17,
  name: "Projectors",
  cols: 12,
  rows: 5,
  keys: [
    key(0, 0, { label: "Lamp on", bg: "#aa0000", fg: "#ffff00" }),
    key(0, 1, { label: "Lamp off", icon: "data:image/png;base64,AAAA" }),
    key(1, 3, { kind: "reference", label: "Shutter", target: { page: 20, row: 2, col: 1 } }),
    key(2, 0, { kind: "page-control", label: "PAGE UP", pickable: false }),
    key(3, 2, { kind: "reference", label: "Nothing", pickable: false }),
    key(4, 11, { label: "Far right" }),
  ],
};

afterEach(() => cleanup());
after(async () => {
  cleanup();
  await settle();
  teardown();
});

const press = (el: Element | null | undefined) => {
  assert.ok(el, "nothing to press");
  return act(async () => {
    fireEvent.click(el as HTMLElement);
  });
};
const keyAt = (where: string) => document.querySelector(`[data-companion-key="${where}"]`) as HTMLElement | null;
const optionNumbers = () => [...document.querySelectorAll("[data-page-option]")].map((o) => o.getAttribute("data-page-option"));
const pageButton = () => screen.getByRole("button", { name: "Companion page" });

describe("the page list", () => {
  test("listedPages leaves out the empty pages and sorts by page number", () => {
    assert.deepEqual(listedPages([...PAGES].reverse()).map((p) => p.page), [1, 17, 20]);
    assert.deepEqual(listedPages(undefined), []);
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

  test("neighbourPage steps over the listed pages, stops at the ends, and starts from a page that is not listed", () => {
    const listed = listedPages(PAGES);
    assert.equal(neighbourPage(listed, 1, 1), 17, "the arrow stopped on an empty page");
    assert.equal(neighbourPage(listed, 17, -1), 1);
    assert.equal(neighbourPage(listed, 20, 1), null);
    assert.equal(neighbourPage(listed, 1, -1), null);
    assert.equal(neighbourPage(listed, 2, 1), 17, "a page that has since gone empty could not step on");
    assert.equal(neighbourPage(listed, 2, -1), 1);
    assert.equal(neighbourPage(listed, null, 1), null);
  });

  test("pageName falls back to Page N for an unnamed page", () => {
    assert.equal(pageName({ page: 2, name: "  " }), "Page 2");
    assert.equal(pageName({ page: 1, name: "Main" }), "Main");
  });
});

describe("the dropdown and the arrows", () => {
  function Harness({ start = 1, onEscape }: { start?: number; onEscape?: () => void }) {
    const [page, setPage] = React.useState<number>(start);
    React.useEffect(() => {
      if (!onEscape) return;
      const h = (e: KeyboardEvent) => e.key === "Escape" && onEscape();
      window.addEventListener("keydown", h);
      return () => window.removeEventListener("keydown", h);
    }, [onEscape]);
    return (
      <>
        <CompanionPageSelect pages={listedPages(PAGES)} page={page} onPage={setPage} />
        <output data-now={page} />
      </>
    );
  }
  const now = () => document.querySelector("[data-now]")?.getAttribute("data-now");

  test("lists only pages with buttons, with how many, and says empty pages are left out", async () => {
    render(<Harness />);
    await press(pageButton());
    assert.deepEqual(optionNumbers(), ["1", "17", "20"]);
    assert.match(document.body.textContent ?? "", /3 pages with buttons · empty pages left out/);
  });

  test("the filter box has focus on opening; a filter finds a page by number or name, and Enter picks the highlighted one", async () => {
    render(<Harness />);
    await press(pageButton());
    const filter = screen.getByRole("textbox", { name: "Filter pages" });
    assert.equal(document.activeElement === filter, true, "the filter did not take focus");
    await act(async () => {
      fireEvent.change(filter, { target: { value: "proj" } });
    });
    assert.deepEqual(optionNumbers(), ["17"]);
    await act(async () => {
      fireEvent.keyDown(filter, { key: "Enter" });
    });
    assert.equal(now(), "17");
    assert.equal(document.querySelector("[data-page-option]") === null, true, "the dropdown stayed open after a pick");
    assert.match(pageButton().textContent ?? "", /17\s*Projectors/);
  });

  test("a filter that matches nothing says so", async () => {
    render(<Harness />);
    await press(pageButton());
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: "Filter pages" }), { target: { value: "zzz" } });
    });
    assert.match(document.body.textContent ?? "", /No page matches/);
  });

  test("the arrows skip empty pages, and each is dead at its end", async () => {
    render(<Harness />);
    assert.equal((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled, true);
    await press(screen.getByRole("button", { name: "Next page" }));
    assert.equal(now(), "17");
    await press(screen.getByRole("button", { name: "Next page" }));
    assert.equal(now(), "20");
    assert.equal((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled, true);
    await press(screen.getByRole("button", { name: "Previous page" }));
    assert.equal(now(), "17");
  });

  test("an outside press closes the list", async () => {
    render(<Harness />);
    await press(pageButton());
    assert.ok(document.querySelector("[data-page-option]"));
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    assert.equal(document.querySelector("[data-page-option]") === null, true);
  });

  test("Escape in the filter closes the list, gives focus back, and is heard by nothing behind it", async () => {
    let heard = 0;
    render(<Harness onEscape={() => heard++} />);
    await press(pageButton());
    assert.equal(document.querySelector("[data-escape-first]") !== null, true, "the list is not marked for a capture-phase owner");
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Filter pages" }), { key: "Escape" });
    });
    assert.equal(document.querySelector("[data-page-option]") === null, true, "Escape left the list open");
    assert.equal(heard, 0, "Escape reached a listener behind the list");
    assert.equal(document.activeElement === pageButton(), true, "focus did not go back to the button");
    // With the list shut, Escape is the owner's again.
    await act(async () => {
      fireEvent.keyDown(pageButton(), { key: "Escape" });
    });
    assert.equal(heard, 1);
  });
});

describe("the grid, read-only", () => {
  const mount = () => render(<CompanionPageGrid view={VIEW} />);

  test("each key carries Companion's own colours, and a key with none takes the default", () => {
    mount();
    const lamp = keyAt("p17 r0 c0")!;
    assert.equal(lamp.style.backgroundColor, "rgb(170, 0, 0)");
    assert.equal(lamp.style.color, "rgb(255, 255, 0)");
    assert.equal(keyAt("p17 r4 c11")!.style.backgroundColor, "", "a key with no colour of its own was given one");
  });

  test("an icon is drawn above its label", () => {
    mount();
    const withIcon = keyAt("p17 r0 c1")!;
    assert.equal(withIcon.querySelector("img")?.getAttribute("src"), "data:image/png;base64,AAAA");
    assert.match(withIcon.textContent ?? "", /Lamp off/);
    assert.equal(keyAt("p17 r0 c0")!.querySelector("img") === null, true);
  });

  test("a reference is drawn as the key it points at, with a ref chip", () => {
    mount();
    const ref = keyAt("p17 r1 c3")!;
    assert.equal(ref.getAttribute("data-key-kind"), "reference");
    assert.match(ref.textContent ?? "", /Shutter/);
    assert.match(ref.textContent ?? "", /ref/);
    assert.match(ref.getAttribute("title") ?? "", /reference/);
  });

  test("a page control is a blank key: no label, nothing to read", () => {
    mount();
    assert.equal(keyAt("p17 r2 c0") === null, true, "a page control drew as a key");
    assert.ok(!(document.body.textContent ?? "").includes("PAGE UP"));
  });

  test("draws the extent the server sent, each key in its own row and column", () => {
    mount();
    const grid = document.querySelector('[role="img"]') as HTMLElement;
    assert.equal(grid.style.gridTemplateColumns, "repeat(12, minmax(2.25rem, 1fr))");
    assert.equal(grid.children.length, 12 * 5, "the grid is not cols x rows cells");
    assert.equal(grid.children[4 * 12 + 11] === keyAt("p17 r4 c11"), true, "the last key is not in the last cell");
    assert.equal(grid.children[1 * 12 + 3] === keyAt("p17 r1 c3"), true, "a key is not in its own row and column");
    assert.equal(document.querySelector('[data-page-grid="17"]') !== null, true);
  });

  test("no key is a control", async () => {
    mount();
    assert.equal(document.querySelectorAll("button, [role='button'], [role='gridcell'], a").length, 0);
  });

  test("draws in the Companion tokens, not in colours of its own", () => {
    mount();
    const classes = [...document.querySelectorAll("[class]")].map((e) => e.getAttribute("class") ?? "").join(" ");
    assert.match(classes, /--su-companion-canvas/);
    assert.match(classes, /--su-companion-key/);
    assert.doesNotMatch(classes, /\bbg-(black|white)\b|bg-\[#|bg-white\/|bg-black\//);
  });
});

describe("the grid, picking", () => {
  function mountPicking(over: { disabled?: boolean; picked?: { page: number; row: number; col: number } } = {}) {
    const picks: { page: number; row: number; col: number }[] = [];
    render(
      <CompanionPageGrid
        view={VIEW}
        pick={{
          onPick: (at) => picks.push(at),
          isPicked: (at) => over.picked !== undefined && over.picked.page === at.page && over.picked.row === at.row && over.picked.col === at.col,
          disabled: over.disabled,
        }}
      />,
    );
    return picks;
  }

  test("a key that can be picked is a button in a grid, and picking it says where", async () => {
    const picks = mountPicking();
    assert.equal(keyAt("p17 r0 c0")!.getAttribute("role"), "gridcell");
    await press(keyAt("p17 r0 c0"));
    assert.deepEqual(picks, [{ page: 17, row: 0, col: 0 }]);
  });

  test("a reference picks what it points at", async () => {
    const picks = mountPicking();
    await press(keyAt("p17 r1 c3"));
    assert.deepEqual(picks, [{ page: 20, row: 2, col: 1 }]);
  });

  test("the picked key says so, and a reference to it does too", () => {
    mountPicking({ picked: { page: 20, row: 2, col: 1 } });
    assert.equal(keyAt("p17 r1 c3")!.getAttribute("aria-pressed"), "true");
    assert.equal(keyAt("p17 r0 c0")!.getAttribute("aria-pressed"), "false");
  });

  test("a key that cannot be picked is drawn dimmed and is not a control", async () => {
    const picks = mountPicking();
    const dead = keyAt("p17 r3 c2")!;
    assert.equal(dead.tagName, "SPAN");
    assert.equal(dead.getAttribute("role"), null);
    await press(dead);
    assert.deepEqual(picks, []);
    assert.equal(keyAt("p17 r2 c0") === null, true, "a page control is a key");
  });

  test("while a write is in flight no key picks", async () => {
    const picks = mountPicking({ disabled: true });
    assert.equal((keyAt("p17 r0 c0") as HTMLButtonElement).disabled, true);
    await press(keyAt("p17 r0 c0"));
    assert.deepEqual(picks, []);
  });
});
