// /stageplots/edit through the real page, cards and hook, against a small fake
// of the /api/stageplots routes that changes a document, answers like the
// server and broadcasts it on stageplots:updated.
//
// What is NOT here: pdf.js rendering (jsdom has no canvas; the page picker is
// handed a fake PDF here and driven with a real one in a browser), the fade
// slider's drag (jsdom fires no pointer drag on a range input), pan and zoom
// on the canvas, and every measured size. Those are driven in a browser.
//
// Every name below is invented. This is a public repository.

import { strict as assert } from "node:assert";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import type { BackgroundView, Plot, StagePlotsView } from "@main/types/stageplots";

import { overridesOfPlot, plotHeight } from "@main/services/stageplots-doc";
import { applyOverride, itemsWithin, readOverrideChange, validateItems } from "@main/services/stageplots-store";
import type { UpcomingPlansDTO } from "@main/types/pco";
import type { PatchFile } from "@main/types/patch";

import { installRenderDom, settle, unmountAndTeardown } from "../../test-dom.js";
import { FakeEventSource } from "../../test-fixtures/fake-event-source.js";

const teardown = installRenderDom();
(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;

let DOC: StagePlotsView;
/** Every write the page sent, as "METHOD path", with its body. */
let sent: { what: string; body: unknown }[] = [];
/** When set, the next write with this "METHOD path" prefix answers 400 with this error. */
let refuse: { what: string; error: string } | null = null;
let ids = 0;
/** What GET /api/state answers: {} (Planning Center not connected) unless a test sets it. */
let STATE: unknown = {};
let UPCOMING: UpcomingPlansDTO = { plans: [], cacheAgeMs: 0 };
/** What GET /api/stageplots/patch answers, or a 503 while PATCH_DOWN. */
let PATCH: PatchFile;
let PATCH_DOWN = false;
/** While set, GET /api/stageplots/patch waits for it: a patch that has not answered yet. */
let PATCH_HOLD: Promise<void> | null = null;

function patchFile(): PatchFile {
  return {
    updatedAt: "",
    sheets: [
      { id: "empty", name: "Offsite kit", kind: "analog", devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} } },
      {
        id: "main",
        name: "Main patch",
        kind: "analog",
        devices: [
          { id: "rack-a", name: "Rack A", kind: "rack", inputs: 32, outputs: 16 },
          { id: "sb1", name: "SB-1", kind: "snake", inputs: 16, outputs: 4, color: "#0091ff" },
          { id: "fp3", name: "FP-3", kind: "pocket", inputs: 4, outputs: 0, color: "#12a594" },
        ],
        endpoints: [
          { rackId: "rack-a", dir: "in", index: 1, consoleChannel: "1", label: "Kick In", path: [{ deviceId: "sb1", connector: "1" }] },
          { rackId: "rack-a", dir: "in", index: 2, consoleChannel: "2", label: "Kick Out", path: [{ deviceId: "sb1", connector: "2" }] },
        ],
        variants: [],
        assignments: { byServiceType: {}, byPlan: {} },
      },
    ],
  };
}

/** Tell the open pages the patch was saved, as patchStore.save does. */
function patchSaved() {
  FakeEventSource.last?.push("patch:updated", PATCH);
}

function bg(id: string, name: string, extra: Partial<BackgroundView> = {}): BackgroundView {
  return {
    id,
    name,
    original: { hash: "0123456789abcdef", mime: "image/jpeg", bytes: 2_500_000 },
    source: { hash: "0123456789abcdef", ext: "jpg" },
    converted: { hash: "fedcba9876543210", width: 2400, height: 1600, bytes: 400 * 1024 },
    cleanup: true,
    pdfPage: null,
    pdfPages: null,
    url: `/stageplot-images/${id}.webp`,
    sourceUrl: `/stageplot-images/${id}.jpg`,
    ...extra,
  };
}

function plot(id: string, venueId: string, name: string, backgroundId: string | null = null): Plot {
  return { id, venueId, name, backgroundId, bgFade: 0.4, items: [], version: 0 };
}

function doc(): StagePlotsView {
  return {
    venues: [{ id: "v-1", name: "Room One", kind: "home", notes: "", plotIds: ["p-1", "p-2"], defaultPlotId: "p-1" }],
    backgrounds: [bg("b-1", "Plan one.jpg")],
    plots: [plot("p-1", "v-1", "Standard", "b-1"), plot("p-2", "v-1", "Special")],
    overrides: [],
    pendingRemovals: [],
  };
}

function heightOf(p: Plot): number {
  return plotHeight(DOC.backgrounds.find((b) => b.id === p.backgroundId) ?? null);
}

function broadcast() {
  FakeEventSource.last?.push("stageplots:updated", DOC);
}

/** The fake routes: just enough of each to answer the way the server does. */
function route(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; json: unknown } {
  const venue = (id: string) => DOC.venues.find((v) => v.id === id)!;
  let m: RegExpExecArray | null;
  if (method === "POST" && path === "/api/stageplots/venues") {
    const v = { id: `v-new${++ids}`, plotIds: [], defaultPlotId: null, notes: "", ...(body as object) } as unknown as StagePlotsView["venues"][number];
    DOC.venues.push(v);
    return { status: 201, json: v };
  }
  if (method === "PATCH" && (m = /^\/api\/stageplots\/venues\/([^/]+)$/.exec(path))) {
    Object.assign(venue(m[1]), body);
    return { status: 200, json: venue(m[1]) };
  }
  if (method === "POST" && path === "/api/stageplots/backgrounds/pdf") return { status: 201, json: { originalHash: "aaaaaaaaaaaaaaaa", bytes: 9000 } };
  if (method === "POST" && path === "/api/stageplots/backgrounds") {
    const b = bg(`b-new${++ids}`, query.get("name")!, query.get("original") ? { pdfPage: Number(query.get("page")), pdfPages: Number(query.get("pages")) } : {});
    DOC.backgrounds.push(b);
    return { status: 201, json: b };
  }
  if (method === "PATCH" && (m = /^\/api\/stageplots\/backgrounds\/([^/]+)$/.exec(path))) {
    const b = DOC.backgrounds.find((x) => x.id === m![1])!;
    const changes = body as { cleanup?: boolean };
    if (changes.cleanup !== undefined) Object.assign(b, { cleanup: changes.cleanup, converted: { ...b.converted, bytes: changes.cleanup ? 400 * 1024 : 640 * 1024 } });
    return { status: 200, json: b };
  }
  if (method === "POST" && (m = /^\/api\/stageplots\/plots\/([^/]+)\/duplicate$/.exec(path))) {
    const source = DOC.plots.find((p) => p.id === m![1])!;
    const copy = { ...source, id: `p-copy${++ids}`, name: `${source.name} copy` };
    DOC.plots.push(copy);
    const v = venue(source.venueId);
    v.plotIds.splice(v.plotIds.indexOf(source.id) + 1, 0, copy.id);
    return { status: 201, json: copy };
  }
  if (method === "POST" && (m = /^\/api\/stageplots\/venues\/([^/]+)\/default$/.exec(path))) {
    venue(m[1]).defaultPlotId = (body as { plotId: string }).plotId;
    return { status: 200, json: venue(m[1]) };
  }
  if (method === "PUT" && (m = /^\/api\/stageplots\/plots\/([^/]+)\/items$/.exec(path))) {
    // As the server does, in its order: the items are held to the real rules on
    // the plot's height, then the version decides; never a canned answer.
    const p = DOC.plots.find((x) => x.id === m![1])!;
    const b = body as { version: number; items: Plot["items"] };
    const problem = validateItems(b.items, heightOf(p));
    if (problem) return { status: 400, json: { error: problem } };
    if (b.version !== p.version) return { status: 409, json: { error: "changed elsewhere", version: p.version } };
    if (JSON.stringify(b.items) === JSON.stringify(p.items)) return { status: 200, json: { plot: p } };
    Object.assign(p, { items: b.items, version: p.version + 1 });
    return { status: 200, json: { plot: p } };
  }
  if (method === "PUT" && path === "/api/stageplots/overrides") {
    // The server's own reading of the body and its own rule, never a canned answer.
    const change = readOverrideChange(body);
    if ("problem" in change) return { status: 400, json: { error: change.problem } };
    const next = applyOverride({ ...DOC, backgrounds: [], pendingRemovals: [] }, change);
    if ("problem" in next) return { status: next.status, json: { error: next.problem } };
    DOC.overrides = next.doc.overrides;
    return { status: 200, json: DOC };
  }
  if (method === "DELETE" && (m = /^\/api\/stageplots\/plots\/([^/]+)$/.exec(path))) {
    const p = DOC.plots.find((x) => x.id === m![1])!;
    const v = venue(p.venueId);
    if (v.defaultPlotId === p.id) return { status: 409, json: { error: "this is the venue's default plot" } };
    // As the route does: the plot, its place in its venue, and the overrides naming it.
    const clearedPlans = overridesOfPlot(DOC, p.id).map((o) => o.planId);
    DOC.plots = DOC.plots.filter((x) => x.id !== p.id);
    v.plotIds = v.plotIds.filter((x) => x !== p.id);
    DOC.overrides = DOC.overrides.filter((o) => o.plotId !== p.id);
    return { status: 200, json: { ok: true, clearedPlans } };
  }
  if (method === "PATCH" && (m = /^\/api\/stageplots\/plots\/([^/]+)$/.exec(path))) {
    const p = DOC.plots.find((x) => x.id === m![1])!;
    Object.assign(p, body, { version: p.version + 1 });
    // The real move of items below a shorter background's edge, as the route makes it.
    p.items = itemsWithin(p.items, heightOf(p)).items;
    return { status: 200, json: p };
  }
  return { status: 404, json: { error: `the fake has no ${method} ${path}` } };
}

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost");
  const method = init?.method ?? "GET";
  let status = 200;
  let json: unknown = DOC;
  if (u.pathname === "/api/stageplots/patch") {
    if (PATCH_HOLD) await PATCH_HOLD;
    const [st, body] = PATCH_DOWN ? [503, { error: "patch.json could not be read (EIO)" }] : [200, PATCH];
    return { ok: st < 300, status: st, statusText: String(st), json: async () => body, text: async () => JSON.stringify(body) };
  }
  if (!u.pathname.startsWith("/api/stageplots")) {
    const other = u.pathname === "/api/state" ? STATE : u.pathname === "/api/plans/upcoming" ? UPCOMING : {};
    return { ok: true, status: 200, statusText: "OK", json: async () => other, text: async () => JSON.stringify(other) };
  }
  if (method !== "GET") {
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    sent.push({ what: `${method} ${u.pathname}${u.search}`, body });
    if (refuse && `${method} ${u.pathname}`.startsWith(refuse.what)) {
      ({ status, json } = { status: 400, json: { error: refuse.error } });
      refuse = null;
    } else {
      ({ status, json } = route(method, u.pathname, u.searchParams, body));
      if (status < 300) broadcast();
    }
  }
  return { ok: status < 300, status, statusText: String(status), json: async () => json, text: async () => JSON.stringify(json) };
};

const { render, cleanup, screen, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { StagePlotsEdit } = await import("./stageplots-edit.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { itemRenderProbe } = await import("../../main/stageplots/plot-items.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { StagePlotsPage, LAST_VENUE_KEY } = await import("../../main/stageplots-view.js");
const { DEFAULT_STAGE_STATE } = await import("../../main/test-render-ctx.js");

/** A PDF as the page picker sees it: three pages, each rendered to a labelled blob. */
const rendered: string[] = [];
const fakePdf = async () => {
  // Rendering from a destroyed document fails, as pdf.js does.
  let destroyed = false;
  return {
    pages: 3,
    renderPage: async (page: number, longEdge: number) => {
      if (destroyed) throw new Error("the document was destroyed");
      rendered.push(`${page}@${longEdge}`);
      return new Blob([`page ${page} at ${longEdge}`], { type: "image/png" });
    },
    destroy: () => {
      destroyed = true;
    },
  };
};

/** The edit page, and with `viewer` an open /stageplots beside it, as two browsers would have. */
async function mount({ viewer = false }: { viewer?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(StagePlotsEdit, { openPdf: fakePdf }),
        React.createElement(ConfirmHost),
        viewer ? React.createElement("div", { "data-testid": "viewer" }, React.createElement(StagePlotsPage)) : null,
      ),
    );
  });
  for (let i = 0; i < 4; i++) await settle();
}

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
  await settle();
}

const card = (name: string) => screen.getByRole("region", { name });

/** Open the plot's Radix menu from its trigger, the way a keyboard does. */
async function openMenu() {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: "Plot actions" }), { key: "Enter" });
  });
  await settle();
}
const tabs = () => screen.getAllByRole("tab");
const writes = () => sent.map((s) => s.what);

beforeEach(() => {
  DOC = doc();
  PATCH = patchFile();
  PATCH_DOWN = false;
  PATCH_HOLD = null;
  STATE = {};
  UPCOMING = { plans: [], cacheAgeMs: 0 };
  localStorage.clear();
  sent = [];
  refuse = null;
  rendered.length = 0;
  (globalThis as unknown as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }).URL.createObjectURL = () => "blob:thumb";
  (globalThis as unknown as { URL: { revokeObjectURL: unknown } }).URL.revokeObjectURL = () => {};
});
afterEach(async () => {
  cleanup();
  await settle();
  resetReplayCache();
  resetStageState();
});
after(() => unmountAndTeardown(cleanup, teardown));

describe("/stageplots/edit", () => {
  test("the Publish card sits last in the left column, for the selected venue", async () => {
    await mount();
    const publish = card("Publish");
    assert.equal(publish.parentElement?.lastElementChild, publish, "the Publish card is not at the foot of the left column");
    assert.ok(publish.parentElement?.contains(card("Venues")), "the Publish card is not in the left column");
    assert.ok(within(publish).getByRole("button", { name: "Publish Room One" }));
  });

  test("adding a venue shows it selected", async () => {
    await mount();
    await click(within(card("Venues")).getByRole("button", { name: "Venue" }));
    assert.deepEqual(writes(), ["POST /api/stageplots/venues"]);
    const current = within(card("Venues")).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true");
    assert.equal(current?.textContent, "New venue0 plots");
    assert.equal((screen.getByLabelText("Venue name") as HTMLInputElement).value, "New venue");
  });

  test("upload a JPEG posts raw bytes and lists the background", async () => {
    await mount();
    const file = new File(["jpeg bytes"], "Stage photo.jpg", { type: "image/jpeg" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("background-file"), { target: { files: [file] } });
    });
    await settle();
    await settle();
    assert.deepEqual(writes(), ["POST /api/stageplots/backgrounds?name=Stage+photo.jpg"]);
    assert.equal(sent[0].body, file, "the body is the file itself, not JSON");
    const rows = within(card("Backgrounds")).getAllByRole("button").filter((b) => b.hasAttribute("aria-current"));
    assert.deepEqual(rows.map((r) => r.querySelector("b")?.textContent), ["Plan one.jpg", "Stage photo.jpg"]);
    assert.equal(rows[1].getAttribute("aria-current"), "true", "the new background is selected");
  });

  test("a file over the cap is refused here, before any upload", async () => {
    await mount();
    const big = new File([new Uint8Array(13 * 1024 * 1024)], "Huge.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("background-file"), { target: { files: [big] } });
    });
    await settle();
    assert.deepEqual(writes(), []);
    assert.match(within(card("Backgrounds")).getByRole("alert").textContent!, /Huge\.png is 13\.0 MB; an image can be at most 12 MB/);
  });

  test("a PDF upload asks for the page and posts original then raster", async () => {
    await mount();
    const pdf = new File(["%PDF-1.7 fake"], "Plan set.pdf", { type: "application/pdf" });
    await act(async () => {
      fireEvent.change(screen.getByTestId("background-file"), { target: { files: [pdf] } });
    });
    await settle();
    await settle();
    assert.ok(screen.getByText("Choose a page"));
    assert.deepEqual(writes(), [], "nothing goes up before a page is chosen");
    await click(screen.getByRole("button", { name: "Page 2" }));
    await click(screen.getByRole("button", { name: "Use page 2" }));
    assert.deepEqual(writes(), [
      "POST /api/stageplots/backgrounds/pdf?name=Plan+set.pdf",
      "POST /api/stageplots/backgrounds?name=Plan+set.pdf&original=aaaaaaaaaaaaaaaa&page=2&pages=3",
    ]);
    assert.equal(sent[0].body, pdf, "the original goes up as the file itself");
    assert.equal(await (sent[1].body as Blob).text(), "page 2 at 2400", "the raster is page 2 at 2400 px");
    assert.ok(rendered.includes("2@2400"));
    const row = within(card("Backgrounds")).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true");
    assert.equal(row?.querySelector("small")?.textContent, "Page 2 of 3 · 400 KB");
  });

  test("clean-up toggle re-converts and updates the size", async () => {
    await mount();
    assert.equal(screen.getByTestId("web-image").textContent, "400 KB · 2400 × 1600");
    await click(screen.getByRole("switch", { name: "Clean-up" }));
    assert.deepEqual(writes(), ["PATCH /api/stageplots/backgrounds/b-1"]);
    assert.deepEqual(sent[0].body, { cleanup: false });
    assert.equal(screen.getByTestId("web-image").textContent, "640 KB · 2400 × 1600");
    assert.equal(screen.getByRole("switch", { name: "Clean-up" }).getAttribute("aria-checked"), "false");
  });

  test("deleting a used background shows the plot names", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Delete background…" }));
    assert.deepEqual(writes(), []);
    assert.match(within(card("Backgrounds")).getByRole("alert").textContent!, /used by Room One · Standard/);
  });

  test("duplicate opens the copy", async () => {
    await mount();
    await openMenu();
    await click(screen.getByRole("menuitem", { name: "Duplicate" }));
    assert.deepEqual(writes(), ["POST /api/stageplots/plots/p-1/duplicate"]);
    assert.deepEqual(tabs().map((t) => t.textContent), ["Standard", "Standard copy", "Special"]);
    assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
  });

  test("set as default moves the star", async () => {
    await mount();
    const starOn = () => tabs().findIndex((t) => t.querySelector('[aria-label="Default plot"]'));
    assert.equal(starOn(), 0);
    await click(tabs()[1]);
    await openMenu();
    await click(screen.getByRole("menuitem", { name: "Set as default" }));
    assert.deepEqual(writes(), ["POST /api/stageplots/venues/v-1/default"]);
    assert.equal(starOn(), 1);
  });

  test("deleting the default plot is not offered", async () => {
    await mount();
    await openMenu();
    const del = screen.getByRole("menuitem", { name: /Delete/ });
    assert.equal(del.getAttribute("aria-disabled"), "true");
    assert.match(del.textContent!, /Make another the default first/);
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    await settle();
    await click(tabs()[1]);
    await openMenu();
    assert.equal(screen.getByRole("menuitem", { name: /Delete/ }).getAttribute("aria-disabled"), null);
  });

  test("a failed save shows the error beside the control and keeps the saved value", async () => {
    await mount();
    refuse = { what: "PATCH /api/stageplots/venues/v-1", error: "the venue's name is longer than 60 characters" };
    const name = screen.getByLabelText("Venue name") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(name, { target: { value: "A name the server refuses" } });
      fireEvent.blur(name);
    });
    await settle();
    await settle();
    assert.equal(within(card("Venues")).getByRole("alert").textContent, "the venue's name is longer than 60 characters");
    assert.equal((screen.getByLabelText("Venue name") as HTMLInputElement).value, "Room One", "the field went back to what is saved");
  });

  test("rename from the menu edits the tab in place and saves on Enter", async () => {
    await mount();
    await openMenu();
    await click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Plot name") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(field, { target: { value: "Renamed" } });
      fireEvent.keyDown(field, { key: "Enter" });
      field.blur();
    });
    await settle();
    await settle();
    assert.deepEqual(writes(), ["PATCH /api/stageplots/plots/p-1"]);
    assert.deepEqual(sent[0].body, { name: "Renamed" });
    assert.equal(tabs()[0].textContent, "Renamed");
  });

  test("the fade is sent once when the slider is let go and then left", async () => {
    await mount();
    const slider = screen.getByLabelText("Fade");
    await act(async () => {
      fireEvent.change(slider, { target: { value: "70" } });
      fireEvent.pointerUp(slider);
    });
    await act(async () => {
      fireEvent.keyUp(slider);
      fireEvent.blur(slider);
    });
    await settle();
    assert.deepEqual(writes(), ["PATCH /api/stageplots/plots/p-1"]);
    assert.deepEqual(sent[0].body, { bgFade: 0.7 });
  });

  test("choosing another background saves the plot", async () => {
    await mount();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Background"), { target: { value: "" } });
    });
    await settle();
    assert.deepEqual(writes(), ["PATCH /api/stageplots/plots/p-1"]);
    assert.deepEqual(sent[0].body, { backgroundId: null });
  });
});

// ── The plot editor ────────────────────────────────────────────────────────
//
// The palette's drop to icons below a 600 px canvas is measured
// (useElementSize), and jsdom measures everything as 0, so it is driven in a
// browser at 1440 and 1920 px, not tested here.
//
// The canvas is driven with pointer events against a stubbed box: jsdom lays
// nothing out, so the SVG is given a 1000 x 666.7 pixel box, one pixel per plot
// unit at the whole-plot view (the background is 2400 x 1600). Pointer capture,
// pinch and the measured label size are driven in a browser.

function item(over: Partial<Plot["items"][number]> & { id: string }): Plot["items"][number] {
  return { type: "box", x: 100, y: 100, w: 80, h: 60, rotation: 0, label: "", color: null, notes: "", inputs: [], ...over };
}

const canvas = () => screen.getByTestId("canvas") as unknown as SVGSVGElement;
function stubBox() {
  const svg = canvas();
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 2000 / 3, width: 1000, height: 2000 / 3, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}
const drawn = (id: string) => canvas().querySelector(`[data-id="${id}"]`)!;
const at = (id: string) => ({ x: Number(drawn(id).getAttribute("data-x")), y: Number(drawn(id).getAttribute("data-y")) });
const banner = () => screen.queryByText(/Unsaved changes to/);

async function pointer(kind: "pointerDown" | "pointerMove" | "pointerUp", target: Element, x: number, y: number) {
  await act(async () => {
    fireEvent[kind](target, { pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });
  });
}

/** Press on `id` at its top-left plus 5, drag by (dx, dy) in `steps` moves, let go. */
async function dragItem(id: string, dx: number, dy: number, steps = 4) {
  stubBox();
  const start = at(id);
  const [x0, y0] = [start.x + 5, start.y + 5];
  await pointer("pointerDown", drawn(id).querySelector("rect, ellipse, polyline, circle, g")!, x0, y0);
  for (let i = 1; i <= steps; i++) await pointer("pointerMove", canvas(), x0 + (dx * i) / steps, y0 + (dy * i) / steps);
  await pointer("pointerUp", canvas(), x0 + dx, y0 + dy);
  await settle();
}

async function addFromPalette(testId: string): Promise<string> {
  const before = new Set([...canvas().querySelectorAll("[data-id]")].map((g) => g.getAttribute("data-id")));
  await click(screen.getByTestId(`add-${testId}`));
  const added = [...canvas().querySelectorAll("[data-id]")].map((g) => g.getAttribute("data-id")!).find((id) => !before.has(id));
  assert.ok(added, `adding ${testId} drew nothing`);
  return added;
}

describe("the plot editor", () => {
  test("clicking Drum kit in the palette adds a selected drum kit", async () => {
    await mount();
    const id = await addFromPalette("drumkit");
    assert.equal(drawn(id).querySelector("[data-symbol]")?.getAttribute("data-symbol"), "drumkit");
    assert.ok(drawn(id).querySelector('[data-hd="size"]'), "the new item is not selected");
    assert.match(screen.getByTestId("inspector").textContent!, /Symbol · Drum kit/);
    assert.ok(banner(), "no unsaved banner");
    assert.deepEqual(writes(), [], "adding saved something");
  });

  test("dragging moves it and one undo puts it back, without panning the zoomed plot", async () => {
    await mount();
    const id = await addFromPalette("box");
    await click(screen.getByRole("button", { name: "Zoom in" }));
    const view = canvas().getAttribute("viewBox");
    const before = at(id);
    await dragItem(id, 80, 40);
    // Zoomed in 1.25x: 80 screen pixels are 64 plot units.
    assert.deepEqual(at(id), { x: before.x + 64, y: before.y + 32 });
    assert.equal(canvas().getAttribute("viewBox"), view, "dragging an item panned the plot");
    await click(screen.getByTestId("undo"));
    assert.deepEqual(at(id), before, "one undo did not put the drag back");
    await click(screen.getByTestId("undo"));
    assert.ok(canvas().querySelector(`[data-id="${id}"]`) === null, "the second undo is the add");
  });

  test("the banner waits for a drag that began on a clean draft to end, so the canvas does not move under it", async () => {
    DOC.plots[0].items = [item({ id: "b" })];
    await mount();
    stubBox();
    const start = at("b");
    await pointer("pointerDown", drawn("b").querySelector("rect")!, start.x + 5, start.y + 5);
    await pointer("pointerMove", canvas(), start.x + 25, start.y + 5);
    await pointer("pointerMove", canvas(), start.x + 45, start.y + 5);
    assert.ok(banner() === null, "the banner appeared mid-drag");
    await pointer("pointerUp", canvas(), start.x + 45, start.y + 5);
    await settle();
    assert.ok(banner() !== null, "no banner after the drag");
    assert.equal(at("b").x, start.x + 40);
  });

  test("typing RF filters suggestions to RF antenna and Enter sets the label", async () => {
    DOC.plots[1].items = [item({ id: "x1", type: "symbol", symbol: "amp", label: "RF antenna" })];
    await mount();
    const id = await addFromPalette("box");
    const field = screen.getByTestId("f-label") as HTMLInputElement;
    await act(async () => {
      fireEvent.focus(field);
    });
    const list = () => screen.getByTestId("suggestions");
    assert.match(list().textContent!, /In this venueRF antennaStarter gearDrum kit/, "focus shows the whole list");
    await act(async () => {
      fireEvent.change(field, { target: { value: "RF" } });
    });
    assert.deepEqual(within(list()).getAllByRole("option").map((o) => o.textContent), ["RF antenna"]);
    assert.equal(list().querySelector("mark")?.textContent, "RF");
    await act(async () => {
      fireEvent.keyDown(field, { key: "ArrowDown" });
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await settle();
    assert.equal((screen.getByTestId("f-label") as HTMLInputElement).value, "RF antenna");
    assert.ok([...drawn(id).querySelectorAll("text")].some((t) => t.textContent === "RF antenna"), "the canvas does not show the label");
  });

  test("arrow keys nudge only while the canvas has focus", async () => {
    await mount();
    const id = await addFromPalette("box");
    const before = at(id);
    assert.ok(document.activeElement === canvas(), "adding does not focus the canvas");
    await act(async () => {
      fireEvent.keyDown(canvas(), { key: "ArrowRight" });
      fireEvent.keyDown(canvas(), { key: "ArrowDown", shiftKey: true });
    });
    assert.deepEqual(at(id), { x: before.x + 4, y: before.y + 20 });
    const field = screen.getByTestId("f-label");
    await act(async () => {
      field.focus();
      fireEvent.keyDown(field, { key: "ArrowRight" });
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
    });
    assert.deepEqual(at(id), { x: before.x + 4, y: before.y + 20 }, "an arrow key moved the item from outside the canvas");
  });

  test("Save sends the version and clears the banner", async () => {
    await mount();
    await addFromPalette("conn");
    await click(screen.getByRole("button", { name: "Save" }));
    const put = sent.find((w) => w.what === "PUT /api/stageplots/plots/p-1/items")!;
    assert.ok(put, `no save: ${writes().join(", ")}`);
    assert.equal((put.body as { version: number }).version, 0);
    assert.equal((put.body as { items: unknown[] }).items.length, 1);
    assert.ok(banner() === null);
    assert.equal(DOC.plots[0].version, 1);
  });

  test("a 409 shows Reload and keeps the draft", async () => {
    await mount();
    const mine = await addFromPalette("drumkit");
    // Another browser saves this plot first; its broadcast arrives here.
    DOC.plots[0].items = [item({ id: "theirs", label: "Their riser" })];
    DOC.plots[0].version = 1;
    await act(async () => broadcast());
    await settle();
    assert.ok(drawn(mine), "a change elsewhere replaced the draft");
    await click(screen.getByRole("button", { name: "Save" }));
    assert.match(document.body.textContent!, /This plot changed elsewhere/);
    assert.ok(drawn(mine), "the draft was dropped");
    assert.equal(DOC.plots[0].items[0].id, "theirs", "the other save was overwritten");
    await click(screen.getByRole("button", { name: "Reload" }));
    assert.ok(drawn("theirs"));
    assert.ok(canvas().querySelector(`[data-id="${mine}"]`) === null);
    assert.doesNotMatch(document.body.textContent!, /changed elsewhere/);
    assert.ok(banner() === null);
  });

  test("Discard after a save from elsewhere shows that save, and the next Save is not a 409", async () => {
    await mount();
    await addFromPalette("box");
    DOC.plots[0].items = [item({ id: "theirs", label: "Their riser" })];
    DOC.plots[0].version = 1;
    await act(async () => broadcast());
    await settle();
    await click(screen.getByRole("button", { name: "Discard" }));
    assert.ok(canvas().querySelector('[data-id="theirs"]') !== null, "Discard went back to the plot as it was before the other save");
    await addFromPalette("circle");
    await click(screen.getByRole("button", { name: "Save" }));
    assert.doesNotMatch(document.body.textContent!, /changed elsewhere/);
    assert.equal(DOC.plots[0].version, 2);
  });

  test("a fade or background change while unsaved does not make my own Save a 409", async () => {
    await mount();
    await addFromPalette("box");
    const slider = screen.getByLabelText("Fade");
    await act(async () => {
      fireEvent.change(slider, { target: { value: "70" } });
      fireEvent.pointerUp(slider);
    });
    await settle();
    assert.equal(DOC.plots[0].version, 1, "the fade did not bump the version");
    await click(screen.getByRole("button", { name: "Save" }));
    assert.doesNotMatch(document.body.textContent!, /changed elsewhere/, "my own fade made my Save a 409");
    assert.equal((sent.at(-1)!.body as { version: number }).version, 1);
    assert.equal(DOC.plots[0].items.length, 1);
  });

  test("a change elsewhere to a clean draft is taken", async () => {
    await mount();
    DOC.plots[0].items = [item({ id: "theirs", label: "Their riser" })];
    DOC.plots[0].version = 1;
    await act(async () => broadcast());
    await settle();
    assert.ok(drawn("theirs"));
    assert.ok(banner() === null);
  });

  test("Discard puts back what is saved", async () => {
    DOC.plots[0].items = [item({ id: "b" })];
    await mount();
    await addFromPalette("circle");
    await click(screen.getByRole("button", { name: "Discard" }));
    assert.deepEqual([...canvas().querySelectorAll("[data-items] > [data-id]")].map((g) => g.getAttribute("data-id")), ["b"]);
    assert.ok(banner() === null);
  });

  test("switching plot with unsaved changes asks first", async () => {
    await mount();
    const mine = await addFromPalette("box");
    await click(tabs()[1]);
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent!, /Room One · Standard are not saved/);
    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true", "Cancel left the plot");
    assert.ok(drawn(mine), "Cancel dropped the draft");
    await click(tabs()[1]);
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
    assert.ok(banner() === null);
  });

  test("a 500-item plot re-renders only the dragged item per pointermove", async () => {
    DOC.plots[0].items = Array.from({ length: 500 }, (_, i) => item({ id: `i-${i}`, x: (i % 25) * 38, y: Math.floor(i / 25) * 30, w: 30, h: 20 }));
    await mount();
    stubBox();
    const target = "i-260";
    const start = at(target);
    await pointer("pointerDown", drawn(target).querySelector("rect")!, start.x + 5, start.y + 5);
    await settle();
    const renders = new Map<string, number>();
    itemRenderProbe.current = (id) => renders.set(id, (renders.get(id) ?? 0) + 1);
    try {
      for (let i = 1; i <= 10; i++) await pointer("pointerMove", canvas(), start.x + 5 + i * 3, start.y + 5);
      await pointer("pointerUp", canvas(), start.x + 35, start.y + 5);
      await settle();
    } finally {
      itemRenderProbe.current = null;
    }
    assert.deepEqual([...renders], [[target, 10]], "items other than the dragged one re-rendered, or it rendered more than once per move");
    assert.equal(at(target).x, start.x + 30);
  });

  test("Print prints the canvas as it stands, unsaved changes included", async () => {
    let printed = 0;
    (window as unknown as { print: () => void }).print = () => void printed++;
    await mount();
    const mine = await addFromPalette("conn");
    await click(screen.getByRole("button", { name: "Print" }));
    assert.equal(printed, 1);
    const page = screen.getByTestId("print-page");
    assert.ok(page.querySelector(`[data-id="${mine}"]`), "the unsaved item is not on the printed page");
    assert.match(page.querySelector("h1")!.textContent!, /^Room One · Standard$/);
  });

  // ── A background change over unsaved work (the fake moves items as the route does) ──
  const refusedOrConflict = () => /changed elsewhere|must be a number/.test(document.body.textContent!);
  async function chooseBackground(value: string, choice: "Save and switch" | "Discard and switch" | "Cancel") {
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Background"), { target: { value } });
    });
    await settle();
    const dialog = screen.queryByTestId("background-switch");
    if (dialog) await click(within(dialog).getByRole("button", { name: choice }));
    await settle();
  }

  test("Save and switch: a new item below the grid's edge saves, moves up, and the next Save lands (the 400 path)", async () => {
    await mount();
    const mine = await addFromPalette("box");
    await dragItem(mine, 0, 600 - at(mine).y); // y 600, below the grid's 562.5
    await chooseBackground("", "Save and switch");
    const switching = writes().slice();
    await addFromPalette("circle");
    await click(screen.getByRole("button", { name: "Save" }));
    assert.ok(!refusedOrConflict(), `the save after switching was refused: ${document.body.textContent!.match(/[^.]*(changed elsewhere|must be a number)[^.]*/)?.[0]}`);
    assert.deepEqual(switching.slice(-2), ["PUT /api/stageplots/plots/p-1/items", "PATCH /api/stageplots/plots/p-1"]);
    assert.ok(DOC.plots[0].items.every((it) => it.y <= 562.5));
  });

  test("Discard and switch: the saved item the server moves is taken, and editing it saves (the 409 path)", async () => {
    DOC.plots[0].items = [item({ id: "b", y: 600, h: 60 })];
    await mount();
    await addFromPalette("circle");
    await chooseBackground("", "Discard and switch");
    stubBox();
    const b = at("b");
    await pointer("pointerDown", drawn("b").querySelector("rect")!, b.x + 5, b.y + 5);
    await pointer("pointerUp", canvas(), b.x + 5, b.y + 5);
    await act(async () => {
      fireEvent.keyDown(canvas(), { key: "ArrowUp" });
    });
    await click(screen.getByRole("button", { name: "Save" }));
    assert.ok(!refusedOrConflict(), `the save after switching was refused: ${document.body.textContent!.match(/[^.]*(changed elsewhere|must be a number)[^.]*/)?.[0]}`);
    assert.equal(DOC.plots[0].items[0].y, 562.5 - 60 - 4);
  });

  test("Cancel keeps the background and the draft", async () => {
    await mount();
    const mine = await addFromPalette("box");
    await chooseBackground("", "Cancel");
    assert.ok(!writes().some((w) => w.startsWith("PATCH")), writes().join(", "));
    assert.equal((screen.getByLabelText("Background") as HTMLSelectElement).value, "b-1");
    assert.ok(drawn(mine));
  });

  test("a 409 that only a rename caused is sent again on the new version, not shown as changed elsewhere", async () => {
    await mount();
    await addFromPalette("box");
    // A rename elsewhere lands; its broadcast has not arrived yet.
    Object.assign(DOC.plots[0], { name: "Renamed", version: 1 });
    await click(screen.getByRole("button", { name: "Save" }));
    assert.doesNotMatch(document.body.textContent!, /changed elsewhere/);
    assert.equal(DOC.plots[0].version, 2);
    assert.equal(DOC.plots[0].items.length, 1);
  });

  test("after a 409, undoing back to nothing unsaved clears the banner", async () => {
    await mount();
    await addFromPalette("box");
    DOC.plots[0].items = [item({ id: "theirs", label: "Their riser" })];
    DOC.plots[0].version = 1;
    await act(async () => broadcast());
    await settle();
    await click(screen.getByRole("button", { name: "Save" }));
    assert.match(document.body.textContent!, /changed elsewhere/);
    await click(screen.getByTestId("undo"));
    assert.doesNotMatch(document.body.textContent!, /changed elsewhere/, "the banner stayed with nothing unsaved");
    assert.ok(drawn("theirs"));
  });

  test("Delete asks about the plot first, so its Cancel never costs the draft", async () => {
    await mount();
    await click(tabs()[1]);
    const mine = await addFromPalette("box");
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    const first = screen.getByRole("alertdialog");
    assert.match(first.textContent!, /Delete Special\?/);
    await click(within(first).getByRole("button", { name: "Cancel" }));
    assert.ok(drawn(mine), "cancelling the delete dropped the draft");
  });

  test("an item at the top edge turns by its handle underneath, the right way round", async () => {
    DOC.plots[0].items = [item({ id: "t", y: 0, h: 40, w: 80 })];
    await mount();
    stubBox();
    const t = at("t");
    await pointer("pointerDown", drawn("t").querySelector("rect")!, t.x + 5, t.y + 5);
    await pointer("pointerUp", canvas(), t.x + 5, t.y + 5);
    const rot = drawn("t").querySelector('[data-hd="rot"]')!;
    assert.ok(rot.hasAttribute("data-below"), "the rotate handle is not under the item");
    // The handle sits straight under the centre (140, 20); drag it a little right of there.
    const [cx, cy] = [140, 20 + 20 + 6 + 26];
    await pointer("pointerDown", rot, cx, cy);
    await pointer("pointerMove", canvas(), cx + 10, cy);
    await pointer("pointerMove", canvas(), cx + 20, cy);
    await pointer("pointerUp", canvas(), cx + 20, cy);
    await settle();
    const r = Number(drawn("t").getAttribute("data-rot"));
    assert.ok(Math.abs(r) <= 45, `a small drag of the handle underneath turned the item ${r}°`);
  });

  // Another editor changes the background (the fake moves items as the route does) while this draft is unsaved.
  async function backgroundChangedElsewhere() {
    const p = DOC.plots[0];
    Object.assign(p, { backgroundId: null, version: p.version + 1 });
    p.items = itemsWithin(p.items, heightOf(p)).items;
    await act(async () => broadcast());
    await settle();
  }

  test("a shorter background from elsewhere under unsaved work: the draft is fitted, and Save lands when nothing saved moved", async () => {
    await mount();
    const mine = await addFromPalette("box");
    await dragItem(mine, 0, 600 - at(mine).y);
    await backgroundChangedElsewhere();
    await click(screen.getByRole("button", { name: "Save" }));
    assert.doesNotMatch(document.body.textContent!, /must be a number|changed elsewhere/);
    assert.ok(DOC.plots[0].items[0].y <= 562.5, `saved at y ${DOC.plots[0].items[0].y}`);
  });

  test("a shorter background from elsewhere that moved saved items: Save shows changed elsewhere, not a refusal naming a y", async () => {
    DOC.plots[0].items = [item({ id: "low", y: 600, h: 50 })];
    await mount();
    await addFromPalette("circle");
    await backgroundChangedElsewhere();
    await click(screen.getByRole("button", { name: "Save" }));
    assert.doesNotMatch(document.body.textContent!, /must be a number/, "the save was refused for an item's y");
    assert.match(document.body.textContent!, /This plot changed elsewhere/);
  });
});

describe("the This week card", () => {
  // Dates far ahead, so "upcoming" holds whatever day the suite runs on;
  // 15, 22 and 29 Nov 2099 are Sundays.
  const LIVE = "2099-11-15T15:00:00Z";
  const upcoming = (planId: string, sortDate: string) => ({ serviceTypeId: "st-1", serviceTypeName: "Service One", planId, title: "Week", sortDate, dates: null, isCurrent: false });

  function connected() {
    STATE = { ...DEFAULT_STAGE_STATE, pcoConfigured: true, serviceTypeId: "st-1", planId: "plan-15", planDates: "November 15, 2099", timezone: "America/Chicago" };
    UPCOMING = { plans: [upcoming("plan-15", LIVE), upcoming("plan-22", "2099-11-22T15:00:00Z"), upcoming("plan-29", "2099-11-29T15:00:00Z")], cacheAgeMs: 0 };
    DOC.venues[0].plotIds.push("p-3");
    DOC.plots.push(plot("p-3", "v-1", "Baptism"));
    // Another venue's plots must never be offered here.
    DOC.venues.push({ id: "v-2", name: "Room Two", kind: "home", notes: "", plotIds: ["p-9"], defaultPlotId: "p-9" });
    DOC.plots.push(plot("p-9", "v-2", "Elsewhere"));
  }
  const thisWeek = () => card("This week");
  const planSelect = () => within(thisWeek()).getByLabelText("Plot for this plan") as HTMLSelectElement;
  const options = (el: HTMLSelectElement) => [...el.options].map((o) => o.textContent);
  const rows = () =>
    within(thisWeek())
      .queryAllByRole("listitem")
      .map((li) => li.textContent);
  async function choose(el: HTMLSelectElement, value: string) {
    await act(async () => {
      fireEvent.change(el, { target: { value } });
    });
    for (let i = 0; i < 3; i++) await settle();
  }

  test("choosing Baptism for the live plan saves the override and the viewer badge changes", async () => {
    connected();
    localStorage.setItem(LAST_VENUE_KEY, "v-1");
    await mount({ viewer: true });
    const viewer = screen.getByTestId("viewer");
    assert.equal(within(viewer).getByTestId("plan-badge").textContent, "Default");
    assert.match(within(thisWeek()).getByText(/^Plan/).textContent!, /Plan · Sun 15 Nov/);
    assert.equal(planSelect().value, "");
    await choose(planSelect(), "p-3");
    assert.deepEqual(sent.at(-1), { what: "PUT /api/stageplots/overrides", body: { planId: "plan-15", venueId: "v-1", plotId: "p-3", planDate: LIVE } });
    assert.deepEqual(DOC.overrides, [{ planId: "plan-15", venueId: "v-1", plotId: "p-3", planDate: "2099-11-15T15:00:00.000Z" }]);
    assert.equal(planSelect().value, "p-3");
    assert.equal(within(viewer).getByTestId("plan-badge").textContent, "For this plan · Sun 15 Nov");
    assert.equal(within(viewer).getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent, "Baptism");
    // And back.
    await choose(planSelect(), "");
    assert.deepEqual((sent.at(-1)?.body as { plotId: unknown }).plotId, null);
    assert.deepEqual(DOC.overrides, []);
    assert.equal(within(viewer).getByTestId("plan-badge").textContent, "Default");
  });

  test("the select lists only this venue's plots, the default as Default", async () => {
    connected();
    await mount();
    assert.deepEqual(options(planSelect()), ["Default (Standard)", "Special", "Baptism"]);
  });

  test("× removes an override", async () => {
    connected();
    DOC.overrides = [{ planId: "plan-22", venueId: "v-1", plotId: "p-2", planDate: "2099-11-22T15:00:00.000Z" }];
    await mount();
    assert.deepEqual(rows(), ["Sun 22 NovSpecial"]);
    await click(within(thisWeek()).getByRole("button", { name: "Use the default for Sun 22 Nov" }));
    assert.deepEqual(sent.at(-1), { what: "PUT /api/stageplots/overrides", body: { planId: "plan-22", venueId: "v-1", plotId: null, planDate: null } });
    assert.deepEqual(DOC.overrides, []);
    assert.deepEqual(rows(), []);
    assert.ok(within(thisWeek()).getByText("None."));
  });

  test("the list holds this venue's upcoming overrides, the live plan aside (it is the select): no past plan, none of another venue's, an undated one named from the plan list", async () => {
    connected();
    DOC.overrides = [
      { planId: "plan-15", venueId: "v-1", plotId: "p-3", planDate: LIVE },
      { planId: "plan-old", venueId: "v-1", plotId: "p-2", planDate: "2000-01-02T15:00:00.000Z" },
      { planId: "plan-22", venueId: "v-2", plotId: "p-9", planDate: "2099-11-22T15:00:00.000Z" },
      { planId: "plan-29", venueId: "v-1", plotId: "p-3", planDate: null },
      { planId: "plan-22", venueId: "v-1", plotId: "p-2", planDate: "2099-11-22T15:00:00.000Z" },
    ];
    await mount();
    // plan-29 has no stored date: the upcoming list names it.
    assert.deepEqual(rows(), ["Sun 22 NovSpecial", "Sun 29 NovBaptism"]);
    assert.equal(planSelect().value, "p-3");
  });

  test("another upcoming plan can be given its own plot", async () => {
    connected();
    await mount();
    const another = within(thisWeek()).getByLabelText("Give another plan its own plot") as HTMLSelectElement;
    // The live plan is the select above, not a choice here.
    assert.deepEqual(options(another).slice(1), ["Sun 22 Nov · Service One", "Sun 29 Nov · Service One"]);
    await choose(another, "plan-29");
    const plotFor = within(thisWeek()).getByLabelText("Plot for the plan being added") as HTMLSelectElement;
    assert.deepEqual(options(plotFor).slice(1), ["Special", "Baptism"]);
    await choose(plotFor, "p-2");
    assert.deepEqual(sent.at(-1), { what: "PUT /api/stageplots/overrides", body: { planId: "plan-29", venueId: "v-1", plotId: "p-2", planDate: "2099-11-29T15:00:00Z" } });
    assert.deepEqual(rows(), ["Sun 29 NovSpecial"]);
  });

  test("Another plan offers upcoming plans only, never one from the last few days", async () => {
    connected();
    UPCOMING = { ...UPCOMING, plans: [upcoming("plan-old", "2000-01-02T15:00:00Z"), ...UPCOMING.plans] };
    await mount();
    const another = within(thisWeek()).getByLabelText("Give another plan its own plot") as HTMLSelectElement;
    assert.deepEqual(options(another).slice(1), ["Sun 22 Nov · Service One", "Sun 29 Nov · Service One"]);
  });

  test("two plans on one day are told apart by their time, in the card and in the delete confirm", async () => {
    connected();
    UPCOMING = {
      ...UPCOMING,
      plans: [upcoming("plan-15", LIVE), upcoming("plan-22a", "2099-11-22T15:00:00Z"), upcoming("plan-22b", "2099-11-22T17:00:00Z")],
    };
    DOC.overrides = [{ planId: "plan-22a", venueId: "v-1", plotId: "p-2", planDate: "2099-11-22T15:00:00.000Z" }];
    await mount();
    // 15:00 and 17:00 UTC are 9:00 and 11:00 in Chicago.
    assert.deepEqual(rows(), ["Sun 22 Nov 9:00Special"]);
    const another = within(thisWeek()).getByLabelText("Give another plan its own plot") as HTMLSelectElement;
    assert.deepEqual(options(another).slice(1), ["Sun 22 Nov 11:00 · Service One"]);
    await click(tabs()[1]);
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    assert.match(screen.getByRole("alertdialog").textContent!, /go back to the default plot: Sun 22 Nov 9:00\./);
  });

  test("with the plan list unavailable the card says why other plans are not offered", async () => {
    connected();
    UPCOMING = { ...UPCOMING, unavailable: "Planning Center returned 503" };
    await mount();
    assert.ok(within(thisWeek()).getByText("Planning Center is unreachable; other plans can't be listed."));
    assert.equal(within(thisWeek()).queryByLabelText("Give another plan its own plot"), null);
  });

  test("deleting a plot clears its overrides, and the confirm names the plans", async () => {
    connected();
    DOC.overrides = [
      { planId: "plan-15", venueId: "v-1", plotId: "p-2", planDate: LIVE },
      { planId: "plan-22", venueId: "v-1", plotId: "p-2", planDate: "2099-11-22T15:00:00.000Z" },
      { planId: "plan-29", venueId: "v-1", plotId: "p-3", planDate: null },
    ];
    await mount();
    await click(tabs()[1]);
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent!, /The 2 plans using it go back to the default plot: Sun 15 Nov, Sun 22 Nov\./);
    await click(within(dialog).getByRole("button", { name: "Delete plot" }));
    assert.ok(writes().includes("DELETE /api/stageplots/plots/p-2"));
    assert.deepEqual(
      DOC.overrides.map((o) => o.planId),
      ["plan-29"],
    );
  });

  test("a plot no plan uses deletes with the plain confirm", async () => {
    connected();
    await mount();
    await click(tabs()[1]);
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    assert.doesNotMatch(screen.getByRole("alertdialog").textContent!, /plan/);
  });

  test("with Planning Center not connected it says so, and offers no plan", async () => {
    await mount();
    assert.ok(within(thisWeek()).getByText("Connect Planning Center to give a plan its own plot."));
    assert.equal(within(thisWeek()).queryByLabelText("Plot for this plan"), null);
  });

  test("with no plan live or next it says so", async () => {
    connected();
    STATE = { ...(STATE as object), planId: null, planDates: null };
    await mount();
    assert.ok(within(thisWeek()).getByText("No plan is live or coming up."));
  });
});


describe("linking a connection point to the patch", () => {
  const inspector = () => screen.getByTestId("inspector");
  const label = () => screen.getByTestId("f-label") as HTMLInputElement;
  const devices = () => within(within(inspector()).getByRole("listbox", { name: "Devices" }));
  const savedItem = (id: string) => {
    const put = [...sent].reverse().find((w) => w.what === "PUT /api/stageplots/plots/p-1/items");
    assert.ok(put, `no save: ${writes().join(", ")}`);
    return (put.body as { items: Plot["items"] }).items.find((it) => it.id === id)!;
  };
  async function linkedOnServer() {
    DOC.plots[0].items = [item({ id: "c1", type: "conn", w: 25, h: 25, label: "SB-1", color: "#0091ff", patchLink: { sheetId: "main", deviceId: "sb1", lastName: "SB-1", lastColor: "#0091ff" } })];
    await mount();
    await act(async () => {
      fireEvent.pointerDown(drawn("c1"), { pointerId: 1, clientX: 0, clientY: 0, button: 0, isPrimary: true });
      fireEvent.pointerUp(drawn("c1"), { pointerId: 1, clientX: 0, clientY: 0, button: 0, isPrimary: true });
    });
    await settle();
  }

  test("pick a sheet, then a device, and Link: the point takes its name and colour, locked, and Save stores them as its last", async () => {
    await mount();
    const id = await addFromPalette("conn");
    await click(within(inspector()).getByRole("button", { name: "Link to patch device" }));
    const sheet = within(inspector()).getByLabelText("Patch sheet") as HTMLSelectElement;
    assert.equal(sheet.value, "main", "the first sheet with devices is offered first");
    assert.deepEqual(
      devices().getAllByRole("option").map((o) => o.textContent),
      ["Rack AInput Rack32 in · 16 out", "SB-1Snake16 in · 4 out", "FP-3Floor pocket4 in"],
    );
    assert.ok((within(inspector()).getByRole("button", { name: "Link" }) as HTMLButtonElement).disabled, "Link before a device is picked");
    await click(devices().getByRole("option", { name: /SB-1/ }));
    await click(within(inspector()).getByRole("button", { name: "Link" }));

    assert.match(screen.getByTestId("link-on").textContent!, /SB-1Snake · Main patch · 16 in · 4 out/);
    assert.equal(label().value, "SB-1");
    assert.ok(label().disabled, "the label is editable on a linked point");
    assert.match(inspector().textContent!, /Name and color follow the patch device\./);
    assert.ok(within(inspector()).getAllByRole("button", { name: /Blue|No color/ }).every((b) => (b as HTMLButtonElement).disabled));
    assert.match(drawn(id).textContent!, /SB-1/);

    await click(screen.getByRole("button", { name: "Save" }));
    const saved = savedItem(id);
    assert.deepEqual(saved.patchLink, { sheetId: "main", deviceId: "sb1", lastName: "SB-1", lastColor: "#0091ff" });
    assert.deepEqual([saved.label, saved.color], ["SB-1", "#0091ff"]);
    assert.ok(banner() === null);
  });

  test("a picker opened before the patch answers offers the first sheet with devices once it does", async () => {
    let answer!: () => void;
    PATCH_HOLD = new Promise((resolve) => (answer = resolve));
    await mount();
    await addFromPalette("conn");
    await click(within(inspector()).getByRole("button", { name: "Link to patch device" }));
    assert.match(screen.getByTestId("link-pick").textContent!, /Reading the patch sheet…/);
    await act(async () => answer());
    for (let i = 0; i < 3; i++) await settle();
    assert.equal((within(inspector()).getByLabelText("Patch sheet") as HTMLSelectElement).value, "main");
    assert.deepEqual(
      devices().getAllByRole("option").map((o) => o.textContent),
      ["Rack AInput Rack32 in · 16 out", "SB-1Snake16 in · 4 out", "FP-3Floor pocket4 in"],
    );
  });

  test("Cancel closes the picker and links nothing", async () => {
    await mount();
    await addFromPalette("conn");
    await click(within(inspector()).getByRole("button", { name: "Link to patch device" }));
    await click(devices().getByRole("option", { name: /FP-3/ }));
    await click(within(inspector()).getByRole("button", { name: "Cancel" }));
    assert.equal(screen.queryByTestId("link-pick"), null);
    assert.equal(label().disabled, false);
    assert.ok(within(inspector()).getByRole("button", { name: "Link to patch device" }));
  });

  test("a device renamed and recoloured in the patch: the point follows on the next render, unsaved, and the next Save stores it", async () => {
    await linkedOnServer();
    PATCH.sheets[1]!.devices[1] = { ...PATCH.sheets[1]!.devices[1]!, name: "SB-1 Left", color: "#46a758" };
    await act(async () => patchSaved());
    await settle();
    assert.equal(label().value, "SB-1 Left");
    assert.match(drawn("c1").textContent!, /SB-1 Left/);
    assert.ok(banner() === null, "following the patch is not an unsaved change");
    await click(within(inspector()).getByRole("button", { name: "Add input" }));
    await click(screen.getByRole("button", { name: "Save" }));
    const saved = savedItem("c1");
    assert.deepEqual([saved.label, saved.color, saved.patchLink?.lastName, saved.patchLink?.lastColor], ["SB-1 Left", "#46a758", "SB-1 Left", "#46a758"]);
  });

  test("a device deleted: the point reads device removed, keeps its last name, and still saves", async () => {
    await linkedOnServer();
    PATCH.sheets[1]!.devices.splice(1, 1);
    await act(async () => patchSaved());
    await settle();
    assert.match(screen.getByTestId("link-lost").textContent!, /SB-1unlinked · device removed/);
    assert.equal(label().value, "SB-1");
    await click(within(inspector()).getByRole("button", { name: "Add input" }));
    await click(screen.getByRole("button", { name: "Save" }));
    assert.equal(savedItem("c1").patchLink?.deviceId, "sb1", "the dangling link was dropped");
    assert.doesNotMatch(document.body.textContent!, /must|refused/);
    assert.ok(banner() === null);
  });

  test("the patch sheet unreadable: unlinked, patch sheet unavailable, with the last name and colour", async () => {
    PATCH_DOWN = true;
    await linkedOnServer();
    assert.match(screen.getByTestId("link-lost").textContent!, /SB-1unlinked · patch sheet unavailable/);
    assert.match(inspector().textContent!, /It follows the device again once the patch sheet can be read\./);
    assert.match(inspector().textContent!, /A tap lists the point's own inputs, without patch channels, until the sheet is back\./);
    // Back: a save of the patch answers it.
    PATCH_DOWN = false;
    await act(async () => patchSaved());
    await settle();
    assert.ok(screen.getByTestId("link-on"));
  });

  test("Unlink makes the name and colour the point's own again", async () => {
    await linkedOnServer();
    await click(within(inspector()).getByRole("button", { name: "Unlink" }));
    assert.equal(label().disabled, false);
    assert.equal(label().value, "SB-1");
    assert.ok(within(inspector()).getByRole("button", { name: "Link to patch device" }));
    await click(screen.getByRole("button", { name: "Save" }));
    const saved = savedItem("c1");
    assert.equal(saved.patchLink, undefined);
    assert.deepEqual([saved.label, saved.color], ["SB-1", "#0091ff"]);
  });

  test("only a connection point offers a patch device", async () => {
    await mount();
    await addFromPalette("box");
    assert.equal(within(inspector()).queryByRole("button", { name: "Link to patch device" }), null);
  });
});
