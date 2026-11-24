// qrc-client.ts — QRC (Q-SYS Remote Control) over TCP: JSON-RPC 2.0, each message
// terminated by a NUL byte, requests matched to replies by numeric id.
//
// `QrcTransport` is the seam the rest of the integration depends on, so a QRWC
// (WebSocket) transport can replace this class without touching callers.

import net from "node:net";
import { toError } from "../errors.js";
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
const MAX_BUFFER_BYTES = 1024 * 1024;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class QrcClient implements QrcTransport {
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  private readonly closeHandlers: ((err: Error | null) => void)[] = [];
  private closed = false;
  private closeError: Error | null = null;

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
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let nul: number;
    while ((nul = this.buffer.indexOf(0)) !== -1) {
      const text = this.buffer.subarray(0, nul).toString("utf8");
      this.buffer = this.buffer.subarray(nul + 1);
      if (text) this.dispatch(text);
    }
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      console.warn(`[qsys] QRC receive buffer passed ${MAX_BUFFER_BYTES} bytes without a terminator, dropping the connection`);
      this.closeError ??= new Error("QRC receive buffer limit exceeded");
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
        if (error) p.reject(new QrcError(`QRC ${p.method}: ${String(error.message ?? "error")}`, Number(error.code)));
        else p.resolve(msg.result);
      });
    } else if (typeof msg.method === "string" && msg.id === undefined) {
      for (const cb of this.notificationHandlers) {
        try {
          cb(msg.method, msg.params);
        } catch (err) {
          console.warn(`[qsys] QRC notification handler for ${scrub(msg.method)} threw: ${scrubError(err)}`);
        }
      }
    } else {
      console.warn(`[qsys] ignoring QRC message with no matching request (id ${scrub(msg.id)})`);
    }
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    const reason = this.closeError ?? new Error("QRC connection closed");
    for (const id of [...this.pending.keys()]) this.settle(id, (p) => p.reject(toError(reason)));
    for (const cb of this.closeHandlers) cb(this.closeError);
  }
}
