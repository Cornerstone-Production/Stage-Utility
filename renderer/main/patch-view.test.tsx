// What this file guards, and why each one is here.
//
// /patch is what a volunteer reads in the minutes before a service, so every
// case below is a way for it to show the wrong channels, or to look right and do
// nothing. All of them run the real component over the real resolve step (the
// patch file is served by a stubbed /api/patch, and the standing variant, the
// "was <old>" and "new" notes and the changed set come out of resolvePatch, not
// out of a fixture that already knows the answer).
//
// 1. FILTER AND CHANGES ONLY NARROW THE TABLES. A filter that matches everything
//    is a search box that does not search; Changes only that shows an unchanged
//    row is the page lying about what is different this week.
// 2. JUMP TO SCROLLS THE RACK IT NAMES, and opens it if it was collapsed. A list
//    of racks whose buttons do nothing renders fine and is worth nothing.
// 3. THE CHANGES CARD COVERS BOTH DIRECTIONS at desk width, where there is room
//    for it and nothing else says an output changed; the stacked layout keeps its
//    one direction at a time.
// 4. IT UPDATES LIVE. A push on patch:updated has to reach the open table.
// 5. BELOW lg IT IS STILL THE STACKED COLUMN, from the same filters.
//
// What is NOT here, because jsdom loads no stylesheet and reports every
// offsetHeight as 0: the 34px row height, the 270px sticky column, the amber tint
// and the 3px device edge actually being painted, and the container query that
// drops the console node from a path when the card is narrow (only the classes that
// ask for it are checked). They need a layout engine, and are checked in a browser.
//
// Every name, label and colour below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, settle, unmountAndTeardown } from "../test-dom.js";
import { FakeEventSource } from "../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let FILE: PatchFile;
let STATE: StageState;
/** The viewport width the matchMedia stub answers for. */
let width = 1440;
/** The rack each jump scrolled to, by the name in its header. */
let scrolled: string[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  const path = String(url).split("?")[0];
  const body = path === "/api/patch" ? FILE : path === "/api/state" ? STATE : null;
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

const { render, cleanup, screen, within, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { PatchView } = await import("./patch-view.js");
const { DEFAULT_STAGE_STATE } = await import("./test-render-ctx.js");
const { __resetForTests: resetStageState } = await import("./use-stage-state.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../lib/api.js");

// jsdom has no matchMedia and no scrollIntoView. The first decides the layout,
// the second is what Jump to exists to call.
(globalThis as unknown as { window: Window }).window.matchMedia = ((query: string) => ({
  // Answers the real question, so a breakpoint moved off 1024 is noticed: only a
  // query for a minimum width the viewport has reached matches.
  matches: Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity) <= width,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
})) as unknown as typeof window.matchMedia;
(globalThis as unknown as { Element: { prototype: { scrollIntoView: unknown } } }).Element.prototype.scrollIntoView =
  function (this: Element) {
    scrolled.push(this.querySelector("b")?.textContent ?? "(no header)");
  };

const ep = (rackId: string, dir: "in" | "out", index: number, rest: Partial<PatchEndpoint> = {}): PatchEndpoint => ({
  rackId,
  dir,
  index,
  ...rest,
});
const via = (deviceId: string, connector: string) => [{ deviceId, connector }];

/** Two racks and a snake. Inputs: five on Alpha (two under an owner), one on Beta; one output on Alpha. */
function analog(): PatchSheet {
  const defaults: PatchEndpoint[] = [
    ep("alpha", "in", 1, { label: "Kick", mic: "Mic K", consoleChannel: "11", phantom: true, path: via("snake", "1") }),
    ep("alpha", "in", 2, { label: "Snare", mic: "Mic S", consoleChannel: "12", path: via("snake", "2") }),
    ep("alpha", "in", 3, { label: "Bass", consoleChannel: "13", owner: "Owner One", path: via("snake", "3") }),
    ep("alpha", "in", 4, { label: "Keys", consoleChannel: "14", owner: "Owner One", path: via("snake", "4") }),
    ep("alpha", "in", 5, { label: "Guitar", consoleChannel: "15", owner: "Owner Two", path: via("snake", "5") }),
    ep("beta", "in", 1, { label: "Lead", mic: "Mic L", consoleChannel: "21", path: via("snake", "9") }),
    ep("alpha", "out", 1, { label: "Wedge", feedType: "Wedge feed", consoleChannel: "31", path: via("snake", "7") }),
  ];
  return {
    id: "analog",
    name: "Analog",
    kind: "analog",
    devices: [
      { id: "alpha", name: "Alpha Rack", kind: "rack", inputs: 16, outputs: 8, color: "#cc3333" },
      { id: "beta", name: "Beta Rack", kind: "rack", inputs: 8, outputs: 8, color: "#33aa55" },
      { id: "snake", name: "Snake X", kind: "snake", inputs: 16, outputs: 8, color: "#3377cc" },
    ],
    endpoints: defaults,
    variants: [
      {
        id: "v1",
        name: "Variant V",
        overrides: {
          // was "Snare"
          "alpha:in:2": ep("alpha", "in", 2, { label: "Snare Top" }),
          // a channel the default patch left empty
          "alpha:in:6": ep("alpha", "in", 6, { label: "Tom", consoleChannel: "16", path: via("snake", "6") }),
          // switched off for the week
          "alpha:in:3": ep("alpha", "in", 3, { unused: true }),
          // same name, different box
          "beta:in:1": ep("beta", "in", 1, { path: via("snake", "10") }),
          // an output the default patch left empty
          "alpha:out:2": ep("alpha", "out", 2, { label: "Record", feedType: "Record", consoleChannel: "32", path: via("snake", "8") }),
        },
      },
    ],
    assignments: { byServiceType: { "st-1": "v1" }, byPlan: {} },
  };
}

function dante(): PatchSheet {
  return {
    id: "dante",
    name: "Dante",
    kind: "dante",
    devices: [{ id: "dbox", name: "Dante Box", kind: "rack", inputs: 4, outputs: 4 }],
    endpoints: [ep("dbox", "in", 1, { label: "Playback L", consoleChannel: "41" })],
    variants: [],
    assignments: { byServiceType: {}, byPlan: {} },
  };
}

function file(...sheets: PatchSheet[]): PatchFile {
  return { sheets, updatedAt: "2026-01-01T00:00:00.000Z" };
}

async function mount() {
  await act(async () => {
    render(React.createElement(PatchView));
  });
  await settle();
  await settle();
}

/** The cell texts of one column of one rack's table, in row order. Group rows (Owned by …) are skipped. */
function column(table: HTMLElement, header: string): string[] {
  const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
  const at = heads.indexOf(header);
  assert.ok(at >= 0, `no ${header} column in [${heads.join(", ")}]`);
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .filter((r) => within(r).queryAllByRole("cell").length === heads.length)
    .map((r) => within(r).getAllByRole("cell")[at].textContent ?? "");
}
const sources = (table: HTMLElement) => column(table, "Source");
const tableFor = (rack: string) => screen.getByRole("table", { name: new RegExp(`^${rack}`) });
const tableNames = () => screen.queryAllByRole("table").map((t) => t.getAttribute("aria-label"));
const type = (value: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value } });

beforeEach(() => {
  FILE = file(analog());
  STATE = { ...DEFAULT_STAGE_STATE, serviceTypeId: "st-1", serviceTypeName: "Service One", planId: "plan-1", planTitle: "Week Title", planDates: "Sun Jan 4" };
  width = 1440;
  scrolled = [];
});
afterEach(async () => {
  cleanup();
  await settle();
  resetStageState();
  resetReplayCache();
});
after(() => unmountAndTeardown(cleanup, teardown));

describe("at desk width", () => {
  test("one real table per rack, with the columns for the direction on screen", async () => {
    await mount();
    assert.deepEqual(tableNames(), ["Alpha Rack inputs", "Beta Rack inputs"]);
    const alpha = tableFor("Alpha Rack");
    assert.deepEqual(
      within(alpha).getAllByRole("columnheader").map((h) => h.textContent),
      ["Ch", "Console", "Source", "Mic", "48V", "Signal path", "Note"],
    );
    assert.deepEqual(sources(alpha), ["Kick", "Snare Top", "Bass", "Keys", "Guitar", "Tom"]);

    fireEvent.click(screen.getByRole("button", { name: "Outputs" }));
    await settle();
    assert.deepEqual(tableNames(), ["Alpha Rack outputs"]);
    assert.deepEqual(
      within(tableFor("Alpha Rack")).getAllByRole("columnheader").map((h) => h.textContent),
      ["Ch", "Console", "Destination", "Feed", "Signal path", "Note"],
    );
  });

  test("the notes say what changed: was, new, re-patched, unused", async () => {
    await mount();
    const alpha = tableFor("Alpha Rack");
    const notes = column(alpha, "Note");
    const labels = sources(alpha);
    const noteOf = (label: string) => notes[labels.indexOf(label)];
    assert.equal(noteOf("Snare Top"), "was Snare");
    assert.equal(noteOf("Tom"), "new");
    assert.equal(noteOf("Bass"), "unused this week");
    assert.equal(noteOf("Kick"), "");
    assert.equal(column(tableFor("Beta Rack"), "Note")[0], "re-patched");
  });

  test("an unused row is marked so it can be struck through, a changed one so it can be tinted", async () => {
    await mount();
    const rows = within(tableFor("Alpha Rack")).getAllByRole("row");
    const row = (label: string) => rows.find((r) => within(r).queryByText(label, { selector: "td" }))!;
    assert.equal(row("Bass").dataset.unused, "true");
    assert.equal(row("Bass").dataset.changed, "true");
    assert.equal(row("Snare Top").dataset.unused, undefined);
    assert.equal(row("Snare Top").dataset.changed, "true");
    assert.equal(row("Kick").dataset.changed, undefined);
  });

  test("each row carries its device colour as a left edge", async () => {
    await mount();
    const cell = within(tableFor("Alpha Rack")).getAllByRole("row")[1].querySelector("td")!;
    assert.equal(cell.style.boxShadow, "inset 3px 0 0 #3377cc");
  });

  test("the changes card lists inputs AND outputs, the jump list names the racks on screen", async () => {
    await mount();
    const card = screen.getByText(/from the standard patch/).parentElement!;
    assert.match(card.textContent ?? "", /^5 changes from the standard patch/);
    for (const row of ["in 2", "in 3", "in 6", "in 1", "out 2"]) assert.ok(within(card).getByText(row), row);
    assert.ok(within(card).getByText("Record"), "an output change is missing from the card");

    fireEvent.click(screen.getByRole("button", { name: "Outputs" }));
    await settle();
    assert.match(screen.getByText(/from the standard patch/).textContent ?? "", /^5 changes/, "the card follows the direction");
    const jump = screen.getByRole("navigation", { name: "Jump to" });
    assert.deepEqual(within(jump).getAllByRole("button").map((b) => b.textContent), ["Alpha Rack2"]);
  });

  test("a channel that changed only in its mic still says it changed", async () => {
    const sheet = analog();
    sheet.variants[0].overrides["alpha:in:1"] = ep("alpha", "in", 1, { mic: "Mic K2" });
    FILE = file(sheet);
    await mount();
    const alpha = tableFor("Alpha Rack");
    assert.equal(column(alpha, "Note")[sources(alpha).indexOf("Kick")], "changed");
  });

  test("an unused channel the standard patch already had unused is dimmed, not flagged as a change", async () => {
    const sheet = analog();
    sheet.endpoints.push(ep("alpha", "in", 7, { label: "Spare", consoleChannel: "17", unused: true, path: via("snake", "7") }));
    FILE = file(sheet);
    await mount();
    const alpha = tableFor("Alpha Rack");
    const row = within(alpha).getAllByRole("row").find((r) => within(r).queryByText("Spare", { selector: "td" }))!;
    assert.equal(row.dataset.unused, "true");
    assert.equal(row.dataset.changed, undefined, "an unchanged row was marked changed");
    const note = within(row).getByText("unused this week");
    assert.doesNotMatch(note.className, /text-warn/, "the note wears the colour of a change");
  });

  test("on an Outputs row the arrow beside the console node goes with it when the card is narrow", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Outputs" }));
    await settle();
    // Outputs read console, rack, box, destination. The console pill and the
    // arrow after it are the two that the container query hides.
    const path = within(tableFor("Alpha Rack")).getAllByRole("row")[1].querySelector("div.w-max")!;
    const kids = [...path.children];
    // Both must name the same container width, or one drops without the other.
    assert.match(kids[0].className, /(^| )hidden @min-\[62rem\]:inline( |$)/, "the console pill is not droppable");
    assert.equal(kids[1].tagName.toLowerCase(), "svg");
    assert.match(kids[1].getAttribute("class") ?? "", /(^| )hidden @min-\[62rem\]:block( |$)/, "a dangling arrow is left before the rack pill");
    assert.doesNotMatch(kids[2].className, /hidden/, "the rack pill must stay");
  });

  test("a channel already unused that changes another way does not claim to be newly unused", async () => {
    const sheet = analog();
    sheet.endpoints.push(ep("alpha", "in", 7, { label: "Spare", mic: "Old", consoleChannel: "17", unused: true, path: via("snake", "7") }));
    sheet.variants[0].overrides["alpha:in:7"] = ep("alpha", "in", 7, { mic: "New" });
    FILE = file(sheet);
    await mount();
    const alpha = tableFor("Alpha Rack");
    assert.equal(column(alpha, "Note")[sources(alpha).indexOf("Spare")], "changed");
  });

  test("the context card names the week, the variant and that the page is read-only", async () => {
    await mount();
    assert.ok(screen.getByText("Service One"));
    assert.ok(screen.getByText("Week Title · Sun Jan 4"));
    assert.ok(screen.getByText("Base: Variant V"));
    assert.ok(screen.getByText("Read-only"));
  });

  describe("Filter", () => {
    test("matches the source, the mic, the console channel, the channel and the owner", async () => {
      await mount();
      const left = (q: string) => {
        type(q);
        return screen.queryAllByRole("table").flatMap((t) => sources(t));
      };
      assert.deepEqual(left("snare top"), ["Snare Top"], "source");
      assert.deepEqual(left("mic l"), ["Lead"], "mic");
      assert.deepEqual(left("15"), ["Guitar"], "console channel");
      assert.deepEqual(left("owner two"), ["Guitar"], "owner");
      assert.deepEqual(left("nothing matches this"), []);
      assert.ok(screen.getByText("No channels match."));
    });

    test("drops a rack with no row left, from the tables and from Jump to", async () => {
      await mount();
      type("lead");
      assert.deepEqual(tableNames(), ["Beta Rack inputs"]);
      const jump = screen.getByRole("navigation", { name: "Jump to" });
      assert.deepEqual(within(jump).getAllByRole("button").map((b) => b.textContent), ["Beta Rack1"]);
    });

    test("a rack with rows hidden says how many of how many are showing", async () => {
      await mount();
      type("owner one");
      assert.match(screen.getByRole("button", { name: /Alpha Rack/, expanded: true }).textContent ?? "", /2 of 6/);
    });
  });

  describe("Changes only", () => {
    test("leaves exactly the rows the resolved patch says changed", async () => {
      await mount();
      fireEvent.click(screen.getByRole("button", { name: "Changes only" }));
      await settle();
      assert.deepEqual(sources(tableFor("Alpha Rack")), ["Snare Top", "Bass", "Tom"]);
      assert.deepEqual(sources(tableFor("Beta Rack")), ["Lead"]);
      assert.equal(screen.getByRole("button", { name: "Changes only" }).getAttribute("aria-pressed"), "true");
    });
  });

  describe("Jump to", () => {
    test("scrolls the rack it names", async () => {
      await mount();
      const jump = screen.getByRole("navigation", { name: "Jump to" });
      fireEvent.click(within(jump).getByRole("button", { name: /Beta Rack/ }));
      assert.deepEqual(scrolled, ["Beta Rack"]);
      fireEvent.click(within(jump).getByRole("button", { name: /Alpha Rack/ }));
      assert.deepEqual(scrolled, ["Beta Rack", "Alpha Rack"]);
    });

    test("moves focus into the rack, so a keyboard user lands where the page scrolled", async () => {
      await mount();
      fireEvent.click(within(screen.getByRole("navigation", { name: "Jump to" })).getByRole("button", { name: /Beta Rack/ }));
      assert.match(document.activeElement?.textContent ?? "", /^Beta Rack/);
      assert.equal(document.activeElement?.getAttribute("aria-expanded"), "true");
    });

    test("opens a rack that was collapsed", async () => {
      await mount();
      fireEvent.click(screen.getByRole("button", { name: /Beta Rack/, expanded: true }));
      assert.deepEqual(tableNames(), ["Alpha Rack inputs"], "collapsing hides the table");
      fireEvent.click(within(screen.getByRole("navigation", { name: "Jump to" })).getByRole("button", { name: /Beta Rack/ }));
      assert.deepEqual(tableNames(), ["Alpha Rack inputs", "Beta Rack inputs"]);
      assert.deepEqual(scrolled, ["Beta Rack"]);
    });
  });

  test("an owner is a group row inside the table, once per run", async () => {
    await mount();
    const rows = within(tableFor("Alpha Rack")).getAllByRole("row").map((r) => r.textContent ?? "");
    const groups = rows.filter((t) => t.startsWith("Owned by"));
    assert.deepEqual(groups, ["Owned by Owner One", "Owned by Owner Two"]);
  });

  test("collapsing a rack hides its table and keeps its header", async () => {
    await mount();
    const header = screen.getByRole("button", { name: /Alpha Rack/, expanded: true });
    fireEvent.click(header);
    assert.equal(screen.queryByRole("table", { name: /^Alpha Rack/ }), null);
    assert.equal(screen.getByRole("button", { name: /Alpha Rack/, expanded: false }).getAttribute("aria-expanded"), "false");
  });

  test("sheet tabs appear for two sheets with a patch, and switching changes the tables", async () => {
    FILE = file(analog(), dante());
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Dante" }));
    await settle();
    assert.deepEqual(tableNames(), ["Dante Box inputs"]);
    assert.deepEqual(sources(tableFor("Dante Box")), ["Playback L"]);
  });

  test("no tabs for a single sheet", async () => {
    await mount();
    assert.equal(screen.queryByRole("button", { name: "Dante" }), null);
    assert.equal(screen.queryByRole("button", { name: "Analog" }), null);
  });

  test("an edit pushed on patch:updated reaches the open table", async () => {
    await mount();
    assert.ok(!sources(tableFor("Alpha Rack")).includes("Piano"));
    const edited = analog();
    edited.endpoints.push(ep("alpha", "in", 7, { label: "Piano", consoleChannel: "17", path: via("snake", "7") }));
    await act(async () => {
      FakeEventSource.last!.push("patch:updated", file(edited));
    });
    await settle();
    assert.ok(sources(tableFor("Alpha Rack")).includes("Piano"), "the pushed channel never appeared");
  });

  test("an empty filter result and a sheet with no outputs say different things", async () => {
    await mount();
    type("zzz");
    assert.ok(screen.getByText("No channels match."));
    type("");
    FILE = file({ ...analog(), variants: [], endpoints: analog().endpoints.filter((e) => e.dir === "in") });
    await act(async () => {
      FakeEventSource.last!.push("patch:updated", FILE);
    });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Outputs" }));
    await settle();
    assert.ok(screen.getByText("No outputs on this sheet."));
  });

  test("the desk layout starts at exactly 1024px", async () => {
    width = 1024;
    await mount();
    assert.equal(screen.queryAllByRole("table").length, 2);
  });

  test("the empty state and the footer are the same", async () => {
    FILE = file({ ...analog(), devices: [], endpoints: [], variants: [] });
    await mount();
    assert.ok(screen.getByText("No patch has been set up yet."));
    const edit = screen.getByRole("link", { name: "Edit the patch" });
    assert.equal(edit.getAttribute("href"), "/patch/edit");
    assert.equal(screen.queryAllByRole("table").length, 0);
  });
});

describe("below lg", () => {
  beforeEach(() => {
    width = 1023;
  });

  test("it is the stacked column: no table, the same rows, one direction of changes", async () => {
    await mount();
    assert.equal(screen.queryAllByRole("table").length, 0);
    for (const label of ["Kick", "Snare Top", "Tom", "Lead"]) assert.ok(screen.getAllByText(label).length > 0, label);
    const card = screen.getByText(/from the standard patch/).parentElement!.parentElement!;
    assert.match(card.textContent ?? "", /^4 changes/, "inputs only while Inputs is showing");
    assert.equal(within(card).queryByText("Record"), null);
  });

  test("Filter and Changes only narrow it through the same rules", async () => {
    await mount();
    type("lead");
    assert.equal(screen.queryAllByText("Kick").length, 0);
    assert.ok(screen.getAllByText("Lead").length > 0);
    type("");
    fireEvent.click(screen.getByRole("button", { name: "Changes only" }));
    await settle();
    assert.equal(screen.queryAllByText("Kick").length, 0, "an unchanged channel survived Changes only");
    assert.ok(screen.getAllByText("Snare Top").length > 0);
  });

  test("a filter that matches nothing says so, as it does at desk width", async () => {
    await mount();
    type("zzz");
    assert.ok(screen.getByText("No channels match."));
  });

  test("an edit pushed on patch:updated reaches it too", async () => {
    await mount();
    const edited = analog();
    edited.endpoints.push(ep("alpha", "in", 7, { label: "Piano", consoleChannel: "17", path: via("snake", "7") }));
    await act(async () => {
      FakeEventSource.last!.push("patch:updated", file(edited));
    });
    await settle();
    assert.ok(screen.getAllByText("Piano").length > 0);
  });
});
