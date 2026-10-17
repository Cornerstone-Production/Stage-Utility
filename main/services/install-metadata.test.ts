// The two names an HTML document carries for a home-screen install, and the
// manifest, driven over the real documents.
//
// iOS reads apple-mobile-web-app-title from the HTML when the app is added, before
// any script runs, so the server has to put the operator's name there. The real
// index.html and app.html are used, not a snippet: a document that lost the tag, or
// grew a second one, would otherwise be a function that works on a string no page
// contains.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { JSDOM } from "jsdom";

import { brandHtml, buildManifest } from "./install-metadata.js";

const DOCS = ["index.html", "app.html"] as const;
const html = (doc: string) => readFileSync(new URL(`../../${doc}`, import.meta.url), "utf8");

function read(source: string) {
  const d = new JSDOM(source).window.document;
  return {
    titles: [...d.querySelectorAll('meta[name="apple-mobile-web-app-title"]')].map((m) => m.getAttribute("content")),
    pageTitle: d.title,
    pageTitles: d.querySelectorAll("title").length,
  };
}

describe("brandHtml over the real documents", () => {
  for (const doc of DOCS) {
    test(`${doc} carries the app name once in each place`, () => {
      const out = read(brandHtml(html(doc), "Chapel AV"));
      assert.deepEqual(out.titles, ["Chapel AV"]);
      assert.equal(out.pageTitle, "Chapel AV");
      assert.equal(out.pageTitles, 1);
    });

    test(`${doc} keeps every other tag`, () => {
      const before = html(doc);
      const after = brandHtml(before, "Chapel AV");
      const strip = (s: string) =>
        s.replace(/(name="apple-mobile-web-app-title" content=")[^"]*/, "$1").replace(/(<title>)[^<]*/, "$1");
      assert.equal(strip(after), strip(before), "only the two names may change");
    });

    test(`${doc} survives a name that looks like markup or a replacement pattern`, () => {
      for (const name of [`A "quoted" name`, "<b>bold</b> & more", "Costs $& and $1 and $$"]) {
        const out = read(brandHtml(html(doc), name));
        assert.deepEqual(out.titles, [name]);
        assert.equal(out.pageTitle, name);
        assert.equal(out.pageTitles, 1, `${JSON.stringify(name)} injected markup`);
      }
    });
  }
});

describe("buildManifest", () => {
  test("carries the app name as name and short_name", () => {
    const m = buildManifest("Chapel AV");
    assert.equal(m.name, "Chapel AV");
    assert.equal(m.short_name, "Chapel AV");
  });
});
