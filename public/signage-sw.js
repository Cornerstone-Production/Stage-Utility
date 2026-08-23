// signage-sw.js — what makes a signage screen survive a reboot with no server.
//
// Everything else about offline signage is in the page: it holds a day's plan,
// prefetches its assets, and stops advancing when the stream drops. None of that
// helps if the page RELOADS, because the app shell itself comes from the server.
// This is the only piece that can answer that request without one.
//
// Deliberately plain JavaScript in public/ rather than a bundled module: a
// service worker is fetched and run by the browser directly, and a hashed build
// artifact would change name on every release, orphaning the registration.
//
// THE RULE THIS FILE LIVES BY: never serve a shell we have not successfully
// fetched at least once. A worker that installs a broken or half-downloaded app
// strands a screen on it, and there is nobody at the screen to clear a cache.

const VERSION = "v2";
const SHELL = `signage-shell-${VERSION}`;
const MEDIA = `signage-media-${VERSION}`;

/** The kiosk shell, and the ONLY document this worker ever serves offline.
 *
 *  Kept deliberately short — anything hashed is picked up by the runtime cache
 *  below, and listing hashed names here would break every build.
 *
 *  This app ships TWO shells: index.html is the kiosk, app.html is the operator
 *  console (see remote-server.tryServeStatic). They are different documents, and
 *  a display served the operator one is a display showing a settings page. */
const SHELL_URLS = ["/", "/index.html"];

/** The document a failed navigation is answered with. */
const SHELL_DOC = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // addAll rejects if ANY request fails, which is what we want: a partial
      // shell is worse than no worker at all.
      await cache.addAll(SHELL_URLS);
      // Take over as soon as this one is ready. A signage screen has no second
      // tab to close, so waiting for one would mean waiting for a reboot.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions, so an old shell cannot be served
      // after an update.
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHELL && k !== MEDIA).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Media is content-addressed and immutable, so a hit is always correct. */
function isMedia(url) {
  return url.pathname.startsWith("/signage-media/");
}

/** The built bundle: hashed names under /assets, plus the shell documents. */
function isShell(url) {
  return (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname.startsWith("/assets/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The event stream must never be cached or replayed — a display fed a stale
  // horizon would believe it was connected and act on hours-old content.
  if (url.pathname.startsWith("/api/")) return;

  if (isMedia(url)) {
    // Cache first. The name is a hash of the bytes, so a hit cannot be stale.
    event.respondWith(
      (async () => {
        const cache = await caches.open(MEDIA);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  // A NAVIGATION - the reload this whole file exists for.
  //
  // A display lives at its own path: /display-8, /foyer-north, whatever slug it
  // was given, and a kiosk device boots at /enroll and is redirected from there.
  // Matching a list of known shell paths misses every one of them, so the worker
  // declined to handle the request, the browser went to the dead network, and
  // the reload was a connection error. Which is precisely the failure this was
  // written to remove.
  //
  // Every navigation falls back to the kiosk shell instead. The kiosk is a
  // single page that routes on the path, so index.html is the right answer for
  // any of them - the same rule any SPA offline fallback uses.
  //
  // What it must NOT do is cache the response it got. Not every navigation is
  // the kiosk: /settings serves app.html, and /enroll on an unclaimed device
  // serves a server-rendered holding screen. Storing either as the shell means
  // the next power cut brings the wall up on a settings page. The documented way
  // to prepare a Pi is to open the Signage tab ON that Pi, so the operator path
  // was not a corner case - it was the workflow.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async (err) => {
        const cache = await caches.open(SHELL);
        // Match the DOCUMENT, not the request: nothing ever cached "/display-8"
        // itself, and matching on the request would miss.
        const hit = (await cache.match(SHELL_DOC)) ?? (await cache.match("/"));
        if (hit) return hit;
        throw err;
      }),
    );
    return;
  }

  if (isShell(url)) {
    // Network first, falling back to the cache. That ordering matters: the
    // screen should follow a deployed update rather than pin itself to whatever
    // it cached first, and the fallback is only reached when the server is
    // genuinely unreachable.
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        try {
          const res = await fetch(req);
          if (res.ok) await cache.put(req, res.clone());
          return res;
        } catch (err) {
          const hit = await cache.match(req);
          if (hit) return hit;
          // Nothing cached and no server: rethrow rather than answer with
          // something invented, so the failure is visible in the console rather
          // than looking like a blank page the app rendered on purpose.
          throw err;
        }
      })(),
    );
  }
});

// Refresh the held shell, asked for by a page that IS the kiosk shell.
//
// The alternative — caching whatever a navigation returned — is what shipped
// the operator console to a wall screen. The kiosk page knows what it is; the
// worker, looking at a URL, does not, and teaching it the server's route table
// would be a second copy of that table to keep in step.
//
// Fetched by URL rather than reusing a response, so what lands in the cache is
// the shell and nothing else.
async function refreshShell() {
  const res = await fetch(SHELL_DOC, { cache: "reload" });
  if (!res.ok) throw new Error(`shell refresh: ${res.status}`);
  const cache = await caches.open(SHELL);
  await cache.put(SHELL_DOC, res);
}

// The page asks for a set of assets to be held. Answers with what it actually
// holds, so "Prepare for offline" reports a fact rather than an intention.
self.addEventListener("message", (event) => {
  const msg = event.data;

  if (msg && msg.type === "signage:shell") {
    event.waitUntil(
      refreshShell().catch((err) => {
        // A screen with a stale shell still plays; one with none does not come
        // back at all. Either way the install-time copy stands, so this is
        // reported and not escalated.
        console.warn("[signage] could not refresh the offline shell:", err);
      }),
    );
    return;
  }

  if (!msg || msg.type !== "signage:precache") return;

  event.waitUntil(
    (async () => {
      const cache = await caches.open(MEDIA);
      let cached = 0;
      const failed = [];
      for (const url of msg.urls ?? []) {
        try {
          if (await cache.match(url)) {
            cached++;
            continue;
          }
          const res = await fetch(url);
          if (!res.ok) throw new Error(String(res.status));
          await cache.put(url, res.clone());
          cached++;
        } catch (err) {
          // Named, not counted. "30 of 34" tells an operator to try again;
          // naming the file tells them which one is broken.
          failed.push({ url, error: String(err) });
        }
      }
      const source = event.source ?? (await self.clients.matchAll())[0];
      source?.postMessage({
        type: "signage:precache-done",
        cached,
        total: (msg.urls ?? []).length,
        failed,
      });
    })(),
  );
});
