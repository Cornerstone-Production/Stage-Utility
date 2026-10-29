// The Mic slots page, rendered over a stubbed server.
//
// What is under test is what an operator can be misled by: a move that lands in
// the wrong column, a spacer that stacks, a Save all that leaves a board out, a
// recalled layout that reaches a screen before Save all, a delete that does not
// repoint its screens. The moves are board-model.test.ts as functions; here the
// same moves go through the rendered page, by the pointer (through dnd-kit) and
// by the keyboard.
//
// jsdom lays nothing out, so every rect is empty and dnd-kit has nothing to hit
// against. `placeRects` gives each column, card, gap and stack zone a rect from
// the DOM's own structure, which is all a drop needs.
//
// NOT unit-tested here, and driven in a browser instead: the drop-zone geometry
// against the real columns, the accent ring and the preview's shape (jsdom loads
// no stylesheet), and the drag ghost.
//
// NOTHING BELOW PASSES A DOM NODE AS AN ASSERT OPERAND: node:assert inspects a
// live jsdom element when an assertion fails, and that does not terminate in any
// useful time. Every assertion is on a string or a boolean.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, isPlumbing } from "../../test-dom.js";

const teardown = installRenderDom();

const BOARDS = () =>
  [
    { id: "b-left", name: "Left wall", columnWidthIn: null, createdAt: "", shownOn: [{ kind: "view", id: "v-left", name: "Left Display", viewId: "v-left" }] },
    { id: "b-right", name: "Right wall", columnWidthIn: null, createdAt: "", shownOn: [{ kind: "view", id: "v-right", name: "Right Display", viewId: "v-right" }] },
  ] as unknown as SlotBoardDTO[];

const slot = (id: string, over: Partial<Slot> = {}): Slot =>
  ({
    id,
    channel: id.toUpperCase(),
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: `Pos ${id}` }] },
    deviceBinding: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
    ...over,
  }) as Slot;

/** "a | b+c | ~s" to slots, as the model test writes them. */
function board(spec: string): Slot[] {
  const out: Slot[] = [];
  for (const col of spec.split("|").map((c) => c.trim())) {
    col.split("+").forEach((raw, i) => {
      const spacer = raw.startsWith("~");
      const id = spacer ? raw.slice(1) : raw;
      out.push(
        slot(id, {
          order: out.length,
          ...(spacer ? { link: { kind: "spacer" }, widthIn: 2 } : {}),
          ...(i > 0 ? { stackWithPrevious: true } : {}),
        } as Partial<Slot>),
      );
    });
  }
  return out;
}

let layouts: Record<string, Slot[]> = {};
/** A plan's own layout per board, returned when the target names a plan. */
let overrides: Record<string, Slot[]> = {};
let boards: SlotBoardDTO[] = [];
let presets: SlotPreset[] = [];
/** What the resolver adds to a slot, by id: a person and their prep. */
let resolvedExtras: Record<string, Partial<Slot>> = {};
let checkNoCapsule: { boardId: string; boardName: string; slotId: string; name: string }[] = [];
let planId: string | null = null;
let requests: { url: string; method: string; body: string | null }[] = [];
let failSave: string | null = null;

const STATE = () =>
  ({
    appName: "Stage",
    serviceTypeId: "st-1",
    serviceTypeName: "Weekend",
    planId,
    planDates: "September 13, 2026",
    timezone: "UTC",
    slotsByView: {},
    slotsByLayoutObject: {},
    chargerBays: [],
    views: [
      { id: "v-left", name: "Left Display", kind: "slots", boardId: "b-left", createdAt: "" },
      { id: "v-right", name: "Right Display", kind: "slots", boardId: "b-right", createdAt: "" },
    ],
  }) as unknown as StageState;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (isPlumbing(url)) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : null;
  requests.push({ url, method, body });
  const path = new URL(url, "http://localhost:8788").pathname;
  let status = 200;
  let out: unknown = {};
  const targets = path.match(/^\/api\/boards\/([^/]+)\/targets$/);
  if (path === "/api/state") out = STATE();
  else if (path === "/api/boards" && method === "GET") out = boards;
  else if (targets) {
    out = {
      scope: "board",
      key: targets[1],
      boardId: targets[1],
      serviceTypeId: "st-1",
      serviceTypeName: "Weekend",
      planId: new URL(url, "http://x").searchParams.get("planId"),
      planDates: "September 13, 2026",
      planSortDate: new URL(url, "http://x").searchParams.get("planId") ? "2026-09-13T14:00:00Z" : null,
      defaultSlots: layouts[targets[1]!] ?? [],
      overrideSlots: new URL(url, "http://x").searchParams.get("planId") ? (overrides[targets[1]!] ?? null) : null,
    };
  } else if (path === "/api/plans/upcoming") out = { plans: [], cacheAgeMs: 0 };
  else if (path === "/api/presets" && method === "GET") out = presets;
  else if (path === "/api/integrations/wireless/channels") out = [];
  else if (path === "/api/integrations/wireless/statuses") out = [];
  else if (path === "/api/views/resolve-slots") out = { slots: (JSON.parse(body ?? "{}").slots as Slot[]).map((x) => ({ ...x, ...(resolvedExtras[x.id] ?? {}) })), roster: "none" };
  else if (path === "/api/boards/check") out = { serviceTypeId: "st-1", planId, roster: "none", unplaced: [], noPosition: [], noCapsule: checkNoCapsule };
  else if (path === "/api/boards/slots" && method === "POST") {
    if (failSave) {
      status = 400;
      out = { error: failSave };
    } else out = STATE();
  } else if (/^\/api\/boards\/[^/]+$/.test(path) && method === "DELETE") out = STATE();
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Bad Request",
    json: async () => out,
    text: async () => JSON.stringify(out),
  };
};

const { render, cleanup, act, fireEvent, screen, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MicSlotsPage } = await import("./mic-slots-page.js");
const { registerTargetGuard, __setEditingTargetForTests } = await import("../../settings/sections/editing-target.js");
const { __resetForTests } = await import("../../main/use-stage-state.js");
const { __resetReplayCacheForTests } = await import("../../lib/api.js");
const { TooltipProvider } = await import("../../components/ui/tooltip-provider.js");

const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

let client: InstanceType<typeof QueryClient> | null = null;
async function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null, React.createElement(MicSlotsPage, null))));
  await settle();
}

beforeEach(() => {
  cleanup();
  __resetForTests();
  __resetReplayCacheForTests();
  __setEditingTargetForTests(null);
  registerTargetGuard("mic-slots", null);
  boards = BOARDS();
  layouts = { "b-left": board("a | b+c | ~s | d"), "b-right": board("x | y") };
  overrides = {};
  presets = [];
  resolvedExtras = {};
  checkNoCapsule = [];
  planId = null;
  requests = [];
  failSave = null;
  window.history.replaceState(null, "", "/mic-slots");
});
afterEach(async () => {
  cleanup();
  await settle();
  client?.clear();
  client = null;
});
after(async () => {
  __setEditingTargetForTests(null);
  await settle();
  teardown();
});

// ── reading the page back ───────────────────────────────────────────────────

const section = (id: string) => document.querySelector(`[data-board-id="${id}"]`) as HTMLElement;
const card = (id: string) => document.querySelector(`[data-mic-slot="${id}"]`) as HTMLElement;

/** A board as the model test writes it: columns by "|", a stack by "+", a spacer "~". */
function shape(boardId: string): string {
  const cols = new Map<Element, string[]>();
  for (const el of section(boardId).querySelectorAll("[data-mic-slot], [data-mic-spacer]")) {
    const col = el.hasAttribute("data-mic-spacer") ? el.parentElement! : el.parentElement!.parentElement!;
    const label = el.hasAttribute("data-mic-spacer") ? `~${el.getAttribute("data-mic-spacer")}` : el.getAttribute("data-mic-slot")!;
    cols.set(col, [...(cols.get(col) ?? []), label]);
  }
  return [...cols.values()].map((c) => c.join("+")).join(" | ");
}

const unsaved = () => !!document.querySelector("[data-mic-unsaved]");
const posts = (suffix: string) => requests.filter((r) => r.method === "POST" && new URL(r.url, "http://x").pathname === suffix);

// ── dnd-kit under jsdom ─────────────────────────────────────────────────────

const rects = new WeakMap<Element, { x: number; y: number; w: number; h: number }>();
const realRect = Element.prototype.getBoundingClientRect;
function install() {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this);
    if (!r) return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRect;
    return { x: r.x, y: r.y, left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, toJSON() {} } as DOMRect;
  };
}
function uninstall() {
  Element.prototype.getBoundingClientRect = realRect;
}

/** Rects from the DOM's structure: boards stacked 1000px apart, a column every
 *  110px, a card every 100px down a column, a 10px gap strip on each boundary. */
function placeRects() {
  document.querySelectorAll("[data-board-id]").forEach((sec, bi) => {
    const y0 = bi * 1000;
    const cols = new Map<Element, Element[]>();
    sec.querySelectorAll("[data-mic-slot], [data-mic-spacer]").forEach((el) => {
      const col = el.hasAttribute("data-mic-spacer") ? el.parentElement! : el.parentElement!.parentElement!;
      cols.set(col, [...(cols.get(col) ?? []), el]);
    });
    let x = 0;
    let gaps = 0;
    for (const [col, els] of cols) {
      rects.set(col, { x, y: y0, w: 100, h: 400 });
      const bar = col.querySelector("[data-mic-column-bar]");
      if (bar) rects.set(bar, { x, y: y0, w: 100, h: 12 });
      els.forEach((el, i) => {
        const r = { x, y: y0 + 20 + i * 100, w: 100, h: 90 };
        rects.set(el, r);
        const zone = el.querySelector("[data-mic-stack]");
        if (zone) rects.set(zone, { x: r.x, y: r.y + 45, w: 100, h: 45 });
      });
      x += 110;
      gaps++;
    }
    sec.querySelectorAll("[data-mic-gap]").forEach((g, gi) => {
      rects.set(g, { x: gi * 110 - 15, y: y0, w: 10, h: 400 });
    });
    void gaps;
  });
}
const centre = (el: Element) => {
  const r = rects.get(el)!;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

/** Press on `source`, carry it to `target`, let go. */
async function drag(source: Element, target: Element) {
  install();
  try {
    placeRects();
    const s = centre(source);
    const t = centre(target);
    await act(async () => {
      fireEvent.mouseDown(source, { button: 0, clientX: s.x, clientY: s.y });
      fireEvent.mouseMove(document, { clientX: s.x + 8, clientY: s.y + 8 });
    });
    await settle();
    await act(async () => {
      fireEvent.mouseMove(document, { clientX: t.x, clientY: t.y });
    });
    await settle();
    await act(async () => {
      fireEvent.mouseUp(document, { clientX: t.x, clientY: t.y });
    });
    await settle();
  } finally {
    uninstall();
  }
}
const gap = (boardId: string, index: number) => document.querySelector(`[data-mic-gap="${boardId}:${index}"]`)!;
const stackZone = (slotId: string) => document.querySelector(`[data-mic-stack="${slotId}"]`)!;
const bar = (leadId: string) => document.querySelector(`[data-mic-column-bar="${leadId}"]`)!;
const spacerEl = (id: string) => document.querySelector(`[data-mic-spacer="${id}"]`)!;

const key = async (el: Element, k: string, shift = false) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k, shiftKey: shift });
  });
  await settle();
};
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
};
const openMenu = async (el: Element) => {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
    fireEvent.click(el);
    await settle();
  });
};
const choose = async (el: Element) => {
  await act(async () => {
    fireEvent.pointerDown(el, { button: 0, ctrlKey: false });
    fireEvent.pointerUp(el, { button: 0, ctrlKey: false });
    fireEvent.click(el);
    await settle();
  });
};

// ── the page ────────────────────────────────────────────────────────────────

describe("the page", () => {
  test("is one section per board, drawn with the real slot cards", async () => {
    await mount();
    assert.equal(shape("b-left"), "a | b+c | ~s | d");
    assert.equal(shape("b-right"), "x | y");
    assert.ok(screen.getByRole("heading", { name: "Left wall" }));
    assert.ok(screen.getByRole("heading", { name: "Right wall" }));
    assert.ok(screen.getByRole("button", { name: "New board" }));
  });

  test("a deep link selects and marks its board", async () => {
    window.history.replaceState(null, "", "/mic-slots?board=b-right");
    await mount();
    assert.equal(section("b-right").getAttribute("data-active"), "true");
    assert.equal(section("b-left").getAttribute("data-active"), null);
    assert.equal(card("x").getAttribute("data-selected"), "true", "the board's first slot is selected, so the inspector has something to show");
  });
});

describe("dragging with the pointer", () => {
  test("a card dropped in a gap becomes its own column there", async () => {
    await mount();
    await drag(card("d"), gap("b-left", 1));
    assert.equal(shape("b-left"), "a | d | b+c | ~s");
    assert.ok(unsaved());
  });

  test("a card dropped on another card's lower half stacks below it", async () => {
    await mount();
    await drag(card("d"), stackZone("a"));
    assert.equal(shape("b-left"), "a+d | b+c | ~s");
  });

  test("a card dragged out of a stack unstacks", async () => {
    await mount();
    await drag(card("c"), gap("b-left", 0));
    assert.equal(shape("b-left"), "c | a | b | ~s | d");
  });

  test("the bar on a column drags the whole stack", async () => {
    await mount();
    await drag(bar("b"), gap("b-left", 0));
    assert.equal(shape("b-left"), "b+c | a | ~s | d");
  });

  test("a card moves from one board to the other", async () => {
    await mount();
    await drag(card("d"), gap("b-right", 1));
    assert.equal(shape("b-left"), "a | b+c | ~s");
    assert.equal(shape("b-right"), "x | d | y");
  });

  test("a card stacks onto a card of the other board", async () => {
    await mount();
    await drag(card("a"), stackZone("x"));
    assert.equal(shape("b-right"), "x+a | y");
    assert.equal(shape("b-left"), "b+c | ~s | d");
  });

  test("a spacer never stacks", async () => {
    await mount();
    await drag(spacerEl("s"), stackZone("a"));
    assert.equal(shape("b-left"), "a | b+c | ~s | d", "a spacer dropped on a card must leave the board as it was");
    assert.ok(!unsaved(), "and a drop that changed nothing is not an unsaved change");
  });

  test("a spacer moves like a column", async () => {
    await mount();
    await drag(spacerEl("s"), gap("b-left", 0));
    assert.equal(shape("b-left"), "~s | a | b+c | d");
  });

  test("a drop that lands on nothing changes nothing", async () => {
    await mount();
    install();
    placeRects();
    const s = centre(card("a"));
    await act(async () => {
      fireEvent.mouseDown(card("a"), { button: 0, clientX: s.x, clientY: s.y });
      fireEvent.mouseMove(document, { clientX: s.x + 8, clientY: s.y + 8 });
    });
    await act(async () => {
      fireEvent.mouseMove(document, { clientX: 9000, clientY: 9000 });
      fireEvent.mouseUp(document, { clientX: 9000, clientY: 9000 });
    });
    uninstall();
    await settle();
    assert.equal(shape("b-left"), "a | b+c | ~s | d");
    assert.ok(!unsaved());
  });
});

describe("the keyboard", () => {
  test("Shift+Down skips a spacer to the column beyond it", async () => {
    await mount();
    await key(card("d"), "ArrowDown", true);
    assert.equal(shape("b-left"), "a | b+c+d | ~s");
  });

  test("Shift+Down on a card with a plain left neighbour stacks it", async () => {
    layouts["b-left"] = board("a | b | c");
    await mount();
    await key(card("b"), "ArrowDown", true);
    assert.equal(shape("b-left"), "a+b | c");
    await key(card("b"), "ArrowUp", true);
    assert.equal(shape("b-left"), "a | b | c");
  });

  test("a card moved by keyboard keeps focus, so the next key press still reaches it", async () => {
    // Stacking puts the card in another column, which is a new element; without the
    // refocus the browser drops focus to the page and a second Shift+Up goes nowhere.
    layouts["b-left"] = board("a | b | c");
    await mount();
    card("b").focus();
    await key(card("b"), "ArrowDown", true);
    assert.equal(shape("b-left"), "a+b | c");
    assert.ok(document.activeElement === card("b"), "focus is on the card that moved");
    await key(document.activeElement!, "ArrowUp", true);
    assert.equal(shape("b-left"), "a | b | c");
  });

  test("the arrow keys move a column, and Delete removes a card", async () => {
    layouts["b-left"] = board("a | b | c");
    await mount();
    await key(card("b"), "ArrowRight");
    assert.equal(shape("b-left"), "a | c | b");
    await key(card("b"), "Delete");
    assert.equal(shape("b-left"), "a | c");
  });
});

describe("Save all", () => {
  test("sends every board with unsaved work in one request, and nothing else", async () => {
    await mount();
    const addButtons = screen.getAllByRole("button", { name: "Slot" });
    await click(addButtons[0]!);
    await click(addButtons[1]!);
    await click(screen.getByRole("button", { name: "Save all" }));
    const saves = posts("/api/boards/slots");
    assert.equal(saves.length, 1, "one request");
    const sent = JSON.parse(saves[0]!.body!) as { boards: { boardId: string; slots: Slot[]; target: unknown }[] };
    assert.deepEqual(sent.boards.map((b) => b.boardId).sort(), ["b-left", "b-right"]);
    assert.equal(sent.boards.find((b) => b.boardId === "b-left")!.slots.length, 6, "five slots and a spacer, plus the new one");
    assert.deepEqual(sent.boards[0]!.target, { kind: "default", serviceTypeId: "st-1" });
    assert.ok(!unsaved(), "saved");
  });

  test("a board nobody touched is not in it", async () => {
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await click(screen.getByRole("button", { name: "Save all" }));
    const sent = JSON.parse(posts("/api/boards/slots")[0]!.body!) as { boards: { boardId: string }[] };
    assert.deepEqual(sent.boards.map((b) => b.boardId), ["b-left"]);
  });

  test("a refusal keeps the work and names the board that failed", async () => {
    await mount();
    failSave = 'Board "Right wall": body.slots must be a list of slots';
    await click(screen.getAllByRole("button", { name: "Slot" })[1]!);
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.ok(unsaved(), "nothing was saved, so the edit is still there");
    assert.ok(within(section("b-right")).getByRole("alert").textContent!.includes("Right wall"), "the failure is on the board it names");
    assert.equal(section("b-left").querySelector("[role=alert]"), null, "and not on the other");
  });

  test("with nothing changed it is off", async () => {
    await mount();
    assert.equal((screen.getByRole("button", { name: "Save all" }) as HTMLButtonElement).disabled, true);
  });
});

describe("deleting a board", () => {
  test("the dialog asks what its screens show instead, and the delete says so", async () => {
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Right wall" }));
    await choose(screen.getByRole("menuitem", { name: "Delete board…" }));
    const dialog = screen.getByRole("dialog");
    assert.ok(within(dialog).getByText(/Right Display/));
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Show instead"), { target: { value: "b-left" } });
    });
    await click(within(dialog).getByRole("button", { name: "Delete board" }));
    const del = requests.find((r) => r.method === "DELETE" && r.url.endsWith("/api/boards/b-right"));
    assert.ok(del, "DELETE /api/boards/b-right");
    assert.deepEqual(JSON.parse(del!.body!), { replacement: "b-left" });
  });

  test("left on Nothing it sends null, not a missing field", async () => {
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Right wall" }));
    await choose(screen.getByRole("menuitem", { name: "Delete board…" }));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete board" }));
    const del = requests.find((r) => r.method === "DELETE" && r.url.endsWith("/api/boards/b-right"));
    assert.deepEqual(JSON.parse(del!.body!), { replacement: null });
  });
});

describe("saved layouts", () => {
  test("recall fills the editor and saves nothing", async () => {
    presets = [{ id: "p1", name: "Easter", slots: board("q | r"), createdAt: "2026-04-02T00:00:00Z", boardId: "b-right" }];
    await mount();
    await click(screen.getByRole("button", { name: "Saved layouts" }));
    const writesBefore = requests.filter((r) => r.method !== "GET" && !r.url.includes("resolve-slots")).length;
    await click(screen.getByRole("button", { name: "Recall Easter" }));
    assert.equal(shape("b-right").replace(/slot-[0-9a-f-]+/g, "?"), "? | ?", "the editor holds the recalled layout's two slots");
    assert.ok(unsaved(), "it is an unsaved change");
    const writesAfter = requests.filter((r) => r.method !== "GET" && !r.url.includes("resolve-slots")).length;
    assert.equal(writesAfter, writesBefore, "recalling reaches no screen, and writes nothing");
    assert.equal(posts("/api/boards/slots").length, 0);
  });

  test("recall defaults to the board the layout came from", async () => {
    presets = [{ id: "p1", name: "Easter", slots: board("q"), createdAt: "2026-04-02T00:00:00Z", boardId: "b-right" }];
    await mount();
    await click(screen.getByRole("button", { name: "Saved layouts" }));
    assert.ok(screen.getByRole("button", { name: "Recall Easter" }).textContent!.includes("Right wall"));
  });
});

describe("a saved layout's name", () => {
  const preset = () => ({ id: "p1", name: "Opening", slots: board("q"), createdAt: "2026-04-02T00:00:00Z", boardId: "b-right" }) as SlotPreset;

  async function rename(typed: string) {
    presets = [preset()];
    await mount();
    await click(screen.getByRole("button", { name: "Saved layouts" }));
    await openMenu(screen.getByRole("button", { name: "More for Opening" }));
    await choose(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Rename Opening") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.blur(field);
    });
    await settle();
  }
  const patches = () => requests.filter((r) => r.method === "PATCH" && r.url.endsWith("/api/presets/p1"));

  test("saves a changed name trimmed on blur", async () => {
    await rename("  Welcome  ");
    assert.deepEqual(patches().map((r) => JSON.parse(r.body!)), [{ name: "Welcome" }]);
  });

  test("an emptied name is put back, not saved as nothing", async () => {
    await rename("   ");
    assert.equal(patches().length, 0);
    assert.ok(screen.getByText("Opening"));
  });
});

describe("which side of the plan the page edits", () => {
  const typeButton = () => screen.getByRole("button", { name: /Weekend default/ });
  const planButton = () => screen.getByRole("button", { name: /only/ }) as HTMLButtonElement;

  test("opens on the plan, showing the plan's own layout", async () => {
    planId = "p1";
    overrides = { "b-left": board("o1 | o2") };
    await mount();
    assert.equal(planButton().getAttribute("aria-pressed"), "true");
    assert.equal(shape("b-left"), "o1 | o2");
  });

  test("the Default side shows the DEFAULT even while a plan has its own", async () => {
    // The layout in effect this week is the exception. Editing the default from it
    // would save this week's exception onto the service type's standing layout.
    planId = "p1";
    overrides = { "b-left": board("o1 | o2") };
    await mount();
    await click(typeButton());
    assert.equal(shape("b-left"), "a | b+c | ~s | d");
  });

  test("a plan with no layout of its own edits a copy of the default, not an empty board", async () => {
    planId = "p1";
    await mount();
    assert.equal(shape("b-left"), "a | b+c | ~s | d");
  });

  test("the plan side is off with no plan, and the page opens on the default", async () => {
    await mount();
    assert.equal(planButton().disabled, true);
    assert.equal(typeButton().getAttribute("aria-pressed"), "true");
  });

  test("EDITED is there only when a board has a layout for this plan", async () => {
    planId = "p1";
    await mount();
    assert.ok(!document.querySelector("[data-mic-edited]"), "no board is an exception");
    cleanup();
    overrides = { "b-right": board("o1") };
    await mount();
    assert.ok(document.querySelector("[data-mic-edited]"), "one board is");
  });

  test("a save on the plan side carries the plan, its type and its date", async () => {
    planId = "p1";
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await click(screen.getByRole("button", { name: "Save all" }));
    const sent = JSON.parse(posts("/api/boards/slots")[0]!.body!) as { boards: { target: unknown }[] };
    assert.deepEqual(sent.boards[0]!.target, { kind: "plan", planId: "p1", serviceTypeId: "st-1", sortDate: "2026-09-13T14:00:00Z" }, "without the date the 30-day prune can never age the override out");
  });

  test("a save on the Default side is the type's default, never a plan's", async () => {
    planId = "p1";
    await mount();
    await click(typeButton());
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await click(screen.getByRole("button", { name: "Save all" }));
    const sent = JSON.parse(posts("/api/boards/slots")[0]!.body!) as { boards: { target: unknown }[] };
    assert.deepEqual(sent.boards[0]!.target, { kind: "default", serviceTypeId: "st-1" });
  });

  test("Revert and Set as default are offered only when there is a plan layout to act on", async () => {
    planId = "p1";
    await mount();
    await openMenu(screen.getByRole("button", { name: "Plan board actions" }));
    assert.equal(screen.getByRole("menuitem", { name: /^Revert/ }).getAttribute("aria-disabled"), "true");
    assert.equal(screen.getByRole("menuitem", { name: /^Set .* as/ }).getAttribute("aria-disabled"), "true");
  });
});

describe("unsaved work and the plan switcher", () => {
  test("stepping to another plan asks first, and keeps the work when refused", async () => {
    const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
    const { requestEditingTarget } = await import("../../settings/sections/editing-target.js");
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null, React.createElement(MicSlotsPage, null), React.createElement(ConfirmHost, null))));
    await settle();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    assert.ok(unsaved());
    let moved: boolean | null = null;
    await act(async () => {
      void requestEditingTarget({ serviceTypeId: "st-1", planId: null }).then((ok) => (moved = ok));
    });
    await settle();
    await click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    assert.equal(moved, false, "the switcher stays where it was");
    assert.ok(unsaved(), "and the work is still there");
    await act(async () => {
      void requestEditingTarget({ serviceTypeId: "st-1", planId: null }).then((ok) => (moved = ok));
    });
    await settle();
    await click(screen.getByRole("button", { name: "Discard" }));
    await settle();
    assert.equal(moved, true);
    assert.ok(!unsaved(), "discarding drops the edits");
  });
});

describe("prep from Planning Center", () => {
  const prep = () => (document.querySelector("[data-prep-capsule]")?.textContent ?? "") + " | " + (document.querySelector("[data-prep-ears]")?.textContent ?? "");

  test("the inspector shows the selected slot's capsule and that they bring their own in-ears", async () => {
    resolvedExtras = { a: { displayName: "Ana Rivera", prep: { capsule: "KSM9", ownIems: true } } };
    await mount();
    await click(card("a"));
    // The resolver answers after the preview's 250 ms debounce.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    assert.equal(prep(), "KSM9 | Brings their own");
  });

  test("no tag reads 'no tag', a bound IEM pack is house buds, and neither is no pack", async () => {
    layouts["b-left"] = [{ ...board("a")[0]!, iemBinding: { providerId: "wireless", channelId: "i1" } } as Slot, ...board("b | c").map((s, i) => ({ ...s, order: i + 1 }))];
    await mount();
    await click(card("a"));
    await settle();
    assert.equal(prep(), "no tag | House buds");
    await click(card("b"));
    await settle();
    assert.equal(prep(), "no tag | No pack on this slot");
  });

  test("the check names the people on mics with no capsule, and Show them marks and selects their slots", async () => {
    checkNoCapsule = [
      { boardId: "b-left", boardName: "Left wall", slotId: "b", name: "Ben" },
      { boardId: "b-left", boardName: "Left wall", slotId: "d", name: "Dee" },
    ];
    await mount();
    const row = document.querySelector("[data-check-no-capsule]")!;
    assert.ok((row.textContent ?? "").includes("2 people on slots with a mic have no Capsule tag yet"));
    await click(within(row as HTMLElement).getByRole("button", { name: "Show them" }));
    assert.equal(card("b").getAttribute("data-selected"), "true", "the first is selected");
    assert.equal(card("d").getAttribute("data-highlighted"), "true", "the rest are marked");
    await click(card("a"));
    assert.equal(card("d").getAttribute("data-highlighted"), null, "the next selection clears the marks");
  });

  test("no such people, no row", async () => {
    await mount();
    assert.ok(!document.querySelector("[data-check-no-capsule]"));
  });
});
