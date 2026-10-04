// probe.test.ts — the camera check against fake cameras on loopback: an RTSP
// server that answers DESCRIBE however a test says, and an HTTP server for an
// HLS playlist. Real sockets, the real probe; nothing mocked.
//
// rtsps:// is proved against a self-signed certificate made on the spot with
// the system's openssl (no key is committed); that one test skips where
// openssl is absent.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { after, test } from "node:test";

import { authorizationFor, digestResponse, parseSdp, probeFeed, probeKind, rtspEndpoint } from "./probe.js";

const SPROP_1080 = "Z2TAKKwbGqB4AiflkSAAAH0gADqYEeEQjUA=,aO48gA==";

function sdp(lines: string[]): string {
  return ["v=0", "o=- 0 0 IN IP4 127.0.0.1", "s=Stream", "t=0 0", ...lines, ""].join("\r\n");
}

const SDP_H264 = sdp([
  "m=video 0 RTP/AVP 96",
  "a=rtpmap:96 H264/90000",
  `a=fmtp:96 packetization-mode=1;profile-level-id=640028;sprop-parameter-sets=${SPROP_1080}`,
  "m=audio 0 RTP/AVP 97",
  "a=rtpmap:97 MPEG4-GENERIC/48000/2",
]);

interface RtspRequest {
  method: string;
  uri: string;
  headers: Map<string, string>;
}

/** What a fake camera does with one request. */
type Behaviour =
  | { reply: string }
  | "silent"
  | "close";

function rtspReply(status: string, headers: string[] = [], body = ""): string {
  const length = Buffer.byteLength(body);
  return [`RTSP/1.0 ${status}`, "CSeq: 1", ...headers, ...(body ? ["Content-Type: application/sdp", `Content-Length: ${length}`] : ["Content-Length: 0"]), "", body].join("\r\n");
}

const servers: net.Server[] = [];
const httpServers: http.Server[] = [];
const openSockets = new Set<net.Socket>();

after(() => {
  for (const s of openSockets) s.destroy();
  for (const s of servers) s.close();
  for (const s of httpServers) s.close();
});

/** A fake RTSP camera; `seen` is every request it received, in order. */
async function fakeCamera(behave: (req: RtspRequest, n: number) => Behaviour): Promise<{ port: number; seen: RtspRequest[]; sockets: Set<net.Socket> }> {
  const seen: RtspRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    openSockets.add(socket);
    sockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
      sockets.delete(socket);
    });
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const lines = buffer.slice(0, end).split("\r\n");
      buffer = buffer.slice(end + 4);
      const [method, uri] = lines[0]!.split(" ");
      const headers = new Map<string, string>();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
      }
      const req: RtspRequest = { method: method!, uri: uri!, headers };
      seen.push(req);
      const b = behave(req, seen.length);
      if (b === "close") socket.destroy();
      else if (b !== "silent") socket.write(b.reply);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, seen, sockets };
}

const target = (port: number, path = "/BOX", username = "", password = "") => ({ url: `rtsp://127.0.0.1:${port}${path}`, username, password });

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

// ── Pure pieces ─────────────────────────────────────────────────────────────

test("digestResponse reproduces RFC 2617's own worked example", () => {
  // Section 3.5: Mufasa, "Circle Of Life", GET /dir/index.html, qop=auth.
  assert.equal(
    digestResponse({
      username: "Mufasa",
      password: "Circle Of Life",
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
      method: "GET",
      uri: "/dir/index.html",
      qop: "auth",
      nc: "00000001",
      cnonce: "0a4f113b",
    }),
    "6629fae49393a05397450978507c4ef1",
  );
});

test("digestResponse without qop is the RFC 2069 form, hand-computed for a DESCRIBE", () => {
  assert.equal(
    digestResponse({
      username: "admin",
      password: "hunter2",
      realm: "IP Camera",
      nonce: "abcdef0123456789",
      method: "DESCRIBE",
      uri: "rtsp://10.0.0.5:554/stream1",
    }),
    "15c2b9b143c4a97a15e2d4ed056e7c90",
  );
});

test("probeKind says what can be asked cheaply", () => {
  assert.equal(probeKind("rtsp://h/x"), "rtsp");
  assert.equal(probeKind("RTSPS://h/x"), "rtsp");
  assert.equal(probeKind("http://h/x.m3u8"), "hls");
  assert.equal(probeKind("https://h/x.m3u8"), "hls");
  assert.equal(probeKind("srt://h:9000"), null);
});

test("rtspEndpoint: default ports are 554 and 322, and the request URI carries no userinfo", () => {
  assert.deepEqual(rtspEndpoint("rtsp://cam.local/BOX"), { secure: false, host: "cam.local", port: 554, uri: "rtsp://cam.local/BOX" });
  assert.deepEqual(rtspEndpoint("rtsps://cam.local/BOX"), { secure: true, host: "cam.local", port: 322, uri: "rtsps://cam.local/BOX" });
  assert.deepEqual(rtspEndpoint("rtsp://admin:pw@10.0.0.5:8554/a?b=1"), { secure: false, host: "10.0.0.5", port: 8554, uri: "rtsp://10.0.0.5:8554/a?b=1" });
});

test("parseSdp takes the first video section, and a codec with no size is still a codec", () => {
  assert.deepEqual(parseSdp(SDP_H264), { codec: "H264", width: 1920, height: 1080 });
  assert.deepEqual(parseSdp(sdp(["m=video 0 RTP/AVP 96", "a=rtpmap:96 H265/90000"])), { codec: "H265" });
  assert.deepEqual(parseSdp(sdp(["m=audio 0 RTP/AVP 97", "a=rtpmap:97 PCMU/8000"])), {}, "no video section, nothing to report");
  // An rtpmap for a payload the video line does not use belongs to something else.
  assert.deepEqual(parseSdp(sdp(["m=video 0 RTP/AVP 96", "a=rtpmap:96 H264/90000", "a=rtpmap:98 H265/90000"])), { codec: "H264" });
});

// ── RTSP ────────────────────────────────────────────────────────────────────

test("200 with an SDP is ready, with the codec and resolution from the SPS, and the request is a well-formed DESCRIBE", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("200 OK", [], SDP_H264) }));
  const result = await probeFeed(target(cam.port));
  assert.deepEqual(result, { state: "ready", codec: "H264", width: 1920, height: 1080 });
  assert.equal(cam.seen.length, 1, "one DESCRIBE, no stream");
  const req = cam.seen[0]!;
  assert.equal(req.method, "DESCRIBE");
  assert.equal(req.uri, `rtsp://127.0.0.1:${cam.port}/BOX`);
  assert.equal(req.headers.get("cseq"), "1");
  assert.equal(req.headers.get("accept"), "application/sdp");
  assert.ok(req.headers.get("user-agent"), "a User-Agent is sent");
  assert.equal(req.headers.has("authorization"), false, "no login is offered before one is asked for");
});

test("an H.265 camera is ready with its codec and no resolution", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("200 OK", [], sdp(["m=video 0 RTP/AVP 96", "a=rtpmap:96 H265/90000"])) }));
  assert.deepEqual(await probeFeed(target(cam.port)), { state: "ready", codec: "H265" });
});

test("a 401 asking for Basic is answered once with the saved login, then ready", async () => {
  const cam = await fakeCamera((req) =>
    req.headers.get("authorization") === `Basic ${Buffer.from("admin:hunter2-secret").toString("base64")}`
      ? { reply: rtspReply("200 OK", [], SDP_H264) }
      : { reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Basic realm="cam"']) },
  );
  const result = await probeFeed(target(cam.port, "/BOX", "admin", "hunter2-secret"));
  assert.equal(result.state, "ready");
  assert.equal(cam.seen.length, 2, "the first request, and one retry with the login");
});

test("a 401 asking for Digest is answered with the correct response hash (qop=auth), then ready", async () => {
  const realm = "IP Camera";
  const nonce = "0123456789abcdef";
  const cam = await fakeCamera((req) => {
    const auth = req.headers.get("authorization");
    if (!auth) return { reply: rtspReply("401 Unauthorized", [`WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}", qop="auth", opaque="op"`]) };
    const f = new Map([...auth.slice("Digest ".length).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1]!, m[2] ?? m[3]!] as const));
    // The server's own arithmetic, written out here rather than shared with the probe.
    const ha1 = md5(`admin:${realm}:hunter2-secret`);
    const ha2 = md5(`DESCRIBE:${req.uri}`);
    const expected = md5(`${ha1}:${nonce}:${f.get("nc")}:${f.get("cnonce")}:auth:${ha2}`);
    const ok = auth.startsWith("Digest ") && f.get("response") === expected && f.get("uri") === req.uri && f.get("username") === "admin" && f.get("opaque") === "op" && f.get("qop") === "auth";
    return ok ? { reply: rtspReply("200 OK", [], SDP_H264) } : { reply: rtspReply("401 Unauthorized", [`WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}", qop="auth"`]) };
  });
  const result = await probeFeed(target(cam.port, "/BOX", "admin", "hunter2-secret"));
  assert.equal(result.state, "ready", JSON.stringify(result));
  assert.equal(cam.seen.length, 2);
});

test("a Digest challenge with no qop is answered in the RFC 2069 form", async () => {
  const cam = await fakeCamera((req) => {
    const auth = req.headers.get("authorization");
    if (!auth) return { reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Digest realm="IP Camera", nonce="abcdef0123456789"']) };
    const expected = md5(`${md5("admin:IP Camera:hunter2")}:abcdef0123456789:${md5(`DESCRIBE:${req.uri}`)}`);
    return auth.includes(`response="${expected}"`) && !auth.includes("qop=") ? { reply: rtspReply("200 OK", [], SDP_H264) } : { reply: rtspReply("401 Unauthorized") };
  });
  assert.equal((await probeFeed(target(cam.port, "/BOX", "admin", "hunter2"))).state, "ready");
});

test("when Digest and Basic are both offered, Digest is the one used", async () => {
  const cam = await fakeCamera((req) =>
    req.headers.get("authorization")
      ? { reply: rtspReply("200 OK", [], SDP_H264) }
      : { reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Basic realm="x"', 'WWW-Authenticate: Digest realm="x", nonce="n"']) },
  );
  await probeFeed(target(cam.port, "/BOX", "admin", "pw"));
  assert.match(cam.seen[1]!.headers.get("authorization")!, /^Digest /);
});

test("a 401 with no username saved says the camera wants a login, and does not retry", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Basic realm="cam"']) }));
  assert.deepEqual(await probeFeed(target(cam.port)), { state: "failed", reason: "The camera wants a login · add the username and password" });
  assert.equal(cam.seen.length, 1);
});

test("a 401 that stays a 401 with a login says the camera refused it, and never carries the password", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Basic realm="cam"']) }));
  const result = await probeFeed(target(cam.port, "/BOX", "admin", "hunter2-secret"));
  assert.deepEqual(result, { state: "failed", reason: "The camera refused the login · check the username and password" });
  assert.equal(cam.seen.length, 2, "one retry, not a loop");
  assert.equal(JSON.stringify(result).includes("hunter2-secret"), false);
});

test("a 404 names the host and says to check the path", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("404 Not Found") }));
  assert.deepEqual(await probeFeed(target(cam.port)), { state: "failed", reason: "No stream at this path on 127.0.0.1 · check the path" });
});

// Seen on the real BOX encoder, 2 Oct 2026: it answers one DESCRIBE at a time,
// and 406 Not Acceptable to every other in flight (two servers checking the
// same camera, or a check landing while the relay dials it).
test("a 406 is the camera busy: asked again, and ready once it answers", async () => {
  const cam = await fakeCamera((_req, n) => ({ reply: n === 1 ? rtspReply("406 Not Acceptable") : rtspReply("200 OK", [], SDP_H264) }));
  assert.deepEqual(await probeFeed(target(cam.port)), { state: "ready", codec: "H264", width: 1920, height: 1080 });
  assert.equal(cam.seen.length, 2);
});

test("a camera that stays busy is inconclusive, never 'not answering'", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("406 Not Acceptable") }));
  assert.deepEqual(await probeFeed(target(cam.port)), { state: "busy" });
  assert.equal(cam.seen.length, 3, "asked once and again twice");
});

test("any other status is shown as the camera said it", async () => {
  const cam = await fakeCamera(() => ({ reply: rtspReply("503 Service Unavailable") }));
  assert.deepEqual(await probeFeed(target(cam.port)), { state: "failed", reason: "The camera answered 503 Service Unavailable" });
});

test("a camera that connects and says nothing is 'no answer for this path', after the timeout", async () => {
  const cam = await fakeCamera(() => "silent");
  const started = Date.now();
  const result = await probeFeed(target(cam.port), 300);
  assert.deepEqual(result, { state: "failed", reason: "No answer from 127.0.0.1 for this path · check the address and path" });
  assert.ok(Date.now() - started >= 250, "it waited for the timeout rather than giving up early");
  assert.ok(Date.now() - started < 2000, "and no longer than it was told to");
});

test("a refused connection names the host and port", async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.deepEqual(await probeFeed(target(port)), { state: "failed", reason: `127.0.0.1 refused the connection on port ${port}` });
});

test("an address nothing can reach is 'not reachable'", async () => {
  // TEST-NET-1: never routed. Either the network refuses at once or the
  // connect times out; both are "not reachable".
  const result = await probeFeed({ url: "rtsp://192.0.2.1:554/BOX", username: "", password: "" }, 400);
  assert.deepEqual(result, { state: "failed", reason: "192.0.2.1 is not reachable" });
});

test("a camera that hangs up without answering says so", async () => {
  const cam = await fakeCamera(() => "close");
  const result = await probeFeed(target(cam.port));
  assert.deepEqual(result, { state: "failed", reason: "127.0.0.1 closed the connection without answering · check the address and path" });
});

test("something that is not RTSP on the port is reported as such", async () => {
  const cam = await fakeCamera(() => ({ reply: "HTTP/1.1 400 Bad Request\r\n\r\n" }));
  const result = await probeFeed(target(cam.port));
  assert.equal(result.state, "failed");
  assert.match((result as { reason: string }).reason, /not with RTSP/);
});

test("an SRT address is not probed at all", async () => {
  assert.deepEqual(await probeFeed({ url: "srt://127.0.0.1:9999", username: "", password: "" }), { state: "unchecked" });
});

test("an address that does not parse is a failed check, not a throw", async () => {
  const result = await probeFeed({ url: "rtsp://", username: "", password: "" });
  assert.equal(result.state, "failed");
});

// ── HLS ─────────────────────────────────────────────────────────────────────

async function fakeHls(handler: http.RequestListener): Promise<{ port: number; requests: http.IncomingMessage[]; sockets: Set<net.Socket> }> {
  const requests: http.IncomingMessage[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  httpServers.push(server);
  server.on("connection", (s) => {
    openSockets.add(s);
    sockets.add(s);
    s.on("close", () => {
      openSockets.delete(s);
      sockets.delete(s);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, requests, sockets };
}

const hlsTarget = (port: number, username = "", password = "") => ({ url: `http://127.0.0.1:${port}/live/index.m3u8`, username, password });

test("an HLS playlist is ready, with the first RESOLUTION", async () => {
  const hls = await fakeHls((_req, res) => {
    res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhi.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nlo.m3u8\n');
  });
  assert.deepEqual(await probeFeed(hlsTarget(hls.port)), { state: "ready", width: 1920, height: 1080 });
  assert.equal(hls.requests[0]!.url, "/live/index.m3u8");
});

test("a media playlist with no RESOLUTION is ready without one", async () => {
  const hls = await fakeHls((_req, res) => res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n"));
  assert.deepEqual(await probeFeed(hlsTarget(hls.port)), { state: "ready" });
});

test("a 200 that is not a playlist is a failed check", async () => {
  const hls = await fakeHls((_req, res) => res.end("<html>a camera login page</html>"));
  const result = await probeFeed(hlsTarget(hls.port));
  assert.deepEqual(result, { state: "failed", reason: "127.0.0.1 answered, but not with a playlist · check the path" });
});

test("an HLS 404 says to check the path", async () => {
  const hls = await fakeHls((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  assert.deepEqual(await probeFeed(hlsTarget(hls.port)), { state: "failed", reason: "No stream at this path on 127.0.0.1 · check the path" });
});

test("an HLS source sends Basic auth when a username is saved, and a 401 with it is a refused login", async () => {
  const hls = await fakeHls((req, res) => {
    if (req.headers.authorization === `Basic ${Buffer.from("admin:hunter2-secret").toString("base64")}`) res.end("#EXTM3U\n");
    else {
      res.statusCode = 401;
      res.end();
    }
  });
  assert.equal((await probeFeed(hlsTarget(hls.port, "admin", "hunter2-secret"))).state, "ready");
  assert.deepEqual(await probeFeed(hlsTarget(hls.port, "admin", "wrong")), { state: "failed", reason: "The camera refused the login · check the username and password" });
  assert.deepEqual(await probeFeed(hlsTarget(hls.port)), { state: "failed", reason: "The camera wants a login · add the username and password" });
});

test("an HLS server that connects and never answers times out as 'no answer'", async () => {
  const hls = await fakeHls(() => {});
  const result = await probeFeed(hlsTarget(hls.port), 300);
  assert.deepEqual(result, { state: "failed", reason: "No answer from 127.0.0.1 for this path · check the address and path" });
});

test("an HLS connection refusal names the port", async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  assert.deepEqual(await probeFeed(hlsTarget(port)), { state: "failed", reason: `127.0.0.1 refused the connection on port ${port}` });
});

// ── rtsps ───────────────────────────────────────────────────────────────────

function selfSignedPair(): { key: string; cert: string } | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), "su-probe-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=127.0.0.1", "-days", "1"], { stdio: "ignore" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } catch {
    return null;
  }
}

const pair = selfSignedPair();

test("rtsps:// is probed over TLS even though the camera's certificate is self-signed", { skip: pair === null ? "openssl is not available" : false }, async () => {
  const requests: string[] = [];
  const server = tls.createServer({ key: pair!.key, cert: pair!.cert }, (socket) => {
    openSockets.add(socket);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      requests.push(chunk.toString("latin1").split("\r\n")[0]!);
      socket.write(rtspReply("200 OK", [], SDP_H264));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const result = await probeFeed({ url: `rtsps://127.0.0.1:${port}/BOX`, username: "", password: "" });
  assert.deepEqual(result, { state: "ready", codec: "H264", width: 1920, height: 1080 });
  assert.equal(requests[0], `DESCRIBE rtsps://127.0.0.1:${port}/BOX RTSP/1.0`);
});

// ── Digest edge cases ───────────────────────────────────────────────────────

test("a Digest this check cannot do says which it was, and does not call it a refused login", async () => {
  const cases: [string, string][] = [
    ['Digest realm="x", nonce="n", algorithm=SHA-256, qop="auth"', "algorithm SHA-256"],
    ['Digest realm="x", nonce="n", algorithm=MD5-sess, qop="auth"', "algorithm MD5-SESS"],
    ['Digest realm="x", nonce="n", qop="auth-int"', "qop auth-int"],
  ];
  for (const [challenge, named] of cases) {
    const cam = await fakeCamera(() => ({ reply: rtspReply("401 Unauthorized", [`WWW-Authenticate: ${challenge}`]) }));
    const result = await probeFeed(target(cam.port, "/BOX", "admin", "pw"));
    assert.deepEqual(result, { state: "failed", reason: `The camera asks for a login method this check can't use (${named})` }, challenge);
    assert.equal(cam.seen.length, 1, "no guess is sent");
  }
});

test("a Digest this check cannot do falls to Basic when the camera offers that too", async () => {
  const cam = await fakeCamera((req) =>
    req.headers.get("authorization")?.startsWith("Basic ")
      ? { reply: rtspReply("200 OK", [], SDP_H264) }
      : { reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Digest realm="x", nonce="n", algorithm=SHA-256', 'WWW-Authenticate: Basic realm="x"']) },
  );
  assert.equal((await probeFeed(target(cam.port, "/BOX", "admin", "pw"))).state, "ready");
});

test("qop offered as 'auth, auth-int' is answered with auth", async () => {
  const cam = await fakeCamera((req) =>
    req.headers.get("authorization")?.includes("qop=auth,")
      ? { reply: rtspReply("200 OK", [], SDP_H264) }
      : { reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Digest realm="x", nonce="n", qop="auth,auth-int"']) },
  );
  assert.equal((await probeFeed(target(cam.port, "/BOX", "admin", "pw"))).state, "ready");
});

test("line breaks in the username, realm, nonce and opaque never reach the Authorization header", async () => {
  const challenge = ['Digest realm="a\r\nX-Injected-Realm: 1"', 'nonce="b\r\nX-Injected-Nonce: 1"', 'opaque="c\r\nX-Injected-Opaque: 1"', 'qop="auth"'].join(", ");
  const answer = authorizationFor([challenge], { url: "rtsp://h/x", username: "admin\r\nX-Injected-User: 1", password: "pw" }, "DESCRIBE", "rtsp://h/x");
  assert.ok(answer && "header" in answer);
  assert.equal(/[\r\n]/.test(answer.header), false, "a line break reached the header");
  assert.match(answer.header, /^Digest username="adminX-Injected-User: 1"/);
});

test("on the wire, a username with a line break adds no header to the request", async () => {
  const cam = await fakeCamera((req) =>
    req.headers.has("authorization")
      ? { reply: rtspReply("200 OK", [], SDP_H264) }
      : { reply: rtspReply("401 Unauthorized", ['WWW-Authenticate: Digest realm="x", nonce="n"']) },
  );
  await probeFeed(target(cam.port, "/BOX", "admin\r\nX-Injected: 1", "pw"));
  assert.equal(cam.seen[1]!.headers.has("x-injected"), false, "the line break started a header of its own");
});

// ── Redirects, IPv6, and not holding anything open ──────────────────────────

test("an HLS redirect is shown as the camera's own status, not followed", async () => {
  const hls = await fakeHls((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere.m3u8" });
    res.end();
  });
  assert.deepEqual(await probeFeed(hlsTarget(hls.port)), { state: "failed", reason: "The camera answered 302 Found" });
  assert.equal(hls.requests.length, 1);
});

async function listenOnLoopback6(handler: http.RequestListener): Promise<{ port: number } | null> {
  const server = http.createServer(handler);
  httpServers.push(server);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch {
    return null;
  }
  return { port: (server.address() as net.AddressInfo).port };
}

test("a bracketed IPv6 HLS address is reachable, and the reason still shows it bracketed", async (t) => {
  const v6 = await listenOnLoopback6((_req, res) => res.end("#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\nx.m3u8\n"));
  if (!v6) return t.skip("this machine has no IPv6 loopback");
  assert.deepEqual(await probeFeed({ url: `http://[::1]:${v6.port}/live/index.m3u8`, username: "", password: "" }), { state: "ready", width: 1280, height: 720 });
  const refused = await probeFeed({ url: "http://[::1]:1/live/index.m3u8", username: "", password: "" });
  assert.deepEqual(refused, { state: "failed", reason: "[::1] refused the connection on port 1" });
});

test("an RTSP camera that floods without ever finishing a reply is a quick failure, not a wait for the timeout", async () => {
  const cam = await fakeCamera(() => "silent");
  // Replace the silent behaviour with a flood on connect.
  const flood = net.createServer((socket) => {
    openSockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => openSockets.delete(socket));
    socket.on("data", () => {
      const junk = Buffer.alloc(32 * 1024, 0x61);
      for (let i = 0; i < 16; i++) socket.write(junk);
    });
  });
  servers.push(flood);
  await new Promise<void>((resolve) => flood.listen(0, "127.0.0.1", resolve));
  void cam;
  const started = Date.now();
  const result = await probeFeed(target((flood.address() as net.AddressInfo).port), 3000);
  assert.deepEqual(result, { state: "failed", reason: "127.0.0.1 answered with more than a camera should · check the address" });
  assert.ok(Date.now() - started < 1500, "it read until the timeout instead of stopping at the cap");
});

test("an HLS server that never stops sending is a quick failure with the same reason", async () => {
  const hls = await fakeHls((_req, res) => {
    res.write("#EXTM3U\n");
    const timer = setInterval(() => res.write("#".repeat(32 * 1024)), 1);
    res.on("close", () => clearInterval(timer));
  });
  const started = Date.now();
  const result = await probeFeed(hlsTarget(hls.port), 3000);
  assert.deepEqual(result, { state: "failed", reason: "127.0.0.1 answered with more than a camera should · check the address" });
  assert.ok(Date.now() - started < 1500, "it read until the timeout instead of stopping at the cap");
});

/** Waits (briefly) for the fake server's side of every connection to be closed. */
async function closedWithin(sockets: Set<net.Socket>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (sockets.size > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return sockets.size === 0;
}

test("the probe closes its connection once it has a result, whichever result it is", async () => {
  const cases: [string, Behaviour][] = [
    ["a ready answer", { reply: rtspReply("200 OK", [], SDP_H264) }],
    ["a 404", { reply: rtspReply("404 Not Found") }],
  ];
  for (const [what, behaviour] of cases) {
    const cam = await fakeCamera(() => behaviour);
    await probeFeed(target(cam.port));
    assert.equal(await closedWithin(cam.sockets, 1000), true, `the connection was left open after ${what}`);
  }
  const silent = await fakeCamera(() => "silent");
  await probeFeed(target(silent.port), 200);
  assert.equal(await closedWithin(silent.sockets, 1000), true, "the connection was left open after the timeout");

  const hls = await fakeHls((_req, res) => res.end("#EXTM3U\n"));
  await probeFeed(hlsTarget(hls.port));
  assert.equal(await closedWithin(hls.sockets, 1000), true, "the HLS connection was left open after a playlist");
});

test("the probe leaves no timer running once it has a result, so a long timeout is not held for", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const cam = await fakeCamera(() => ({ reply: rtspReply("200 OK", [], SDP_H264) }));
  const hls = await fakeHls((_req, res) => res.end("#EXTM3U\n"));
  const before = timers();
  await probeFeed(target(cam.port), 60_000);
  await probeFeed(hlsTarget(hls.port), 60_000);
  assert.ok(timers() <= before, `${timers() - before} timer(s) from a probe still pending`);
});
