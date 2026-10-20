// The headers a stored image is served with, through RemoteServer's real request
// handler on a real socket.
//
// Layout and branding images may be SVG, and anyone on the LAN can upload one.
// Drawn by an <img> an SVG is inert, but opened directly its <script> ran as this
// app: same origin, so it could read everything and write anything. Each route
// that serves a stored image is driven here, because the fix is a header each
// of them has to send.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { serveOnSocket, type SocketServer } from "./fixtures/socket-server.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-image-headers-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { RemoteServer } = await import("./remote-server.js");
const { saveLayoutImage } = await import("./layout-image-store.js");
const { saveImage } = await import("./image-files.js");
const { BRANDING_IMAGE_DIR } = await import("./branding-image-store.js");
const { settingsStore } = await import("./settings-store.js");

// What an attacker would upload: draws a square, and tries a write as the app.
const HOSTILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  "<script>fetch('/api/update/apply', { method: 'POST' })</script>" +
  '<rect width="10" height="10"/></svg>';
const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(HOSTILE_SVG).toString("base64")}`;
// The store checks only the PNG signature on the way in, which is all a served
// icon needs to be for this test.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const pngDataUrl = `data:image/png;base64,${PNG.toString("base64")}`;

let server: SocketServer;
const get = (pathname: string) => server.send("GET", pathname);

/** A policy's directives, by name. A later duplicate is ignored, as a browser does. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), values);
  }
  return out;
}

/** What makes the document inert, checked as a browser would read the policy
 *  rather than as text, so a weakened policy fails as surely as a missing one. */
function assertInert(headers: http.IncomingHttpHeaders, what: string): void {
  const policy = headers["content-security-policy"];
  assert.equal(typeof policy, "string", `${what} was served with no Content-Security-Policy`);
  const d = directives(policy as string);
  const scripts = d.get("script-src") ?? d.get("default-src");
  assert.deepEqual(scripts, ["'none'"], `${what} may run script: ${policy}`);
  const sandbox = d.get("sandbox");
  assert.ok(sandbox, `${what} is not sandboxed: ${policy}`);
  assert.deepEqual(sandbox.filter((v) => v === "allow-scripts" || v === "allow-same-origin"), [], `${what}'s sandbox lets script or the app's origin back in: ${policy}`);
  assert.equal(headers["x-content-type-options"], "nosniff", `${what} may be sniffed into another type`);
}

before(async () => {
  server = await serveOnSocket(new RemoteServer().handle);
});

after(async () => {
  await server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("a stored image opened directly runs nothing", () => {
  test("a layout image", async () => {
    const url = await saveLayoutImage(svgDataUrl);
    const r = await get(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/svg+xml");
    assertInert(r.headers, url);
  });

  test("a branding image", async () => {
    const ref = await saveImage(BRANDING_IMAGE_DIR, svgDataUrl);
    const r = await get(ref);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/svg+xml");
    assertInert(r.headers, ref);
  });

  test("a custom app icon, served at the built-in icon's path", async () => {
    await settingsStore.patch({ appIcon192: await saveImage(BRANDING_IMAGE_DIR, pngDataUrl) });
    const r = await get("/icon-192.png");
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "image/png");
    assertInert(r.headers, "/icon-192.png");
  });
});

test("every response names its type as final, not only the images", async () => {
  const r = await get("/api/version");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});
