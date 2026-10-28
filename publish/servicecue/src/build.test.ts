// build.ts — which build of the page a deployment serves, and how the object is told.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { viewerBuildTag } from "../../../main/types/servicecue-publish.js";
import { BUILD_HEADER, __resetBuildNoticesForTests, buildOf, forObject, viewerBuild } from "./build.js";

const ORIGIN = new URL("https://servicecue.example.workers.dev/servicecue/weekend/audio?plan=1");
const ID = "0123456789ab";

/** Static assets holding one document, recording what was asked of them. */
function assetsHolding(body: string | null, status = 200) {
  const asked: string[] = [];
  const assets = async (request: Request) => {
    asked.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response(body, { status });
  };
  return { assets, asked };
}

/** What the Worker wrote to its log, one string per line. */
let log: string[] = [];
beforeEach(() => {
  log = [];
  mock.method(console, "warn", (...args: unknown[]) => void log.push(args.map(String).join(" ")));
});
afterEach(() => {
  mock.restoreAll();
  __resetBuildNoticesForTests();
});

describe("viewerBuild", () => {
  test("is the id the deployed document carries, asked for by the document's own name and not the visitor's path", async () => {
    const { assets, asked } = assetsHolding(`<!doctype html><html><head>${viewerBuildTag(ID)}</head></html>`);
    assert.equal(await viewerBuild(assets, ORIGIN), ID);
    assert.deepEqual(asked, ["GET /servicecue.html"]);
  });

  test("is null for a document with no id, a comment that names one, and a document that is not there", async () => {
    assert.equal(await viewerBuild(assetsHolding("<html><head></head></html>").assets, ORIGIN), null);
    assert.equal(await viewerBuild(assetsHolding(`<!-- ${viewerBuildTag(ID)} --><html></html>`).assets, ORIGIN), null);
    assert.equal(await viewerBuild(assetsHolding("missing", 404).assets, ORIGIN), null);
    assert.equal(await viewerBuild(assetsHolding('<meta name="servicecue-build" content="not-an-id" />').assets, ORIGIN), null);
  });

  test("says nothing on the log for a document that carries an id", async () => {
    const { assets } = assetsHolding(`<html><head>${viewerBuildTag(ID)}</head></html>`);
    for (let beat = 0; beat < 3; beat++) await viewerBuild(assets, ORIGIN);
    assert.deepEqual(log, []);
  });

  test("says once, on the Worker's log, that a document with no id means no open page will reload, however often it is asked", async () => {
    const { assets } = assetsHolding("<html><head></head></html>");
    for (let beat = 0; beat < 5; beat++) assert.equal(await viewerBuild(assets, ORIGIN), null);
    assert.equal(log.length, 1, `a heartbeat every 30 seconds would write a line every 30 seconds: ${log.join(" | ")}`);
    assert.match(log[0]!, /^\[servicecue-worker\] \/servicecue\.html carries no build id, so a page left open will not reload after a deploy$/);
  });

  test("says once that a deploy with no document in it tells no page which build is current, and names the status it answered", async () => {
    const { assets } = assetsHolding("missing", 404);
    for (let beat = 0; beat < 5; beat++) assert.equal(await viewerBuild(assets, ORIGIN), null);
    assert.equal(log.length, 1);
    assert.match(log[0]!, /^\[servicecue-worker\] \/servicecue\.html is not in this deploy \(HTTP 404\)/);
  });

  test("says each of the two things once: they are different faults", async () => {
    await viewerBuild(assetsHolding("missing", 404).assets, ORIGIN);
    await viewerBuild(assetsHolding("<html></html>").assets, ORIGIN);
    await viewerBuild(assetsHolding("missing", 404).assets, ORIGIN);
    await viewerBuild(assetsHolding("<html></html>").assets, ORIGIN);
    assert.equal(log.length, 2);
  });
});

describe("what the Worker tells the object", () => {
  const visitor = () =>
    new Request("https://servicecue.example.workers.dev/api/live", {
      headers: { Upgrade: "websocket", Origin: "https://servicecue.example.workers.dev", "X-Other": "kept" },
    });

  test("is the build id on the request, set by the Worker", () => {
    const forwarded = forObject(visitor(), ID);
    assert.equal(forwarded.headers.get(BUILD_HEADER), ID);
    assert.equal(buildOf(forwarded), ID);
  });

  test("leaves the rest of the request as it was", () => {
    const forwarded = forObject(visitor(), ID);
    assert.equal(forwarded.headers.get("upgrade"), "websocket");
    assert.equal(forwarded.headers.get("origin"), "https://servicecue.example.workers.dev");
    assert.equal(forwarded.headers.get("x-other"), "kept");
    assert.equal(forwarded.url, "https://servicecue.example.workers.dev/api/live");
    assert.equal(forwarded.method, "GET");
  });

  test("never carries a build id a visitor sent: the Worker's own, or none", () => {
    const forged = new Request("https://servicecue.example.workers.dev/api/live", { headers: { Upgrade: "websocket", [BUILD_HEADER]: "ffffffffffff" } });
    assert.equal(buildOf(forObject(forged, ID)), ID, "the visitor's id survived next to the Worker's");
    assert.equal(buildOf(forObject(forged, null)), null, "the visitor's id was passed on because the Worker had none");
    assert.equal(forObject(forged, null).headers.has(BUILD_HEADER), false);
  });

  test("is read back only if it is an id", () => {
    for (const value of ["", "short", "0123456789AB", "0123456789abc", "0123456789ab, 0123456789ab"]) {
      assert.equal(buildOf(new Request("https://x.example/", { headers: { [BUILD_HEADER]: value } })), null, value);
    }
    assert.equal(buildOf(new Request("https://x.example/")), null);
  });
});
