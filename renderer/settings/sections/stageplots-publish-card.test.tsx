// The editor's Publish card, every state and both confirms, with the wording of the
// approved mockup (section 5), against a fake of the four publish routes and the
// Public link settings the card reads its host from.
//
// What is NOT here: the copy on a real plain-HTTP page, and how the link is cut short,
// are driven in a browser. jsdom has a document.execCommand that does nothing and no
// layout, so only the fallback's choice (a selected field holding the whole link) is
// checked here, not that a person can copy from it; and it measures no width, so that a
// long host truncates while "/stageplots/q7Hk2v…Hk2E" stays whole is a screenshot, not a test.
//
// Every name below is invented. This is a public repository.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { PendingRemovalView, Venue, VenuePublish } from "@main/types/stageplots";

import { installRenderDom, settle } from "../../test-dom.js";

installRenderDom();

const ORIGIN = "https://plots.example.workers.dev";
const SECRET = "A".repeat(42) + "E";

let VENUE: Venue;
let PENDING: PendingRemovalView[] = [];
/** What GET /api/servicecue/publish answers. */
let SETTINGS: { url: string; token: string } = { url: ORIGIN, token: "••••" };
let sent: string[] = [];
/** The next publish call answers this status and error instead. */
let refuse: { status: number; error: string } | null = null;
/** A notice the next successful call carries beside the venue. */
let notice: string | null = null;
/** What the server says following the last Public link save could not do (StagePlotsView.notice). */
let FOLLOW: { at: string; message: string } | undefined;

function published(extra: Partial<VenuePublish> = {}): VenuePublish {
  return {
    secret: SECRET,
    origin: ORIGIN,
    publishedAt: "2026-11-12T20:32:00.000Z",
    lastError: null,
    publishedImages: [],
    unpublishedImages: [],
    ...extra,
  };
}

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url), "http://localhost");
  const method = init?.method ?? "GET";
  let status = 200;
  let json: unknown = {};
  if (u.pathname === "/api/servicecue/publish") json = { enabled: false, ...SETTINGS };
  else if (method === "POST" && u.pathname === "/api/stageplots/pending/remove") {
    sent.push(`${method} ${u.pathname}`);
    const here = PENDING.filter((e) => e.origin === ORIGIN).length;
    PENDING = PENDING.filter((e) => e.origin !== ORIGIN);
    json = { removed: here, left: 0, waiting: PENDING.length };
  }
  else if (method === "POST" && /^\/api\/stageplots\/venues\/[^/]+\/(publish|regenerate|unpublish|publish-now)$/.test(u.pathname)) {
    sent.push(`${method} ${u.pathname}`);
    if (refuse) {
      ({ status } = refuse);
      json = { error: refuse.error };
      refuse = null;
    } else {
      const action = u.pathname.split("/").pop();
      VENUE = action === "unpublish" ? { ...VENUE, publish: undefined } : { ...VENUE, publish: published() };
      json = notice ? { ...VENUE, notice } : VENUE;
      notice = null;
    }
  }
  return { ok: status < 300, status, statusText: String(status), json: async () => json, text: async () => JSON.stringify(json) };
};

const { render, cleanup, screen, fireEvent } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PublishCard, PendingLinksCard, shortSecret } = await import("./stageplots-publish-card.js");
const { ConfirmHost } = await import("../../components/ui/confirm-dialog.js");
const { setDisplayHourCycle } = await import("../../lib/clock-format.js");

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const save = async <T,>(fn: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  };
  const view = () =>
    React.createElement(
      QueryClientProvider,
      { client },
      VENUE.id === "none"
        ? React.createElement(PendingLinksCard, { pending: PENDING, save, notice: FOLLOW, timeZone: "America/Chicago" })
        : React.createElement(PublishCard, { venue: VENUE, pending: PENDING, save, timeZone: "America/Chicago", follow: FOLLOW }),
      React.createElement(ConfirmHost),
    );
  let rerender!: (ui: React.ReactElement) => void;
  await act(async () => {
    ({ rerender } = render(view()));
  });
  for (let i = 0; i < 3; i++) await settle();
  return { refresh: async () => act(async () => rerender(view())) };
}

async function click(el: Element) {
  await act(async () => {
    fireEvent.click(el);
  });
  for (let i = 0; i < 3; i++) await settle();
}

const card = () => screen.getByRole("region", { name: "Publish" });
const text = () => card().textContent ?? "";

beforeEach(() => {
  VENUE = { id: "v-1", name: "Room One", kind: "home", notes: "", plotIds: [], defaultPlotId: null };
  SETTINGS = { url: ORIGIN, token: "••••" };
  sent = [];
  refuse = null;
  notice = null;
  PENDING = [];
  FOLLOW = undefined;
  setDisplayHourCycle("24h");
});
afterEach(async () => {
  cleanup();
  await settle();
});

describe("the Publish card, off", () => {
  test("explains publishing in the mockup's words and publishes on its button", async () => {
    const m = await mount();
    assert.equal(screen.getByTestId("publish-pill").textContent, "Off");
    assert.match(text(), /Put Room One on plots\.example\.workers\.dev behind a secret link\. Anyone with the link can view its plots, read-only\. Nothing lists it\./);
    await click(screen.getByRole("button", { name: "Publish Room One" }));
    assert.deepEqual(sent, ["POST /api/stageplots/venues/v-1/publish"]);
    await m.refresh();
    assert.equal(screen.getByTestId("publish-pill").textContent, "Published");
  });

  test("a refusal is shown beside the button, and the plots are said to be saved", async () => {
    await mount();
    refuse = { status: 502, error: "plots.example.workers.dev does not know StagePlots yet: deploy the Worker." };
    await click(screen.getByRole("button", { name: "Publish Room One" }));
    assert.match(screen.getByRole("alert").textContent ?? "", /^plots\.example\.workers\.dev does not know StagePlots yet: deploy the Worker\. Your plots are saved here\.$/);
    assert.equal(screen.getByTestId("publish-pill").textContent, "Off");
  });

  test("with no page address or token, the button is off and the card says where to set them", async () => {
    SETTINGS = { url: "", token: "" };
    await mount();
    assert.equal((screen.getByRole("button", { name: "Publish Room One" }) as HTMLButtonElement).disabled, true);
    assert.match(text(), /Set up the public link first, in Settings > Advanced > Public link\./);
    assert.equal(screen.getByRole("link", { name: "Settings > Advanced > Public link" }).getAttribute("href"), "/settings/advanced/public-link");
  });
});

describe("the Publish card, published", () => {
  test("shows when it was last published, in the app's zone, and the link cut short with the whole of it on hover", async () => {
    VENUE.publish = published();
    await mount();
    assert.equal(screen.getByTestId("publish-pill").textContent, "Published");
    assert.match(text(), /Last publishedThu 12 Nov, 14:32/);
    assert.equal(screen.getByTestId("publish-link").textContent, `plots.example.workers.dev/stageplots/${shortSecret(SECRET)}`);
    assert.equal(shortSecret(SECRET), "AAAAAA…AAAE");
    assert.equal(screen.getByTestId("publish-link").parentElement!.getAttribute("title"), `plots.example.workers.dev/stageplots/${SECRET}`);
    assert.equal(screen.queryByRole("alert"), null);
  });

  test("Copy writes the whole link where there is a clipboard", async () => {
    VENUE.publish = published();
    const wrote: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void wrote.push(t) } });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    try {
      await mount();
      await click(screen.getByRole("button", { name: "Copy link" }));
      assert.deepEqual(wrote, [`${ORIGIN}/stageplots/${SECRET}`]);
      assert.match(text(), /Copied\./);
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
      Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    }
  });

  test("on plain HTTP, with no clipboard and a copy command that does nothing, the whole link is put in a field and selected", async () => {
    VENUE.publish = published();
    delete (navigator as { clipboard?: unknown }).clipboard;
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    await mount();
    await click(screen.getByRole("button", { name: "Copy link" }));
    const field = screen.getByRole("textbox", { name: "Link" }) as HTMLInputElement;
    assert.equal(field.value, `${ORIGIN}/stageplots/${SECRET}`);
    assert.equal(document.activeElement, field, "the link was not focused for copying");
    assert.equal(field.selectionEnd! - field.selectionStart!, field.value.length, "the link was not selected whole");
    assert.match(text(), /Selected: press Ctrl\+C \(⌘C on a Mac\) to copy it\./);
  });

  test("Regenerate… asks in the mockup's words, does nothing on Cancel, and regenerates on its button", async () => {
    VENUE.publish = published();
    await mount();
    await click(screen.getByRole("button", { name: "Regenerate…" }));
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /Regenerate the link\?/);
    assert.match(dialog.textContent ?? "", /Room One is published under a new secret link\. The old link stops working as soon as the new one is up, so anyone using it will need the new one\./);
    await click(screen.getByRole("button", { name: "Cancel" }));
    assert.deepEqual(sent, []);
    await click(screen.getByRole("button", { name: "Regenerate…" }));
    await click(screen.getByRole("button", { name: "Regenerate link" }));
    assert.deepEqual(sent, ["POST /api/stageplots/venues/v-1/regenerate"]);
  });

  test("Unpublish… asks in the mockup's words, naming the host, and unpublishes on its button", async () => {
    VENUE.publish = published();
    const m = await mount();
    await click(screen.getByRole("button", { name: "Unpublish…" }));
    const dialog = screen.getByRole("alertdialog");
    assert.match(dialog.textContent ?? "", /Unpublish Room One\?/);
    assert.match(dialog.textContent ?? "", /Its page and backgrounds are removed from plots\.example\.workers\.dev and the link stops working\. The plots stay here\. Publishing again makes a new link\./);
    await click(screen.getByRole("button", { name: "Cancel" }));
    assert.deepEqual(sent, []);
    await click(screen.getByRole("button", { name: "Unpublish…" }));
    await click(screen.getByRole("button", { name: "Unpublish" }));
    assert.deepEqual(sent, ["POST /api/stageplots/venues/v-1/unpublish"]);
    await m.refresh();
    assert.equal(screen.getByTestId("publish-pill").textContent, "Off");
  });

  test("a notice the server sends with the answer stays on the card after it turns Off", async () => {
    VENUE.publish = published();
    const m = await mount();
    notice = "The copy published to old.example.workers.dev is left on old.example.workers.dev: this server has no token for that page any more.";
    await click(screen.getByRole("button", { name: "Unpublish…" }));
    await click(screen.getByRole("button", { name: "Unpublish" }));
    await m.refresh();
    assert.equal(screen.getByTestId("publish-pill").textContent, "Off");
    assert.match(text(), /left on old\.example\.workers\.dev: this server has no token for that page any more\./);
  });

  test("backgrounds not yet published are counted, and Publish now sends them", async () => {
    VENUE.publish = published({ unpublishedImages: ["0000000000000001", "0000000000000002"], publishedImages: [] });
    await mount();
    assert.match(text(), /2 backgrounds not yet published\. Publish now/);
    await click(screen.getByRole("button", { name: "Publish now" }));
    assert.deepEqual(sent, ["POST /api/stageplots/venues/v-1/publish-now"]);
  });

  test("the last error, with its time, says the plots are saved here", async () => {
    VENUE.publish = published({ lastError: { at: "2026-11-12T20:31:00.000Z", message: "plots.example.workers.dev did not answer (timed out after 10 s)." } });
    await mount();
    assert.equal(
      screen.getByRole("alert").textContent,
      "Last error 14:31: plots.example.workers.dev did not answer (timed out after 10 s). Your plots are saved here.",
    );
    // A failure with every background published still has a way to try again.
    assert.ok(screen.getByRole("button", { name: "Publish now" }));
  });
});

describe("old links still live", () => {
  const entry = (origin: string, reason: PendingRemovalView["reason"] = "regenerated"): PendingRemovalView => ({ origin, since: "2026-11-12T20:00:00.000Z", reason });

  test("are counted by page, and Remove now drains those on the page set up", async () => {
    VENUE.publish = published();
    PENDING = [entry(ORIGIN), entry(ORIGIN, "unpublished")];
    const m = await mount();
    assert.match(text(), /2 old links still live on plots\.example\.workers\.dev\./);
    await click(screen.getByRole("button", { name: "Remove now" }));
    assert.deepEqual(sent, ["POST /api/stageplots/pending/remove"]);
    await m.refresh();
    assert.equal(/old links? still live/.test(text()), false);
  });

  test("on a page that is not set up here say so, and offer nothing that cannot work", async () => {
    PENDING = [entry("https://old.example.workers.dev", "address changed")];
    await mount();
    assert.match(text(), /1 old link still live on old\.example\.workers\.dev\. Set that page up again to remove it\./);
    assert.equal(screen.queryByRole("button", { name: "Remove now" }), null);
  });

  test("show with no venue selected, so a deleted venue's link is never out of sight", async () => {
    VENUE = { ...VENUE, id: "none" };
    PENDING = [entry(ORIGIN, "venue deleted")];
    await mount();
    assert.match(text(), /1 old link still live on plots\.example\.workers\.dev\./);
    assert.ok(screen.getByRole("button", { name: "Remove now" }));
  });
});

describe("what following a page address could not do", () => {
  const FAILED = { at: "2026-11-13T15:04:00.000Z", message: "The old links on old.example.workers.dev could not be removed with its token." };

  test("shows on the card with a venue selected, never read as success", async () => {
    VENUE.publish = published();
    FOLLOW = FAILED;
    await mount();
    assert.match(screen.getByTestId("follow-notice").textContent ?? "", /^Page address saved 09:04: The old links on old\.example\.workers\.dev could not be removed with its token\.$/);
  });

  test("shows with no venue selected, even with no old links waiting", async () => {
    VENUE = { ...VENUE, id: "none" };
    FOLLOW = FAILED;
    await mount();
    assert.ok(card());
    assert.match(screen.getByTestId("follow-notice").textContent ?? "", /could not be removed with its token/);
  });

  test("is not shown when the follow did all of it", async () => {
    VENUE = { ...VENUE, id: "none" };
    await mount();
    assert.equal(screen.queryByTestId("follow-notice"), null);
  });
});
