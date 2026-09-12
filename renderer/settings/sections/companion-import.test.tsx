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
  /** Where this button's own device reports its state. See companion-state-source.ts. */
  stateSource?: StubSource;
}

/** An inferred state source, or none. */
type StubSource = { variable: string; onValue: string; offValue: string; moduleId: string } | null;

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
    // Set per test. Annotated so a test may assign one — the inferred literal
    // would otherwise be `null` and nothing could be written to it.
    stateSource: null as StubSource,
    // Set per test, like stateSource: the literal would otherwise be `false`
    // and nothing could be written to it.
    learnable: false as boolean,
    exists: false,
  },
];

let SINGLES: StubButton[] = [];
/** What Companion has, for the per-pair State select. */
let CUSTOM_VARIABLES: string[] = [];
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
    body = ok
      ? { ok: true, pairs: PAIRS, buttons: SINGLES, customVariables: CUSTOM_VARIABLES }
      : { ok: false, reason: "EHOSTUNREACH", pairs: [], buttons: [] };
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
  CUSTOM_VARIABLES = [];
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

  test("the search filters BOTH sections, and the count says how many are left", async () => {
    // One field over the whole dialog. A field that filtered only the singles
    // left an operator who could not find a button unable to tell whether it
    // was offered as half of a pair — which is the question the two sections
    // exist to answer.
    await mount();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search buttons"), { target: { value: "cam" } });
    });
    assert.deepEqual(singleRowNames(), ["Cam 1"]);
    assert.equal(
      document.querySelectorAll("[data-cue-kind='switch']").length,
      0,
      "the pair matches nothing typed, so its row must be gone too",
    );
    assert.equal(document.querySelector("[data-import-search-count]")?.textContent, "1 of 4");
  });

  test("a query that matches a pair by its OFF cue name keeps the pair row", async () => {
    // `projectors_off` is the name in somebody's Home Assistant config, and it
    // is on the row — a matcher reading only the base would not find it.
    await mount();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search buttons"), { target: { value: "projectors_off" } });
    });
    assert.equal(document.querySelectorAll("[data-cue-kind='switch']").length, 1);
    assert.deepEqual(singleRowNames(), []);
  });

  test("a section with no matches says so under its heading, rather than vanishing", async () => {
    await mount();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search buttons"), { target: { value: "cam" } });
    });
    // Both headings are still there — a heading that disappears reads as "this
    // Companion has no pairs", a different answer from "none of them match".
    const text = document.body.textContent ?? "";
    assert.match(text, /ON\/OFF pairs/);
    assert.match(text, /Single buttons/);
    assert.match(text, /No matches/);
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

// ── Select all / Clear, per section ─────────────────────────────────────────
//
// Each section's own pair, acting only on what THAT section shows — a pairs
// Select all must not touch the singles, and a singles Select all with a
// search active must not reach past what the search is hiding. An
// already-imported row (`exists: true`) is never selected, because it is
// disabled for the same reason: its cue already exists.
describe("Select all / Clear per section", () => {
  test("pairs Select all ticks every pair not already existing, and leaves singles untouched", async () => {
    PAIRS.push({ ...PAIRS[0]!, page: 2, slug: "lighting_projectors", base: "Lighting", exists: true });
    try {
      await mount();
      // Untick the one suggested pair first, so Select all is doing the work.
      await act(async () => {
        screen.getByLabelText("Projectors · Room A: Screens").click();
      });
      assert.equal(footer(), "Import");

      await act(async () => {
        screen.getByRole("button", { name: "Select all 1 shown pairs" }).click();
      });
      assert.deepEqual(boxes(), [
        { name: "Projectors · Room A: Screens", checked: "true", disabled: false },
        { name: "Lighting · Room A: Screens", checked: "false", disabled: true },
        { name: "Take Screens · Room A: Screens", checked: "false", disabled: false },
        { name: "House Lights ON · Room A: Screens", checked: "false", disabled: false },
        { name: "Cam 1 · Room A: Cameras", checked: "false", disabled: false },
      ]);
      assert.equal(footer(), "Import 1 pair", "the already-imported pair must not have been ticked");
    } finally {
      PAIRS.length = 1;
    }
  });

  test("pairs Select all with a search active ticks only the shown pairs", async () => {
    // The same rule as the singles': Select all over pairs the search has
    // hidden is an import of things the operator cannot see.
    PAIRS.push({ ...PAIRS[0]!, page: 2, slug: "lighting", base: "Lighting", suggested: false });
    try {
      await mount();
      assert.equal(footer(), "Import 1 pair");
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Search buttons"), { target: { value: "projectors" } });
      });
      assert.equal(document.querySelectorAll("[data-cue-kind='switch']").length, 1);

      await act(async () => {
        screen.getByRole("button", { name: "Select all 1 shown pairs" }).click();
      });
      assert.equal(footer(), "Import 1 pair", "the hidden pair must not have been ticked");
    } finally {
      PAIRS.length = 1;
    }
  });

  test("pairs Clear unticks only the pairs section", async () => {
    await mount();
    await act(async () => {
      screen.getByLabelText("Cam 1 · Room A: Cameras").click();
    });
    assert.equal(footer(), "Import 1 pair and 1 button");

    await act(async () => {
      screen.getByRole("button", { name: "Clear pairs" }).click();
    });
    assert.deepEqual(
      boxes().map((b) => b.checked),
      ["false", "false", "false", "true"],
    );
    assert.equal(footer(), "Import 1 button", "clearing pairs must not touch the ticked single button");
  });

  test("singles Select all with a search active ticks only the shown rows", async () => {
    await mount();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search buttons"), { target: { value: "cam" } });
    });
    assert.deepEqual(singleRowNames(), ["Cam 1"]);

    await act(async () => {
      screen.getByRole("button", { name: "Select all 1 shown buttons" }).click();
    });
    // Take Screens and House Lights ON are hidden by the search, so they are
    // not even rendered here — the assertion that they were never ticked is
    // in the request the footer's count implies: 1 pair + 1 button, not 3.
    // The PAIR's box is gone too: one query filters both sections. Its tick
    // survives being filtered out, which is why the footer still counts it.
    assert.deepEqual(
      boxes().map((b) => ({ name: b.name, checked: b.checked })),
      [{ name: "Cam 1 · Room A: Cameras", checked: "true" }],
    );
    assert.equal(footer(), "Import 1 pair and 1 button");

    // Clear the search and confirm the two hidden rows were never ticked.
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search buttons"), { target: { value: "" } });
    });
    assert.deepEqual(
      boxes().map((b) => b.checked),
      ["true", "false", "false", "true"],
      "a hidden row was ticked by Select all",
    );
  });

  test("singles Clear unticks that section only", async () => {
    await mount();
    await act(async () => {
      screen.getByLabelText("Take Screens · Room A: Screens").click();
    });
    await act(async () => {
      screen.getByLabelText("Cam 1 · Room A: Cameras").click();
    });
    assert.equal(footer(), "Import 1 pair and 2 buttons");

    await act(async () => {
      screen.getByRole("button", { name: "Clear single buttons" }).click();
    });
    assert.deepEqual(
      boxes().map((b) => b.checked),
      ["true", "false", "false", "false"],
    );
    assert.equal(footer(), "Import 1 pair", "the pair must survive a singles Clear");
  });
});

// ── The State select ──────────────────────────────────────────────────────────
//
// Chosen here, the binding is written onto the `_on` rule as it is created. Three
// things are silent when they break:
//
//  - the DEFAULT. A variable named after the pair is the one the operator meant;
//    guessing more loosely would bind `projectors` to `projectors_last_error`
//    and report the wrong thing with nobody having chosen it.
//  - the REQUEST. A select that renders and does not reach the request is this
//    repo's named scar, and the resulting cues look right until Home Assistant
//    reports what it asked for rather than what happened.
//
// NOT unit-tested, and driven in a headless browser instead: that clicking the
// select does not toggle the pair's checkbox. The pair row used to be one
// <label> wrapping everything, and in a real browser a click on a control
// inside a label activates that label's control — so choosing a variable
// unticked the pair it was for. jsdom's fireEvent.change does not synthesise
// label activation at all: a test for it passed with the row restored to a
// single <label>, which is a vacuous guard, so it was deleted rather than
// shipped. The row is a <div> with the label around the checkbox and the words
// only.
//
describe("the per-pair State select", () => {
  const importNow = async () => {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").startsWith("Import"))!
        .click();
    });
    await settle();
    return JSON.parse(requests.find((r) => r.url.includes("import-pairs"))!.body ?? "{}") as {
      pairs: { slug: string; stateVariable?: string }[];
    };
  };

  const stateSelect = (): HTMLSelectElement | null =>
    document.querySelector('select[aria-label="State variable for Projectors · Room A: Screens"]');

  test("the accessible name carries the PAGE, so two pairs with one base differ", async () => {
    // The real Companion this was built against has "Projectors" on two pages.
    // Two selects with the same accessible name are indistinguishable to a
    // screen reader and to anything driving the page.
    CUSTOM_VARIABLES = ["projectors_state"];
    PAIRS.push({
      ...PAIRS[0]!,
      page: 2,
      pageName: "Room A: Lighting",
      slug: "room_a_lighting_projectors",
    });
    try {
      await mount();
      assert.deepEqual(
        // The pairs section's selects only — the single buttons each have a
        // Toggle select of their own, covered further down.
        [...document.querySelectorAll("select")]
          .map((el) => el.getAttribute("aria-label") ?? "")
          .filter((n) => n.startsWith("State variable for")),
        [
          "State variable for Projectors · Room A: Screens",
          "State variable for Projectors · Room A: Lighting",
        ],
      );
    } finally {
      PAIRS.length = 1;
    }
  });

  test("is not offered at all when Companion has no custom variables", async () => {
    // A dropdown whose only entry is None is a control that does nothing.
    CUSTOM_VARIABLES = [];
    await mount();
    assert.equal(stateSelect() === null, true);
    const body = await importNow();
    assert.deepEqual(
      body.pairs.map((p) => p.stateVariable),
      [""],
    );
  });

  test("defaults to the variable named after the pair", async () => {
    CUSTOM_VARIABLES = ["house_lights_state", "projectors_state", "amps"];
    await mount();
    assert.equal(stateSelect()?.value, "projectors_state");
    const body = await importNow();
    assert.deepEqual(
      body.pairs.map((p) => `${p.slug}=${p.stateVariable}`),
      ["projectors=projectors_state"],
    );
  });

  test("defaults to nothing when no variable is named after the pair", async () => {
    // `projectors_last_error` contains the slug and is deliberately NOT a match.
    CUSTOM_VARIABLES = ["projectors_last_error", "amps_state"];
    await mount();
    assert.equal(stateSelect()?.value, "");
    const body = await importNow();
    assert.deepEqual(
      body.pairs.map((p) => p.stateVariable),
      [""],
    );
  });

  test("what is chosen reaches the request", async () => {
    CUSTOM_VARIABLES = ["projectors_state", "amps_state"];
    await mount();
    await act(async () => {
      fireEvent.change(stateSelect()!, { target: { value: "amps_state" } });
    });
    assert.equal(stateSelect()?.value, "amps_state");
    const body = await importNow();
    assert.deepEqual(
      body.pairs.map((p) => p.stateVariable),
      ["amps_state"],
    );
  });

  test("choosing None on a suggested pair sticks, and is sent as blank", async () => {
    // "" is a real choice and has to survive a re-render, or the default
    // re-suggests the variable the operator has just declined.
    CUSTOM_VARIABLES = ["projectors_state"];
    await mount();
    await act(async () => {
      fireEvent.change(stateSelect()!, { target: { value: "" } });
    });
    assert.equal(stateSelect()?.value, "");
    const body = await importNow();
    assert.deepEqual(
      body.pairs.map((p) => p.stateVariable),
      [""],
    );
  });
});

// ── The per-button Toggle select ──────────────────────────────────────────────
//
// A Companion button that is really a TOGGLE — one key for both directions, no
// OFF partner — is imported as a PAIR when a state variable is chosen for it,
// and as one cue when it is not. What is silent when it breaks is the same
// thing as for the pairs select: a control that renders and does not reach the
// request. The cues then look right, and Home Assistant gets a script that
// snaps back and toggles the light again on every tap.
//
// NOT unit-tested here, for the same reason the pairs row is not: that a click
// on this select does not activate the row's checkbox is a real-browser
// behaviour of <label>, and jsdom's fireEvent.change does not synthesise label
// activation at all — a test for it would pass with the row restored to a
// single <label>, which is the vacuous guard this repo keeps shipping. The row
// is a <div> with the label around the checkbox and the words only, and it was
// driven in a browser.
describe("the per-button Toggle select", () => {
  const toggleSelect = (name: string): HTMLSelectElement | null =>
    document.querySelector(`select[aria-label="Toggle with state for ${name}"]`);

  const importNow = async () => {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").startsWith("Import"))!
        .click();
    });
    await settle();
    return JSON.parse(requests.find((r) => r.url.includes("import-pairs"))!.body ?? "{}") as {
      buttons: { slug: string; stateVariable?: string }[];
    };
  };

  test("one select per single button, with the page in the accessible name", async () => {
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    assert.deepEqual(
      [...document.querySelectorAll("select")]
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter((n) => n.startsWith("Toggle with state")),
      [
        "Toggle with state for Take Screens · Room A: Screens",
        "Toggle with state for House Lights ON · Room A: Screens",
        "Toggle with state for Cam 1 · Room A: Cameras",
      ],
    );
  });

  test("nothing is suggested — a single button is only a toggle if somebody says so", async () => {
    // Unlike a pair, where a variable named after the base is the one the
    // operator meant. A pre-chosen variable here would turn a camera shot into
    // a switch nobody asked for.
    CUSTOM_VARIABLES = ["house_lights_state", "house_lights_on"];
    await mount();
    assert.equal(toggleSelect("House Lights ON · Room A: Screens")?.value, "");
  });

  test("is not offered at all when Companion has no custom variables", async () => {
    CUSTOM_VARIABLES = [];
    await mount();
    assert.equal(toggleSelect("House Lights ON · Room A: Screens") === null, true);
  });

  test("choosing a variable ticks that row, so the choice is not lost", async () => {
    // Found in a browser: the select changed, the footer still read "Import 1
    // pair", and pressing Import created nothing for the button whose variable
    // had just been chosen. Picking a variable for one button is the operator
    // saying they want that button.
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    assert.equal(footer(), "Import 1 pair");
    await act(async () => {
      fireEvent.change(toggleSelect("House Lights ON · Room A: Screens")!, {
        target: { value: "house_lights_state" },
      });
    });
    assert.equal(footer(), "Import 1 pair and 1 button");
    assert.deepEqual(
      boxes().map((b) => b.checked),
      ["true", "false", "true", "false"],
      "the row whose variable was chosen is the one that got ticked",
    );
    // Clearing it does NOT untick — unticking is the checkbox's job.
    await act(async () => {
      fireEvent.change(toggleSelect("House Lights ON · Room A: Screens")!, { target: { value: "" } });
    });
    assert.equal(footer(), "Import 1 pair and 1 button");
  });

  test("what is chosen reaches the request, for THAT button only", async () => {
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    await act(async () => {
      fireEvent.change(toggleSelect("House Lights ON · Room A: Screens")!, {
        target: { value: "house_lights_state" },
      });
    });
    // No click on House Lights: choosing its variable ticked it. Cam 1 is
    // ticked by hand, and is the button that must NOT carry a variable.
    await act(async () => {
      screen.getByLabelText("Cam 1 · Room A: Cameras").click();
    });
    const body = await importNow();
    assert.deepEqual(
      body.buttons.map((b) => `${b.slug}=${b.stateVariable ?? "(none)"}`),
      ["house_lights_on=house_lights_state", "cam_1=(none)"],
    );
    // ABSENT, not blank: a `stateVariable: ""` on the wire would be a body the
    // server has to know to ignore, and the server reads any non-blank value as
    // "this is a toggle".
    assert.equal(
      body.buttons.some((b) => "stateVariable" in b && !b.stateVariable),
      false,
      "a button with no variable sent the key anyway",
    );
  });

  test("the row shows the two cue names it would create, and calls itself a switch", async () => {
    CUSTOM_VARIABLES = ["house_lights_state"];
    await mount();
    const before = document.body.textContent ?? "";
    assert.equal(before.includes("house_lights_on / house_lights_off"), false);
    await act(async () => {
      fireEvent.change(toggleSelect("House Lights ON · Room A: Screens")!, {
        target: { value: "house_lights_state" },
      });
    });
    const after = document.body.textContent ?? "";
    // The trailing ON comes off the name: the pair is the house lights, and
    // `house_lights_on_off` is what naming it after the whole label would give.
    assert.equal(after.includes("house_lights_on / house_lights_off"), true);
    // And the tag follows, because it is a switch in Home Assistant now, not a
    // script. Two switch tags on screen: the Projectors pair and this button.
    assert.equal(document.querySelectorAll("[data-cue-kind='switch']").length, 2);
  });
});

// ── An INFERRED state source ──────────────────────────────────────────────────
//
// A button that drives a smart plug, a television or a projector already has
// somewhere to read its state from — the module's own variable — with nothing
// for the operator to build in Companion at all. The dialog offers that as the
// default binding.
//
// What is silent when this breaks: the VALUES. A kasa plug's `power_state`
// holds `On`, not `on`, and the comparison downstream is case-sensitive — so an
// import that carried the variable and not its two values creates a pair that
// reads unknown forever, with a State select on screen that looks correct.
describe("a button's own inferred state source", () => {
  const PLUG = {
    variable: "VCR-Overhead-Light:power_state",
    onValue: "On",
    offValue: "Off",
    moduleId: "tplink-kasasmartplug",
  };
  const PJLINK = {
    variable: "Projectors:powerState",
    onValue: "On",
    offValue: "Off",
    moduleId: "generic-pjlink",
  };

  const stateSelect = (): HTMLSelectElement | null =>
    document.querySelector('select[aria-label="State variable for Projectors · Room A: Screens"]');
  const toggleSelect = (name: string): HTMLSelectElement | null =>
    document.querySelector(`select[aria-label="Toggle with state for ${name}"]`);

  const importNow = async () => {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").startsWith("Import"))!
        .click();
    });
    await settle();
    return JSON.parse(requests.find((r) => r.url.includes("import-pairs"))!.body ?? "{}") as {
      pairs: { slug: string; stateVariable?: string; stateOnValue?: string; stateOffValue?: string }[];
      buttons: { slug: string; stateVariable?: string; stateOnValue?: string; stateOffValue?: string }[];
    };
  };

  /** Every option in a select, as "value|text". */
  const options = (el: HTMLSelectElement | null): string[] =>
    [...(el?.options ?? [])].map((o) => `${o.value}|${o.textContent ?? ""}`);

  test("a pair defaults to its own button's source, with the VALUES", async () => {
    CUSTOM_VARIABLES = [];
    PAIRS[0]!.stateSource = PJLINK;
    try {
      await mount();
      assert.equal(stateSelect()?.value, "Projectors:powerState");
      const body = await importNow();
      assert.deepEqual(
        body.pairs.map((p) => `${p.slug}=${p.stateVariable}/${p.stateOnValue}/${p.stateOffValue}`),
        ["projectors=Projectors:powerState/On/Off"],
      );
    } finally {
      PAIRS[0]!.stateSource = null;
    }
  });

  test("it is offered with no custom variables at all, and says it was inferred", async () => {
    // A Companion with no custom variables at all. Before the inference there
    // was nothing to offer and the select was not rendered; now the only entry
    // is the one nobody had to build. (This comment used to say the install
    // this was built against had none; its 5.0.3+9703 export has ten — but ten
    // against forty pairs is the same problem, and the case below is real for
    // any install that has never made one.)
    CUSTOM_VARIABLES = [];
    PAIRS[0]!.stateSource = PJLINK;
    try {
      await mount();
      assert.deepEqual(options(stateSelect()), [
        "|No state",
        "Projectors:powerState|Projectors:powerState (inferred)",
      ]);
    } finally {
      PAIRS[0]!.stateSource = null;
    }
  });

  test("the inference beats a custom variable merely NAMED after the pair", async () => {
    // `projectors_state` is a guess from a spelling; the inferred source is the
    // connection the button actually drives, read out of Companion's document.
    CUSTOM_VARIABLES = ["projectors_state"];
    PAIRS[0]!.stateSource = PJLINK;
    try {
      await mount();
      assert.equal(stateSelect()?.value, "Projectors:powerState");
    } finally {
      PAIRS[0]!.stateSource = null;
    }
  });

  test("an explicit choice wins, and sends no values with it", async () => {
    // A custom variable an operator's own buttons set holds "on"/"off"; sending
    // the inferred `On`/`Off` alongside it would bind a switch that can never
    // read on.
    CUSTOM_VARIABLES = ["projectors_state"];
    PAIRS[0]!.stateSource = PJLINK;
    try {
      await mount();
      await act(async () => {
        fireEvent.change(stateSelect()!, { target: { value: "projectors_state" } });
      });
      assert.equal(stateSelect()?.value, "projectors_state");
      const body = await importNow();
      assert.deepEqual(
        body.pairs.map((p) => `${p.stateVariable}/${p.stateOnValue ?? "-"}/${p.stateOffValue ?? "-"}`),
        ["projectors_state/-/-"],
      );
    } finally {
      PAIRS[0]!.stateSource = null;
    }
  });

  test("choosing None still sticks over an inferred source", async () => {
    CUSTOM_VARIABLES = [];
    PAIRS[0]!.stateSource = PJLINK;
    try {
      await mount();
      await act(async () => {
        fireEvent.change(stateSelect()!, { target: { value: "" } });
      });
      assert.equal(stateSelect()?.value, "");
      const body = await importNow();
      assert.deepEqual(
        body.pairs.map((p) => p.stateVariable),
        [""],
      );
    } finally {
      PAIRS[0]!.stateSource = null;
    }
  });

  test("a learnable pair says \"will learn\" where None would be", async () => {
    // Nothing in the verified table covers what this pair drives, so leaving
    // the select EMPTY is not "no state" — it is a state source that will be
    // learned from the first press on and off. "No state" there reads as "this
    // pair cannot report its state", which is the opposite.
    //
    // A custom variable named after the pair still wins the default, as it does
    // for every other pair: the operator built it on purpose, and it reports
    // from the first press rather than the third.
    CUSTOM_VARIABLES = ["projectors_state"];
    PAIRS[0]!.learnable = true;
    try {
      await mount();
      assert.deepEqual(options(stateSelect()), ["|will learn", "projectors_state|projectors_state"]);
      assert.equal(stateSelect()?.value, "projectors_state");
      // And choosing the empty option imports the pair unbound, which is what
      // hands it to the learning path.
      await act(async () => {
        fireEvent.change(stateSelect()!, { target: { value: "" } });
      });
      const body = await importNow();
      assert.deepEqual(
        body.pairs.map((p) => p.stateVariable),
        [""],
      );
    } finally {
      PAIRS[0]!.learnable = false;
    }
  });

  test("a pair the table DOES cover says No state, never will learn", async () => {
    // `learnable` is false whenever the inference has an answer: the table is
    // verified and wins, and an operator told a pair "will learn" while it was
    // about to be bound from the table would be told the wrong thing.
    CUSTOM_VARIABLES = ["projectors_state"];
    PAIRS[0]!.stateSource = PJLINK;
    try {
      await mount();
      assert.equal(options(stateSelect()).includes("|will learn"), false);
      assert.equal(options(stateSelect()).includes("|No state"), true);
    } finally {
      PAIRS[0]!.stateSource = null;
    }
  });

  test("with no custom variables at all, a learnable pair still says will learn", async () => {
    // No select is rendered — there is nothing to choose — so the words have to
    // be there on their own or the pair looks like every unbound pair.
    CUSTOM_VARIABLES = [];
    PAIRS[0]!.learnable = true;
    try {
      await mount();
      assert.equal(stateSelect(), null, "a select was offered with nothing to choose");
      assert.equal(document.body.textContent?.includes("will learn"), true);
    } finally {
      PAIRS[0]!.learnable = false;
    }
  });

  test("a single button with a source is offered as a SWITCH, and stays unticked", async () => {
    CUSTOM_VARIABLES = [];
    SINGLES = [
      button({ page: 2, row: 2, col: 0, label: "VCR Light ON", slug: "vcr_light_on", stateSource: PLUG }),
      button({ row: 2, col: 3, label: "Take Screens", slug: "take_screens" }),
    ];
    await mount();

    // The tag says switch — it would become a PAIR pressing that one key both
    // ways — while the box is not ticked. Nothing in this section is ticked for
    // you, whatever it would become.
    assert.deepEqual(
      [...document.querySelectorAll("[data-cue-kind]")].map((el) => el.getAttribute("data-cue-kind")),
      ["switch", "switch", "script"],
    );
    assert.deepEqual(
      boxes()
        .filter((b) => b.name.startsWith("VCR Light ON"))
        .map((b) => `${b.name}=${b.checked}`),
      ["VCR Light ON · Room A: Screens=false"],
    );
    assert.equal(toggleSelect("VCR Light ON · Room A: Screens")?.value, PLUG.variable);
  });

  test("a single button's inferred binding reaches the request once it is ticked", async () => {
    CUSTOM_VARIABLES = [];
    SINGLES = [
      button({ page: 2, row: 2, col: 0, label: "VCR Light ON", slug: "vcr_light_on", stateSource: PLUG }),
    ];
    await mount();
    await act(async () => {
      screen.getByRole("checkbox", { name: "VCR Light ON · Room A: Screens" }).click();
    });
    const body = await importNow();
    assert.deepEqual(
      body.buttons.map((b) => `${b.slug}=${b.stateVariable}/${b.stateOnValue}/${b.stateOffValue}`),
      ["vcr_light_on=VCR-Overhead-Light:power_state/On/Off"],
    );
  });
});
