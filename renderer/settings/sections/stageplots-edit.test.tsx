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

import type { BackgroundView, Plot, PlotDraft, StagePlotsView } from "@main/types/stageplots";

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
/** The kept drafts GET /api/stageplots/drafts answers, kept and deleted as the server does. */
let DRAFTS: PlotDraft[] = [];
/** While set, every draft request fails as a server that does not answer. */
let DRAFTS_DOWN = false;
/** While set, a draft PUT waits for it before it lands: one still on its way. */
let DRAFT_HOLD: Promise<void> | null = null;
/** While set, a save of a plot's items lands on the server and waits for it before it answers. */
let ITEMS_HOLD: Promise<void> | null = null;
/** While set, a save, rename or delete of a plot answers this as its `draftNotice`: the drafts file did not take it. */
let DRAFT_NOTICE: string | null = null;
/** Draft PUTs sent, landed or not. */
let draftPutsOut = 0;
/** GET /api/stageplots/drafts asked, from any page. */
let draftReads = 0;
/** The drafts note the server broadcasts on stageplots:drafts after any change to them. */
function announceDrafts() {
  FakeEventSource.last?.push("stageplots:drafts", { drafts: DRAFTS.map((d) => ({ plotId: d.plotId, savedAt: d.savedAt })) });
}

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
    venues: [{ id: "v-1", name: "Room One", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: ["p-1", "p-2"], defaultPlotId: "p-1" }],
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
  // A copy, as the real stream's JSON is: the same object again would be no change to React.
  FakeEventSource.last?.push("stageplots:updated", structuredClone(DOC));
}

/** The fake routes: just enough of each to answer the way the server does. */
function route(method: string, path: string, query: URLSearchParams, body: unknown): { status: number; json: unknown } {
  const venue = (id: string) => DOC.venues.find((v) => v.id === id)!;
  let m: RegExpExecArray | null;
  if (method === "POST" && path === "/api/stageplots/venues") {
    const v = { id: `v-new${++ids}`, slug: `new-venue-${ids}`, oldSlugs: [], plotIds: [], defaultPlotId: null, notes: "", ...(body as object) } as unknown as StagePlotsView["venues"][number];
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
  if (method === "PUT" && (m = /^\/api\/stageplots\/plots\/([^/]+)\/draft$/.exec(path))) {
    const { baseVersion, items } = body as { baseVersion: number; items: PlotDraft["items"] };
    const draft = { plotId: m[1], baseVersion, items, savedAt: `2026-11-14T14:${String(32 + DRAFTS.length).padStart(2, "0")}:00.000Z` };
    DRAFTS = [...DRAFTS.filter((d) => d.plotId !== m![1]), draft];
    // As the server does: the note goes out before the answer.
    announceDrafts();
    return { status: 200, json: { plotId: m[1], baseVersion, savedAt: draft.savedAt } };
  }
  if (method === "DELETE" && (m = /^\/api\/stageplots\/plots\/([^/]+)\/draft$/.exec(path))) {
    DRAFTS = DRAFTS.filter((d) => d.plotId !== m![1]);
    return { status: 200, json: { ok: true } };
  }
  if (method === "PUT" && (m = /^\/api\/stageplots\/plots\/([^/]+)\/items$/.exec(path))) {
    // The server deletes the plot's draft as a save lands.
    DRAFTS = DRAFTS.filter((d) => d.plotId !== m![1]);
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
    // As the route does: the plot, its place in its venue, the overrides naming it,
    // and the first plot left as the default when it was the default.
    const clearedPlans = overridesOfPlot(DOC, p.id).map((o) => o.planId);
    DOC.plots = DOC.plots.filter((x) => x.id !== p.id);
    v.plotIds = v.plotIds.filter((x) => x !== p.id);
    if (v.defaultPlotId === p.id) v.defaultPlotId = v.plotIds[0] ?? null;
    DOC.overrides = DOC.overrides.filter((o) => o.plotId !== p.id);
    return { status: 200, json: { ok: true, clearedPlans, defaultPlotId: v.defaultPlotId } };
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
  // A copy, as a real read is: the same object again would be no change to React.
  let json: unknown = structuredClone(DOC);
  if (/\/draft$/.test(u.pathname)) {
    if (DRAFTS_DOWN) throw new TypeError("Failed to fetch");
    if (method === "PUT") draftPutsOut++;
    if (DRAFT_HOLD && method === "PUT") await DRAFT_HOLD;
  }
  if (u.pathname === "/api/stageplots/drafts") {
    draftReads++;
    const body = { drafts: structuredClone(DRAFTS) };
    return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
  }
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
      if (status < 300 && DRAFT_NOTICE && /^\/api\/stageplots\/plots\/[^/]+(\/items)?$/.test(u.pathname)) json = { ...(json as object), draftNotice: DRAFT_NOTICE };
    }
    if (ITEMS_HOLD && method === "PUT" && u.pathname.endsWith("/items")) await ITEMS_HOLD;
  }
  return { ok: status < 300, status, statusText: String(status), json: async () => json, text: async () => JSON.stringify(json) };
};

const { render, cleanup, screen, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { StagePlotsEdit } = await import("./stageplots-edit.js");
const { PATCH_REREAD } = await import("../../main/stageplots/use-patch.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { itemRenderProbe } = await import("../../main/stageplots/plot-items.js");
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");
const { __resetForTests: resetStageState } = await import("../../main/use-stage-state.js");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } = await import("@tanstack/react-router");
const { CleanupPreview } = await import("./stageplots-cleanup-preview.js");
const { clearClipboard } = await import("../../main/stageplots/clipboard.js");
const { DUPLICATE_OFFSET } = await import("../../main/stageplots/editor-state.js");
const { StagePlotsManagePage, StagePlotsManageVenueRoute, StagePlotsPage, LAST_VENUE_KEY } = await import("../../main/stageplots-view.js");
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
  });
  for (let i = 0; i < 4; i++) await settle();
}

/** The editor and /stageplots as two routes of a real router over a memory history, opened at `url`. */
async function mountRouted(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRootRoute({});
  const edit = createRoute({ getParentRoute: () => root, path: "/stageplots/edit", component: () => React.createElement(StagePlotsEdit, { openPdf: fakePdf }) });
  const list = createRoute({ getParentRoute: () => root, path: "/stageplots/manage", component: StagePlotsManagePage });
  const venue = createRoute({ getParentRoute: () => root, path: "/stageplots/manage/$venueId", component: StagePlotsManageVenueRoute });
  const router = createRouter({ routeTree: root.addChildren([edit, list, venue]), history: createMemoryHistory({ initialEntries: [url] }) });
  await act(async () => {
    await act(async () => {
      render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never), React.createElement(ConfirmHost)));
    });
  });
  for (let i = 0; i < 6; i++) await settle();
  return router;
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
  clearClipboard();
  DOC = doc();
  PATCH = patchFile();
  PATCH_DOWN = false;
  PATCH_HOLD = null;
  DRAFTS = [];
  DRAFTS_DOWN = false;
  DRAFT_HOLD = null;
  ITEMS_HOLD = null;
  DRAFT_NOTICE = null;
  draftPutsOut = 0;
  draftReads = 0;
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
  test("a venue picked after opening with ?venue= wins over the parameter", async () => {
    DOC.venues.push({ id: "v-2", name: "Room Two", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: [], defaultPlotId: null });
    window.history.replaceState(null, "", "/stageplots/edit?venue=v-2");
    try {
      await mount();
      assert.ok(within(card("Publish")).getByRole("button", { name: "Publish Room Two" }));
      await click(within(card("Venues")).getByRole("button", { name: /Room One/ }));
      assert.ok(within(card("Publish")).getByRole("button", { name: "Publish Room One" }));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  test("?venue= opens the editor on that venue", async () => {
    DOC.venues.push({ id: "v-2", name: "Room Two", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: [], defaultPlotId: null });
    window.history.replaceState(null, "", "/stageplots/edit?venue=v-2");
    try {
      await mount();
      assert.ok(within(card("Publish")).getByRole("button", { name: "Publish Room Two" }));
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  test("?venue=&plot= opens the editor on that venue with that plot selected", async () => {
    await mountRouted("/stageplots/edit?venue=v-1&plot=p-2");
    assert.equal(tabs().find((t) => t.textContent === "Special")?.getAttribute("aria-selected"), "true");
    assert.equal(tabs().find((t) => t.textContent === "Standard")?.getAttribute("aria-selected"), "false");
  });

  test("the back link goes to the venue list inside the app, no page load; a modified click is left to the browser", async () => {
    const router = await mountRouted("/stageplots/edit?venue=v-1");
    const back = screen.getByRole("link", { name: "Stage plots" });
    // Cmd-click: not ours, so the browser opens it in a new tab.
    const modified = fireEvent.click(back, { metaKey: true });
    assert.equal(modified, true, "a Cmd-click was taken over");
    assert.equal(router.state.location.pathname, "/stageplots/edit");
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.click(back);
    });
    for (let i = 0; i < 4; i++) await settle();
    assert.equal(notPrevented, false, "a plain click was left to the browser, which loads the page");
    assert.equal(router.state.location.pathname, "/stageplots/manage");
    assert.equal(screen.queryAllByRole("tab").length, 0, "the plot editor is gone");
    assert.ok(screen.getByText("Room One"), "the venue list shows");
  });

  test("the Publish card sits last in the left column, for the selected venue", async () => {
    await mount();
    const publish = card("Publish");
    assert.equal(publish.parentElement?.lastElementChild, publish, "the Publish card is not at the foot of the left column");
    assert.ok(publish.parentElement?.contains(card("Venues")), "the Publish card is not in the left column");
    assert.ok(within(publish).getByRole("button", { name: "Publish Room One" }));
  });

  test("adding a venue asks its name first, adds it under that name and shows it selected", async () => {
    await mount();
    await click(within(card("Venues")).getByRole("button", { name: "Venue" }));
    assert.deepEqual(writes(), [], "nothing is added before it has a name");
    const field = screen.getByLabelText("New venue name") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  Main Auditorium " } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await settle();
    assert.deepEqual(writes(), ["POST /api/stageplots/venues"]);
    // The name goes with the create, so the address the server makes from it is the venue's name.
    assert.deepEqual(sent[0].body, { name: "Main Auditorium", kind: "home", notes: "" });
    const current = within(card("Venues")).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true");
    assert.equal(current?.textContent, "Main Auditorium0 plots");
    assert.equal((screen.getByLabelText("Venue name") as HTMLInputElement).value, "Main Auditorium");
    assert.equal(screen.queryByLabelText("New venue name"), null);
  });

  test("Escape, or leaving the new venue's name empty, adds nothing", async () => {
    await mount();
    await click(within(card("Venues")).getByRole("button", { name: "Venue" }));
    let field = screen.getByLabelText("New venue name");
    fireEvent.change(field, { target: { value: "Chapel" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Escape" });
    });
    assert.equal(screen.queryByLabelText("New venue name"), null);
    await click(within(card("Venues")).getByRole("button", { name: "Venue" }));
    field = screen.getByLabelText("New venue name");
    await act(async () => {
      fireEvent.blur(field);
    });
    await settle();
    assert.deepEqual(writes(), []);
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

  test("Before and After open large, switch with the arrow keys, and Escape closes back to the thumbnail", async () => {
    await mount();
    await click(screen.getByRole("button", { name: "Open Before large" }));
    const dialog = screen.getByRole("dialog", { name: /before and after clean-up/ });
    assert.equal(within(dialog).getByRole("button", { name: "Before" }).getAttribute("aria-pressed"), "true");
    assert.match(screen.getByTestId("cleanup-meta").textContent!, /^Source · /);
    assert.equal(document.activeElement, within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => {
      fireEvent.keyDown(document, { key: "ArrowRight" });
    });
    assert.match(screen.getByTestId("cleanup-meta").textContent!, /^Web image · WebP · .* · 2400 × 1600$/);
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 300));
    });
    await settle();
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(document.activeElement, screen.getByRole("button", { name: "Open After large" }), "focus returns to the thumbnail it shrank into");
  });

  test("both thumbnails load lazily", async () => {
    await mount();
    const imgs = ["Open Before large", "Open After large"].map((name) => screen.getByRole("button", { name }).querySelector("img")!);
    assert.deepEqual(imgs.map((i) => i.getAttribute("loading")), ["lazy", "lazy"]);
  });

  test("a preview that goes away while it shrinks never calls onClose or takes focus afterwards", async () => {
    let closed = 0;
    const thumb = document.createElement("button");
    thumb.getBoundingClientRect = () => ({ left: 10, top: 10, right: 110, bottom: 80, width: 100, height: 70, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(thumb);
    const view = render(React.createElement(CleanupPreview, { background: DOC.backgrounds[0], side: "before", thumbOf: () => thumb, onClose: () => void closed++, kindLabel: "JPEG" }));
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    view.unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    thumb.remove();
    assert.equal(closed, 0, "the shrink's timer outlived the preview");
    assert.notEqual(document.activeElement, thumb);
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

  test("deleting the default plot says which plot takes over, and it does", async () => {
    await mount();
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent!, /Special becomes the default\./);
    await click(within(dialog).getByRole("button", { name: "Delete plot" }));
    assert.ok(writes().includes("DELETE /api/stageplots/plots/p-1"));
    assert.equal(DOC.venues[0].defaultPlotId, "p-2");
    await settle();
    assert.deepEqual(tabs().map((t) => t.textContent), ["Special"]);
    assert.ok(within(tabs()[0]).getByRole("img", { name: "Default plot" }));
  });

  test("deleting the last plot leaves the venue empty, offering Add plot", async () => {
    DOC.venues[0].plotIds = ["p-1"];
    DOC.plots = DOC.plots.filter((p) => p.id === "p-1");
    await mount();
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    assert.match(screen.getByRole("alertdialog").textContent!, /Room One is left with no plots\./);
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete plot" }));
    assert.equal(DOC.venues[0].defaultPlotId, null);
    await settle();
    assert.equal(screen.queryAllByRole("tab").length, 0);
    assert.ok(screen.getByRole("button", { name: "Add plot" }));
    assert.equal(screen.queryByRole("button", { name: "New plot" }), null);
  });

  test("Move right and Move left reorder the tabs, saved as the venue's plotIds", async () => {
    await mount();
    await openMenu();
    assert.equal(screen.getByRole("menuitem", { name: "Move left" }).getAttribute("aria-disabled"), "true");
    await click(screen.getByRole("menuitem", { name: "Move right" }));
    assert.deepEqual(sent.at(-1), { what: "PATCH /api/stageplots/venues/v-1", body: { plotIds: ["p-2", "p-1"] } });
    await settle();
    assert.deepEqual(tabs().map((t) => t.textContent), ["Special", "Standard"]);
  });

  test("deleting the default, with the tabs reordered, names the first tab left, and the server makes that plot the default", async () => {
    // Created p-1, p-2, p-3; the tabs read Third, Standard, Special.
    DOC.plots.push(plot("p-3", "v-1", "Third"));
    DOC.venues[0].plotIds = ["p-3", "p-1", "p-2"];
    await mount();
    assert.deepEqual(tabs().map((t) => t.textContent), ["Third", "Standard", "Special"]);
    // Standard (the default) moves right, so the tab order is Third, Special, Standard.
    await openMenu();
    await click(screen.getByRole("menuitem", { name: "Move right" }));
    await settle();
    assert.deepEqual(DOC.venues[0].plotIds, ["p-3", "p-2", "p-1"]);
    await openMenu();
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = screen.getByRole("alertdialog");
    // The FIRST plot left in tab order (Third), not the last (Special) and not creation order's (Special).
    assert.match(dialog.textContent!, /Third becomes the default\./);
    await click(within(dialog).getByRole("button", { name: "Delete plot" }));
    assert.equal(DOC.venues[0].defaultPlotId, "p-3", "the server made the plot the confirm named the default");
  });

  // jsdom lays nothing out, so the tabs are given boxes: `[left, top]` each, 100 x 30.
  function stubTabs(boxes: Record<string, [number, number]>) {
    for (const tab of tabs()) {
      const [left, top] = boxes[tab.dataset.plotTab!];
      tab.getBoundingClientRect = () => ({ left, top, right: left + 100, bottom: top + 30, width: 100, height: 30, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    }
  }
  const tabOf = (id: string) => tabs().find((t) => t.dataset.plotTab === id)!;
  async function tabEvent(kind: "pointerDown" | "pointerMove" | "pointerUp", id: string, x: number, y: number) {
    await act(async () => {
      fireEvent[kind](tabOf(id), { pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });
    });
  }
  /** Press on the middle of `id`, drag to (x, y) in two moves, let go. */
  async function dragTab(id: string, boxes: Record<string, [number, number]>, x: number, y: number) {
    stubTabs(boxes);
    const [left, top] = boxes[id];
    await tabEvent("pointerDown", id, left + 50, top + 15);
    await tabEvent("pointerMove", id, left + 50 + (x - left - 50) / 2, y);
    await tabEvent("pointerMove", id, x, y);
    await tabEvent("pointerUp", id, x, y);
    await settle();
  }

  test("dragging a tab along the row reorders the plots, saved as the venue's plotIds", async () => {
    DOC.plots.push(plot("p-3", "v-1", "Third"));
    DOC.venues[0].plotIds = ["p-1", "p-2", "p-3"];
    await mount();
    // Standard let go at 240: right of Special's middle (150), left of Third's (250), so slot 1.
    await dragTab("p-1", { "p-1": [0, 0], "p-2": [100, 0], "p-3": [200, 0] }, 240, 15);
    assert.deepEqual(sent.at(-1), { what: "PATCH /api/stageplots/venues/v-1", body: { plotIds: ["p-2", "p-1", "p-3"] } });
    // The click the browser sends after the drag does not select the tab.
    await act(async () => {
      fireEvent.click(tabOf("p-1"), { detail: 1 });
    });
    assert.equal(tabOf("p-2").getAttribute("aria-selected"), "false");
  });

  test("dragging across a wrapped row lands in the slot under the pointer, by row", async () => {
    DOC.plots.push(plot("p-3", "v-1", "Third"), plot("p-4", "v-1", "Fourth"));
    DOC.venues[0].plotIds = ["p-1", "p-2", "p-3", "p-4"];
    await mount();
    // Two rows of two: Standard, Special over Third, Fourth. Fourth dragged into the first
    // row's left end is slot 0, not decided by the horizontal position alone.
    await dragTab("p-4", { "p-1": [0, 0], "p-2": [100, 0], "p-3": [0, 40], "p-4": [100, 40] }, 10, 15);
    assert.deepEqual(sent.at(-1)?.body, { plotIds: ["p-4", "p-1", "p-2", "p-3"] });
    sent = [];
    DOC.venues[0].plotIds = ["p-1", "p-2", "p-3", "p-4"];
    broadcast();
    await settle();
    // Standard dragged to the second row's left end (x 10, y 55): after the whole first row's
    // other tab (Special) and before Third.
    await dragTab("p-1", { "p-1": [0, 0], "p-2": [100, 0], "p-3": [0, 40], "p-4": [100, 40] }, 10, 55);
    assert.deepEqual(sent.at(-1)?.body, { plotIds: ["p-2", "p-1", "p-3", "p-4"] });
  });

  test("a drag with no click after it does not swallow a later click on a tab", async () => {
    await mount();
    await dragTab("p-1", { "p-1": [0, 0], "p-2": [100, 0] }, 160, 15);
    // The browser sent no click after the release (it ended off the tab). Time passes.
    await settle();
    await act(async () => {
      fireEvent.click(tabOf("p-2"), { detail: 1 });
    });
    assert.equal(tabOf("p-2").getAttribute("aria-selected"), "true");
  });

  test("Escape cancels a tab drag and sends nothing; the next keyboard click still selects", async () => {
    await mount();
    stubTabs({ "p-1": [0, 0], "p-2": [100, 0] });
    await tabEvent("pointerDown", "p-1", 50, 15);
    await tabEvent("pointerMove", "p-1", 160, 15);
    assert.ok(screen.getByTestId("tab-drop-marker"));
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    assert.equal(screen.queryByTestId("tab-drop-marker"), null);
    await tabEvent("pointerUp", "p-1", 160, 15);
    assert.deepEqual(writes(), [], "nothing was saved");
    // A keyboard Enter or Space on a tab is a click with no detail: not the one that follows a drag.
    await act(async () => {
      fireEvent.click(tabOf("p-2"), { detail: 0 });
    });
    assert.equal(tabOf("p-2").getAttribute("aria-selected"), "true");
  });

  test("a double-click on a tab renames it in place", async () => {
    await mount();
    await act(async () => {
      fireEvent.doubleClick(tabs()[1]);
    });
    const field = screen.getByRole("textbox", { name: "Plot name" }) as HTMLInputElement;
    assert.equal(document.activeElement, field);
    await act(async () => {
      fireEvent.change(field, { target: { value: "Christmas" } });
      fireEvent.blur(field);
    });
    await settle();
    assert.deepEqual(sent.at(-1), { what: "PATCH /api/stageplots/plots/p-2", body: { name: "Christmas" } });
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

/** A press on a palette item, moves, and a release, as a drag from the palette. */
async function paletteDrag(testId: string, to: { x: number; y: number }, { release = true, thenClick = false }: { release?: boolean; thenClick?: boolean } = {}) {
  const btn = screen.getByTestId(`add-${testId}`);
  const ev = async (kind: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) => {
    await act(async () => {
      fireEvent[kind](btn, { pointerId: 1, clientX: x, clientY: y, button: 0, isPrimary: true });
      // The browser sends the click in the same task as the release.
      if (kind === "pointerUp" && thenClick) fireEvent.click(btn, { detail: 1 });
    });
  };
  await ev("pointerDown", 20, 200);
  await ev("pointerMove", 25, 205);
  await ev("pointerMove", to.x, to.y);
  if (release) await ev("pointerUp", to.x, to.y);
  await settle();
}
const itemIds = () => [...canvas().querySelectorAll("[data-id]")].map((g) => g.getAttribute("data-id")!);

describe("the plot editor", () => {
  test("a palette item dragged onto the plot lands centred on the drop point", async () => {
    await mount();
    stubBox();
    await paletteDrag("box", { x: 400, y: 300 }, { thenClick: true });
    assert.equal(itemIds().length, 1, "the click after a drop added a second item");
    const [id] = itemIds();
    assert.ok(id, "the drop added nothing");
    const w = Number(drawn(id).querySelector("rect")!.getAttribute("width"));
    const h = Number(drawn(id).querySelector("rect")!.getAttribute("height"));
    assert.ok(Math.abs(at(id).x + w / 2 - 400) <= 1 && Math.abs(at(id).y + h / 2 - 300) <= 1, `centred on (400, 300), at ${JSON.stringify(at(id))} ${w}x${h}`);
  });

  test("a palette drag let go off the plot, or ended with Escape, adds nothing; a plain click after still adds", async () => {
    await mount();
    stubBox();
    // Off the plot: below its box (it is 666 px tall).
    await paletteDrag("box", { x: 400, y: 900 });
    assert.deepEqual(itemIds(), [], "dropped off the plot");
    // Escape mid-drag, then let go over the plot.
    await paletteDrag("box", { x: 400, y: 300 }, { release: false });
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    await act(async () => {
      fireEvent.pointerUp(screen.getByTestId("add-box"), { pointerId: 1, clientX: 400, clientY: 300, button: 0, isPrimary: true });
    });
    await settle();
    assert.deepEqual(itemIds(), [], "Escape cancelled the drag");
    assert.equal(screen.queryByTestId("palette-ghost"), null);
    // A later keyboard (or any plain) click adds, as it always did.
    await act(async () => {
      fireEvent.click(screen.getByTestId("add-box"), { detail: 0 });
    });
    await settle();
    assert.equal(itemIds().length, 1, "a plain click after a cancelled drag still adds");
  });

  test("clicking Drum kit in the palette adds a selected drum kit", async () => {
    await mount();
    const id = await addFromPalette("drumkit");
    assert.equal(drawn(id).querySelector("[data-symbol]")?.getAttribute("data-symbol"), "drumkit");
    assert.ok(canvas().querySelector(`[data-selection-of="${id}"] [data-hd="size"]`), "the new item is not selected");
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
    assert.match(document.body.textContent!, /This plot was saved elsewhere/);
    assert.ok(drawn(mine), "the draft was dropped");
    assert.equal(DOC.plots[0].items[0].id, "theirs", "the other save was overwritten");
    await click(screen.getByRole("button", { name: "Reload" }));
    assert.ok(drawn("theirs"));
    assert.ok(canvas().querySelector(`[data-id="${mine}"]`) === null);
    assert.doesNotMatch(document.body.textContent!, /saved elsewhere/);
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
    assert.doesNotMatch(document.body.textContent!, /saved elsewhere/);
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
    assert.doesNotMatch(document.body.textContent!, /saved elsewhere/, "my own fade made my Save a 409");
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

  test("switching plot with unsaved changes keeps them as the plot's draft and switches without asking; back again, they open", async () => {
    await mount();
    const mine = await addFromPalette("box");
    await click(tabs()[1]);
    await settle();
    assert.equal(screen.queryByRole("alertdialog"), null, "it asked although the draft could be kept");
    assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
    assert.ok(writes().includes("PUT /api/stageplots/plots/p-1/draft"), writes().join(", "));
    assert.deepEqual(DRAFTS.map((d) => [d.plotId, d.items.map((it) => it.id)]), [["p-1", [mine]]]);
    // The plot with a draft carries a dot on its tab, and so does its venue.
    assert.ok(within(tabs()[0]).queryByLabelText("Unsaved draft"), "no dot on the tab with a draft");
    assert.equal(within(tabs()[1]).queryByLabelText("Unsaved draft"), null);
    assert.ok(within(card("Venues")).queryByLabelText("Unsaved draft"), "no dot on the venue");
    await click(tabs()[0]);
    await settle();
    assert.ok(drawn(mine), "the kept draft did not open");
    assert.match(document.body.textContent!, /Unsaved draft from \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2} on Room One · Standard\. \/stageplots still shows the saved plot\./);
  });

  test("switching plot when the draft cannot be kept asks first, and Discard changes switches", async () => {
    DRAFTS_DOWN = true;
    await mount();
    const mine = await addFromPalette("box");
    await click(tabs()[1]);
    await settle();
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent!, /The draft of Room One · Standard could not be kept on the server/);
    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true", "Cancel left the plot");
    assert.ok(drawn(mine), "Cancel dropped the draft");
    await click(tabs()[1]);
    await settle();
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
    assert.ok(banner() === null);
  });

  // ── Keys, and the right-click menus ───────────────────────────────────────

  /** Two boxes, `a` then `b` in drawing order, with `id` selected by a press on it. */
  async function twoBoxes(select: "a" | "b") {
    DOC.plots[0].items = [item({ id: "a", x: 100, y: 100 }), item({ id: "b", x: 400, y: 300 })];
    await mount();
    stubBox();
    const p = at(select);
    await pointer("pointerDown", drawn(select).querySelector("rect")!, p.x + 5, p.y + 5);
    await pointer("pointerUp", canvas(), p.x + 5, p.y + 5);
    await settle();
  }
  const orderNow = () => [...canvas().querySelectorAll("[data-items] > [data-id]")].map((g) => g.getAttribute("data-id")!);
  async function key(init: KeyboardEventInit & { key: string }) {
    await act(async () => {
      fireEvent.keyDown(canvas(), init);
    });
  }
  /** Where the menu opens: over an item (what is drawn there is what elementFromPoint says), or the empty plot. */
  async function rightClick(over: "a" | "b" | null, x = 600, y = 500) {
    stubBox();
    (document as unknown as { elementFromPoint: unknown }).elementFromPoint = () => (over ? drawn(over).querySelector("rect")! : canvas());
    await act(async () => {
      fireEvent.contextMenu(over ? drawn(over).querySelector("rect")! : canvas(), { clientX: x, clientY: y });
    });
    await settle();
  }

  test("Cmd or Ctrl with C and V copy and paste, each paste a step further on; X cuts, and its first paste lands where it was", async () => {
    await twoBoxes("a");
    const origin = at("a");
    await key({ key: "c", metaKey: true });
    await key({ key: "v", metaKey: true });
    assert.equal(itemIds().length, 3, "Cmd+V pasted");
    const first = itemIds().find((id) => id !== "a" && id !== "b")!;
    assert.deepEqual(at(first), { x: origin.x + DUPLICATE_OFFSET, y: origin.y + DUPLICATE_OFFSET }, "the first paste of a copy is one step on");
    await key({ key: "v", ctrlKey: true });
    const second = itemIds().find((id) => ![first, "a", "b"].includes(id))!;
    assert.deepEqual(at(second), { x: origin.x + 2 * DUPLICATE_OFFSET, y: origin.y + 2 * DUPLICATE_OFFSET }, "the next paste is a step further");
    // Cut the selected (pasted) item: it goes, and its first paste lands where it was.
    const where = at(second);
    await key({ key: "x", ctrlKey: true });
    assert.equal(itemIds().includes(second), false, "Ctrl+X removed it");
    await key({ key: "v", ctrlKey: true });
    const back = itemIds().find((id) => ![first, "a", "b"].includes(id))!;
    assert.deepEqual(at(back), where, "a cut's first paste is at offset 0");
  });

  test("Cmd or Ctrl with D duplicates the selected item", async () => {
    await twoBoxes("b");
    await key({ key: "d", metaKey: true });
    assert.equal(itemIds().length, 3);
    await key({ key: "d", ctrlKey: true });
    assert.equal(itemIds().length, 4);
  });

  test("the arrange keys: Cmd+[ and ] a step, Alt+Cmd+[ and ] all the way, and the order shows while the item is selected", async () => {
    DOC.plots[0].items = [item({ id: "a", x: 100, y: 100 }), item({ id: "b", x: 400, y: 300 }), item({ id: "c", x: 700, y: 100 })];
    await mount();
    stubBox();
    const p = at("b");
    await pointer("pointerDown", drawn("b").querySelector("rect")!, p.x + 5, p.y + 5);
    await pointer("pointerUp", canvas(), p.x + 5, p.y + 5);
    await settle();
    assert.deepEqual(orderNow(), ["a", "b", "c"]);
    await key({ key: "[", code: "BracketLeft", metaKey: true });
    assert.deepEqual(orderNow(), ["b", "a", "c"], "backward one step, drawn there while selected");
    await key({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.deepEqual(orderNow(), ["a", "b", "c"], "forward one step");
    await key({ key: "‘", code: "BracketLeft", metaKey: true, altKey: true });
    assert.deepEqual(orderNow(), ["b", "a", "c"], "Alt+Cmd+[ sends it to the back");
    await key({ key: "’", code: "BracketRight", metaKey: true, altKey: true });
    assert.deepEqual(orderNow(), ["a", "c", "b"], "Alt+Cmd+] brings it to the front");
    // Shift+Cmd+[ is the browser's (it switches tabs): the page does nothing with it.
    await key({ key: "{", code: "BracketLeft", metaKey: true, shiftKey: true });
    assert.deepEqual(orderNow(), ["a", "c", "b"]);
    assert.ok(canvas().querySelector('[data-selection-of="b"]'), "it is still the selected item");
  });

  test("right-click on an item selects it and offers Cut, Copy, Paste, Duplicate, Arrange and Delete; Arrange moves it while selected", async () => {
    await twoBoxes("a");
    await rightClick("b");
    const menu = screen.getByRole("menu");
    assert.deepEqual(
      within(menu).getAllByRole("menuitem").map((m) => m.textContent!.replace(/[⌘⌥⇧⌫›].*$/, "")),
      ["Cut", "Copy", "Paste", "Duplicate", "Arrange", "Delete"],
    );
    assert.ok(canvas().querySelector('[data-selection-of="b"]'), "the item under the click was selected first");
    assert.equal(within(menu).getByRole("menuitem", { name: /^Paste/ }).hasAttribute("disabled"), true, "nothing copied yet");
    await act(async () => {
      fireEvent.mouseEnter(within(menu).getByRole("menuitem", { name: /Arrange/ }).parentElement!);
    });
    const sub = within(screen.getAllByRole("menu")[1]);
    assert.deepEqual(
      sub.getAllByRole("menuitem").map((m) => m.textContent),
      ["Bring to front⌥⌘]", "Bring forward⌘]", "Send backward⌘[", "Send to back⌥⌘["],
    );
    await click(sub.getByRole("menuitem", { name: /Send to back/ }));
    assert.deepEqual(orderNow(), ["b", "a"], "Send to back shows at once, with b still selected");
    assert.ok(canvas().querySelector('[data-selection-of="b"]'));
  });

  test("right-click on the empty plot offers Paste here, Add here, Undo, Redo and Fit", async () => {
    await twoBoxes("a");
    await rightClick(null, 800, 500);
    const menu = screen.getByRole("menu");
    assert.deepEqual(
      within(menu).getAllByRole("menuitem").map((m) => m.textContent!.replace(/[⌘⇧›].*$/, "")),
      ["Paste here", "Add here", "Undo", "Redo", "Fit the whole plot"],
    );
    assert.equal(within(menu).getByRole("menuitem", { name: /^Paste here/ }).hasAttribute("disabled"), true);
    await act(async () => {
      fireEvent.mouseEnter(within(menu).getByRole("menuitem", { name: /Add here/ }).parentElement!);
    });
    await click(within(screen.getAllByRole("menu")[1]).getByRole("menuitem", { name: "Box" }));
    const added = itemIds().find((id) => id !== "a" && id !== "b");
    assert.ok(added, "Add here > Box added a box");
    const w = Number(drawn(added).querySelector("rect")!.getAttribute("width"));
    assert.ok(Math.abs(at(added).x + w / 2 - 800) <= 1, "centred where it was clicked");
  });

  test("right-click Delete on a tab that is not the selected one deletes it without asking about, or discarding, the selected plot's changes", async () => {
    // The draft cannot be kept, so leaving the selected plot would ask: deleting another must not.
    DRAFTS_DOWN = true;
    await mount();
    const mine = await addFromPalette("box");
    assert.ok(banner(), "Standard has unsaved changes");
    await act(async () => {
      fireEvent.contextMenu(tabs().find((t) => t.textContent === "Special")!, { clientX: 50, clientY: 20 });
    });
    await click(screen.getByRole("menuitem", { name: /Delete/ }));
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent!, /Delete Special\?/);
    await click(within(dialog).getByRole("button", { name: "Delete plot" }));
    assert.ok(writes().includes("DELETE /api/stageplots/plots/p-2"), "Special was deleted");
    assert.equal(screen.queryByText(/Discard unsaved changes\?/), null, "no discard prompt");
    assert.equal(screen.queryByRole("alertdialog"), null);
    assert.ok(drawn(mine), "Standard's draft is intact");
    assert.ok(banner(), "and still unsaved");
  });

  test("a venue's Rename declined at the discard prompt leaves nothing waiting: picking it later does not grab the name field", async () => {
    DOC.venues.push({ id: "v-2", name: "Room Two", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: [], defaultPlotId: null });
    // The prompt comes only when the draft cannot be kept.
    DRAFTS_DOWN = true;
    await mount();
    await addFromPalette("box");
    const rowTwo = () => within(card("Venues")).getByRole("button", { name: /Room Two/ });
    await act(async () => {
      fireEvent.contextMenu(rowTwo(), { clientX: 30, clientY: 30 });
    });
    await click(screen.getByRole("menuitem", { name: "Rename" }));
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    assert.equal(rowTwo().getAttribute("aria-current"), "false", "the switch was declined");
    // Later, by a plain pick: the same prompt, accepted. The name field must not take focus.
    await click(rowTwo());
    await click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard changes" }));
    assert.equal(rowTwo().getAttribute("aria-current"), "true", "Room Two is selected now");
    const field = screen.getByLabelText("Venue name") as HTMLInputElement;
    assert.notEqual(document.activeElement, field, "the declined Rename was still waiting and took the cursor");
  });

  test("an address the server refuses shows under the field as the server wrote it, a venue's name in its own case", async () => {
    await mount();
    refuse = { what: "PATCH /api/stageplots/venues/v-1", error: "chapel already uses that address" };
    const field = screen.getByLabelText("Address") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(field, { target: { value: "chapel" } });
      fireEvent.blur(field);
    });
    await settle();
    assert.equal(field.value, "chapel", "the refused address was not kept as typed");
    assert.equal(screen.getByRole("alert").textContent, "chapel already uses that address.", "the card rewrote the server's sentence");
  });

  test("a venue's menu copies and opens its address by name, not its id", async () => {
    DOC.venues[0].slug = "room-one";
    const router = await mountRouted("/stageplots/edit?venue=v-1");
    const row = () => within(card("Venues")).getByRole("button", { name: /Room One/ });
    const menu = async (name: string) => {
      await act(async () => {
        fireEvent.contextMenu(row(), { clientX: 30, clientY: 30 });
      });
      await click(screen.getByRole("menuitem", { name }));
      await settle();
    };
    await menu("Copy its address");
    // No clipboard here, so it shows the address to copy by hand: the address is the point.
    assert.match(within(card("Venues")).getByRole("status").textContent!, /\/stageplots\/room-one$/);
    await menu("Open in Stage plots");
    assert.equal(router.state.location.pathname, "/stageplots/manage/room-one");
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
  const refusedOrConflict = () => /saved elsewhere|must be a number/.test(document.body.textContent!);
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
    assert.ok(!refusedOrConflict(), `the save after switching was refused: ${document.body.textContent!.match(/[^.]*(saved elsewhere|must be a number)[^.]*/)?.[0]}`);
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
    assert.ok(!refusedOrConflict(), `the save after switching was refused: ${document.body.textContent!.match(/[^.]*(saved elsewhere|must be a number)[^.]*/)?.[0]}`);
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
    assert.doesNotMatch(document.body.textContent!, /saved elsewhere/);
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
    assert.match(document.body.textContent!, /saved elsewhere/);
    await click(screen.getByTestId("undo"));
    assert.doesNotMatch(document.body.textContent!, /saved elsewhere/, "the banner stayed with nothing unsaved");
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
    const rot = canvas().querySelector('[data-selection-of="t"] [data-hd="rot"]')!;
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
    assert.doesNotMatch(document.body.textContent!, /must be a number|saved elsewhere/);
    assert.ok(DOC.plots[0].items[0].y <= 562.5, `saved at y ${DOC.plots[0].items[0].y}`);
  });

  test("a shorter background from elsewhere that moved saved items: Save shows changed elsewhere, not a refusal naming a y", async () => {
    DOC.plots[0].items = [item({ id: "low", y: 600, h: 50 })];
    await mount();
    await addFromPalette("circle");
    await backgroundChangedElsewhere();
    await click(screen.getByRole("button", { name: "Save" }));
    assert.doesNotMatch(document.body.textContent!, /must be a number/, "the save was refused for an item's y");
    assert.match(document.body.textContent!, /This plot was saved elsewhere/);
  });
});

describe("the kept draft", () => {
  /** Real time passing, for the second the editor waits before it keeps a change. */
  const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
  /** Until `ok`, in real time (the editor waits a second before it keeps a change, two before it tries again), or fail after 6 s. */
  const until = async (ok: () => boolean, what: string) => {
    for (const end = Date.now() + 6000; !ok(); ) {
      if (Date.now() > end) assert.fail(`still waiting for ${what}`);
      await wait(50);
    }
  };
  const isKept = () => screen.queryByTestId("draft-kept") !== null;
  const draftWrites = () => writes().filter((w) => w.endsWith("/draft"));
  const ids = () => [...canvas().querySelectorAll("[data-items] > [data-id]")].map((g) => g.getAttribute("data-id"));
  const kept = (over: Partial<PlotDraft> = {}): PlotDraft => ({ plotId: "p-1", baseVersion: DOC.plots[0].version, items: [item({ id: "drafted" })], savedAt: "2026-11-14T14:32:00.000Z", ...over });

  test("a change is kept a second after it, and the banner says when", async () => {
    await mount();
    await addFromPalette("box");
    assert.deepEqual(draftWrites(), [], "kept before the second was up");
    assert.ok(screen.getByTestId("draft-keeping"));
    await until(isKept, "the draft to be kept");
    assert.deepEqual(draftWrites(), ["PUT /api/stageplots/plots/p-1/draft"]);
    assert.match(screen.getByTestId("draft-kept").textContent!, /^Draft kept \d{1,2}:\d{2}/);
    assert.equal(sent.at(-1)!.body && (sent.at(-1)!.body as { baseVersion: number }).baseVersion, DOC.plots[0].version);
  });

  test("Save deletes the draft, and no draft write lands after it", async () => {
    await mount();
    await addFromPalette("box");
    await until(isKept, "the draft to be kept");
    await click(screen.getByRole("button", { name: "Save" }));
    await settle();
    assert.deepEqual(DRAFTS, [], "the save left the draft");
    await wait(1200);
    assert.deepEqual(draftWrites(), ["PUT /api/stageplots/plots/p-1/draft"], "a draft write after the Save");
    assert.equal(within(tabs()[0]).queryByLabelText("Unsaved draft"), null);
  });

  test("a Save pressed while a draft write is on its way goes after it, so the draft does not come back", async () => {
    await mount();
    await addFromPalette("box");
    let release!: () => void;
    DRAFT_HOLD = new Promise((r) => (release = r));
    await until(() => draftPutsOut > 0, "the draft write to go out");
    // The draft write is out and has not landed; Save is pressed now.
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    await settle();
    release();
    DRAFT_HOLD = null;
    for (let i = 0; i < 4; i++) await settle();
    assert.deepEqual(
      writes().filter((w) => w.startsWith("PUT")),
      ["PUT /api/stageplots/plots/p-1/draft", "PUT /api/stageplots/plots/p-1/items"],
      "the save went out before the draft write it should wait for",
    );
    assert.deepEqual(DRAFTS, [], "a draft of what was just saved was left on the server");
  });

  test("a plot's draft survives a save on another plot, and opens again when its tab is picked", async () => {
    await mount();
    const mine = await addFromPalette("box");
    await until(isKept, "the draft to be kept");
    await click(tabs()[1]);
    await addFromPalette("circle");
    await click(screen.getByRole("button", { name: "Save" }));
    await settle();
    assert.deepEqual(DRAFTS.map((d) => d.plotId), ["p-1"], "the save on Special took Standard's draft");
    await click(tabs()[0]);
    for (let i = 0; i < 3; i++) await settle();
    assert.ok(ids().includes(mine), "Standard opened without its draft");
    assert.match(document.body.textContent!, /Unsaved draft from/);
    assert.deepEqual(DRAFTS.map((d) => d.plotId), ["p-1"], "opening Standard deleted its draft");
  });

  test("closing the page while a Save is on its way sends no draft of what it is saving, so the draft does not come back over it", async () => {
    await mount();
    await addFromPalette("box");
    let release!: () => void;
    ITEMS_HOLD = new Promise((r) => (release = r));
    // Saved before the second was up: nothing kept yet, so a closing page would send it.
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Save" })));
    await until(() => writes().includes("PUT /api/stageplots/plots/p-1/items"), "the save to go out");
    // The save has landed on the server and its answer is not back: the tab closes now.
    await act(async () => void window.dispatchEvent(new Event("pagehide")));
    await settle();
    release();
    ITEMS_HOLD = null;
    for (let i = 0; i < 4; i++) await settle();
    assert.deepEqual(draftWrites(), [], "the page sent a draft of the items its Save was carrying");
    assert.deepEqual(DRAFTS, [], "a draft came back over the save that deleted it");
  });

  test("the plot's version moving under an unchanged draft (a rename elsewhere) keeps it again on the new version, so it never opens as saved elsewhere", async () => {
    await mount();
    await addFromPalette("box");
    await until(isKept, "the draft to be kept");
    assert.equal(DRAFTS[0].baseVersion, 0);
    // Renamed on another desk; the server's draft stayed on version 0 (its write landed after the
    // rename carried the drafts, or the carry could not be written).
    DOC.plots[0] = { ...DOC.plots[0], name: "Renamed", version: 1 };
    await act(async () => broadcast());
    await until(() => DRAFTS[0]?.baseVersion === 1, "the draft to be kept again on version 1");
    assert.ok(isKept(), "the banner does not say the draft is kept");
    cleanup();
    await settle();
    await mount();
    assert.equal(screen.queryByText(/This plot was saved elsewhere/), null, "the draft opened as saved elsewhere");
    assert.match(document.body.textContent!, /Unsaved draft from/);
  });

  test("a save, or a rename through its card, whose draft the server could not tidy says so in a note, and stands", async () => {
    DRAFT_NOTICE = "Saved, but the plot's unsaved draft could not be deleted, so it may open again: disk full";
    await mount();
    await addFromPalette("box");
    await click(screen.getByRole("button", { name: "Save" }));
    await settle();
    assert.equal(banner(), null, "the save did not land");
    assert.equal(screen.getByTestId("draft-note").textContent, DRAFT_NOTICE);
    // Through a card's save: a rename.
    DRAFT_NOTICE = "Saved, but the plot's unsaved draft could not be moved onto this version, so it may open as saved elsewhere: disk full";
    await openMenu();
    await click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByLabelText("Plot name") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(field, { target: { value: "Renamed" } });
      fireEvent.keyDown(field, { key: "Enter" });
      field.blur();
    });
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(tabs()[0].textContent, "Renamed");
    assert.equal(screen.getByTestId("draft-note").textContent, DRAFT_NOTICE);
    // The next save that leaves nothing undone clears it.
    DRAFT_NOTICE = null;
    await addFromPalette("circle");
    await click(screen.getByRole("button", { name: "Save" }));
    await settle();
    assert.equal(screen.queryByTestId("draft-note"), null);
  });

  test("closing the tab asks only while the newest change has not reached the server", async () => {
    const { createRootRoute, createRoute, createRouter, createBrowserHistory, RouterProvider, Outlet } = await import("@tanstack/react-router");
    window.history.replaceState(null, "", "/stageplots/edit");
    const root = createRootRoute({ component: () => React.createElement(React.Fragment, null, React.createElement(Outlet), React.createElement(ConfirmHost)) });
    const edit = createRoute({ getParentRoute: () => root, path: "/stageplots/edit", component: () => React.createElement(StagePlotsEdit, { openPdf: fakePdf }) });
    const history = createBrowserHistory();
    const router = createRouter({ routeTree: root.addChildren([edit]), history });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    try {
      await act(async () => {
        await act(async () => {
          render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
        });
      });
      for (let i = 0; i < 4; i++) await settle();
      const closing = () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      assert.equal(closing(), false, "it asked with nothing unsaved");
      await addFromPalette("box");
      assert.equal(closing(), true, "it let the tab close before the change was kept");
      await until(isKept, "the draft to be kept");
      assert.equal(closing(), false, "it asked although the change is kept");
    } finally {
      cleanup();
      history.destroy();
      window.history.replaceState(null, "", "/");
    }
  });

  test("its own kept changes are not read back: one read of the drafts on mount, and one for a draft kept elsewhere", async () => {
    await mount();
    assert.equal(draftReads, 1);
    await addFromPalette("box");
    await until(isKept, "the draft to be kept");
    await addFromPalette("circle");
    await until(() => draftPutsOut === 2 && isKept(), "the second change to be kept");
    assert.equal(draftReads, 1, "the editor read back a draft it had just written");
    // Another desk keeps a draft of the other plot: that is news, read once, and its tab gets the dot.
    DRAFTS = [...DRAFTS, { plotId: "p-2", baseVersion: 0, items: [item({ id: "theirs" })], savedAt: "2026-11-14T15:00:00.000Z" }];
    await act(async () => announceDrafts());
    for (let i = 0; i < 3; i++) await settle();
    assert.equal(draftReads, 2);
    assert.ok(within(tabs()[1]).queryByLabelText("Unsaved draft"), "the other desk's draft has no dot");
  });

  test("undo back to the saved plot deletes the draft", async () => {
    await mount();
    await addFromPalette("box");
    await until(isKept, "the draft to be kept");
    await click(screen.getByTestId("undo"));
    await settle();
    assert.deepEqual(draftWrites(), ["PUT /api/stageplots/plots/p-1/draft", "DELETE /api/stageplots/plots/p-1/draft"]);
    assert.deepEqual(DRAFTS, []);
  });

  test("a kept draft opens over the saved plot, says when it is from, and Discard draft deletes it on the server", async () => {
    DOC.plots[0].items = [item({ id: "saved" })];
    DRAFTS = [kept()];
    await mount();
    assert.deepEqual(ids(), ["drafted"]);
    assert.match(document.body.textContent!, /Unsaved draft from Sat 14 Nov, \d{1,2}:32 on Room One · Standard\./);
    await click(screen.getByRole("button", { name: "Discard draft" }));
    await settle();
    assert.deepEqual(ids(), ["saved"]);
    assert.deepEqual(draftWrites(), ["DELETE /api/stageplots/plots/p-1/draft"]);
    assert.deepEqual(DRAFTS, []);
    assert.equal(banner(), null);
  });

  test("a kept draft saved from the banner it opened with saves on its base and deletes the draft", async () => {
    DRAFTS = [kept()];
    await mount();
    await click(screen.getByRole("button", { name: "Save" }));
    await settle();
    const put = sent.find((w) => w.what === "PUT /api/stageplots/plots/p-1/items")!;
    assert.equal((put.body as { version: number }).version, 0);
    assert.deepEqual((put.body as { items: { id: string }[] }).items.map((it) => it.id), ["drafted"]);
    assert.deepEqual(DRAFTS, []);
  });

  test("a kept draft drawn on a version whose items changed since opens as saved elsewhere, and Reload drops it", async () => {
    DOC.plots[0].items = [item({ id: "theirs" })];
    DOC.plots[0].version = 3;
    DRAFTS = [kept({ baseVersion: 2 })];
    await mount();
    assert.deepEqual(ids(), ["drafted"]);
    assert.match(document.body.textContent!, /This plot was saved elsewhere after your draft began\. Reload shows the saved plot and drops the draft\./);
    assert.equal(screen.queryByRole("button", { name: "Save" }), null);
    await click(screen.getByRole("button", { name: "Reload" }));
    await settle();
    assert.deepEqual(ids(), ["theirs"]);
    assert.ok(draftWrites().includes("DELETE /api/stageplots/plots/p-1/draft"), writes().join(", "));
    assert.deepEqual(DRAFTS, []);
  });

  test("a draft the server cannot take turns the banner red, is tried again, and is kept once it can", async () => {
    DRAFTS_DOWN = true;
    await mount();
    await addFromPalette("box");
    await until(() => /could not be kept/.test(document.body.textContent!), "the store to fail");
    assert.match(document.body.textContent!, /The draft could not be kept \(the server did not answer\); leaving now loses it\. Trying again\./);
    DRAFTS_DOWN = false;
    await until(() => DRAFTS.length === 1, "the retry to keep it");
    assert.deepEqual(DRAFTS.map((d) => d.plotId), ["p-1"]);
    assert.ok(screen.getByTestId("draft-kept"));
  });

  test("a failed read of the drafts holds the editor rather than store over one it has not seen", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input), "http://x").pathname === "/api/stageplots/drafts") throw new TypeError("Failed to fetch");
      return real(input, init);
    }) as typeof fetch;
    try {
      await mount();
      assert.match(document.body.textContent!, /Couldn't read the unsaved drafts/);
      assert.equal(screen.queryByTestId("canvas"), null);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("leaving asks only while the newest change has not reached the server", async () => {
    const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } = await import("@tanstack/react-router");
    const root = createRootRoute({ component: () => React.createElement(React.Fragment, null, React.createElement(Outlet), React.createElement(ConfirmHost)) });
    const edit = createRoute({ getParentRoute: () => root, path: "/stageplots/edit", component: () => React.createElement(StagePlotsEdit, { openPdf: fakePdf }) });
    const list = createRoute({ getParentRoute: () => root, path: "/stageplots", component: () => React.createElement("p", null, "the list") });
    const router = createRouter({ routeTree: root.addChildren([edit, list]), history: createMemoryHistory({ initialEntries: ["/stageplots/edit"] }) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () => {
      await act(async () => {
        render(React.createElement(QueryClientProvider, { client }, React.createElement(RouterProvider, { router } as never)));
      });
    });
    for (let i = 0; i < 4; i++) await settle();
    const leave = async () => {
      await act(async () => void router.navigate({ to: "/stageplots" } as never));
      for (let i = 0; i < 3; i++) await settle();
    };
    // The newest change not kept, and the server not answering: it asks; Cancel stays.
    DRAFTS_DOWN = true;
    await addFromPalette("box");
    await leave();
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent!, /have not reached the server/);
    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    assert.equal(router.state.location.pathname, "/stageplots/edit");
    // The server back: the change is kept on the way out, and nothing asks.
    DRAFTS_DOWN = false;
    await leave();
    assert.equal(screen.queryByRole("alertdialog"), null, "it asked although the change could be kept");
    assert.equal(router.state.location.pathname, "/stageplots");
    assert.deepEqual(DRAFTS.map((d) => d.plotId), ["p-1"]);
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
    DOC.venues.push({ id: "v-2", name: "Room Two", slug: null, oldSlugs: [], kind: "home", notes: "", plotIds: ["p-9"], defaultPlotId: "p-9" });
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

  // This runs use-patch uncompiled. The build's React Compiler memoises its read callback by
  // what the callback reads, so a dependency the callback does not use is dropped there and
  // nowhere here: that case is checked by driving the built app in a browser (see use-patch.ts).
  test("an unreadable patch is read again on its own, with no save, and the point follows it once it answers", async () => {
    const was = { ...PATCH_REREAD };
    Object.assign(PATCH_REREAD, { firstMs: 20, maxMs: 40 });
    try {
      PATCH_DOWN = true;
      await linkedOnServer();
      assert.match(screen.getByTestId("link-lost").textContent!, /patch sheet unavailable/);
      // Failed reads again, on the backoff, still unavailable and never blank.
      await act(async () => new Promise((r) => setTimeout(r, 90)));
      assert.match(screen.getByTestId("link-lost").textContent!, /patch sheet unavailable/);
      // A read again still on its way shows the last answer, not "Reading the patch sheet…".
      let answer!: () => void;
      PATCH_HOLD = new Promise((resolve) => (answer = resolve));
      await act(async () => new Promise((r) => setTimeout(r, 90)));
      assert.match(screen.getByTestId("link-lost").textContent!, /patch sheet unavailable/, "a read again in flight blanked the last answer");
      PATCH_DOWN = false;
      PATCH_HOLD = null;
      answer();
      await act(async () => new Promise((r) => setTimeout(r, 120)));
      await settle();
      assert.ok(screen.getByTestId("link-on"), "the point did not follow the patch once it could be read");
    } finally {
      Object.assign(PATCH_REREAD, was);
    }
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
