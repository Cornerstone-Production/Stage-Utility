// mediamtx-relay.test.ts — MediaMtxRelay against a REAL http.createServer
// standing in for MediaMTX's control API, not a mocked fetch. State lives
// in memory and every request is recorded in order, which is what lets
// this prove an ordering claim (users patched before paths added) and a
// no-op claim (a second reconcile makes no writes) — properties of the
// wire, not of a helper.

import assert from "node:assert/strict";
import * as http from "node:http";
import { afterEach, before, after, describe, it } from "node:test";

import { READER_USER, type RelayUser } from "./mediamtx-config.js";
import { MediaMtxRelay } from "./mediamtx-relay.js";
import type { RelayFeed } from "./relay.js";

/** Keys `GET /v3/config/paths/list` reports beyond what this app ever sets
 *  — recording, run-on-demand, every other protocol's own timeouts — so a
 *  path round-tripped through the fake server looks like a real MediaMTX
 *  answer, not a bare echo of what was posted. */
const PATH_EXTRAS = {
  recordPath: "",
  recordFormat: "fmp4",
  recordPartDuration: "1s",
  recordSegmentDuration: "1h",
  runOnDemand: "",
  maxReaders: 0,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let server: http.Server;
let port = 0;
let calls: Call[] = [];
let configPaths: Map<string, Record<string, unknown>>;
let globalConfig: { authInternalUsers: RelayUser[] };
let runtimePaths: Record<string, unknown>[];
/** Makes `GET /v3/config/paths/list` answer 500, to prove a non-2xx answer
 *  throws rather than being swallowed. */
let failPathsList = false;
/** When set, `failPathsList`'s 500 carries this `error` text instead of the
 *  fixed "relay is not ready" — for R14b's credential-stripping test, which
 *  needs to control exactly what the relay's own error text says. */
let failPathsListWith: string | null = null;
/** When set, `GET /v3/config/paths/list` answers 500 with this raw text,
 *  which is not JSON. */
let rawPathsListBody: string | null = null;

function bootState(): void {
  configPaths = new Map();
  globalConfig = { authInternalUsers: [] };
  runtimePaths = [];
  failPathsList = false;
  failPathsListWith = null;
  rawPathsListBody = null;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

before(async () => {
  bootState();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw.length > 0 ? JSON.parse(raw) : undefined;
      const method = req.method ?? "GET";
      const url = req.url ?? "";
      calls.push({ method, url, body });
      handle(method, url, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  bootState();
  calls = [];
});

function handle(method: string, url: string, body: unknown, res: http.ServerResponse): void {
  if (method === "GET" && url === "/v3/config/paths/list") {
    if (rawPathsListBody !== null) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(rawPathsListBody);
      return;
    }
    if (failPathsList) return send(res, 500, { error: failPathsListWith ?? "relay is not ready" });
    const items = [...configPaths.entries()].map(([name, conf]) => ({ name, ...conf }));
    return send(res, 200, { items });
  }
  const addMatch = /^\/v3\/config\/paths\/add\/([^/]+)$/.exec(url);
  if (method === "POST" && addMatch) {
    const name = decodeURIComponent(addMatch[1]);
    if (configPaths.has(name)) return send(res, 400, { error: "path already exists" });
    configPaths.set(name, { ...PATH_EXTRAS, ...(body as Record<string, unknown>) });
    return send(res, 200, {});
  }
  const replaceMatch = /^\/v3\/config\/paths\/replace\/([^/]+)$/.exec(url);
  if (method === "POST" && replaceMatch) {
    const name = decodeURIComponent(replaceMatch[1]);
    configPaths.set(name, { ...PATH_EXTRAS, ...(body as Record<string, unknown>) });
    return send(res, 200, {});
  }
  const deleteMatch = /^\/v3\/config\/paths\/delete\/([^/]+)$/.exec(url);
  if (method === "DELETE" && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    configPaths.delete(name);
    return send(res, 200, {});
  }
  if (method === "GET" && url === "/v3/config/global/get") {
    // The real v1.21.1 binary redacts a non-empty password to the literal
    // string "<redacted>" on every read — confirmed directly with curl.
    // `globalConfig` itself stays the true value so a test can still assert
    // on it; only the wire response is redacted, same as the real relay.
    const redacted = {
      ...globalConfig,
      authInternalUsers: globalConfig.authInternalUsers.map((u) => ({ ...u, pass: u.pass ? "<redacted>" : u.pass })),
    };
    return send(res, 200, redacted);
  }
  if (method === "PATCH" && url === "/v3/config/global/patch") {
    // The real v1.21.1 binary canonicalizes a bare IP in `ips` to CIDR on
    // every read ("127.0.0.1" -> "127.0.0.1/32"), confirmed by driving it
    // directly — reproduced here so the "no writes" tests below exercise
    // the same mismatch MediaMtxRelay has to tolerate, not an echo of
    // whatever it happened to send.
    const patch = body as { authInternalUsers?: RelayUser[] };
    if (patch.authInternalUsers) {
      patch.authInternalUsers = patch.authInternalUsers.map((u) => ({
        ...u,
        ips: u.ips.map((ip) => (ip.includes("/") ? ip : ip.includes(":") ? `${ip}/128` : `${ip}/32`)),
      }));
    }
    Object.assign(globalConfig, patch);
    return send(res, 200, {});
  }
  if (method === "GET" && url === "/v3/paths/list") {
    return send(res, 200, { items: runtimePaths });
  }
  const kickMatch = /^\/v3\/(rtmpconns|srtconns|webrtcsessions)\/kick\/([^/]+)$/.exec(url);
  if (method === "POST" && kickMatch) {
    return send(res, 200, {});
  }
  send(res, 404, { error: "not found" });
}

const PULL: RelayFeed = { id: "cam1", kind: "pull", source: "rtsp://admin:p%40ss@h/s" };
const PUSH: RelayFeed = { id: "obs1", kind: "push", password: "hunter2" };
/** READER_USER as the relay itself stores it after a patch: `ips` in CIDR,
 *  same as globalConfig's ground truth below (see the PATCH handler). */
const STORED_READER_USER = { ...READER_USER, ips: ["127.0.0.1/32", "::1/128"] };

describe("MediaMtxRelay.reconcile", () => {
  it("patches authInternalUsers BEFORE every path write — an add, a replace AND a remove alike", async () => {
    // Pre-seed the relay directly (bypassing HTTP) so one reconcile() call
    // has to add obs1, replace cam1 (its stale conf differs from PULL's)
    // and remove orphan, all alongside the very first users patch — the
    // ordering claim has to hold for every write kind, not just add.
    configPaths.set("cam1", { ...PATH_EXTRAS, source: "rtsp://stale-host/s", sourceOnDemand: true });
    configPaths.set("orphan", { ...PATH_EXTRAS, source: "rtsp://gone/x", sourceOnDemand: true });

    const relay = new MediaMtxRelay(port);
    await relay.reconcile([PULL, PUSH]);

    const writes = calls.filter((c) => c.method !== "GET");
    const patchIndex = writes.findIndex((c) => c.url === "/v3/config/global/patch");
    const addIndexes = writes
      .map((c, i) => (c.url.startsWith("/v3/config/paths/add/") ? i : -1))
      .filter((i) => i >= 0);
    const replaceIndexes = writes
      .map((c, i) => (c.url.startsWith("/v3/config/paths/replace/") ? i : -1))
      .filter((i) => i >= 0);
    const removeIndexes = writes
      .map((c, i) => (c.method === "DELETE" ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(patchIndex >= 0, "expected a users patch");
    assert.ok(addIndexes.length > 0, "expected a path add");
    assert.ok(replaceIndexes.length > 0, "expected a path replace");
    assert.ok(removeIndexes.length > 0, "expected a path remove");
    assert.ok(
      [...addIndexes, ...replaceIndexes, ...removeIndexes].every((i) => i > patchIndex),
      `expected the users patch (index ${patchIndex}) before every add/replace/remove ` +
        `(add ${addIndexes.join(",")}, replace ${replaceIndexes.join(",")}, remove ${removeIndexes.join(",")})`,
    );

    assert.deepEqual(globalConfig.authInternalUsers, [
      STORED_READER_USER,
      { user: "video", pass: "hunter2", ips: [], permissions: [{ action: "publish", path: "obs1" }] },
    ]);
    assert.equal(configPaths.get("cam1")?.source, "rtsp://admin:p%40ss@h/s");
    assert.equal(configPaths.get("obs1")?.source, "publisher");
    assert.equal(configPaths.has("orphan"), false);
  });

  it("forwards a pull feed's folded URL unchanged, including an SRT passphrase in the query", async () => {
    const srtPull: RelayFeed = { id: "cam2", kind: "pull", source: "srt://h:9000?streamid=x&passphrase=p%40ss" };
    const relay = new MediaMtxRelay(port);
    await relay.reconcile([srtPull]);
    assert.equal(configPaths.get("cam2")?.source, "srt://h:9000?streamid=x&passphrase=p%40ss");
  });

  it("a second reconcile with no changes makes no writes", async () => {
    // Pull-only: the relay's own IP-to-CIDR canonicalization (reproduced by
    // the PATCH handler above) is the only thing that could make an
    // unchanged READER_USER look different on the second GET, and
    // MediaMtxRelay must tolerate it. (A push feed's password is a
    // different story — see the redaction test below.)
    const relay = new MediaMtxRelay(port);
    await relay.reconcile([PULL]);
    calls = [];

    await relay.reconcile([PULL]);
    const writes = calls.filter((c) => c.method !== "GET");
    assert.deepEqual(writes, []);
  });

  it("re-patches a push feed's user on every call, because the relay redacts the password it would need to confirm unchanged", async () => {
    // The real relay never answers a readable password back (confirmed
    // directly against v1.21.1: a non-empty `pass` reads "<redacted>"), so
    // comparing it literally always looks different and this always
    // re-sends it — deliberately: the alternative (ignoring `pass` in the
    // comparison) would also skip a GENUINE password rotation, since
    // nothing else about that user changes either.
    const relay = new MediaMtxRelay(port);
    await relay.reconcile([PUSH]);
    calls = [];

    await relay.reconcile([PUSH]);
    const writes = calls.filter((c) => c.method !== "GET");
    assert.deepEqual(
      writes.map((c) => c.url),
      ["/v3/config/global/patch"],
    );
    // The password the relay actually holds is still right, even though
    // nothing on the wire could have proven that from a GET alone.
    assert.equal(globalConfig.authInternalUsers.find((u) => u.user === "video")?.pass, "hunter2");
  });

  it("restores every path after the relay restarts and its runtime state clears", async () => {
    const relay = new MediaMtxRelay(port);
    await relay.reconcile([PULL, PUSH]);
    assert.equal(configPaths.size, 2);

    // The fake "restarts": runtime config resets to whatever the static
    // file on disk holds again — no added paths, no patched users.
    configPaths = new Map();
    globalConfig = { authInternalUsers: [] };

    await relay.reconcile([PULL, PUSH]);
    assert.equal(configPaths.get("cam1")?.source, "rtsp://admin:p%40ss@h/s");
    assert.equal(configPaths.get("obs1")?.source, "publisher");
    assert.deepEqual(globalConfig.authInternalUsers, [
      STORED_READER_USER,
      { user: "video", pass: "hunter2", ips: [], permissions: [{ action: "publish", path: "obs1" }] },
    ]);
  });

  it("adds, replaces and removes in one call", async () => {
    const relay = new MediaMtxRelay(port);
    const orphan: RelayFeed = { id: "orphan", kind: "pull", source: "rtsp://gone/x" };
    await relay.reconcile([PULL, orphan]);
    assert.equal(configPaths.size, 2);

    const changed: RelayFeed = { id: "cam1", kind: "pull", source: "rtsp://new-host/s" };
    await relay.reconcile([changed, PUSH]);

    assert.equal(configPaths.get("cam1")?.source, "rtsp://new-host/s"); // replaced
    assert.equal(configPaths.get("obs1")?.source, "publisher"); // added
    assert.equal(configPaths.has("orphan"), false); // removed
    assert.equal(configPaths.size, 2);
  });

  it("a non-2xx answer throws an Error carrying the relay's error text", async () => {
    failPathsList = true;
    const relay = new MediaMtxRelay(port);
    await assert.rejects(
      () => relay.reconcile([PULL]),
      (err: Error) => {
        assert.equal(err.message, "relay is not ready");
        return true;
      },
    );
  });

  // R14b, defence in depth: reconcile-plan.ts's own fix (percent-encoding a
  // literal `%`) is the primary defence against a credentialed URL ever
  // reaching the relay malformed in the first place — this is what happens
  // if a credential reaches an Error message anyway, from any cause, not
  // only that one. Confirmed against a real v1.21.1 binary that a malformed
  // pull source produces exactly this shape of error text (garbled by the
  // relay's own Go fmt formatting, credentials and all).
  it("strips a user:pass@ userinfo out of the relay's own error text before it becomes this module's Error message", async () => {
    failPathsList = true;
    failPathsListWith = "'rtsp://admin:s3c%!z(MISSING)zret@192.0.2.1/s' is not a valid URL";
    const relay = new MediaMtxRelay(port);
    await assert.rejects(
      () => relay.reconcile([PULL]),
      (err: Error) => {
        assert.equal(err.message, "'rtsp://192.0.2.1/s' is not a valid URL");
        assert.equal(err.message.includes("admin"), false, "the username must not survive either");
        assert.equal(err.message.includes("s3c"), false, "no fragment of the password may survive");
        return true;
      },
    );
  });

  it("an answer that is not JSON never carries its body into the Error message", async () => {
    rawPathsListBody = "srt://192.0.2.5:9000?passphrase=SECRETPASS123 refused";
    const relay = new MediaMtxRelay(port);
    await assert.rejects(
      () => relay.reconcile([PULL]),
      (err: Error) => {
        assert.equal(err.message.includes("SECRETPASS123"), false, `the body reached the Error message: ${err.message}`);
        assert.equal(err.message, "MediaMTX answered 500, not JSON");
        return true;
      },
    );
  });

  it("strips an SRT pull's passphrase out of the relay's own error text", async () => {
    failPathsList = true;
    failPathsListWith = "'srt://ho%zzst:9000?passphrase=SECRETPASS123' is not a valid URL";
    const relay = new MediaMtxRelay(port);
    await assert.rejects(
      () => relay.reconcile([PULL]),
      (err: Error) => {
        assert.equal(err.message.includes("SECRETPASS123"), false, "the passphrase must not reach an Error message");
        assert.equal(err.message, "'srt://ho%zzst:9000?passphrase=<redacted>' is not a valid URL");
        return true;
      },
    );
  });
});

describe("MediaMtxRelay.status", () => {
  it("maps tracks2[0].codecProps onto video, and reader count", async () => {
    runtimePaths = [
      {
        name: "cam1",
        ready: true,
        readyTime: "2026-09-28T00:00:00Z",
        source: { type: "rtmpConn", id: "conn-1" },
        tracks2: [{ codec: "H264", codecProps: { width: 1280, height: 720, profile: "High" } }],
        readers: [{ type: "webRTCSession" }, { type: "hlsMuxer" }],
      },
      {
        name: "cam2",
        ready: false,
        readyTime: null,
        source: null,
        readers: [],
      },
    ];
    const relay = new MediaMtxRelay(port);
    const status = await relay.status();
    assert.deepEqual(status, [
      {
        name: "cam1",
        ready: true,
        readyTime: "2026-09-28T00:00:00Z",
        source: { type: "rtmpConn", id: "conn-1" },
        video: { codec: "H264", width: 1280, height: 720, profile: "High" },
        readers: 2,
      },
      {
        name: "cam2",
        ready: false,
        readyTime: null,
        source: null,
        video: null,
        readers: 0,
      },
    ]);
  });
});

describe("MediaMtxRelay.kickPublisher", () => {
  it("an rtmpConn publisher is kicked at /v3/rtmpconns/kick/<id>, and reports true", async () => {
    runtimePaths = [{ name: "cam1", ready: true, readyTime: null, source: { type: "rtmpConn", id: "conn-1" } }];
    const relay = new MediaMtxRelay(port);
    assert.equal(await relay.kickPublisher("cam1"), true);
    assert.ok(calls.some((c) => c.method === "POST" && c.url === "/v3/rtmpconns/kick/conn-1"));
  });

  it("an srtConn publisher is kicked at /v3/srtconns/kick/<id>, and reports true", async () => {
    runtimePaths = [{ name: "cam1", ready: true, readyTime: null, source: { type: "srtConn", id: "conn-2" } }];
    const relay = new MediaMtxRelay(port);
    assert.equal(await relay.kickPublisher("cam1"), true);
    assert.ok(calls.some((c) => c.method === "POST" && c.url === "/v3/srtconns/kick/conn-2"));
  });

  it("a webRTCSession publisher is kicked at /v3/webrtcsessions/kick/<id>, and reports true", async () => {
    runtimePaths = [{ name: "cam1", ready: true, readyTime: null, source: { type: "webRTCSession", id: "conn-3" } }];
    const relay = new MediaMtxRelay(port);
    assert.equal(await relay.kickPublisher("cam1"), true);
    assert.ok(calls.some((c) => c.method === "POST" && c.url === "/v3/webrtcsessions/kick/conn-3"));
  });

  it("is a no-op when nobody is publishing, and reports false — never mistaken for a drop that happened", async () => {
    runtimePaths = [{ name: "cam1", ready: false, readyTime: null, source: null }];
    const relay = new MediaMtxRelay(port);
    assert.equal(await relay.kickPublisher("cam1"), false);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  it("throws for a source type outside the three mapped ones", async () => {
    runtimePaths = [{ name: "cam1", ready: true, readyTime: null, source: { type: "rtspSession", id: "conn-9" } }];
    const relay = new MediaMtxRelay(port);
    await assert.rejects(
      () => relay.kickPublisher("cam1"),
      (err: Error) => {
        assert.equal(err.message, 'Cannot kick a publisher of type "rtspSession"');
        return true;
      },
    );
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });
});

describe("MediaMtxRelay.playback", () => {
  it("is same-origin relay-proxy paths", () => {
    const relay = new MediaMtxRelay(port);
    assert.deepEqual(relay.playback("cam1"), { whep: "/video/cam1/whep", hls: "/video/cam1/index.m3u8" });
  });
});
