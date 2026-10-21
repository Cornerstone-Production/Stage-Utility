// routes.test.ts — which paths the Worker answers, and which it does not.
//
// The URLs here are written the way a client can send them and parsed with the
// same WHATWG URL the runtime uses, so a form the parser rewrites (a `..`
// segment, `%2e%2e`, a backslash) is judged as what it becomes — which is what the
// Worker sees too — and a form it leaves alone (`%2f`, `%5c`, `//`) is judged as sent.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PUBLIC_STATIC_FILES } from "../../../main/types/servicecue-publish.js";
import { isPublishArea, routePublic, routePublish } from "./routes.js";

const url = (path: string) => new URL(path, "https://servicecue.example.workers.dev");

/** `kind` of the route, or `reject:<status>`. */
const publicKind = (method: string, path: string): string => {
  const r = routePublic(method, url(path));
  return r.kind === "reject" ? `reject:${r.status}` : r.kind;
};
const publishKind = (method: string, path: string): string => {
  const r = routePublish(method, url(path));
  return r.kind === "reject" ? `reject:${r.status}` : r.kind;
};

describe("the viewer's addresses", () => {
  test("the landing page, and a rundown by name, by id, with any layout", () => {
    for (const ok of [
      "/servicecue",
      "/servicecue/",
      "/servicecue/weekend/audio",
      "/servicecue/weekend/audio/",
      "/servicecue/weekend/all-columns",
      "/servicecue/weekend/__all__",
      "/servicecue/12345/0c5a1e1e-77d1-4b0c-9a55-3f3f5a4f0b11",
      "/servicecue/the-gathering/id-lq2x4k-ab12cd34",
      "/servicecue/weekend/audio?plan=99&text=150&from=%2Fservicecue",
    ]) {
      assert.equal(publicKind("GET", ok), "viewer", ok);
    }
  });

  test("nothing else under /servicecue is a page", () => {
    for (const no of [
      "/servicecue/presets",
      "/servicecue/manage",
      "/servicecue/weekend",
      "/servicecue/weekend/audio/extra",
      "/servicecue/weekend/audio/extra/",
      "/servicecue//weekend/audio",
      "/servicecue/weekend//audio",
      "/servicecue/weekend/audio//",
      "/servicecue//",
      "/servicecuex",
      "/servicecue-old",
      "/ServiceCue",
      "/SERVICECUE/weekend/audio",
      "/scriptview/weekend/audio",
      "/index.html",
      "/servicecue.html",
      "/app.html",
    ]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
  });

  test("sends the bare address to the landing page, and takes only a read there", () => {
    assert.equal(publicKind("GET", "/"), "home");
    assert.equal(publicKind("HEAD", "/"), "home");
    assert.equal(publicKind("POST", "/"), "reject:405");
  });

  test("a segment is a slug or an id: letters, digits, underscore, dash", () => {
    for (const no of [
      "/servicecue/we.ekend/audio",
      "/servicecue/weekend/au%64io",
      "/servicecue/week%2fend/audio",
      "/servicecue/weekend%2faudio",
      "/servicecue/weekend/..%2fapi",
      "/servicecue/weekend/audio%2f",
      "/servicecue/weekend/a%5cb",
      "/servicecue/weekend/a%20b",
      "/servicecue/weekend/a b",
      `/servicecue/weekend/${"a".repeat(101)}`,
      "/servicecue/weekend/%e2%80%ae",
    ]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
  });

  test("a form the URL parser resolves is judged as what it resolves to, and so never reaches the page it climbs out of", () => {
    // `..` and `%2e%2e` are collapsed before the Worker sees them; the backslash is a
    // slash. What is left is an ordinary path, answered or refused like any other.
    assert.equal(url("/servicecue/weekend/../../assets/../servicecue.html").pathname, "/servicecue.html");
    assert.equal(publicKind("GET", "/servicecue/weekend/../../assets/../servicecue.html"), "reject:404");
    assert.equal(publicKind("GET", "/servicecue/weekend/%2e%2e/%2e%2e/api/log"), "reject:404");
    assert.equal(publicKind("GET", "/servicecue/%2e%2e/_publish/v1/status"), "reject:404", "and the publisher's area is not a public path");
    assert.equal(publicKind("GET", "/assets/..\\servicecue.html"), "reject:404");
    // One that resolves to an address the page does have is that page: climbing out
    // of /servicecue/weekend by `%2e%2e` lands on the landing page, nowhere else.
    assert.equal(url("/servicecue/weekend/%2e%2e").pathname, "/servicecue/");
    assert.equal(publicKind("GET", "/servicecue/weekend/%2e%2e"), "viewer");
  });
});

describe("the build's own files", () => {
  // The asset service answers these without the Worker (wrangler.jsonc names them, and
  // scripts/servicecue-public-build.test.ts holds that list to what the build writes). A
  // request for one that reaches the Worker anyway is for a path it does not name.
  test("are not routes: nothing the Worker names is a file", () => {
    for (const no of [
      ...PUBLIC_STATIC_FILES,
      "/assets",
      "/assets/",
      "/assets/servicecue-public-Dk3f9_x.js",
      "/assets/index-4f8a.css",
      "/assets/a/b.js",
      "/assets/..%2fservicecue.html",
      "/assets/%2e%2e%2fservicecue.html",
      "/favicon.ico",
      "/robots.txt",
      "/package.json",
      "/wrangler.jsonc",
      "/src/worker.ts",
      "/_headers",
    ]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
  });
});

describe("docs, images and the live pages", () => {
  test("a doc is served at the path it answers", () => {
    assert.deepEqual(routePublic("GET", url("/api/state")), { kind: "doc", key: "state" });
    assert.deepEqual(routePublic("GET", url("/api/plans/upcoming?days=60")), { kind: "doc", key: "plans-upcoming" });
    assert.deepEqual(routePublic("GET", url("/api/servicecue/rundown?serviceTypeId=1&planId=2")), { kind: "doc", key: "rundown-1-2" });
  });

  test("a doc path with a query it does not take is nothing", () => {
    for (const no of ["/api/state?x=1", "/api/plans/upcoming", "/api/plans/upcoming?days=30", "/api/servicecue/rundown", "/api/servicecue/rundown?serviceTypeId=x", "/api/servicecue/rundown?serviceTypeId=1&x=1"]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
  });

  test("an image is served by name", () => {
    assert.deepEqual(routePublic("GET", url("/branding-images/logo-1234abcd.png")), { kind: "asset", name: "logo-1234abcd.png" });
    for (const no of ["/branding-images/", "/branding-images/a/b.png", "/branding-images/a%2fb.png", "/branding-images/a b.png", `/branding-images/${"a".repeat(101)}.png`]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
    // A name of dots is no name: the URL parser climbs to the bare address.
    for (const up of ["/branding-images/..", "/branding-images/%2e%2e"]) assert.equal(publicKind("GET", up), "home", up);
  });

  test("the heartbeat and the live socket take no query", () => {
    assert.equal(publicKind("GET", "/api/publish/heartbeat"), "heartbeat");
    assert.equal(publicKind("GET", "/api/live"), "live");
    for (const no of ["/api/publish/heartbeat?x=1", "/api/live?x=1", "/api/live/", "/api/publish", "/api/publish/", "/api/publish/heartbeat/"]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
  });

  test("the app's own API is not here, whatever it is called", () => {
    for (const no of ["/api/events", "/api/events/poll", "/api/log", "/api/log/client", "/api/version", "/api/update/apply", "/api/devices", "/api/integrations", "/api/messages", "/api/pco/plan-items", "/api/views", "/api/outputs", "/api/config/export", "/api/servicecue/note-categories", "/photos", "/enroll", "/layout-images/x.png", "/display-1", "/settings", "/history", "/patch", "/baptism"]) {
      assert.equal(publicKind("GET", no), "reject:404", no);
    }
  });
});

describe("methods", () => {
  test("a public path answers GET and HEAD, and the socket answers GET", () => {
    for (const path of ["/servicecue", "/servicecue/a/b", "/api/state", "/branding-images/a.png", "/api/publish/heartbeat"]) {
      assert.notEqual(publicKind("GET", path), "reject:404", path);
      assert.equal(publicKind("HEAD", path), publicKind("GET", path), `HEAD ${path}`);
    }
    assert.equal(publicKind("HEAD", "/api/live"), "reject:405");
  });

  test("any other method on a path that exists is a 405 naming what it takes", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]) {
      for (const path of ["/servicecue", "/servicecue/a/b", "/api/state", "/branding-images/a.png", "/api/publish/heartbeat", "/api/live"]) {
        const r = routePublic(method, url(path));
        assert.equal(r.kind, "reject", `${method} ${path}`);
        if (r.kind === "reject") {
          assert.equal(r.status, 405, `${method} ${path}`);
          assert.equal(r.allow, path === "/api/live" ? "GET" : "GET, HEAD");
        }
      }
    }
  });

  test("a path that does not exist is a 404 whatever the method", () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      assert.equal(publicKind(method, "/nothing-here"), "reject:404", method);
      assert.equal(publicKind(method, "/servicecue/presets"), "reject:404", method);
    }
  });
});

describe("the publisher's area", () => {
  test("is everything under /_publish", () => {
    for (const yes of ["/_publish", "/_publish/", "/_publish/v1/status", "/_publish/v2/anything", "/_publish/x"]) {
      assert.equal(isPublishArea(yes), true, yes);
    }
    for (const no of ["/", "/_publishx", "/publish", "/api/_publish/v1/status", "/_Publish/v1/status", "//_publish/v1/status"]) {
      assert.equal(isPublishArea(no), false, no);
    }
  });

  test("each operation, with the one method it takes", () => {
    assert.equal(publishKind("PUT", "/_publish/v1/doc/state"), "putDoc");
    assert.equal(publishKind("DELETE", "/_publish/v1/doc/rundown-12-34"), "deleteDoc");
    assert.equal(publishKind("POST", "/_publish/v1/frame"), "postFrame");
    assert.equal(publishKind("PUT", "/_publish/v1/asset/logo.png"), "putAsset");
    assert.equal(publishKind("POST", "/_publish/v1/heartbeat"), "postHeartbeat");
    assert.equal(publishKind("PUT", "/_publish/v1/manifest"), "putManifest");
    assert.equal(publishKind("GET", "/_publish/v1/status"), "getStatus");
    assert.equal(publishKind("HEAD", "/_publish/v1/status"), "getStatus");
  });

  test("a known path with another method is a 405", () => {
    const cases: [string, string, string][] = [
      ["GET", "/_publish/v1/doc/state", "PUT, DELETE"],
      ["POST", "/_publish/v1/doc/state", "PUT, DELETE"],
      ["GET", "/_publish/v1/frame", "POST"],
      ["PUT", "/_publish/v1/frame", "POST"],
      ["POST", "/_publish/v1/asset/a.png", "PUT"],
      ["DELETE", "/_publish/v1/asset/a.png", "PUT"],
      ["PUT", "/_publish/v1/heartbeat", "POST"],
      ["POST", "/_publish/v1/manifest", "PUT"],
      ["POST", "/_publish/v1/status", "GET, HEAD"],
    ];
    for (const [method, path, allow] of cases) {
      const r = routePublish(method, url(path));
      assert.equal(r.kind, "reject", `${method} ${path}`);
      if (r.kind === "reject") {
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.equal(r.allow, allow, `${method} ${path}`);
      }
    }
  });

  test("a key or a name that cannot exist is a 404, not a store", () => {
    for (const [method, path] of [
      ["PUT", "/_publish/v1/doc/nope"],
      ["PUT", "/_publish/v1/doc/rundown-a"],
      ["PUT", "/_publish/v1/doc/state/extra"],
      ["PUT", "/_publish/v1/doc/"],
      ["DELETE", "/_publish/v1/doc/..%2fstate"],
      ["PUT", "/_publish/v1/asset/bad%20name.png"],
      ["PUT", "/_publish/v1/asset/a%2fb.png"],
      ["PUT", "/_publish/v1/asset/.."],
      ["PUT", "/_publish/v1/asset/"],
      ["GET", "/_publish/v1/status/"],
      ["GET", "/_publish/v1/"],
      ["GET", "/_publish/v1"],
      ["GET", "/_publish/v2/status"],
      ["GET", "/_publish/status"],
      ["POST", "/_publish/v1/frame/x"],
    ] as const) {
      assert.equal(publishKind(method, path), "reject:404", `${method} ${path}`);
    }
  });
});
