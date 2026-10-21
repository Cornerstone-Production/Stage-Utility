// public-mode.ts — the flag is the document's, and only one document has it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { installDom } from "../test-dom.js";

const teardown = installDom();
after(teardown);
afterEach(() => document.documentElement.removeAttribute("data-servicecue-public"));

const { PUBLIC_VIEWER_ATTRIBUTE, isPublicMode } = await import("./public-mode.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("isPublicMode", () => {
  test("is false in a document that does not carry the attribute, which is every operator document", () => {
    assert.equal(isPublicMode(), false);
  });

  test("is true in one that does, read at the moment of asking and not held", () => {
    document.documentElement.setAttribute(PUBLIC_VIEWER_ATTRIBUTE, "");
    assert.equal(isPublicMode(), true);
    document.documentElement.removeAttribute(PUBLIC_VIEWER_ATTRIBUTE);
    assert.equal(isPublicMode(), false);
  });

  test("is false where there is no document at all: a worker, a test harness, a server", () => {
    const g = globalThis as unknown as { document?: unknown };
    const real = g.document;
    delete g.document;
    try {
      assert.equal(isPublicMode(), false);
    } finally {
      g.document = real;
    }
  });
});

describe("the documents", () => {
  // Parsed, not searched: servicecue.html names the attribute in a comment, which a
  // search would take for the thing itself.
  const flagged = (file: string) => new JSDOM(readFileSync(path.join(ROOT, file), "utf8")).window.document.documentElement.hasAttribute(PUBLIC_VIEWER_ATTRIBUTE);

  // That servicecue.html carries it is asserted of the document the build writes
  // (scripts/servicecue-public-build.test.ts), once.
  test("app.html and index.html, the operator app and the kiosk, are not", () => {
    assert.equal(flagged("app.html"), false);
    assert.equal(flagged("index.html"), false);
  });

  test("nor is any other HTML document in the repository's own sources", () => {
    // public/control.html is the one other. A document that carried the attribute
    // would run the church's own pages as the public page.
    assert.equal(flagged("public/control.html"), false);
  });
});
