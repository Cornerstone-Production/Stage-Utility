// The Import from Companion dialog, rendered over a stubbed server.
//
// What is under test is the part that decides what gets created when somebody
// presses one button:
//
//  - NOTHING in the Single buttons section is ticked. A pair is plainly a thing
//    being turned on and off; a single button is whatever somebody put on a
//    Companion page, and a pre-ticked camera shot is a cue somebody can say by
//    accident. A default that flipped the other way would be silent.
//  - the search filters the single buttons and NOT the pairs.
//  - the footer says what will happen, with the grammar right at 0 and 1.
//  - the request carries BOTH `pairs` and `buttons`. A control that renders and
//    does nothing is this repo's named scar, and "the dialog has a second
//    section" is not "the second section imports anything".
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND. node:assert builds its
// failure message by inspecting `actual`, and inspecting a live jsdom element
// does not terminate in any useful time — a sibling file ran for 81.5 s on one
// such assertion and was killed with no line number. Every assertion here is on
// a string, a number or a boolean.
//
// NOT unit-tested here, and driven in a browser against the real server instead:
// the sticky section headings, that the list scrolls at all, and the `switch` /
// `script` tags reading as chips rather than as stray words. jsdom loads no
// stylesheet, so `position: sticky`, `overflow-y` and every colour are not
// observable in it at all.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

const teardown = installRenderDom();

interface StubButton {
  page: number;
  pageId: string;
  pageName: string;
  row: number;
  col: number;
  label: string;
  drives: string[];
  actionIds: string[];
  slug: string;
  exists: boolean;
}

const button = (over: Partial<StubButton>): StubButton => ({
  page: 1,
  pageId: "page-one",
  pageName: "Room A: Screens",
  row: 0,
  col: 0,
  label: "Take Screens",
  drives: [],
  actionIds: ["a1"],
  slug: "take_screens",
  exists: false,
  ...over,
});

const PAIRS = [
  {
    base: "Projectors",
    slug: "projectors",
    page: 1,
    pageName: "Room A: Screens",
    on: button({ col: 1, label: "Projectors ON" }),
    off: button({ col: 2, label: "Projectors OFF" }),
    suggested: true,
    exists: false,
  },
];

let SINGLES: StubButton[] = [];
let ok = true;

/** Every request the stub was handed, so the payload can be read back. */
let requests: { url: string; method: string; body: string | null }[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/events/subscribe")) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  }
  requests.push({
    url,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : null,
  });
  let body: unknown = {};
  if (url.includes("/api/companion/pairs")) {
    body = ok ? { ok: true, pairs: PAIRS, buttons: SINGLES } : { ok: false, reason: "EHOSTUNREACH", pairs: [], buttons: [] };
  } else if (url.includes("import-pairs")) {
    body = { created: ["x"], skipped: [] };
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, act, fireEvent, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { ImportPairsDialog, importFooterLabel, matchesButtonSearch } = await import("./companion-cues.js");

/** Several macrotasks: the query, its re-render and the portal are separate turns. */
const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let client: InstanceType<typeof QueryClient> | null = null;

async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ImportPairsDialog, {
        open: true,
        onOpenChange: () => {},
        onImported: () => {},
      }),
    ),
  );
  await settle();
  return view;
}

beforeEach(() => {
  requests = [];
  ok = true;
  SINGLES = [
    button({ row: 2, col: 3, label: "Take Screens", slug: "take_screens" }),
    button({ row: 2, col: 1, label: "House Lights ON", slug: "house_lights_on" }),
    button({
      page: 3,
      pageId: "page-three",
      pageName: "Room A: Cameras",
      row: 0,
      col: 0,
      label: "Cam 1",
      slug: "cam_1",
    }),
  ];
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

/** Every checkbox's accessible name and checked state, as strings. */
function boxes(): { name: string; checked: string; disabled: boolean }[] {
  return screen.getAllByRole("checkbox").map((el) => ({
    name: el.getAttribute("aria-label") ?? "",
    checked: el.getAttribute("aria-checked") ?? "",
    disabled: (el as HTMLButtonElement).disabled,
  }));
}

/** The `script`-tagged rows' labels, in order — the Single buttons section. */
function singleRowNames(): string[] {
  return [...document.querySelectorAll("[data-cue-kind='script']")].map(
    (tag) => tag.parentElement?.querySelector("span > span")?.textContent ?? "",
  );
}

const footer = (): string =>
  [...document.querySelectorAll("button")]
    .map((b) => b.textContent ?? "")
    .find((t) => t.startsWith("Import")) ?? "";

describe("importFooterLabel", () => {
  test("says what will happen, and omits a side that is zero", () => {
    // "Import 0 pairs and 1 button" is a sentence nobody would type, and this
    // footer is the last thing read before something presses real buttons.
    assert.equal(importFooterLabel(0, 0), "Import");
    assert.equal(importFooterLabel(1, 0), "Import 1 pair");
    assert.equal(importFooterLabel(2, 0), "Import 2 pairs");
    assert.equal(importFooterLabel(0, 1), "Import 1 button");
    assert.equal(importFooterLabel(0, 4), "Import 4 buttons");
    assert.equal(importFooterLabel(1, 1), "Import 1 pair and 1 button");
    assert.equal(importFooterLabel(3, 2), "Import 3 pairs and 2 buttons");
  });
});

describe("matchesButtonSearch", () => {
  test("matches the label, the page and the cue name", () => {
    const b = button({ label: "Take Screens", pageName: "Room A: Screens", slug: "take_screens" });
    assert.equal(matchesButtonSearch(b, ""), true);
    assert.equal(matchesButtonSearch(b, "  "), true);
    assert.equal(matchesButtonSearch(b, "take"), true);
    // The cue name is what somebody says out loud, and often the only part they
    // remember. A label search alone would not find it.
    assert.equal(matchesButtonSearch(b, "take_screens"), true);
    assert.equal(matchesButtonSearch(b, "cameras"), false);
    assert.equal(matchesButtonSearch(b, "ROOM a"), true);
  });
});

describe("the import dialog", () => {
  test("offers both sections, with a count on each", async () => {
    await mount();
    assert.equal(singleRowNames().length, 3);
    assert.equal(document.querySelectorAll("[data-cue-kind='switch']").length, 1);
    const text = document.body.textContent ?? "";
    assert.ok(text.includes("ON/OFF pairs"), "the pairs heading is missing");
    assert.ok(text.includes("Single buttons"), "the single buttons heading is missing");
  });

  test("NOTHING in the single buttons section is ticked, and the suggested pair is", async () => {
    await mount();
    assert.deepEqual(boxes(), [
      { name: "Projectors · Room A: Screens", checked: "true", disabled: false },
      { name: "Take Screens · Room A: Screens", checked: "false", disabled: false },
      { name: "House Lights ON · Room A: Screens", checked: "false", disabled: false },
      { name: "Cam 1 · Room A: Cameras", checked: "false", disabled: false },
    ]);
    assert.equal(footer(), "Import 1 pair");
  });

  test("an already-imported button is offered disabled, not hidden", async () => {
    SINGLES = [button({ row: 2, col: 3, exists: true })];
    await mount();
    assert.deepEqual(
      boxes().map((b) => b.disabled),
      [false, true],
    );
  });

  test("the search filters the single buttons and leaves the pairs alone", async () => {
    await mount();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search single buttons"), { target: { value: "cam" } });
    });
    assert.deepEqual(singleRowNames(), ["Cam 1"]);
    assert.equal(
      document.querySelectorAll("[data-cue-kind='switch']").length,
      1,
      "the search must not filter the pairs — they have their own section",
    );
  });

  test("ticking a button changes the footer and posts BOTH lists", async () => {
    await mount();
    await act(async () => {
      screen.getByLabelText("Cam 1 · Room A: Cameras").click();
    });
    assert.equal(footer(), "Import 1 pair and 1 button");

    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").startsWith("Import"))!
        .click();
    });
    await settle();

    const post = requests.find((r) => r.url.includes("import-pairs"));
    assert.ok(post, "the import was never posted");
    const body = JSON.parse(post.body ?? "{}") as {
      pairs: { slug: string }[];
      buttons: { slug: string; page: number; row: number; col: number }[];
    };
    assert.deepEqual(
      body.pairs.map((p) => p.slug),
      ["projectors"],
    );
    // The COORDINATES travel, not just the name — this is what the server
    // creates the press action from.
    assert.deepEqual(body.buttons, [
      {
        page: 3,
        pageId: "page-three",
        pageName: "Room A: Cameras",
        row: 0,
        col: 0,
        label: "Cam 1",
        drives: [],
        actionIds: ["a1"],
        slug: "cam_1",
        exists: false,
      },
    ]);
  });

  test("unticking the pair leaves a button-only import, and the grammar follows", async () => {
    await mount();
    await act(async () => {
      screen.getByLabelText("Projectors · Room A: Screens").click();
    });
    await act(async () => {
      screen.getByLabelText("Take Screens · Room A: Screens").click();
    });
    await act(async () => {
      screen.getByLabelText("Cam 1 · Room A: Cameras").click();
    });
    assert.equal(footer(), "Import 2 buttons");

    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").startsWith("Import"))!
        .click();
    });
    await settle();
    const body = JSON.parse(requests.find((r) => r.url.includes("import-pairs"))!.body ?? "{}") as {
      pairs: unknown[];
      buttons: { slug: string }[];
    };
    assert.deepEqual(body.pairs, []);
    assert.deepEqual(
      body.buttons.map((b) => b.slug),
      ["take_screens", "cam_1"],
    );
  });

  test("an unreachable Companion says so instead of showing two empty sections", async () => {
    ok = false;
    await mount();
    assert.ok((document.body.textContent ?? "").includes("EHOSTUNREACH"));
    assert.equal(screen.queryAllByRole("checkbox").length, 0);
  });
});
