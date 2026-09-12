// obs-server-harness.ts — enough of obs-websocket v5 to be connected to.
//
// NOT shipped code and not a test file: a harness two OBS test files share, the
// way routes/route-harness.ts is shared. Both of them need to drive the REAL
// service over a REAL socket, because both bugs they guard lived in the handover
// between obs-protocol and obs-service and a unit test of either half passes:
//
//   obs-close-code.test.ts   a 4011 kick must not be reconnected to
//   obs-record-clock.test.ts the record timecode must tick with no traffic
//
// It speaks RFC 6455 directly (handshake, masked client frames, unmasked server
// frames, close frames with a code) rather than pulling in a WebSocket server
// dependency for two test files. Node ships a client, not a server.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** What OBS answers `GetRecordStatus` with when nothing is recording. */
const IDLE_RECORD_STATUS: Record<string, unknown> = {
  outputActive: false,
  outputPaused: false,
  outputTimecode: "00:00:00.000",
  outputDuration: 0,
};

/** One server-to-client frame. Server frames are never masked. */
export function frame(opcode: number, payload: Buffer): Buffer {
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
export function readFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
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

export class FakeObs {
  private server: Server = createServer();
  private sockets: Duplex[] = [];
  /** One entry per accepted upgrade — i.e. per connection attempt the service made. */
  readonly attempts: number[] = [];
  /** Every requestType asked for, in order. The record-clock guard counts these. */
  readonly requests: string[] = [];
  port = 0;
  /** Close the socket with this code instead of answering Identify. */
  refuseIdentifyWith: number | null = null;
  /** What `GetRecordStatus` answers. Mutated by the test between phases, and put
   *  back by `reset()` — a recording left running by one test seeds the NEXT
   *  test's connect as already recording, which is a whole class of false
   *  positive in a file whose subject is how much a recording costs. */
  recordStatus: Record<string, unknown> = { ...IDLE_RECORD_STATUS };

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
      this.requests.push(requestType);
      const responseData: Record<string, unknown> =
        requestType === "GetRecordStatus"
          ? { ...this.recordStatus }
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

  /** Push an op-5 event to every connected client, the way OBS does. */
  pushEvent(eventType: string, eventData: Record<string, unknown>): void {
    for (const s of this.sockets) {
      if (!s.destroyed) this.send(s, { op: 5, d: { eventType, eventIntent: 64, eventData } });
    }
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
    this.requests.length = 0;
    this.recordStatus = { ...IDLE_RECORD_STATUS };
    for (const s of this.sockets) s.destroy();
    this.sockets.length = 0;
    this.refuseIdentifyWith = null;
  }

  async close(): Promise<void> {
    this.reset();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
