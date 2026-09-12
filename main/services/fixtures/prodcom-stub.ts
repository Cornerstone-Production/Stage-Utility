// prodcom-stub.ts — a local ProdCom, faithful enough to test the real client
// against.
//
// Everything here was measured against ProdCom 2.3.2 on the LAN before it was
// written, and the two behaviours that matter most are the ones the box gets
// subtly wrong rather than the ones it gets right:
//
//   `?since=` is honoured for `2026-09-11T00:00:00Z` and for the `+00:00` offset
//   form, and SILENTLY IGNORED for `2026-09-11T00:00:00.000Z` — the exact string
//   `Date#toISOString()` produces. Ignored means no error and no warning: the
//   response is the whole history from the oldest row. That is modelled here
//   (see `SECOND_PRECISION_ISO`), and it is what makes the backfill guard fail
//   when the client sends milliseconds.
//
//   The WebSocket heartbeat is `{"type":"ping"}`, not the `{"type":"heartbeat"}`
//   the published spec describes, and it arrives every 30 s whether or not
//   anything is happening. The transcript SSE stream, by contrast, sends nothing
//   at all — 25 minutes held open produced zero bytes.
//
// The WebSocket framing is hand-rolled (server frames unmasked, client frames
// masked, per RFC 6455) because Node ships a WebSocket client but no server and
// this repo has no `ws` dependency. Only what a test needs is implemented: text
// and close frames, no fragmentation, no extensions, no compression.

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Duplex } from "node:stream";

/** RFC 6455's fixed handshake GUID. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * The only `since` shapes ProdCom 2.3.2 actually filters on.
 *
 * Whole seconds, `Z` or a `+hh:mm` offset. A fractional-second timestamp does
 * not match, and the box then behaves as though no `since` had been sent.
 */
const SECOND_PRECISION_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/;

/** A row as `GET /api/v1/transcript` returns it. Field names are the spec's. */
export type StubEntry = {
  id: string;
  channelId: string;
  channelName?: string;
  text: string;
  source?: "audio" | "typed" | "automation";
  inProgress?: boolean;
  date: string;
  completeDate?: string;
  hasBeenSeen?: boolean;
  triggeredAutomations?: string[];
};

/** A channel as `GET /api/v1/channels` returns it. */
export type StubChannel = {
  id: string;
  name: string;
  color?: string | null;
  sourceType?: string;
  typingEnabled?: boolean;
  isSelected?: boolean;
  unreadCount?: number;
};

export type StubOptions = {
  /** History for `GET /api/v1/transcript`, ascending oldest → newest. */
  entries?: StubEntry[];
  channels?: StubChannel[];
  /** Refuse the WebSocket upgrade, so the client has to fall back to SSE. */
  refuseWebSocket?: boolean;
  /** When set, every request without `Authorization: Bearer <this>` gets a 401. */
  requireBearer?: string;
  /** Reply 500 to `GET /api/v1/channels`. */
  failChannels?: boolean;
  /** Reply 500 to `GET /api/v1/transcript`. */
  failTranscript?: boolean;
  /** Open the SSE stream and immediately end it, so the client keeps
   *  reconnecting — a box whose transcript stream will not stay up. */
  sseCloseImmediately?: boolean;
};

export type StubRequest = { method: string; url: string; headers: http.IncomingHttpHeaders };

export type ProdComStub = {
  port: number;
  /** Every request the stub saw, in order, including WebSocket upgrades. */
  requests: StubRequest[];
  /** Text frames the client sent over the WebSocket, in order. */
  wsReceived: string[];
  /** How many WebSocket upgrades have been accepted. */
  wsUpgrades: number;
  /** How many SSE streams have been opened. */
  sseOpens: number;
  /** Send a raw text frame on every open WebSocket. */
  wsSend(text: string): void;
  /** Send ProdCom's heartbeat on every open WebSocket. */
  wsPing(): void;
  /** Send a transcript entry, wrapped the way `wrap` says. */
  wsTranscript(entry: StubEntry, wrap?: "top" | "data"): void;
  /** Push one event down every open SSE stream. */
  sseSend(entry: StubEntry): void;
  /** Drop every open WebSocket without a close frame. */
  wsDropAll(): void;
  /** Resolve once at least `n` WebSocket upgrades have been accepted. */
  waitForUpgrades(n: number, timeoutMs?: number): Promise<void>;
  /** Resolve once at least `n` SSE streams have been opened. */
  waitForSse(n: number, timeoutMs?: number): Promise<void>;
  /** Resolve once at least `n` requests match `test`. */
  waitForRequest(test: (r: StubRequest) => boolean, n?: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
};

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Pull whole client frames out of `buf`, returning the text ones and the rest. */
function decodeClientFrames(buf: Buffer): { texts: string[]; closed: boolean; rest: Buffer } {
  const texts: string[] = [];
  let closed = false;
  let cursor = buf;
  for (;;) {
    if (cursor.length < 2) break;
    const opcode = cursor[0] & 0x0f;
    const masked = (cursor[1] & 0x80) !== 0;
    let len = cursor[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (cursor.length < 4) break;
      len = cursor.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (cursor.length < 10) break;
      len = Number(cursor.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? cursor.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (cursor.length < offset + len) break;
    const raw = Buffer.from(cursor.subarray(offset, offset + len));
    if (maskKey) for (let i = 0; i < raw.length; i++) raw[i] ^= maskKey[i % 4];
    cursor = cursor.subarray(offset + len);
    if (opcode === 0x8) closed = true;
    else if (opcode === 0x1) texts.push(raw.toString("utf8"));
  }
  return { texts, closed, rest: cursor };
}

export async function startProdComStub(options: StubOptions = {}): Promise<ProdComStub> {
  const entries = options.entries ?? [];
  const channels = options.channels ?? [];
  const requests: StubRequest[] = [];
  const wsReceived: string[] = [];
  const sockets = new Set<Duplex>();
  const sseStreams = new Set<http.ServerResponse>();
  const open = new Set<import("node:net").Socket>();

  const state = { wsUpgrades: 0, sseOpens: 0 };
  const waiters: (() => void)[] = [];
  const notify = () => {
    for (const w of waiters.splice(0)) w();
  };

  const authorized = (headers: http.IncomingHttpHeaders): boolean =>
    !options.requireBearer || headers["authorization"] === `Bearer ${options.requireBearer}`;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers });
    notify();
    const url = new URL(req.url ?? "/", "http://stub");

    if (!authorized(req.headers)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "bad key" } }));
      return;
    }

    if (url.pathname === "/api/v1/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: { version: "2.3.2", platform: "stub", channelCount: channels.length },
          meta: { timestamp: new Date().toISOString() },
        }),
      );
      return;
    }

    if (url.pathname === "/api/v1/channels") {
      if (options.failChannels) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "nope" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: channels, meta: { timestamp: new Date().toISOString() } }));
      return;
    }

    if (url.pathname === "/api/v1/transcript") {
      if (options.failTranscript) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "nope" } }));
        return;
      }
      // ProdCom clamps limit to 200 and defaults it to 50; offset defaults to 0.
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
      const since = url.searchParams.get("since");
      // The whole point of the stub: a `since` the box cannot parse is DROPPED,
      // not rejected, and the caller silently gets the oldest page of everything.
      const filtered =
        since && SECOND_PRECISION_ISO.test(since)
          ? entries.filter((e) => Date.parse(e.date) > Date.parse(since))
          : entries;
      const page = filtered.slice(offset, offset + limit);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: page,
          meta: {
            timestamp: new Date().toISOString(),
            totalCount: filtered.length,
            hasMore: offset + page.length < filtered.length,
          },
        }),
      );
      return;
    }

    if (url.pathname === "/api/v1/transcript/stream") {
      state.sseOpens++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (options.sseCloseImmediately) {
        res.end();
        notify();
        return;
      }
      // Flush now. Node holds response headers until the first write, and this
      // stream may legitimately write nothing for hours — which is the whole
      // problem with the endpoint — so without this the client never sees the
      // 200 and never gets as far as priming from REST.
      res.flushHeaders();
      sseStreams.add(res);
      res.on("close", () => sseStreams.delete(res));
      notify();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: url.pathname } }));
  });

  server.on("connection", (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  });

  server.on("upgrade", (req, socket: Duplex) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers });
    notify();
    const url = new URL(req.url ?? "/", "http://stub");

    if (options.refuseWebSocket || url.pathname !== "/api/v1/ws") {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!authorized(req.headers)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    state.wsUpgrades++;

    // Annotated: subarray() yields Buffer<ArrayBufferLike>, which will not assign
    // back into the Buffer<ArrayBuffer> that Buffer.alloc() infers.
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { texts, closed, rest } = decodeClientFrames(pending);
      pending = rest;
      for (const t of texts) wsReceived.push(t);
      if (texts.length) notify();
      if (closed) {
        sockets.delete(socket);
        socket.destroy();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));

    // ProdCom sends this immediately on upgrade, before any subscribe arrives.
    socket.write(
      encodeTextFrame(
        JSON.stringify({
          type: "welcome",
          streams: ["transcript", "status", "automation", "activity"],
          message: "Connected to ProdCom WebSocket API",
        }),
      ),
    );
    notify();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const wsSend = (text: string): void => {
    const frame = encodeTextFrame(text);
    for (const s of sockets) s.write(frame);
  };

  const until = (ready: () => boolean, label: string, timeoutMs: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ready()) return resolve();
      const timer = setTimeout(() => reject(new Error(`prodcom stub: timed out waiting for ${label}`)), timeoutMs);
      const check = () => {
        if (!ready()) {
          waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      waiters.push(check);
    });

  return {
    port,
    requests,
    wsReceived,
    get wsUpgrades() {
      return state.wsUpgrades;
    },
    get sseOpens() {
      return state.sseOpens;
    },
    wsSend,
    wsPing: () => wsSend(JSON.stringify({ type: "ping" })),
    wsTranscript: (entry, wrap = "data") =>
      wsSend(JSON.stringify(wrap === "top" ? { type: "transcript", ...entry } : { type: "transcript", data: entry })),
    sseSend: (entry) => {
      for (const s of sseStreams) s.write(`data: ${JSON.stringify(entry)}\n\n`);
    },
    wsDropAll: () => {
      for (const s of sockets) s.destroy();
      sockets.clear();
    },
    waitForUpgrades: (n, timeoutMs = 4000) => until(() => state.wsUpgrades >= n, `${n} websocket upgrade(s)`, timeoutMs),
    waitForSse: (n, timeoutMs = 4000) => until(() => state.sseOpens >= n, `${n} SSE stream(s)`, timeoutMs),
    waitForRequest: (test, n = 1, timeoutMs = 4000) =>
      until(() => requests.filter(test).length >= n, `${n} matching request(s)`, timeoutMs),
    close: async () => {
      for (const s of sockets) s.destroy();
      for (const s of sseStreams) s.end();
      for (const s of open) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
