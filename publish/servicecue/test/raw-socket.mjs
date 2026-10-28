// raw-socket.mjs — a WebSocket client with nothing between it and the wire.
//
// The runtime's own WebSocket will not send a header of its choosing, a close code it
// does not allow or a frame it does not make, and a hostile client does all three. This
// speaks RFC 6455 by hand (client frames masked, server frames not), so a test can send
// the Worker what a script would.

import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One open socket. `messages` is every text message received, `closed` how the server ended it, if it has. */
export class RawSocket {
  messages = [];
  closed = null;
  #buffer = Buffer.alloc(0);

  constructor(socket) {
    this.socket = socket;
    socket.on("data", (chunk) => this.#read(chunk));
    socket.on("close", () => (this.closed ??= { code: 1006, reason: "the connection dropped" }));
    socket.on("error", () => {});
  }

  /** The messages that are frames (JSON), not the answer to a ping. */
  frames() {
    return this.messages.filter((m) => m !== "pong").map((m) => JSON.parse(m));
  }

  #read(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const b = this.#buffer;
      if (b.length < 2) return;
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) return;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) return;
        length = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      if (b.length < offset + length) return;
      const opcode = b[0] & 0x0f;
      const payload = b.subarray(offset, offset + length);
      this.#buffer = b.subarray(offset + length);
      if (opcode === 1) this.messages.push(payload.toString("utf8"));
      else if (opcode === 8) {
        this.closed = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString("utf8") };
        // Answer a close with a close, as a polite client does; the tests that care send their own first.
        if (!this.socket.destroyed) this.socket.end(this.#frame(8, payload.subarray(0, 2)));
      } else if (opcode === 9) this.socket.write(this.#frame(10, payload));
    }
  }

  /** A client frame: masked, as the protocol requires of one. */
  #frame(opcode, payload) {
    const mask = randomBytes(4);
    const header =
      payload.length < 126
        ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
        : Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    return Buffer.concat([header, mask, masked]);
  }

  sendText(text) {
    this.socket.write(this.#frame(1, Buffer.from(text, "utf8")));
  }

  sendBinary(bytes) {
    this.socket.write(this.#frame(2, Buffer.from(bytes)));
  }

  /** A close frame with any code at all, the reserved ones included. */
  sendClose(code, reason = "") {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.socket.write(this.#frame(8, payload));
  }

  /** Hang up without a word. */
  destroy() {
    this.socket.destroy();
  }

  /** Wait until `check(this)` is true, or say what never came. */
  async until(check, what, ms = 5000) {
    const deadline = Date.now() + ms;
    while (!check(this)) {
      if (Date.now() > deadline) throw new Error(`never got ${what}; got ${JSON.stringify(this.messages)} closed=${JSON.stringify(this.closed)}`);
      await sleep(10);
    }
  }
}

/**
 * Open the live socket. Resolves `{ socket }` for a 101, or `{ status, body, headers }` for any
 * other answer. `headers` are added to the handshake: an Origin, or the address a Cloudflare edge
 * would have set (`CF-Connecting-IP`, which a local runtime takes from the client).
 */
export function open(base, headers = {}, path = "/api/live") {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const req = request({
      host: hostname,
      port,
      path,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, ...headers },
    });
    req.once("upgrade", (res, socket, head) => {
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      if (res.headers["sec-websocket-accept"] !== accept) return reject(new Error("the server's handshake answer is not for this key"));
      const raw = new RawSocket(socket);
      if (head.length > 0) raw.socket.emit("data", head);
      resolve({ socket: raw });
    });
    req.once("response", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.once("error", reject);
    req.end();
  });
}
