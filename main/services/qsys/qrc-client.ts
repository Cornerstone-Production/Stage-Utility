// qrc-client.ts — QRC (Q-SYS Remote Control) over TCP: JSON-RPC 2.0, each message
// terminated by a NUL byte, requests matched to replies by numeric id.
//
// `QrcTransport` is the seam the rest of the integration depends on, so a QRWC
// (WebSocket) transport can replace this class without touching callers.

import net from "node:net";
import { scrub, scrubError } from "../scrub.js";

export interface QrcTransport {
  send(method: string, params?: unknown): Promise<unknown>;
  onNotification(cb: (method: string, params: unknown) => void): void;
  close(): void;
}

/** A JSON-RPC error reply from the Core. `code` is QRC's (7 unknown component, 8 unknown control, 10 logon required, ...). */
export class QrcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "QrcError";
  }
}

const DEFAULT_TIMEOUT_MS = 5000;
/**
 * The most one message may run to while the client waits for its NUL. A limit on a
 * single message, not on the stream: every reply arrives in TCP-sized pieces, so a
 * large one is unterminated until its last piece lands. Component.GetControls on a
 * big matrix mixer (a few hundred bytes per control, three controls per crosspoint)
 * runs to several MB, so this sits far above any real design and only stops a peer
 * that never terminates. Pieces are kept as a list and joined once, so a large reply
 * costs one copy rather than one per piece.
 */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
/** Unmatched reply ids already warned about; cleared when it reaches this size. */
const MAX_WARNED_IDS = 256;

/** A change-group push in reply form: `result: { Id, Changes: [...] }`. */
function isChangeGroupResult(result: unknown): result is { Id: string; Changes: unknown[] } {
  const r = result as { Id?: unknown; Changes?: unknown } | null;
  return !!r && typeof r === "object" && typeof r.Id === "string" && Array.isArray(r.Changes);
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class QrcClient implements QrcTransport {
  private nextId = 1;
  /** The unterminated message so far, as received. */
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  private readonly closeHandlers: ((err: Error | null) => void)[] = [];
  private closed = false;
  private closeError: Error | null = null;
  private readonly warnedIds = new Set<string>();

  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => {
      this.closeError ??= err;
    });
    socket.on("close", () => this.finish());
  }

  static connect(host: string, port: number, opts?: { timeoutMs?: number }): Promise<QrcClient> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`QRC connect to ${host}:${port} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        socket.removeAllListeners("error");
        resolve(new QrcClient(socket, timeoutMs));
      });
    });
  }

  send(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`QRC ${method}: connection is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`QRC ${method} timed out after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      this.socket.write(`${JSON.stringify(message)}\0`, (err) => {
        if (err) this.settle(id, (p) => p.reject(err));
      });
    });
  }

  /**
   * Register a notification handler. The Core pushes EngineStatus as soon as it
   * accepts the connection, and notifications are not queued: register in the
   * same tick `connect()` resolves (before any other await), or ask `StatusGet`.
   */
  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(cb);
  }

  onClose(cb: (err: Error | null) => void): void {
    if (this.closed) cb(this.closeError);
    else this.closeHandlers.push(cb);
  }

  close(): void {
    this.socket.destroy();
  }

  private settle(id: number, act: (p: Pending) => void): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    act(p);
  }

  private onData(chunk: Buffer): void {
    if (this.socket.destroyed) return;
    let start = 0;
    let nul: number;
    while ((nul = chunk.indexOf(0, start)) !== -1) {
      const tail = chunk.subarray(start, nul);
      // Bytes, not text, until the message is whole: a multi-byte character can
      // be split across two pieces.
      const message = this.partial.length > 0 ? Buffer.concat([...this.partial, tail]) : tail;
      this.partial = [];
      this.partialBytes = 0;
      start = nul + 1;
      if (message.length > 0) this.dispatch(message.toString("utf8"));
    }
    if (start === chunk.length) return;
    const rest = chunk.subarray(start);
    this.partial.push(rest);
    this.partialBytes += rest.length;
    if (this.partialBytes > MAX_MESSAGE_BYTES) {
      console.warn(`[qsys] a QRC message passed ${MAX_MESSAGE_BYTES} bytes without a terminator, dropping the connection`);
      this.closeError ??= new Error(`QRC message passed the ${MAX_MESSAGE_BYTES}-byte receive limit`);
      this.partial = [];
      this.partialBytes = 0;
      this.socket.destroy();
    }
  }

  private dispatch(text: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      msg = JSON.parse(text);
    } catch (err) {
      console.warn(`[qsys] ignoring unparseable QRC message: ${scrubError(err)}`);
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const { error } = msg;
      this.settle(msg.id, (p) => {
        if (!error) return p.resolve(msg.result);
        const code = Number(error.code);
        p.reject(new QrcError(`QRC ${p.method}: ${String(error.message ?? "error")}`, Number.isFinite(code) ? code : -1));
      });
    } else if (typeof msg.method === "string" && msg.id === undefined) {
      this.notify(msg.method, msg.params);
    } else if (!msg.error && isChangeGroupResult(msg.result)) {
      // QSC's reference shows AutoPoll results as replies that repeat the AutoPoll
      // request's id; after the first, nothing is pending for it. Delivered as the
      // notification form, so callers handle one shape.
      this.notify("ChangeGroup.Poll", msg.result);
    } else {
      // Also what a reply arriving after its request timed out looks like. Once per
      // id, so a Core repeating one id cannot flood the log.
      const id = String(msg.id);
      if (this.warnedIds.has(id)) return;
      if (this.warnedIds.size >= MAX_WARNED_IDS) this.warnedIds.clear();
      this.warnedIds.add(id);
      console.warn(`[qsys] ignoring QRC message with no matching request (id ${scrub(msg.id)})`);
    }
  }

  private notify(method: string, params: unknown): void {
    for (const cb of this.notificationHandlers) {
      try {
        cb(method, params);
      } catch (err) {
        console.warn(`[qsys] QRC notification handler for ${scrub(method)} threw: ${scrubError(err)}`);
      }
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const reason = this.closeError ?? new Error("QRC connection closed");
    for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(reason));
    for (const cb of this.closeHandlers) {
      try {
        cb(this.closeError);
      } catch (err) {
        console.warn(`[qsys] QRC close handler threw: ${scrubError(err)}`);
      }
    }
  }
}
