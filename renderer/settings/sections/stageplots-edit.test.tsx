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
  };
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
  if (method === "PATCH" && (m = /^\/api\/stageplots\/plots\/([^/]+)$/.exec(path))) {
    const p = DOC.plots.find((x) => x.id === m![1])!;
    Object.assign(p, body, { version: p.version + 1 });
    return { status: 200, json: p };
  }
  return { status: 404, json: { error: `the fake has no ${method} ${path}` } };
}

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost");
  const method = init?.method ?? "GET";
  let status = 200;
  let json: unknown = DOC;
  if (!u.pathname.startsWith("/api/stageplots")) return { ok: true, status: 200, statusText: "OK", json: async () => ({}), text: async () => "{}" };
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
const { __resetReplayCacheForTests: resetReplayCache } = await import("../../lib/api.js");

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

async function mount() {
  await act(async () => {
    render(React.createElement(StagePlotsEdit, { openPdf: fakePdf }));
  });
  await settle();
  await settle();
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
});
after(() => unmountAndTeardown(cleanup, teardown));

describe("/stageplots/edit", () => {
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
