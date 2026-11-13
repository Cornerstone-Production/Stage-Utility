// stageplots.test.ts — a venue's stage plots on the Worker: what the publisher may put
// under a secret, what a visitor with the secret gets, and what everyone else gets,
// which is exactly what a path the Worker does not know gets.
//
// The real request handler against the in-memory hub, as handle.test.ts runs it. What
// only workerd does (the SQLite table, a 2 MB row) is in test/worker.integration.test.ts.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, mock, test } from "node:test";

import { PUBLISH_MAX_BODY_BYTES, PUBLISH_MIN_TOKEN_LENGTH, STAGEPLOTS_MAX_KEYS } from "../../../main/types/servicecue-publish.js";
import { handle, type HandlerDeps } from "./handle.js";
import { MemoryHub } from "./memory-hub-harness.js";

const TOKEN = "t".repeat(PUBLISH_MIN_TOKEN_LENGTH + 8);
const ORIGIN = "https://servicecue.example.workers.dev";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const VIEWER = "<!doctype html><title>stage plots</title>";

/** A secret as the server makes one. */
const secret = () => randomBytes(32).toString("base64url");
/** The smallest file that says it is a WebP: RIFF, a size, WEBP. */
const webp = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  return bytes;
};

function setup(over: Partial<HandlerDeps> = {}) {
  const hub = new MemoryHub();
  const assets: HandlerDeps["assets"] = async (request) => {
    const path = new URL(request.url).pathname;
    if (path !== "/stageplots.html") return new Response("missing", { status: 404 });
    return new Response(request.method === "HEAD" ? null : VIEWER, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  };
  const deps: HandlerDeps = { hub, upgrade: async () => new Response(null, { status: 501 }), assets, token: TOKEN, now: () => 5_000_000, ...over };
  const run = (method: string, path: string, init: { headers?: Record<string, string>; body?: BodyInit | null } = {}) =>
    handle(new Request(`${ORIGIN}${path}`, { method, headers: init.headers, body: init.body ?? null, duplex: "half" } as RequestInit), deps);
  const put = (s: string, key: string, body: BodyInit, type = "application/json") =>
    run("PUT", `/_publish/v1/stageplots/${s}/${key}`, { headers: { ...AUTH, "Content-Type": type }, body });
  return { hub, run, put };
}

/** Everything a response says: status, every header but Date, and the body bytes. */
async function whole(res: Response): Promise<{ status: number; headers: [string, string][]; body: string }> {
  const headers = [...res.headers].filter(([name]) => name !== "date").sort(([a], [b]) => a.localeCompare(b));
  return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()).toString("base64") };
}

async function publishVenue(s: ReturnType<typeof setup>, sec: string) {
  assert.equal((await s.put(sec, "image/0123456789abcdef", webp(), "image/webp")).status, 204);
  assert.equal((await s.put(sec, "plot/p-1", JSON.stringify({ id: "p-1", name: "Standard", items: [] }))).status, 204);
  assert.equal((await s.put(sec, "index", JSON.stringify({ venue: { name: "Main room" } }))).status, 204);
}

describe("a published venue", () => {
  test("is served at its secret: the page, its index, each plot and each background", async () => {
    const s = setup();
    const sec = secret();
    await publishVenue(s, sec);

    const page = await s.run("GET", `/stageplots/${sec}`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), VIEWER);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal((await s.run("GET", `/stageplots/${sec}/`)).status, 200, "one trailing slash is the same page");

    const index = await s.run("GET", `/stageplots/${sec}/index`);
    assert.equal(index.status, 200);
    assert.deepEqual(await index.json(), { venue: { name: "Main room" } });
    assert.equal(index.headers.get("cache-control"), "no-store");

    const plot = await s.run("GET", `/stageplots/${sec}/plot/p-1`);
    assert.deepEqual(await plot.json(), { id: "p-1", name: "Standard", items: [] });

    const image = await s.run("GET", `/stageplots/${sec}/image/0123456789abcdef`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/webp");
    // Never a shared cache: one would go on serving a background after it was taken down.
    assert.equal(image.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), webp());

    assert.equal((await s.run("HEAD", `/stageplots/${sec}/index`)).status, 200);
  });

  test("is in no status answer, and its writes name nothing on publish:docs", async () => {
    const s = setup();
    const sec = secret();
    await publishVenue(s, sec);
    const status = (await (await s.run("GET", "/_publish/v1/status", { headers: AUTH })).json()) as { docs: string[]; assets: string[] };
    assert.deepEqual(status.docs, []);
    assert.deepEqual(status.assets, []);
    assert.deepEqual(s.hub.calls, [], "a StagePlots write went through the docs, which tell every viewer its key");
    assert.equal(JSON.stringify(status).includes(sec), false);
  });

  test("survives the ServiceCue manifest, which deletes every doc and asset it does not name", async () => {
    const s = setup();
    const sec = secret();
    await publishVenue(s, sec);
    const r = await s.run("PUT", "/_publish/v1/manifest", { headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ docs: [], assets: [] }) });
    assert.equal(r.status, 200);
    assert.equal((await s.run("GET", `/stageplots/${sec}/index`)).status, 200);
  });
});

describe("what everyone without a published secret gets", () => {
  /** The generic 404: a path nothing on the Worker answers. */
  const generic = async (s: ReturnType<typeof setup>, method: string) => whole(await s.run(method, "/nothing-here"));

  test("an unknown secret, a short secret, a malformed key and ../ are the generic 404, byte for byte", async () => {
    const s = setup();
    const published = secret();
    await publishVenue(s, published);
    const paths = [
      `/stageplots/${secret()}`,
      `/stageplots/${secret()}/`,
      `/stageplots/${secret()}/index`,
      `/stageplots/${secret()}/plot/p-1`,
      `/stageplots/${secret()}/image/0123456789abcdef`,
      `/stageplots/${published.slice(0, 42)}`,
      `/stageplots/${published.slice(0, 42)}/index`,
      `/stageplots/${published}x/index`,
      // 43 characters, but the last carries bits a 32-byte secret cannot have.
      `/stageplots/${published.slice(0, 42)}B/index`,
      `/stageplots/${published}/index/`,
      `/stageplots/${published}/plot/`,
      `/stageplots/${published}/plot/p-1/extra`,
      `/stageplots/${published}/image/0123456789ABCDEF`,
      `/stageplots/${published}/image/0123456789abcde`,
      `/stageplots/${published}/manifest`,
      `/stageplots/${published}/..%2findex`,
      `/stageplots/${published}%2findex`,
      `/stageplots/${published}//index`,
      `/stageplots/../stageplots/${secret()}/index`,
      `/stageplots/${secret()}/../index`,
      `/stageplots/${secret()}/%2e%2e/index`,
      "/stageplots",
      "/stageplots/",
      "/stageplots/index",
      "/stageplots.html",
    ];
    for (const method of ["GET", "HEAD"]) {
      const expected = await generic(s, method);
      assert.equal(expected.status, 404);
      for (const path of paths) assert.deepEqual(await whole(await s.run(method, path)), expected, `${method} ${path}`);
    }
  });

  test("another method is the generic 404 whether or not the secret is published", async () => {
    const s = setup();
    const published = secret();
    await publishVenue(s, published);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const expected = await generic(s, method);
      for (const path of [`/stageplots/${published}`, `/stageplots/${published}/index`, `/stageplots/${secret()}/index`]) {
        assert.deepEqual(await whole(await s.run(method, path)), expected, `${method} ${path}`);
      }
    }
  });

  test("a deleted secret is the generic 404, and so is every key it held", async () => {
    const s = setup();
    const sec = secret();
    await publishVenue(s, sec);
    assert.equal((await s.run("DELETE", `/_publish/v1/stageplots/${sec}`, { headers: AUTH })).status, 204);
    for (const method of ["GET", "HEAD"]) {
      const expected = await generic(s, method);
      for (const path of [`/stageplots/${sec}`, `/stageplots/${sec}/index`, `/stageplots/${sec}/plot/p-1`, `/stageplots/${sec}/image/0123456789abcdef`]) {
        assert.deepEqual(await whole(await s.run(method, path)), expected, `${method} ${path}`);
      }
    }
    assert.equal(s.hub.stageplots.size, 0, "something under the secret survived its delete");
  });

  test("a secret holding plots but no index yet has no page", async () => {
    const s = setup();
    const sec = secret();
    await s.put(sec, "plot/p-1", "{}");
    assert.deepEqual(await whole(await s.run("GET", `/stageplots/${sec}`)), await generic(s, "GET"));
  });
});

describe("what the publisher may put", () => {
  test("an unauthenticated or wrong-token PUT is refused and stores nothing", async () => {
    const s = setup();
    const sec = secret();
    for (const headers of [{}, { Authorization: "Bearer not-the-token-not-the-token-not" }] as Record<string, string>[]) {
      const r = await s.run("PUT", `/_publish/v1/stageplots/${sec}/index`, { headers: { ...headers, "Content-Type": "application/json" }, body: "{}" });
      assert.equal(r.status, 401);
      const d = await s.run("DELETE", `/_publish/v1/stageplots/${sec}`, { headers });
      assert.equal(d.status, 401);
    }
    assert.equal(s.hub.stageplots.size, 0);
  });

  test("an image over the cap is refused with 413, and one that is not a WebP with 415 or 400", async () => {
    const s = setup();
    const sec = secret();
    assert.equal((await s.put(sec, "image/0123456789abcdef", webp(PUBLISH_MAX_BODY_BYTES + 1), "image/webp")).status, 413);
    assert.equal((await s.put(sec, "image/0123456789abcdef", webp(), "image/png")).status, 415);
    assert.equal((await s.put(sec, "image/0123456789abcdef", new Uint8Array(64), "image/webp")).status, 400);
    assert.equal((await s.put(sec, "image/0123456789abcdef", new Uint8Array(0), "image/webp")).status, 400);
    assert.equal(s.hub.stageplots.size, 0);
    assert.equal((await s.put(sec, "image/0123456789abcdef", webp(PUBLISH_MAX_BODY_BYTES), "image/webp")).status, 204, "a background at the cap is taken");
  });

  test("a doc must be a JSON object under the cap", async () => {
    const s = setup();
    const sec = secret();
    for (const body of ["[]", "null", "not json", '"text"']) assert.equal((await s.put(sec, "index", body)).status, 400, body);
    assert.equal((await s.put(sec, "plot/p-1", `{"x":"${"a".repeat(PUBLISH_MAX_BODY_BYTES)}"}`)).status, 413);
    assert.equal(s.hub.stageplots.size, 0);
  });

  test("a well-formed request is never answered 404, so a 404 means a Worker that does not know StagePlots", async () => {
    const s = setup();
    const sec = secret();
    for (const [method, path] of [
      ["PUT", `/_publish/v1/stageplots/short/index`],
      ["PUT", `/_publish/v1/stageplots/${sec}/nope`],
      ["PUT", `/_publish/v1/stageplots/${sec}/plot/bad.id`],
      ["PUT", `/_publish/v1/stageplots/${sec}/image/XYZ`],
      ["DELETE", `/_publish/v1/stageplots/short`],
    ] as const) {
      const r = await s.run(method, path, { headers: { ...AUTH, "Content-Type": "application/json" }, body: method === "PUT" ? "{}" : null });
      assert.equal(r.status, 400, `${method} ${path}`);
    }
    const wrong = await s.run("POST", `/_publish/v1/stageplots/${sec}/index`, { headers: AUTH });
    assert.equal(wrong.status, 405);
  });

  test("one secret holds at most STAGEPLOTS_MAX_KEYS; a key it holds can still be replaced", async () => {
    const s = setup();
    const sec = secret();
    for (let i = 0; i < STAGEPLOTS_MAX_KEYS; i++) assert.equal((await s.put(sec, `plot/p-${i}`, "{}")).status, 204);
    assert.equal((await s.put(sec, "plot/one-more", "{}")).status, 409);
    assert.equal((await s.put(sec, "plot/p-0", '{"again":true}')).status, 204);
    assert.equal((await s.put(secret(), "index", "{}")).status, 204, "the cap is per secret");
  });

  test("keep removes every key under the secret that it does not name, and nothing under another", async () => {
    const s = setup();
    const sec = secret();
    const other = secret();
    await publishVenue(s, sec);
    await publishVenue(s, other);
    const r = await s.run("PUT", `/_publish/v1/stageplots/${sec}`, { headers: { ...AUTH, "Content-Type": "application/json" }, body: JSON.stringify({ keys: ["index"] }) });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { removed: ["image/0123456789abcdef", "plot/p-1"] });
    assert.equal((await s.run("GET", `/stageplots/${sec}/plot/p-1`)).status, 404);
    assert.equal((await s.run("GET", `/stageplots/${other}/plot/p-1`)).status, 200);
    for (const body of ['{"keys":["nope"]}', '{"keys":"index"}', "[]"]) {
      const bad = await s.run("PUT", `/_publish/v1/stageplots/${sec}`, { headers: { ...AUTH, "Content-Type": "application/json" }, body });
      assert.equal(bad.status, 400, body);
    }
  });

  test("a delete of one key takes that key only", async () => {
    const s = setup();
    const sec = secret();
    await publishVenue(s, sec);
    assert.equal((await s.run("DELETE", `/_publish/v1/stageplots/${sec}/plot/p-1`, { headers: AUTH })).status, 204);
    assert.equal((await s.run("GET", `/stageplots/${sec}/plot/p-1`)).status, 404);
    assert.equal((await s.run("GET", `/stageplots/${sec}/index`)).status, 200);
  });
});

describe("the Worker's own log", () => {
  test("names no secret when a StagePlots request fails", async () => {
    const sec = secret();
    const broken = new MemoryHub();
    broken.getStagePlot = async () => {
      throw new Error("storage fell over");
    };
    broken.putStagePlot = async () => {
      throw new Error("storage fell over on a write");
    };
    const s = setup({ hub: broken });
    const lines: string[] = [];
    const spy = mock.method(console, "error", (...args: unknown[]) => void lines.push(args.map(String).join(" ")));
    try {
      assert.equal((await s.run("GET", `/stageplots/${sec}/index`)).status, 500);
      // The publisher's side too: its paths carry the secret as well.
      assert.equal((await s.run("PUT", `/_publish/v1/stageplots/${sec}/index`, { headers: { ...AUTH, "Content-Type": "application/json" }, body: "{}" })).status, 500);
    } finally {
      spy.mock.restore();
    }
    assert.equal(lines.length, 2, `each failure was not logged once: ${lines.join(" / ")}`);
    for (const line of lines) assert.equal(line.includes(sec), false, line);
  });
});
