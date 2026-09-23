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
  /** The six-second wall-clock ceiling, in milliseconds, so the trickle case
   *  takes one. */
  protected override get probeDeadlineMs(): number {
    return 400;
  }
  protected override noteWebSocketDown(reason: string, detail: string | null = null, stillOnFallback = false): void {
    this.downs.push({ reason, detail });
    super.noteWebSocketDown(reason, detail, stillOnFallback);
  }
  /** A reconnect, as scheduleReconnect() would run it. */
  public reconnectNow(): Promise<void> {
    return this.connect();
  }
}

/** How the server answers the PROBE's upgrade request. The real client's upgrade
 *  is always dropped, so the client always reaches the never-opened path. */
type ProbeAnswer = "refuse-426" | "accept-101" | "drop" | "trickle" | "flood";

async function serverAnswering(answer: ProbeAnswer): Promise<{
  port: number;
  upgrades: { userAgent: string | undefined }[];
  sseOpens: () => number;
  probeSocketClosed: () => boolean;
  close(): Promise<void>;
}> {
  const upgrades: { userAgent: string | undefined }[] = [];
  const open = new Set<Duplex>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  let sseOpens = 0;
  /** Whether the client has dropped the probe's connection. Read off this end's
   *  socket rather than polling `destroyed`: a peer that destroys its half shows
   *  up here as 'close', or as the EPIPE the next write takes. */
  let probeSocketGone = false;
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/v1/transcript/stream")) {
      sseOpens++;
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
    socket.on("close", () => (probeSocketGone = true));
    socket.on("error", () => (probeSocketGone = true));
    if (answer === "drop") {
      socket.destroy();
      return;
    }
    if (answer === "trickle" || answer === "flood") {
      // A refusal whose body never ends. Chunked, so there is no content-length
      // to finish on, and every chunk resets Node's inactivity timeout — which
      // is the whole reason the probe needs a wall-clock deadline as well.
      socket.write(
        "HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/plain\r\n" +
          "transfer-encoding: chunked\r\nConnection: close\r\n\r\n",
      );
      const piece = answer === "flood" ? "x".repeat(64) : ".";
      const every = answer === "flood" ? 5 : 60;
      const timer = setInterval(() => {
        if (socket.destroyed) {
          clearInterval(timer);
          timers.delete(timer);
          return;
        }
        socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
      }, every);
      timer.unref?.();
      timers.add(timer);
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
    sseOpens: () => sseOpens,
    probeSocketClosed: () => probeSocketGone,
    close: async () => {
      for (const t of timers) clearInterval(t);
      timers.clear();
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

  it("gives up on a refusal whose body never ends, and opens the fallback anyway", async (t) => {
    // THE CASE THAT COST THE CAPTIONS. Node's `timeout` option measures socket
    // INACTIVITY, so a chunked body trickling forever resets it on every chunk:
    // the probe never settled, the fallback never opened, and the single-flight
    // flag stayed set so no later refusal could probe either. Reproduced with a
    // 503 and one chunk per interval — the deadline is what ends it.
    const server = await serverAnswering("trickle");
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await server.close();
    });
    svc.configure("127.0.0.1", server.port, null);

    await eventually(() => svc.downs.length > 0, "the fallback decision to be made", 3000);
    await eventually(() => server.sseOpens() > 0, "the SSE fallback to open", 3000);
    // No status to report — the body never finished — so the bare close reason
    // stands rather than a half-read one.
    assert.match(svc.downs[0]!.reason, /closed before open \(code \d+\)$/);
    assert.equal(probes(server), 1, "one probe per refusal, even when it has to be abandoned");
  });

  it("stops reading once it has enough of the body to name the refusal", async (t) => {
    // The same endless body, arriving fast. There is nothing to learn past
    // PROBE_BODY_BYTES, so the probe finishes on the bytes rather than waiting
    // out its deadline — the status IS reported here, unlike the trickle above.
    const server = await serverAnswering("flood");
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await server.close();
    });
    const started = Date.now();
    svc.configure("127.0.0.1", server.port, null);

    await eventually(() => svc.downs.length > 0, "the fallback decision to be made", 3000);
    assert.equal(svc.downs[0]!.reason, "upgrade refused with HTTP 503 (Service Unavailable)");
    assert.ok(
      Date.now() - started < 400,
      "the probe read to the end of an endless body instead of stopping at the cap",
    );
    assert.ok((svc.downs[0]!.detail ?? "").length <= 200, "more than the cap reached the log line");
  });

  it("stop() during a probe takes the probe's socket with it", async (t) => {
    const server = await serverAnswering("trickle");
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await server.close();
    });
    svc.configure("127.0.0.1", server.port, null);
    await eventually(() => probes(server) === 1, "the probe to go out");
    // The SSE fallback is already live by now — connect() opens it beside the
    // WebSocket attempt from the start. What stop() must prevent is the probe's
    // eventual (stale) answer opening ANOTHER one once this service has let go.
    const sseOpensBeforeStop = server.sseOpens();

    svc.stop();
    // Within a fraction of the probe's own deadline, which is 400 ms here: the
    // deadline would eventually destroy this socket on its own, so a generous
    // window would pass whether or not teardown() does anything. What is under
    // test is that STOPPING takes the socket with it.
    await eventually(() => server.probeSocketClosed(), "the probe socket to be destroyed by stop()", 150);
    assert.equal(
      server.sseOpens(),
      sseOpensBeforeStop,
      "a stopped service's stale probe answer opened another fallback stream",
    );
  });

  it("a second refusal while a probe is in flight does not start a second probe", async (t) => {
    // Two sockets closing before open — a reconnect landing on top of one that
    // is still being diagnosed — must not put a second request on a box that is
    // already unhappy. The trickle server holds the first probe open for the
    // length of its deadline, which is the window this needs.
    const server = await serverAnswering("trickle");
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await server.close();
    });
    svc.configure("127.0.0.1", server.port, null);
    await eventually(() => probes(server) === 1, "the first probe to go out");

    // A second attempt, refused the same way, while the first probe is still
    // reading.
    await svc.reconnectNow();
    await eventually(() => svc.downs.length > 0, "a fallback decision", 3000);
    assert.equal(probes(server), 1, "a second probe went out while one was already in flight");
  });

  it("a probe from a previous connection does not open a fallback for the new one", async (t) => {
    // configure() to a different box while a probe is in flight. The probe's
    // answer is about the OLD host, and acting on it would open a transcript
    // stream against a box this service has already been pointed away from.
    const old = await serverAnswering("trickle");
    const next = await serverAnswering("refuse-426");
    const svc = new TestProdCom();
    t.after(async () => {
      svc.stop();
      await old.close();
      await next.close();
    });

    svc.configure("127.0.0.1", old.port, null);
    await eventually(() => probes(old) === 1, "the probe against the old box");
    // The old box's OWN fallback opened at connect(), same as any other — that is
    // not what this guards. What must not happen is the stale probe's answer,
    // arriving after we have moved on, opening ANOTHER one against it.
    const oldSseAtSwitch = old.sseOpens();
    svc.configure("127.0.0.1", next.port, null); // the operator repoints it

    await eventually(() => next.sseOpens() > 0, "the NEW box's fallback to open", 3000);
    assert.equal(
      old.sseOpens(),
      oldSseAtSwitch,
      "the old box's stale probe answer opened another stream against a box we have left",
    );
  });

  it("does not probe a socket that opened and dropped without ever delivering", async (t) => {
    // A socket that completed the handshake is not a refusal, so it must never
    // reach the probe — that diagnosis is for a socket that never opened at all,
    // and probing this one would put an extra request on the box on every
    // ordinary drop. It is still unproven, though (nothing here ever delivered a
    // transcript entry), so it is worth ONE outage line same as a refusal would
    // be — the SSE fallback carried captions the whole time regardless.
    const { stub, svc } = await onARealWebSocket(t);
    await eventually(() => svc.wsOpenNow, "the websocket to open");
    const before = stub.requests.filter((r) => r.headers["user-agent"] === PROBE_USER_AGENT).length;
    stub.wsDropAll();
    await eventually(() => !svc.wsOpenNow, "the drop to be noticed");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      stub.requests.filter((r) => r.headers["user-agent"] === PROBE_USER_AGENT).length,
      before,
      "a socket that had opened was diagnosed with a refused-upgrade probe",
    );
    assert.equal(svc.downs.length, 1, "an unproven socket dropping was not reported as the websocket being unavailable");
    assert.doesNotMatch(
      svc.downs[0]!.reason,
      /closed before open/,
      "a socket that had opened was described as one that never did",
    );
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
  /** Whether a WebSocket attempt is currently open, proven or not. */
  public get wsOpenNow(): boolean {
    return this.wsAttemptOpen;
  }
}
