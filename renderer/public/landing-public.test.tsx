// The public page's landing page, as a visitor opening the page's own address sees it: the
// ServiceCue card, and the Stage plots card naming each listed venue with its plot count,
// each opening through its own secret link. It reads /api/landing and nothing else.
//
// jsdom loads no stylesheet and measures nothing, so the two-column grid that folds to one on
// a phone, and both themes, are driven in a browser, not here.
//
// Every name below is invented. This is a public repository.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { installRenderDom, settle } from "../test-dom.js";

installRenderDom();
(window as unknown as Record<string, unknown>).matchMedia = (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const A = `${"a".repeat(42)}A`;
const B = `${"b".repeat(42)}E`;
let LIST: unknown;
let STATUS = 200;
/** The request never answers ("network"), or answers with a body that is not JSON ("body"). */
let BREAK: "network" | "body" | null = null;
let asked: string[] = [];

(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  asked.push(new URL(String(url), "https://plots.example.workers.dev").pathname);
  if (BREAK === "network") throw new TypeError("Failed to fetch");
  const json = async () => {
    if (BREAK === "body") throw new SyntaxError("Unexpected token < in JSON");
    return LIST;
  };
  return { ok: STATUS < 300, status: STATUS, json, text: async () => JSON.stringify(LIST) };
};

const { render, cleanup, screen } = await import("@testing-library/react");
const React = (await import("react")).default;
const { act } = await import("react");
const { LandingPublicPage } = await import("./landing-public-page.js");

async function mount() {
  await act(async () => {
    render(React.createElement(LandingPublicPage));
  });
  for (let i = 0; i < 4; i++) await settle();
}

beforeEach(() => {
  LIST = { venues: [{ name: "Main Auditorium", secret: A, plots: 3 }, { name: "Youth Room", secret: B, plots: 1 }] };
  STATUS = 200;
  BREAK = null;
  asked = [];
});
afterEach(() => cleanup());

describe("the landing page", () => {
  test("offers ServiceCue, and each listed venue through its own link, with its plot count", async () => {
    await mount();
    assert.deepEqual(asked, ["/api/landing"]);
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Welcome");
    assert.equal(screen.getByRole("link", { name: /ServiceCue/ }).getAttribute("href"), "/servicecue");
    const venues = screen.getAllByRole("link").filter((a) => a.getAttribute("href")!.startsWith("/stageplots/"));
    assert.deepEqual(
      venues.map((a) => [a.getAttribute("href"), a.textContent]),
      [
        [`/stageplots/${A}`, "Main Auditorium3 plots"],
        [`/stageplots/${B}`, "Youth Room1 plot"],
      ],
    );
  });

  test("draws nothing it was not given as a list: a list that is not one reads as a failure", async () => {
    LIST = { venues: [{ name: "Main Auditorium", secret: "javascript:alert(1)", plots: 3 }] };
    await mount();
    assert.equal(screen.getAllByRole("link").filter((a) => a.getAttribute("href")!.startsWith("/stageplots/")).length, 0);
    assert.match(document.body.textContent!, /The venues could not be loaded/);
  });

  test("a list it cannot read says so, and still offers ServiceCue", async () => {
    STATUS = 500;
    await mount();
    assert.match(document.body.textContent!, /The venues could not be loaded\. Try again in a moment\./);
    assert.ok(screen.getByRole("link", { name: /ServiceCue/ }));
  });

  for (const broken of ["network", "body"] as const) {
    test(`no answer at all, or one that is not JSON, says so too (${broken})`, async () => {
      BREAK = broken;
      await mount();
      assert.match(document.body.textContent!, /The venues could not be loaded\. Try again in a moment\./, "the visitor was left on Loading");
      assert.ok(screen.getByRole("link", { name: /ServiceCue/ }));
    });
  }
});
