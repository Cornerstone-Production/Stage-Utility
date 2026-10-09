// GET /kiosk/StageUtilityOutput-<arch>.zip and its .sha256, over a real HTTP
// socket.
//
// The route harness hands a handler a string-collecting response, which cannot
// carry a binary body of this size, so this one listens. A second local server
// stands in for GitHub, reached through the test-only release base.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { captureConsole } from "../fixtures/capture-console.js";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "su-helper-route-"));
process.env.STAGE_UTILITY_DATA = dataDir;

// After the data directory is set: the route module reads it once.
const { kioskDeviceRoutes } = await import("./kiosk-device-routes.js");
const { pkgVersion } = await import("../updater.js");

const VERSION = pkgVersion();
const ZIP = "StageUtilityOutput-arm64.zip";
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

let app: http.Server;
let appBase: string;
let github: http.Server;
let githubBase: string;
const published = new Map<string, Buffer>();
let githubHits: string[] = [];

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

before(async () => {
  app = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    kioskDeviceRoutes({ req, res, url, pathname: url.pathname, method: req.method ?? "GET" }).then(
      () => {
        if (!res.headersSent) {
          res.writeHead(404);
          res.end("unhandled");
        }
      },
      (err) => {
        res.writeHead(500);
        res.end(String(err));
      },
    );
  });
  github = http.createServer((req, res) => {
    githubHits.push(req.url ?? "");
    const body = published.get(req.url ?? "");
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  appBase = await listen(app);
  githubBase = await listen(github);
});

after(async () => {
  await new Promise((r) => app.close(r));
  await new Promise((r) => github.close(r));
  await fs.rm(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  published.clear();
  githubHits = [];
  process.env.STAGE_UTILITY_TEST_RELEASE_BASE = githubBase;
  await fs.rm(path.join(dataDir, "cache"), { recursive: true, force: true });
});

function publish(zip: Buffer, digest = sha(zip)): void {
  published.set(`/v${VERSION}/${ZIP}`, zip);
  published.set(`/v${VERSION}/${ZIP}.sha256`, Buffer.from(`${digest}  ${ZIP}\n`));
}

describe("GET /kiosk/StageUtilityOutput-<arch>.zip", () => {
  it("fetches the release on the first request and serves the cache on the second", async (t) => {
    captureConsole(t, "log", "warn");
    const zip = crypto.randomBytes(2_500_000);
    publish(zip);

    const first = await fetch(`${appBase}/kiosk/${ZIP}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "application/zip");
    assert.equal(first.headers.get("content-length"), String(zip.length));
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), zip);
    const hits = githubHits.length;
    assert.equal(hits, 2, "the checksum and the zip, and nothing else, are fetched");

    const second = await fetch(`${appBase}/kiosk/${ZIP}`);
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), zip);
    assert.equal(githubHits.length, hits, "the second request is served from the cache");

    const sum = await fetch(`${appBase}/kiosk/${ZIP}.sha256`);
    assert.equal(sum.status, 200);
    assert.equal(await sum.text(), `${sha(zip)}  ${ZIP}\n`);
  });

  it("refuses a zip that does not match the published checksum, with 502 and nothing cached", async (t) => {
    captureConsole(t, "log", "warn");
    publish(crypto.randomBytes(10_000), sha(Buffer.from("not this")));
    const res = await fetch(`${appBase}/kiosk/${ZIP}`);
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /did not match its published SHA-256/);
    const left = await fs.readdir(path.join(dataDir, "cache", "output-helper", VERSION)).catch(() => []);
    assert.deepEqual(left, []);
  });

  it("answers 404 naming the problem when there is no internet and no cache", async (t) => {
    captureConsole(t, "log", "warn");
    // A port nothing listens on.
    const dead = http.createServer();
    const deadBase = await listen(dead);
    await new Promise((r) => dead.close(r));
    process.env.STAGE_UTILITY_TEST_RELEASE_BASE = deadBase;

    const res = await fetch(`${appBase}/kiosk/${ZIP}`);
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /not in the cache and could not be fetched/);
  });

  it("answers 404 for an architecture it does not ship, without asking the release host", async (t) => {
    captureConsole(t, "log", "warn");
    const res = await fetch(`${appBase}/kiosk/StageUtilityOutput-ppc.zip`);
    assert.equal(res.status, 404);
    assert.deepEqual(githubHits, []);
  });
});

describe("GET /kiosk/install-macos.sh", () => {
  const get = (host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(appBase);
      http
        .get({ host: u.hostname, port: u.port, path: "/kiosk/install-macos.sh", headers: { host } }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });

  it("tells the installer the address it was fetched from", async () => {
    const r = await get("192.0.2.10:8788");
    assert.equal(r.status, 200);
    assert.ok(r.body.split("\n").includes('FETCHED_FROM="http://192.0.2.10:8788"'));
  });

  it("does not stamp a Host header that is not an address", async () => {
    const r = await get('x"; id; "');
    assert.equal(r.status, 200);
    assert.ok(r.body.split("\n").includes('FETCHED_FROM=""'));
    assert.ok(!r.body.includes("id; "));
  });
});

describe("GET /kiosk/install-macos.sh behind TLS", () => {
  // A real TLS handshake needs a certificate. What the route reads is
  // `req.socket.encrypted`, which Node sets on a TLS socket, so this serves the
  // route from a socket that carries that flag, the way an https server's does.
  it("stamps an https address, and an http one when the socket is not encrypted", async () => {
    const serve = (encrypted: boolean) =>
      http.createServer((req, res) => {
        if (encrypted) Object.defineProperty(req.socket, "encrypted", { value: true });
        const url = new URL(req.url ?? "/", "http://localhost");
        void kioskDeviceRoutes({ req, res, url, pathname: url.pathname, method: "GET" });
      });
    const stamped = async (encrypted: boolean) => {
      const server = serve(encrypted);
      const base = await listen(server);
      try {
        const u = new URL(base);
        return await new Promise<string>((resolve, reject) => {
          http
            .get({ host: u.hostname, port: u.port, path: "/kiosk/install-macos.sh", headers: { host: "192.0.2.10:8788" } }, (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (c: string) => (body += c));
              res.on("end", () => resolve(body.split("\n").find((l) => l.startsWith("FETCHED_FROM=")) ?? "no FETCHED_FROM line"));
            })
            .on("error", reject);
        });
      } finally {
        await new Promise((r) => server.close(r));
      }
    };
    assert.equal(await stamped(true), 'FETCHED_FROM="https://192.0.2.10:8788"');
    assert.equal(await stamped(false), 'FETCHED_FROM="http://192.0.2.10:8788"');
  });
});
