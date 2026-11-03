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

// A stage-state frame delivered the way the server sends one: api.ts subscribes
// with addEventListener(channel, handler), so this stub keeps the handlers.
const sseHandlers = new Map<string, Set<(e: { data: string }) => void>>();
(globalThis as unknown as { EventSource: unknown }).EventSource = class {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  addEventListener(channel: string, handler: (e: { data: string }) => void): void {
    sseHandlers.set(channel, (sseHandlers.get(channel) ?? new Set()).add(handler));
  }
  removeEventListener(channel: string, handler: (e: { data: string }) => void): void {
    sseHandlers.get(channel)?.delete(handler);
  }
  close(): void {}
};
function emit(channel: string, payload: unknown): void {
  for (const h of [...(sseHandlers.get(channel) ?? [])]) h({ data: JSON.stringify(payload) });
}

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
/** Layouts of a service type other than the one being edited, "board|type". */
let typeLayouts: Record<string, Slot[]> = {};
/** What the switcher lists: the copy dialogs read their service types and plans from it. */
let upcomingPlans: unknown[] = [];
/** Requests whose "METHOD path-suffix" is in here answer 500. */
let failing = new Set<string>();
/** What the screens' views carry: the left screen's own display width. */
let leftDisplayWidth: number | null = null;
/** Boards deleted from another tab: the list drops them and saving one is a 404. */
let goneBoards = new Set<string>();
/** Each board's saved revision, "board|default" or "board|plan"; a save carrying an older one is a 409. */
let revs: Record<string, number> = {};
const revOf = (boardId: string, side: "default" | "plan") => `r${revs[`${boardId}|${side}`] ?? 0}`;
/** While set, Save all answers only once it resolves. */
let holdSave: Promise<void> | null = null;
/** While set, Save all WRITES (the revisions move) and then answers only once it resolves:
 *  the server's boards:changed frame can reach the page before the answer does. */
let holdAfterWrite: Promise<void> | null = null;
/** A custom view with two slots widgets on Left wall, and its layout revision. */
let withWidgets = false;
let padRev = 0;
let padLayout: unknown = null;
const PAD_LAYOUT = () => ({
  version: 1,
  canvas: { width: 1920, height: 1080 },
  objects: [
    { id: "g-1", x: 0, y: 0, w: 0.5, h: 1, z: 0, config: { type: "slots-grid", boardId: "b-left" } },
    { id: "g-2", x: 0.5, y: 0, w: 0.5, h: 1, z: 1, config: { type: "slots-grid", boardId: "b-left" } },
  ],
});

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
      { id: "v-left", name: "Left Display", kind: "slots", boardId: "b-left", createdAt: "", ...(leftDisplayWidth ? { slotsLayout: { displayWidthIn: leftDisplayWidth } } : {}) },
      { id: "v-right", name: "Right Display", kind: "slots", boardId: "b-right", createdAt: "" },
      ...(withWidgets ? [{ id: "v-pad", name: "Stage Pad", kind: "custom", createdAt: "", layoutRev: padRev, layout: padLayout ?? PAD_LAYOUT() }] : []),
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
  const fails = [...failing].some((f) => `${method} ${path}`.endsWith(f));
  if (fails) {
    status = 500;
    out = { error: "the stub was told to fail" };
  } else if (path === "/api/state") out = STATE();
  else if (path === "/api/boards" && method === "GET") out = boards.filter((b) => !goneBoards.has(b.id));
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
      defaultSlots: (new URL(url, "http://x").searchParams.get("serviceTypeId") === "st-1" ? layouts[targets[1]!] : typeLayouts[`${targets[1]}|${new URL(url, "http://x").searchParams.get("serviceTypeId")}`]) ?? [],
      overrideSlots: new URL(url, "http://x").searchParams.get("planId") ? (overrides[targets[1]!] ?? null) : null,
      defaultRev: revOf(targets[1]!, "default"),
      overrideRev: revOf(targets[1]!, "plan"),
    };
  } else if (path === "/api/plans/upcoming") out = { plans: upcomingPlans, cacheAgeMs: 0 };
  else if (path === "/api/presets" && method === "GET") out = presets;
  else if (path === "/api/integrations/wireless/channels") out = [];
  else if (path === "/api/integrations/wireless/statuses") out = [];
  else if (path === "/api/views/resolve-slots" && failing.has("resolve")) {
    status = 500;
    out = { error: "the roster could not be read" };
  } else if (path === "/api/views/resolve-slots") out = { slots: (JSON.parse(body ?? "{}").slots as Slot[]).map((x) => ({ ...x, ...(resolvedExtras[x.id] ?? {}) })), roster: "none" };
  else if (path === "/api/boards/check") out = { serviceTypeId: "st-1", planId, roster: "none", unplaced: [], noPosition: [], noCapsule: checkNoCapsule };
  else if (path === "/api/boards/slots" && method === "POST") {
    if (holdSave) await holdSave;
    const asked = (JSON.parse(body ?? "{}").boards ?? []) as { boardId: string; rev?: string; target?: { kind: string } }[];
    const dead = asked.find((b) => goneBoards.has(b.boardId));
    const side = (b: { target?: { kind: string } }) => (b.target?.kind === "plan" ? "plan" : "default");
    // As the server does: every stale board is listed, not the first.
    const stale = asked.filter((b) => b.rev !== undefined && b.rev !== revOf(b.boardId, side(b)));
    if (stale.length > 0) {
      status = 409;
      const names = stale.map((b) => `"${boards.find((x) => x.id === b.boardId)?.name}"`).join(", ");
      out = {
        error: stale.length === 1 ? `Board ${names}: It was changed elsewhere since this page read it. Nothing was saved.` : `Boards ${names}: They were changed elsewhere since this page read them. Nothing was saved.`,
        code: "boards-changed",
        boards: stale.map((b) => ({ boardId: b.boardId, name: boards.find((x) => x.id === b.boardId)?.name, target: `${side(b)}:st-1` })),
      };
    } else if (dead) {
      status = 404;
      out = { error: `Board "${dead.boardId}": There is no board ${dead.boardId}.` };
    } else if (failSave) {
      status = 400;
      out = { error: failSave };
    } else {
      for (const b of asked) revs[`${b.boardId}|${side(b)}`] = (revs[`${b.boardId}|${side(b)}`] ?? 0) + 1;
      if (holdAfterWrite) await holdAfterWrite;
      out = STATE();
    }
  } else if (/^\/api\/boards\/[^/]+$/.test(path) && method === "DELETE") out = STATE();
  else if (/\/copy-from$|\/promote$|\/override\/[^/]+$/.test(path)) out = STATE();
  else if (/^\/api\/boards\/[^/]+$/.test(path) && method === "PATCH") out = boards;
  else if (path === "/api/views/v-pad" && method === "PATCH") {
    const sent = JSON.parse(body ?? "{}") as { layout: unknown; layoutRev?: number };
    if (sent.layoutRev !== undefined && sent.layoutRev !== padRev) {
      status = 409;
      out = { error: "The layout was changed elsewhere." };
    } else {
      padRev++;
      padLayout = sent.layout;
      out = STATE();
    }
  }
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
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { Toaster } = await import("../../components/ui/toast.js");
const { PageActionsProvider, PageActionsSlot } = await import("../page-actions.js");

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
  render(React.createElement(QueryClientProvider, { client }, React.createElement(TooltipProvider, null, React.createElement(MicSlotsPage, null), React.createElement(ConfirmHost, null), React.createElement(Toaster, null))));
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
  typeLayouts = {};
  upcomingPlans = [];
  failing = new Set();
  leftDisplayWidth = null;
  goneBoards = new Set();
  revs = {};
  holdSave = null;
  holdAfterWrite = null;
  withWidgets = false;
  padRev = 0;
  padLayout = null;
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

  test("only the zone under the pointer is labelled, and it is opaque over the name", async () => {
    // Every zone covers its card's name band while a drag is on. A label in each
    // one printed "Stack below" over every name on the board at once.
    await mount();
    install();
    placeRects();
    const s = centre(card("d"));
    await act(async () => {
      fireEvent.mouseDown(card("d"), { button: 0, clientX: s.x, clientY: s.y });
      fireEvent.mouseMove(document, { clientX: s.x + 8, clientY: s.y + 8 });
    });
    await settle();
    const labels = () => [...document.querySelectorAll("[data-mic-stack]")].filter((z) => /stack below/i.test(z.textContent ?? "")).length;
    const g = centre(gap("b-left", 1));
    await act(async () => {
      fireEvent.mouseMove(document, { clientX: g.x, clientY: g.y });
    });
    await settle();
    assert.equal(labels(), 0, "a zone the pointer is not over must not print over a card's name");
    const z = centre(stackZone("a"));
    await act(async () => {
      fireEvent.mouseMove(document, { clientX: z.x, clientY: z.y });
    });
    await settle();
    assert.equal(labels(), 1);
    const label = stackZone("a").querySelector("[data-mic-stack-label]");
    assert.ok(label);
    assert.match((stackZone("a") as HTMLElement).style.background, /color-mix/);
    // A column is narrow enough that both wrap to two lines; uncentred, each
    // wrapped line sits against the left edge.
    assert.ok(label.classList.contains("text-center"), "the stack label's wrapped lines must be centred");
    const chip = document.querySelector("[data-mic-drag-label]");
    assert.ok(chip, "the dragged slot's name chip must be showing");
    assert.ok(chip.classList.contains("text-center"), "the dragged name's wrapped lines must be centred");
    await act(async () => {
      fireEvent.mouseUp(document, { clientX: z.x, clientY: z.y });
    });
    uninstall();
    await settle();
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

  test("+ Slot and + Spacer work with no crypto.randomUUID, as over plain HTTP", async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
    try {
      await mount();
      await click(within(section("b-right")).getByRole("button", { name: "Slot" }));
      await click(within(section("b-right")).getByRole("button", { name: "Spacer" }));
      assert.equal(section("b-right").querySelectorAll("[data-mic-slot]").length, 3, "a third slot");
      assert.equal(section("b-right").querySelectorAll("[data-mic-spacer]").length, 1, "and a spacer");
    } finally {
      if (real) Object.defineProperty(globalThis.crypto, "randomUUID", real);
      else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
    }
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

// ── copying, and what it must never do ──────────────────────────────────────

const PLANS_TWO_TYPES = () => [
  { serviceTypeId: "st-1", serviceTypeName: "Weekend", planId: "p1", title: "Sunday", sortDate: "2026-09-13T14:00:00Z", dates: "September 13, 2026", isCurrent: true },
  { serviceTypeId: "st-2", serviceTypeName: "Youth Night", planId: "y1", title: "Youth", sortDate: "2026-09-16T23:00:00Z", dates: "September 16, 2026", isCurrent: false },
];
const copyPosts = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/copy-from"));
const alertDialog = () => screen.getByRole("alertdialog");
const pickOption = async (label: string, value: string) => {
  const select = screen.getAllByLabelText(label).find((el) => el.tagName === "SELECT")!;
  await act(async () => {
    fireEvent.change(select, { target: { value } });
  });
};

async function copyEveryBoardFromYouth() {
  await openMenu(screen.getByRole("button", { name: "Plan board actions" }));
  await choose(screen.getByRole("menuitem", { name: /Copy every board/ }));
  await click(within(screen.getByRole("dialog")).getByRole("button", { name: "A service type" }));
  await pickOption("Copy from", "st-2");
  await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy" }));
}

describe("copying a layout over boards", () => {
  test("a board whose source has no layout is skipped and named, never blanked", async () => {
    upcomingPlans = PLANS_TWO_TYPES();
    typeLayouts = { "b-left|st-2": board("m | n") }; // Right wall has nothing for Youth Night
    await mount();
    await copyEveryBoardFromYouth();
    // Both boards have saved rows here, so it asks first, and says what is left alone.
    const text = alertDialog().textContent ?? "";
    assert.ok(text.includes("Left wall (its saved layout)"), text);
    assert.ok(text.includes("Right wall: Youth Night default has no layout"), "the skipped board is named");
    await click(within(alertDialog()).getByRole("button", { name: "Copy" }));
    assert.deepEqual(copyPosts().map((r) => r.url.split("/")[3]), ["b-left"], "Right wall was not written to");
  });

  test("nothing to copy anywhere writes nothing and says so", async () => {
    upcomingPlans = PLANS_TWO_TYPES();
    await mount();
    await copyEveryBoardFromYouth();
    assert.equal(copyPosts().length, 0, "a copy of nothing was sent");
    assert.equal(document.querySelector("[role=alertdialog]"), null, "and nothing was asked about replacing");
  });

  test("replacing saved rows asks first, naming the target, and Cancel writes nothing", async () => {
    upcomingPlans = PLANS_TWO_TYPES();
    typeLayouts = { "b-left|st-2": board("m"), "b-right|st-2": board("n") };
    await mount();
    await copyEveryBoardFromYouth();
    assert.ok((alertDialog().textContent ?? "").includes("Weekend default on Left wall, Right wall is replaced"));
    await click(within(alertDialog()).getByRole("button", { name: "Cancel" }));
    assert.equal(copyPosts().length, 0);
  });

  test("one board, from another board with no layout, is left as it was", async () => {
    layouts["b-right"] = [];
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Left wall" }));
    await choose(screen.getByRole("menuitem", { name: /Copy this board from/ }));
    await pickOption("Copy from", "b-right");
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy" }));
    assert.equal(copyPosts().length, 0);
    assert.equal(shape("b-left"), "a | b+c | ~s | d");
  });
});

// ── Save all and a board deleted elsewhere ──────────────────────────────────

describe("a board deleted in another tab", () => {
  test("Save all drops it, says whose edits went, and still saves the others", async () => {
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await click(screen.getAllByRole("button", { name: "Slot" })[1]!);
    goneBoards = new Set(["b-right"]);
    await click(screen.getByRole("button", { name: "Save all" }));
    const sent = posts("/api/boards/slots").map((r) => (JSON.parse(r.body!) as { boards: { boardId: string }[] }).boards.map((b) => b.boardId));
    assert.deepEqual(sent, [["b-left", "b-right"], ["b-left"]], "the second request is the surviving board alone");
    assert.ok(!unsaved(), "Left wall saved");
    assert.equal(section("b-right"), null, "the page dropped the vanished board");
    assert.ok(document.body.textContent!.includes("Right wall was deleted elsewhere, so its unsaved changes were dropped"));
  });

  test("a deletion noticed before saving says so rather than quietly shrinking the count", async () => {
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[1]!);
    assert.ok(unsaved());
    goneBoards = new Set(["b-right"]);
    await act(async () => {
      await client!.invalidateQueries({ queryKey: ["boards:list"] });
    });
    await settle();
    assert.ok(!unsaved(), "its edits went with it");
    assert.ok(document.body.textContent!.includes("Right wall was deleted elsewhere"));
  });

  test("deleting a board here does not read its layouts again afterwards", async () => {
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Right wall" }));
    await choose(screen.getByRole("menuitem", { name: "Delete board…" }));
    const at = requests.length;
    goneBoards = new Set(["b-right"]);
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete board" }));
    await settle();
    const after = requests.slice(at).filter((r) => r.url.includes("/api/boards/b-right/targets"));
    assert.equal(after.length, 0, "a read of the deleted board's layouts is a 404 per plan");
  });
});

describe("Discard", () => {
  test("throws away the unsaved work, after asking", async () => {
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    assert.ok(unsaved());
    await click(screen.getByRole("button", { name: "Discard" }));
    assert.ok((alertDialog().textContent ?? "").includes("Left wall"), "it names the boards");
    await click(within(alertDialog()).getByRole("button", { name: "Cancel" }));
    assert.ok(unsaved(), "Cancel keeps it");
    await click(screen.getByRole("button", { name: "Discard" }));
    await click(within(alertDialog()).getByRole("button", { name: "Discard" }));
    assert.ok(!unsaved());
    assert.equal(shape("b-left"), "a | b+c | ~s | d");
  });
});

// ── an empty board is still a place to drop ─────────────────────────────────

describe("an empty board", () => {
  test("takes a card dragged onto it from another board", async () => {
    layouts["b-right"] = [];
    await mount();
    assert.ok(document.querySelector('[data-mic-empty="b-right"]'), "it shows its empty state");
    await drag(card("d"), gap("b-right", 0));
    assert.equal(shape("b-left"), "a | b+c | ~s");
    assert.equal(shape("b-right"), "d");
  });
});

// ── dialogs forget what was not applied ─────────────────────────────────────

describe("the charger layout dialog", () => {
  const open = async (board = "Left wall") => {
    await openMenu(screen.getByRole("button", { name: `Board actions for ${board}` }));
    await choose(screen.getByRole("menuitem", { name: "Charger layout…" }));
  };

  test("starts fresh each time it is opened", async () => {
    await mount();
    await open();
    await click(screen.getByRole("switch", { name: "Align to chargers" }));
    assert.equal(screen.getByRole("switch", { name: "Align to chargers" }).getAttribute("aria-checked"), "true");
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await open();
    assert.equal(screen.getByRole("switch", { name: "Align to chargers" }).getAttribute("aria-checked"), "false", "an unapplied switch was kept");
  });

  test("lists every screen showing the board, and writes only what is applied", async () => {
    leftDisplayWidth = null;
    await mount();
    await open();
    await click(screen.getByRole("switch", { name: "Align to chargers" }));
    const input = screen.getByLabelText("Display width of Left Display (inches)") as HTMLInputElement;
    assert.equal(input.value, "32.25", "prefilled with a 37 inch panel's width");
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    const writes = requests.filter((r) => r.method !== "GET" && /\/api\/(views|boards)\/(v-left|b-left)$/.test(new URL(r.url, "http://x").pathname));
    assert.deepEqual(writes.map((w) => [w.method, new URL(w.url, "http://x").pathname.split("/")[3], JSON.parse(w.body!)]), [
      ["PATCH", "b-left", { columnWidthIn: 3.49 }],
      ["PATCH", "v-left", { slotsLayout: { displayWidthIn: 32.25 } }],
    ]);
  });

  test("a screen that already has a width keeps it unless the operator changes it", async () => {
    leftDisplayWidth = 40;
    await mount();
    await open();
    await click(screen.getByRole("switch", { name: "Align to chargers" }));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    assert.equal(requests.filter((r) => r.method === "PATCH" && r.url.endsWith("/api/views/v-left")).length, 0, "its own width was overwritten");
  });
});

describe("the delete dialog", () => {
  test("forgets a replacement that was chosen and cancelled", async () => {
    await mount();
    const openDelete = async () => {
      await openMenu(screen.getByRole("button", { name: "Board actions for Right wall" }));
      await choose(screen.getByRole("menuitem", { name: "Delete board…" }));
    };
    await openDelete();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Show instead"), { target: { value: "b-left" } });
    });
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await openDelete();
    assert.equal((screen.getByLabelText("Show instead") as HTMLSelectElement).value, "__nothing__");
  });
});

// ── Revert and Set as default with unsaved work ─────────────────────────────

describe("Revert and Set as default", () => {
  const withPlanLayout = () => {
    planId = "p1";
    overrides = { "b-left": board("o1 | o2") };
  };
  const planMenu = async (item: RegExp) => {
    await openMenu(screen.getByRole("button", { name: "Plan board actions" }));
    await choose(screen.getByRole("menuitem", { name: item }));
  };
  const deletes = () => requests.filter((r) => r.method === "DELETE" && r.url.includes("/override/"));
  const promotes = () => requests.filter((r) => r.method === "POST" && r.url.endsWith("/promote"));

  test("Revert says it throws the unsaved edits away, and Cancel keeps them", async () => {
    withPlanLayout();
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await planMenu(/^Revert/);
    assert.ok((alertDialog().textContent ?? "").includes("Unsaved changes to Left wall are thrown away"));
    await click(within(alertDialog()).getByRole("button", { name: "Cancel" }));
    assert.ok(unsaved(), "the edits survive a Cancel");
    assert.equal(deletes().length, 0);
  });

  test("Revert drops the edits only once the request has landed: a refusal loses nothing", async () => {
    withPlanLayout();
    failing = new Set(["DELETE /api/boards/b-left/override/p1"]);
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await planMenu(/^Revert/);
    await click(within(alertDialog()).getByRole("button", { name: "Revert and discard changes" }));
    await settle();
    assert.equal(deletes().length, 1, "it was tried");
    assert.ok(unsaved(), "a refused revert must not have thrown the work away first");
    failing = new Set();
    await planMenu(/^Revert/);
    await click(within(alertDialog()).getByRole("button", { name: "Revert and discard changes" }));
    await settle();
    assert.ok(!unsaved(), "after it lands, they go");
  });

  test("Set as default saves the unsaved edits first, then promotes", async () => {
    withPlanLayout();
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await planMenu(/^Set .* as/);
    assert.ok((alertDialog().textContent ?? "").includes("Unsaved changes to Left wall are saved first"));
    await click(within(alertDialog()).getByRole("button", { name: "Save, then set as default" }));
    await settle();
    const order = requests.filter((r) => r.method === "POST" && (r.url.endsWith("/api/boards/slots") || r.url.endsWith("/promote"))).map((r) => r.url.split("/").slice(3).join("/"));
    assert.deepEqual(order, ["slots", "b-left/promote"], "promoting before saving would promote the old layout");
  });

  test("a save that is refused promotes nothing", async () => {
    withPlanLayout();
    failSave = "Board \"Left wall\": nope";
    await mount();
    await click(screen.getAllByRole("button", { name: "Slot" })[0]!);
    await planMenu(/^Set .* as/);
    await click(within(alertDialog()).getByRole("button", { name: "Save, then set as default" }));
    await settle();
    assert.equal(promotes().length, 0);
    assert.ok(unsaved());
  });

  test("one board has its own Set as default, and Revert, in its menu", async () => {
    withPlanLayout();
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Left wall" }));
    await choose(screen.getByRole("menuitem", { name: "Set this board as the default" }));
    await click(within(alertDialog()).getByRole("button", { name: "Set as default" }));
    await settle();
    assert.deepEqual(promotes().map((r) => r.url.split("/")[3]), ["b-left"], "only the board whose menu it was");
    await openMenu(screen.getByRole("button", { name: "Board actions for Right wall" }));
    assert.equal(screen.getByRole("menuitem", { name: "Set this board as the default" }).getAttribute("aria-disabled"), "true", "Right wall has no plan layout to promote");
  });
});

// ── smaller things ──────────────────────────────────────────────────────────

describe("when the preview cannot read the plan's people", () => {
  test("the board says so instead of showing names-less cards as a week with nobody", async () => {
    failing = new Set(["resolve"]);
    await mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    await settle();
    assert.ok(section("b-left").querySelector("[data-mic-preview-failed]"), "no word that the people could not be loaded");
  });
});

describe("Show them on the Default side", () => {
  test("moves to the plan's own layout when the slots only exist there", async () => {
    planId = "p1";
    overrides = { "b-left": board("o1 | o2") };
    checkNoCapsule = [{ boardId: "b-left", boardName: "Left wall", slotId: "o1", name: "Ana" }];
    await mount();
    await click(screen.getByRole("button", { name: /Weekend default/ }));
    assert.equal(card("o1"), null, "on the default the slot is not there");
    await click(within(document.querySelector("[data-check-no-capsule]") as HTMLElement).getByRole("button", { name: "Show them" }));
    assert.equal(card("o1")?.getAttribute("data-selected"), "true", "it went to the plan and selected the slot");
  });

  test("with no plan to go to, it says where they are rather than doing nothing", async () => {
    checkNoCapsule = [{ boardId: "b-left", boardName: "Left wall", slotId: "gone-slot", name: "Ana" }];
    await mount();
    await click(within(document.querySelector("[data-check-no-capsule]") as HTMLElement).getByRole("button", { name: "Show them" }));
    assert.ok(document.body.textContent!.includes("Switch to it to see it"));
  });
});

describe("Overwrite on a saved layout", () => {
  const preset = () => ({ id: "p1", name: "Opening", slots: board("q"), createdAt: "2026-04-02T00:00:00Z", boardId: "b-right" }) as SlotPreset;
  const patches = () => requests.filter((r) => r.method === "PATCH" && r.url.endsWith("/api/presets/p1"));

  test("records the board it now comes from", async () => {
    presets = [preset()];
    await mount();
    await click(screen.getByRole("button", { name: "Saved layouts" }));
    // The Save picker names the board; Overwrite uses it, and the layout now comes from it.
    await openMenu(screen.getByRole("button", { name: "More for Opening" }));
    await choose(screen.getByRole("menuitem", { name: /^Overwrite with/ }));
    await click(within(alertDialog()).getByRole("button", { name: "Overwrite" }));
    await settle();
    assert.equal(JSON.parse(patches()[0]!.body!).boardId, "b-left");
  });

  test("refuses an empty board, as Save does", async () => {
    presets = [preset()];
    layouts["b-left"] = [];
    await mount();
    await click(screen.getByRole("button", { name: "Saved layouts" }));
    await openMenu(screen.getByRole("button", { name: "More for Opening" }));
    await choose(screen.getByRole("menuitem", { name: /^Overwrite with/ }));
    assert.equal(document.querySelector("[role=alertdialog]"), null, "no confirm for an overwrite that cannot happen");
    assert.equal(patches().length, 0);
  });

  test("the reorder grip can be reached from the keyboard", async () => {
    presets = [preset()];
    await mount();
    await click(screen.getByRole("button", { name: "Saved layouts" }));
    assert.notEqual(screen.getByRole("button", { name: "Reorder Opening" }).getAttribute("tabindex"), "-1");
  });
});

describe("the inspector folds away with nothing selected", () => {
  async function mountWithChrome() {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(PageActionsProvider, null, React.createElement(PageActionsSlot, null), React.createElement(MicSlotsPage, null)),
          React.createElement(ConfirmHost, null),
          React.createElement(Toaster, null),
        ),
      ),
    );
    await settle();
  }
  const inspector = () => document.querySelector("[data-mic-inspector]") as HTMLElement;
  const isOpen = () => inspector().getAttribute("data-mic-inspector") === "open";
  const toggle = () => screen.getByRole("button", { name: /inspector/i });
  /** What a real click does: down (focus lands here, and selects), then up, then click. */
  const press = async (el: HTMLElement) => {
    await act(async () => {
      fireEvent.pointerDown(el, { button: 0 });
      fireEvent.mouseDown(el, { button: 0 });
      el.focus();
      fireEvent.pointerUp(el, { button: 0 });
      fireEvent.mouseUp(el, { button: 0 });
      fireEvent.click(el);
    });
    await settle();
  };

  test("closed and inert until a slot is selected", async () => {
    await mountWithChrome();
    assert.equal(isOpen(), false);
    assert.ok(inspector().hasAttribute("inert"), "a folded inspector must not take focus");
    assert.equal(toggle().getAttribute("aria-pressed"), "false");
  });

  test("selecting a slot opens it, and pressing the same slot again folds it away", async () => {
    await mountWithChrome();
    await press(card("a"));
    assert.equal(isOpen(), true, "a selected slot opens the inspector");
    assert.equal(card("a").getAttribute("aria-pressed"), "true");
    await press(card("b"));
    assert.equal(isOpen(), true, "another slot moves the selection, the inspector stays");
    assert.equal(card("b").getAttribute("aria-pressed"), "true");
    await press(card("b"));
    assert.equal(isOpen(), false, "the selected slot pressed again folds the inspector away");
    assert.equal(card("b").getAttribute("aria-pressed"), "false");
    await press(card("b"));
    assert.equal(isOpen(), true, "and pressing it once more opens it again");
  });

  test("the button opens it on the drag help, and closes it with a slot selected", async () => {
    await mountWithChrome();
    await click(toggle());
    assert.equal(isOpen(), true);
    assert.match(inspector().textContent ?? "", /Drag a card into a gap/);
    await click(toggle());
    assert.equal(isOpen(), false);
    await press(card("a"));
    assert.equal(isOpen(), true);
    await click(toggle());
    assert.equal(isOpen(), false, "closing by the button clears the selection");
    assert.equal(card("a").getAttribute("aria-pressed"), "false");
  });

  test("Column width on a stacked card sets its column's width, which the lead carries", async () => {
    boards = BOARDS().map((b) => (b.id === "b-left" ? { ...b, columnWidthIn: 3.49 } : b));
    await mountWithChrome();
    await press(card("c"));
    const input = within(inspector()).getByLabelText("Column width (inches)") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    await settle();
    await click(screen.getByRole("button", { name: "Save all" }));
    const sent = (JSON.parse(posts("/api/boards/slots")[0]!.body!) as { boards: { boardId: string; slots: Slot[] }[] }).boards[0]!.slots;
    assert.deepEqual(sent.filter((x) => x.id === "b" || x.id === "c").map((x) => [x.id, x.widthIn ?? null]), [["b", 5], ["c", null]], "the width landed on a card no screen reads it from");
  });
});

// ── where the unsaved work is saved, and over what ──────────────────────────

const sentBoards = (i = 0) =>
  (JSON.parse(posts("/api/boards/slots")[i]!.body!) as { boards: { boardId: string; slots: Slot[]; target: { kind: string; planId?: string }; rev?: string }[] }).boards;
const leftSlot = () => within(section("b-left")).getByRole("button", { name: "Slot" });
const rightSlot = () => within(section("b-right")).getByRole("button", { name: "Slot" });
const frame = async () => {
  await act(async () => emit("stage:state-changed", STATE()));
  await settle();
};

describe("the target moving under unsaved work", () => {
  test("the live plan advancing keeps the edits on the plan they were made for", async () => {
    planId = "p1";
    await mount();
    await click(leftSlot());
    planId = "p2";
    await frame();
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.equal(sentBoards()[0]!.target.planId, "p1", "one week's edits were saved onto the next");
    assert.ok(document.body.textContent!.includes("The plan moved on"), "the operator is told");
  });

  test("the live plan clearing does not drop the edits onto the default", async () => {
    planId = "p1";
    await mount();
    await click(leftSlot());
    planId = null;
    await frame();
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.deepEqual(sentBoards()[0]!.target.kind, "plan", "a plan's edits were saved as the type's default");
    assert.equal(sentBoards()[0]!.target.planId, "p1");
  });

  test("with nothing unsaved, the editor follows the plan forward", async () => {
    planId = "p1";
    await mount();
    planId = "p2";
    await frame();
    await click(leftSlot());
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.equal(sentBoards()[0]!.target.planId, "p2");
  });
});

describe("a board saved from another browser", () => {
  test("Save all carries the revision each board's edits were made over", async () => {
    revs = { "b-left|default": 4 };
    await mount();
    await click(leftSlot());
    await click(rightSlot());
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.deepEqual(sentBoards().map((b) => [b.boardId, b.rev]).sort(), [["b-left", "r4"], ["b-right", "r0"]]);
  });

  test("a stale revision asks before saving over it, and Cancel keeps the work and names the board", async () => {
    await mount();
    await click(leftSlot());
    revs = { "b-left|default": 1 }; // saved elsewhere
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.ok((alertDialog().textContent ?? "").includes("Left wall"), "the question names the board");
    await click(within(alertDialog()).getByRole("button", { name: "Cancel" }));
    assert.ok(unsaved(), "the work is kept");
    assert.ok(within(section("b-left")).getByRole("alert").textContent!.includes("changed elsewhere"));
    assert.equal(posts("/api/boards/slots").length, 1, "nothing was sent again");
  });

  test("two boards saved elsewhere: the question and the marks name both", async () => {
    await mount();
    await click(leftSlot());
    await click(rightSlot());
    revs = { "b-left|default": 1, "b-right|default": 1 };
    await click(screen.getByRole("button", { name: "Save all" }));
    const asked = alertDialog().textContent ?? "";
    assert.ok(asked.includes("Left wall") && asked.includes("Right wall"), `the question named only one board: ${asked}`);
    await click(within(alertDialog()).getByRole("button", { name: "Cancel" }));
    for (const id of ["b-left", "b-right"]) {
      assert.ok(within(section(id)).queryByRole("alert")?.textContent?.includes("changed elsewhere"), `${id} is not marked`);
    }
  });

  test("Save over it sends the edits again over what is saved now", async () => {
    await mount();
    await click(leftSlot());
    revs = { "b-left|default": 1 };
    await click(screen.getByRole("button", { name: "Save all" }));
    await click(within(alertDialog()).getByRole("button", { name: "Save over it" }));
    await settle();
    assert.equal(posts("/api/boards/slots").length, 2);
    assert.equal(sentBoards(1)[0]!.rev, "r1");
    assert.ok(!unsaved(), "saved");
  });

  test("a stage-state frame does not re-read the layouts: boards:changed does that", async () => {
    await mount();
    const reads = () => requests.filter((r) => r.method === "GET" && r.url.includes("/targets")).length;
    const before = reads();
    await act(async () =>
      emit("stage:state-changed", { ...STATE(), slotsByView: { "v-left": [slot("a", { device: { status: "ok", rf: 3, battery: 50, freq: null, audioLevel: 0.4, charge: null, iemCharge: null, label: null, iemLabel: null } })] } }),
    );
    await settle();
    assert.equal(reads(), before, "telemetry re-read the layouts");
  });
});

describe("boards:changed", () => {
  const targetReads = (boardId: string) => requests.filter((r) => r.method === "GET" && r.url.includes(`/api/boards/${boardId}/targets`)).length;
  const changed = (seq: number, ...ids: string[]) => ({ epoch: "e1", seq, boards: ids.map((id) => ({ id, meta: false, targets: ["default:st-1"] })) });
  const frame = async (payload: unknown) => {
    await act(async () => emit("boards:changed", payload));
    await settle();
  };

  test("re-reads exactly the board a frame names, one no screen shows included", async () => {
    boards = [...BOARDS(), { id: "b-spare", name: "Spare", columnWidthIn: null, createdAt: "", shownOn: [] } as unknown as SlotBoardDTO];
    layouts["b-spare"] = board("q");
    await mount();
    const [spare, left] = [targetReads("b-spare"), targetReads("b-left")];
    layouts["b-spare"] = board("q | z");
    await frame(changed(1, "b-spare"));
    assert.equal(targetReads("b-spare"), spare + 1, "the board saved elsewhere was not read again");
    assert.equal(targetReads("b-left"), left, "a board the frame did not name was read again");
    assert.equal(shape("b-spare"), "q | z", "the page still shows the old layout");
  });

  test("a board with unsaved edits is marked, not overwritten, before Save all", async () => {
    await mount();
    await frame(changed(1, "b-right"));
    await click(leftSlot());
    revs = { "b-left|default": 1 }; // saved from another browser
    await frame(changed(2, "b-left"));
    assert.ok(unsaved(), "the edits were dropped");
    assert.ok(within(section("b-left")).queryByRole("alert")?.textContent?.includes("changed elsewhere"), "the board is not marked");
    assert.equal(!!within(section("b-right")).queryByRole("alert"), false, "a clean board was marked");
  });

  test("a frame that is not the next one re-reads every board", async () => {
    await mount();
    await frame(changed(1, "b-right"));
    const left = targetReads("b-left");
    await frame(changed(5, "b-right"));
    assert.equal(targetReads("b-left"), left + 1, "a missed change went unread");
  });

  test("this page's own Save all is not marked as a change from elsewhere", async () => {
    await mount();
    await frame(changed(1, "b-right"));
    await click(leftSlot());
    let release!: () => void;
    holdAfterWrite = new Promise<void>((r) => (release = r));
    await click(screen.getByRole("button", { name: "Save all" }));
    await frame(changed(2, "b-left")); // the write's own frame, ahead of the answer
    assert.equal(!!within(section("b-left")).queryByRole("alert"), false, "its own save marked the board");
    release();
    await settle();
    assert.ok(!unsaved(), "saved");
    assert.equal(!!within(section("b-left")).queryByRole("alert"), false);
  });
});

describe("a board whose layouts could not be read", () => {
  test("cannot be edited, says why, and does not hide the other board's empty state", async () => {
    layouts["b-left"] = [];
    failing = new Set(["GET /api/boards/b-right/targets"]);
    await mount();
    assert.equal((rightSlot() as HTMLButtonElement).disabled, true, "+ Slot on a board that was not read");
    assert.equal((within(section("b-right")).getByRole("button", { name: "Spacer" }) as HTMLButtonElement).disabled, true);
    assert.ok(section("b-right").querySelector("[data-mic-unread]")?.textContent?.includes("Couldn't read"), "it says why");
    assert.equal(section("b-right").querySelector("[data-mic-gap]"), null, "no drop zone on it");
    assert.ok(document.querySelector('[data-mic-empty="b-left"]'), "the other board's empty state is hidden");
    assert.equal((leftSlot() as HTMLButtonElement).disabled, false);
  });

});

describe("Save all while the operator keeps editing", () => {
  test("an edit made while the save is in flight stays unsaved", async () => {
    let release!: () => void;
    holdSave = new Promise<void>((r) => (release = r));
    await mount();
    await click(leftSlot());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save all" }));
    });
    await settle();
    await click(leftSlot());
    await act(async () => release());
    await settle();
    assert.ok(unsaved(), "the second card was thrown away with the first");
    assert.equal(section("b-left").querySelectorAll("[data-mic-slot]").length, 6, "four slots, plus both new ones");
    holdSave = null;
    await click(screen.getByRole("button", { name: "Save all" }));
    assert.equal(sentBoards(1)[0]!.rev, "r1", "the edit made in flight is over what that save wrote");
  });
});

describe("two widgets in one view", () => {
  test("charger widths for both land: the second uses the revision the first produced", async () => {
    withWidgets = true;
    boards = BOARDS().map((b) =>
      b.id === "b-left"
        ? { ...b, shownOn: [...b.shownOn, { kind: "object", id: "g-1", name: "Stage Pad", viewId: "v-pad" }, { kind: "object", id: "g-2", name: "Stage Pad", viewId: "v-pad" }] }
        : b,
    ) as SlotBoardDTO[];
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Left wall" }));
    await choose(screen.getByRole("menuitem", { name: "Charger layout…" }));
    await click(screen.getByRole("switch", { name: "Align to chargers" }));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    await settle();
    const pads = requests.filter((r) => r.method === "PATCH" && r.url.endsWith("/api/views/v-pad"));
    assert.deepEqual(pads.map((r) => (JSON.parse(r.body!) as { layoutRev: number }).layoutRev), [0, 1]);
    assert.equal(padRev, 2, "the second widget's width was refused");
    assert.ok(!document.body.textContent!.includes("Couldn't set the display width"));
  });
});

describe("plan-wide Revert and Set as default from the Default side", () => {
  test("are off, even with a plan layout to act on", async () => {
    planId = "p1";
    overrides = { "b-left": board("o1 | o2") };
    await mount();
    await click(screen.getByRole("button", { name: /Weekend default/ }));
    await openMenu(screen.getByRole("button", { name: "Plan board actions" }));
    assert.equal(screen.getByRole("menuitem", { name: /^Revert/ }).getAttribute("aria-disabled"), "true");
    assert.equal(screen.getByRole("menuitem", { name: /^Set .* as/ }).getAttribute("aria-disabled"), "true");
  });
});

describe("a dialog whose write failed", () => {
  const dialogOpen = () => !!screen.queryByRole("dialog");

  test("New board stays open when the board could not be made", async () => {
    failing = new Set(["POST /api/boards"]);
    await mount();
    await click(screen.getByRole("button", { name: "New board" }));
    await act(async () => {
      fireEvent.change(document.getElementById("new-board-name")!, { target: { value: "Choir" } });
    });
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create board" }));
    assert.ok(dialogOpen(), "the dialog closed on a board that was never made");
  });

  test("Delete stays open when the delete was refused", async () => {
    failing = new Set(["DELETE /api/boards/b-right"]);
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Right wall" }));
    await choose(screen.getByRole("menuitem", { name: "Delete board…" }));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete board" }));
    assert.ok(dialogOpen(), "the dialog closed on a board that is still there");
  });

  test("Copy stays open when the copy was refused", async () => {
    failing = new Set(["POST /api/boards/b-left/copy-from"]);
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Left wall" }));
    await choose(screen.getByRole("menuitem", { name: /Copy this board from/ }));
    await pickOption("Copy from", "b-right");
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy" }));
    await click(within(alertDialog()).getByRole("button", { name: "Copy" }));
    assert.ok(dialogOpen(), "the dialog closed on a copy that never landed");
  });

  test("Charger layout stays open when the column width was refused", async () => {
    failing = new Set(["PATCH /api/boards/b-left"]);
    await mount();
    await openMenu(screen.getByRole("button", { name: "Board actions for Left wall" }));
    await choose(screen.getByRole("menuitem", { name: "Charger layout…" }));
    await click(screen.getByRole("switch", { name: "Align to chargers" }));
    await click(within(screen.getByRole("dialog")).getByRole("button", { name: "Apply" }));
    assert.ok(dialogOpen(), "the dialog closed on a width that was never set");
  });
});

describe("duplicating a board with unsaved changes", () => {
  test("says the copy is of the saved layout, and Cancel duplicates nothing", async () => {
    await mount();
    await click(leftSlot());
    await openMenu(screen.getByRole("button", { name: "Board actions for Left wall" }));
    await choose(screen.getByRole("menuitem", { name: "Duplicate board" }));
    assert.ok((alertDialog().textContent ?? "").includes("unsaved"), "it says the unsaved changes are not in the copy");
    await click(within(alertDialog()).getByRole("button", { name: "Cancel" }));
    assert.equal(requests.filter((r) => r.method === "POST" && r.url.endsWith("/duplicate")).length, 0);
  });
});
