// A kicked OBS session must stay kicked.
//
// obs-websocket documents close code 4011 (`SessionInvalidated`) as "you must not
// automatically reconnect", and it is what the **Kick** button in OBS's session
// list sends. The adapter threw the close code away and the service called
// scheduleReconnect() unconditionally, so kicking the session started a loop: the
// operator pressed Kick, the app came straight back, and the only way out was to
// turn the integration off.
//
// THIS DRIVES A REAL SOCKET. The bug lived in the handover between two files —
// obs-protocol dropping the code and obs-service not asking for it — and a unit
// test of either half passes while the loop runs. So the test below stands up an
// obs-websocket v5 server (RFC 6455 handshake, real frames, real close codes),
// points the real service at it, and counts how many times the service comes
// back.
//
// The control case is the part that makes this a guard rather than a delay: a
// close with an ordinary code MUST produce a reconnect inside the same window, or
// "no reconnect after 4011" would be satisfied by the app simply being slow.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-obs-close-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { obsService } = await import("./obs-service.js");
const { standDownReason, OBS_STAND_DOWN_CODES } = await import("./obs-protocol.js");

// ── A WebSocket server, small enough to read ────────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One server-to-client frame. Server frames are never masked. */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

/** Client-to-server frames, which ARE masked. Returns whatever is left over. */
function readFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const opcode = buf[off] & 0x0f;
    const masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    let mask: Buffer | null = null;
    if (masked) {
      if (buf.length - p < 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length - p < len) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Enough of obs-websocket v5 to be connected to, and to hang up rudely. */
class FakeObs {
  private server: Server = createServer();
  private sockets: Duplex[] = [];
  /** One entry per accepted upgrade — i.e. per connection attempt the service made. */
  readonly attempts: number[] = [];
  port = 0;
  /** Close the socket with this code instead of answering Identify. */
  refuseIdentifyWith: number | null = null;

  async listen(): Promise<void> {
    this.server.on("upgrade", (req, socket) => this.accept(req.headers["sec-websocket-key"] as string, socket));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
  }

  private accept(key: string, socket: Duplex): void {
    this.attempts.push(Date.now());
    this.sockets.push(socket);
    socket.on("error", () => {
      /* the client hanging up is the point of half these tests */
    });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WS_GUID).digest("base64")}\r\n\r\n`,
    );
    this.send(socket, { op: 0, d: { obsWebSocketVersion: "5.5.0", rpcVersion: 1 } });

    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const { frames: got, rest } = readFrames(Buffer.concat([pending, chunk]));
      pending = Buffer.from(rest);
      for (const f of got) {
        if (f.opcode !== 0x1) continue;
        this.onMessage(socket, JSON.parse(f.payload.toString("utf8")) as { op?: number; d?: Record<string, unknown> });
      }
    });
  }

  private onMessage(socket: Duplex, msg: { op?: number; d?: Record<string, unknown> }): void {
    if (msg.op === 1) {
      if (this.refuseIdentifyWith != null) {
        this.hangUp(socket, this.refuseIdentifyWith);
        return;
      }
      this.send(socket, { op: 2, d: { negotiatedRpcVersion: 1 } });
      return;
    }
    if (msg.op === 6) {
      const requestType = String(msg.d?.requestType ?? "");
      const responseData: Record<string, unknown> =
        requestType === "GetRecordStatus"
          ? { outputActive: false, outputPaused: false, outputTimecode: "00:00:00.000", outputDuration: 0 }
          : requestType === "GetVersion"
            ? { obsVersion: "31.0.0", obsWebSocketVersion: "5.5.0" }
            : { outputActive: false };
      this.send(socket, {
        op: 7,
        d: { requestType, requestId: msg.d?.requestId, requestStatus: { result: true, code: 100 }, responseData },
      });
    }
  }

  private send(socket: Duplex, msg: unknown): void {
    socket.write(frame(0x1, Buffer.from(JSON.stringify(msg))));
  }

  private hangUp(socket: Duplex, code: number): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    socket.write(frame(0x8, payload));
    socket.end();
  }

  /** What OBS's Kick button does, with whatever code the test wants. */
  closeAll(code: number): void {
    for (const s of this.sockets) if (!s.destroyed) this.hangUp(s, code);
  }

  reset(): void {
    this.attempts.length = 0;
    for (const s of this.sockets) s.destroy();
    this.sockets.length = 0;
    this.refuseIdentifyWith = null;
  }

  async close(): Promise<void> {
    this.reset();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const fake = new FakeObs();

/**
 * Long enough for a reconnect to have happened and be visible.
 *
 * The backoff is shortened to 100ms below so this file does not spend thirty
 * seconds waiting out the real 3-second base. `capDelayMs` puts a 1-second floor
 * under a delay when a service schedule is loaded and none is here, so the window
 * is sized to cover both — and the control test is what proves it is wide enough.
 */
const RECONNECT_WINDOW_MS = 1600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForConnected(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (obsService.getLatest().connected) return;
    await sleep(20);
  }
  assert.fail("the service never connected to the stub OBS");
}

before(async () => {
  await fake.listen();
  // The real backoff, just faster. An own accessor shadows the prototype getter,
  // so scheduleReconnect() still does exactly what it does in production.
  Object.defineProperty(obsService, "reconnectBaseMs", { get: () => 100, configurable: true });
});

after(async () => {
  obsService.stop();
  await fake.close();
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

beforeEach(() => {
  obsService.stop();
  fake.reset();
});

describe("a close the service is meant to recover from", () => {
  test("reconnects, which is what makes the 4011 test below mean something", async () => {
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    assert.equal(fake.attempts.length, 1);

    fake.closeAll(1001); // "going away" — OBS restarting, a network blip
    await sleep(RECONNECT_WINDOW_MS);

    assert.ok(
      fake.attempts.length > 1,
      `no reconnect after an ordinary close in ${RECONNECT_WINDOW_MS}ms — the window is too short for the guard below to prove anything`,
    );
  });
});

describe("a close that says do not come back", () => {
  test("4011 SessionInvalidated stands the integration down", async () => {
    // THE BUG. Pressing Kick in OBS used to start a reconnect loop.
    obsService.configure("127.0.0.1", fake.port, null);
    await waitForConnected();
    assert.equal(fake.attempts.length, 1);

    fake.closeAll(4011);
    await sleep(RECONNECT_WINDOW_MS);

    assert.equal(
      fake.attempts.length,
      1,
      `the service reconnected ${fake.attempts.length - 1} time(s) after a 4011 kick — obs-websocket documents 4011 as "you must not automatically reconnect"`,
    );
    assert.equal(obsService.getLatest().connected, false, "it stood down but still reported itself connected");
  });

  test("4009 AuthenticationFailed does not retry a password that will not change", async () => {
    // This one closes BEFORE the handshake finishes, so it reaches the service
    // as a rejected connect() rather than through onClose — a separate path that
    // had the same unconditional retry on it.
    fake.refuseIdentifyWith = 4009;
    obsService.configure("127.0.0.1", fake.port, "wrong-password");
    await sleep(RECONNECT_WINDOW_MS);

    assert.equal(
      fake.attempts.length,
      1,
      `retried a rejected password ${fake.attempts.length - 1} time(s); it will be rejected every time`,
    );
  });

  test("4010 UnsupportedRpcVersion does not retry an RPC version that will not change", async () => {
    fake.refuseIdentifyWith = 4010;
    obsService.configure("127.0.0.1", fake.port, null);
    await sleep(RECONNECT_WINDOW_MS);

    assert.equal(fake.attempts.length, 1, "retried an RPC version OBS has already refused");
  });

  test("a code OBS never sends is not treated as a stand-down", async () => {
    // 4002-4008 and 4012 describe a MESSAGE this client got wrong, not a session
    // that is over. Retrying is right for them, and for anything undocumented.
    fake.refuseIdentifyWith = 4008; // AlreadyIdentified
    obsService.configure("127.0.0.1", fake.port, null);
    await sleep(RECONNECT_WINDOW_MS);

    assert.ok(fake.attempts.length > 1, "stood down on a code that only describes a bad message");
  });
});

describe("the stand-down table", () => {
  test("holds exactly the three codes a retry cannot help", () => {
    // EXACT, not a floor. Values from obs-websocket protocol.md's
    // WebSocketCloseCode enum: 4009 AuthenticationFailed, 4010
    // UnsupportedRpcVersion, 4011 SessionInvalidated.
    assert.deepEqual([...OBS_STAND_DOWN_CODES.keys()].sort(), [4009, 4010, 4011]);
  });

  test("an absent code is not a stand-down", () => {
    // Our own close() passes no code. Reading that as "OBS told us to go away"
    // would make every teardown permanent.
    for (const code of [null, undefined, 1000, 1006, 4000, 4008, 4012]) {
      assert.equal(standDownReason(code), null, `close code ${String(code)} was read as a stand-down`);
    }
  });
});
