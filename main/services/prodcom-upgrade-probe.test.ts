// A refused WebSocket upgrade says which HTTP status it was refused with.
//
// Node's WebSocket exposes NO HTTP status for a refused handshake: a 426, a 401
// and a box with no such route all surface as `close` with code 1006 and an empty
// reason. So for two days in September 2026 the only evidence that ProdCom was
// refusing every upgrade was `[prodcom] websocket unavailable (closed before open
// (code 1006))`, which cannot tell "the API is off" from "the key is wrong" from
// "this build is too old" — the three things an operator would act on
// differently. The client now asks the same URL over plain HTTP once per refusal
// and reports what came back.
//
// Every case here runs the real client against an in-process server, and nothing
// on the network is contacted. The server is written here rather than reusing
// fixtures/prodcom-stub.ts because what is under test is the HANDSHAKE: each case
// needs to answer the client's upgrade and the probe's differently, which the
// stub deliberately does not do.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import { describe, it, type TestContext } from "node:test";

import { ProdComService, PROBE_USER_AGENT } from "./prodcom-service.js";

/** RFC 6455's fixed handshake GUID. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type Down = { reason: string; detail: string | null };

class TestProdCom extends ProdComService {
  public readonly downs: Down[] = [];
  /** Far beyond any case here: one connection attempt per test, no retry loop
   *  putting extra probes on the server while an assertion is being made. */
  protected override get reconnectMs(): number {
    return 60_000;
  }
  protected override get wsRetryIntervalMs(): number {
    return 60_000;
  }
  protected override noteWebSocketDown(reason: string, detail: string | null = null): void {
    this.downs.push({ reason, detail });
    super.noteWebSocketDown(reason, detail);
  }
}

/** How the server answers the PROBE's upgrade request. The real client's upgrade
 *  is always dropped, so the client always reaches the never-opened path. */
type ProbeAnswer = "refuse-426" | "accept-101" | "drop";

async function serverAnswering(answer: ProbeAnswer): Promise<{
  port: number;
  upgrades: { userAgent: string | undefined }[];
  close(): Promise<void>;
}> {
  const upgrades: { userAgent: string | undefined }[] = [];
  const open = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/v1/transcript/stream")) {
      // The fallback the client opens after falling back: answered, and then it
      // sits there saying nothing for the length of the test.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    // Everything the client primes from, answered and ENDED. An unended 200 here
    // leaves getJson waiting out its own four-second timeout, which holds the
    // server sockets open and turns a 5 ms test into a 4 s one.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [], meta: { hasMore: false } }));
  });

  server.on("upgrade", (req, socket: Duplex) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    const ua = req.headers["user-agent"];
    upgrades.push({ userAgent: Array.isArray(ua) ? ua[0] : ua });
    if (ua !== PROBE_USER_AGENT) {
      socket.destroy(); // the real client: closes before open, code 1006
      return;
    }
    if (answer === "drop") {
      socket.destroy();
      return;
    }
    if (answer === "accept-101") {
      const key = String(req.headers["sec-websocket-key"] ?? "");
      const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      return;
    }
    // ProdCom 2.3.2's own refusal, body and all.
    const body = JSON.stringify({ error: { code: "UPGRADE_REQUIRED", message: "WebSocket API is disabled" } });
    socket.write(
      "HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    socket.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    upgrades,
    close: async () => {
      for (const s of open) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function eventually(ready: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function against(t: TestContext, answer: ProbeAnswer) {
  const server = await serverAnswering(answer);
  const svc = new TestProdCom();
  t.after(async () => {
    svc.stop();
    await server.close();
  });
  svc.configure("127.0.0.1", server.port, null);
  await eventually(() => svc.downs.length > 0, "the fallback decision to be made");
  return { server, svc };
}

const probes = (server: { upgrades: { userAgent: string | undefined }[] }): number =>
  server.upgrades.filter((u) => u.userAgent === PROBE_USER_AGENT).length;

describe("a refused upgrade is diagnosed before falling back", () => {
  it("names the status and its meaning when the box refuses", async (t) => {
    const { server, svc } = await against(t, "refuse-426");

    // The guard: without the probe this reads "closed before open (code 1006)",
    // which is what shipped and what said nothing for two days.
    assert.equal(svc.downs[0]!.reason, "upgrade refused with HTTP 426 (Upgrade Required)");
    // Stable per status, because noteWebSocketDown de-duplicates by reason KIND:
    // nothing in it varies per attempt.
    assert.ok(!/\d{4}-\d{2}-\d{2}|bytes|ms\b/.test(svc.downs[0]!.reason), "the reason must not vary per attempt");
    // What the box said rides alongside, not inside the reason.
    assert.equal(svc.downs[0]!.detail, '{"error":{"code":"UPGRADE_REQUIRED","message":"WebSocket API is disabled"}}');
    assert.equal(probes(server), 1, "one probe per refusal");
  });

  it("says the handshake was fine when a probe is accepted", async (t) => {
    // A different bug from a refusal: the upgrade works and the socket dies
    // after it, so an operator should not go looking at the API setting.
    const { server, svc } = await against(t, "accept-101");
    assert.match(svc.downs[0]!.reason, /^upgrade accepted by a probe but the WebSocket closed before open \(code \d+\)$/);
    assert.equal(svc.downs[0]!.detail, null);
    assert.equal(probes(server), 1);
  });

  it("says the probe itself could not connect", async (t) => {
    const svc = new TestProdCom();
    t.after(() => svc.stop());
    // A port with nothing on it: the client cannot upgrade and the probe cannot
    // even connect. Bound and released first, so the port is genuinely free.
    const dead = await serverAnswering("drop");
    const port = dead.port;
    await dead.close();

    svc.configure("127.0.0.1", port, null);
    await eventually(() => svc.downs.length > 0, "the fallback decision to be made");
    assert.match(svc.downs[0]!.reason, /^probe failed: /);
    assert.equal(svc.downs[0]!.detail, null);
  });

  it("falls back on the bare reason when the probe answers nothing at all", async (t) => {
    // The server drops the probe's socket without writing a response: there is
    // no status to report, and the fallback must still open.
    const { svc } = await against(t, "drop");
    assert.match(svc.downs[0]!.reason, /^(probe failed: |closed before open \(code )/);
  });

  it("does not probe when the WebSocket was up and dropped normally", async (t) => {
    // The normal-drop path retries the same transport and never falls back, so
    // there is nothing to diagnose — and a probe there would put an extra
    // request on the box on every ordinary reconnect.
    const { stub, svc } = await onARealWebSocket(t);
    await eventually(() => svc.onWebSocketNow, "the websocket to be the live transport");
    const before = stub.requests.filter((r) => r.headers["user-agent"] === PROBE_USER_AGENT).length;
    stub.wsDropAll();
    await eventually(() => !svc.onWebSocketNow, "the drop to be noticed");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      stub.requests.filter((r) => r.headers["user-agent"] === PROBE_USER_AGENT).length,
      before,
      "a normal drop was diagnosed as a refusal",
    );
    assert.deepEqual(svc.downs, [], "a normal drop must not be reported as the websocket being unavailable");
  });
});

/** The accepting stub, for the one case that needs the WebSocket to come UP
 *  first. */
async function onARealWebSocket(t: TestContext) {
  const { startProdComStub } = await import("./fixtures/prodcom-stub.js");
  const stub = await startProdComStub({ channels: [] });
  const svc = new WsTestProdCom();
  t.after(async () => {
    svc.stop();
    await stub.close();
  });
  svc.configure("127.0.0.1", stub.port, null);
  return { stub, svc };
}

class WsTestProdCom extends TestProdCom {
  public get onWebSocketNow(): boolean {
    return this.onWebSocketTransport;
  }
}
