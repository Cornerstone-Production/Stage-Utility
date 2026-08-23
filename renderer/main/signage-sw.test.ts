// The offline worker, driven rather than read.
//
// public/signage-sw.js is plain JavaScript with no exports, because a service
// worker is fetched and run by the browser directly. So it is evaluated here
// against a stand-in `self`, `caches` and `fetch`, and its real handlers are
// called. Reading it as text would let a comment satisfy any of this.
//
// What is pinned is the rule that a navigation response is never taken for the
// shell. This app ships TWO shells — index.html for a display, app.html for the
// operator console — and the documented way to prepare a Pi is to open the
// Signage tab on that Pi. A worker that cached what it last saw navigate would
// therefore answer the next power cut with a settings page on the wall.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { describe, test } from "node:test";

const SRC = fs.readFileSync("public/signage-sw.js", "utf8");

/** The smallest Cache Storage that behaves like one. */
function makeCaches() {
  const stores = new Map<string, Map<string, string>>();
  const open = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    const s = store;
    return Promise.resolve({
      match: (req: unknown) => Promise.resolve(s.get(keyOf(req))),
      put: (req: unknown, res: { body: string }) => {
        s.set(keyOf(req), res.body);
        return Promise.resolve();
      },
      addAll: (urls: string[]) => {
        for (const u of urls) s.set(u, "shell");
        return Promise.resolve();
      },
    });
  };
  return {
    api: { open, keys: () => Promise.resolve([...stores.keys()]), delete: () => Promise.resolve(true) },
    stores,
  };
}

function keyOf(req: unknown): string {
  return typeof req === "string" ? req : (req as { url: string }).url;
}

interface Loaded {
  /** Fire a handler and return what it answered with, if anything. */
  fire: (type: string, event: Record<string, unknown>) => Promise<unknown[]>;
  stores: Map<string, Map<string, string>>;
  fetched: string[];
}

/** Evaluate the worker with a stand-in environment and return the handles. */
function loadWorker(fetchImpl: (req: unknown) => Promise<{ ok: boolean; body: string; clone: () => unknown }>): Loaded {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const { api, stores } = makeCaches();
  const fetched: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => listeners.set(type, fn),
    location: { origin: "http://kiosk.local" },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
  };
  const wrappedFetch = (req: unknown) => {
    fetched.push(keyOf(req));
    return fetchImpl(req);
  };
  new Function("self", "caches", "fetch", "console", SRC)(self, api, wrappedFetch, console);

  const fire = async (type: string, event: Record<string, unknown>) => {
    const fn = listeners.get(type);
    assert.ok(fn, `the worker registers no ${type} handler`);
    const answers: Promise<unknown>[] = [];
    const waits: Promise<unknown>[] = [];
    fn({
      ...event,
      respondWith: (p: Promise<unknown>) => answers.push(p.catch(() => undefined)),
      waitUntil: (p: Promise<unknown>) => waits.push(p.catch(() => undefined)),
    });
    await Promise.all(waits);
    return Promise.all(answers);
  };
  return { fire, stores, fetched };
}

const ok = (body: string) => ({ ok: true, body, clone: () => ({ ok: true, body }) });
const navigation = (url: string) => ({
  request: { method: "GET", url, mode: "navigate" },
});

describe("the offline worker", () => {
  test("guards the guard: the worker really evaluated and answers", async () => {
    // Every test below fires a handler. A source file that failed to evaluate,
    // or registered nothing, would make them all vacuous — and a handler that
    // declined every request would too, so the answer itself is asserted.
    const w = loadWorker(() => Promise.resolve(ok("KIOSK SHELL")));
    const [answer] = await w.fire("fetch", navigation("http://kiosk.local/display-8"));
    assert.equal((answer as { body: string }).body, "KIOSK SHELL");
  });

  test("a settings navigation is never taken for the shell", async () => {
    // The bug this exists for. Preparing a Pi means opening the Signage tab on
    // that Pi — an operator path, serving app.html — and the shell that had just
    // been cached for the wall was that page.
    const w = loadWorker(() => Promise.resolve(ok("OPERATOR CONSOLE")));
    await w.fire("install", {});
    await w.fire("fetch", navigation("http://kiosk.local/settings/signage"));

    const shell = [...w.stores.entries()].find(([name]) => name.startsWith("signage-shell"))?.[1];
    assert.ok(shell, "nothing was cached at install");
    assert.notEqual(
      shell.get("/index.html"),
      "OPERATOR CONSOLE",
      "the operator console was stored as the display's offline shell",
    );
  });

  test("a dead server answers a display navigation from the held shell", async () => {
    const w = loadWorker((req) =>
      keyOf(req).includes("/index.html")
        ? Promise.resolve(ok("KIOSK SHELL"))
        : Promise.reject(new Error("ECONNREFUSED")),
    );
    await w.fire("install", {});
    // The kiosk page asks for the shell to be refreshed — the only thing that
    // ever writes it, because only that page knows it is the kiosk.
    await w.fire("message", { data: { type: "signage:shell" } });
    await w.fire("fetch", navigation("http://kiosk.local/display-8"));

    const shell = [...w.stores.entries()].find(([name]) => name.startsWith("signage-shell"))?.[1];
    assert.equal(shell?.get("/index.html"), "KIOSK SHELL");
  });

  test("a device booting at its own /enroll URL is answered too", async () => {
    // A Pi never opens a display URL directly: it opens /enroll?device=… and is
    // redirected. With the server gone there is no redirect, so this is the only
    // navigation that happens — and it must not be a connection error.
    const w = loadWorker((req) =>
      keyOf(req).includes("/index.html")
        ? Promise.resolve(ok("KIOSK SHELL"))
        : Promise.reject(new Error("ECONNREFUSED")),
    );
    await w.fire("install", {});
    await w.fire("message", { data: { type: "signage:shell" } });

    const [answer] = await w.fire("fetch", {
      request: { method: "GET", url: "http://kiosk.local/enroll?device=abc", mode: "navigate" },
    });
    assert.equal(answer, "KIOSK SHELL", "a device booting offline got no shell");
  });

  test("the event stream is never cached", async () => {
    const w = loadWorker(() => Promise.resolve(ok("hello")));
    await w.fire("fetch", { request: { method: "GET", url: "http://kiosk.local/api/events" } });
    assert.equal(w.fetched.length, 0, "an /api request went through the worker");
  });
});
