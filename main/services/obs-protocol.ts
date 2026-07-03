// obs-protocol.ts — OBS Studio obs-websocket v5 wire protocol (JSON-over-WebSocket).
//
// obs-websocket v5 ships with OBS 28+. Enable it in OBS: Tools → WebSocket Server
// Settings (default port 4455, optional password). It is a JSON message protocol
// over a single WebSocket; every frame is `{ op, d }`:
//   server → Hello (op 0):      d = { obsWebSocketVersion, rpcVersion,
//                                      authentication?: { challenge, salt } }
//   client → Identify (op 1):   d = { rpcVersion, authentication?, eventSubscriptions }
//   server → Identified (op 2): d = { negotiatedRpcVersion }
//   client → Request (op 6):    d = { requestType, requestId, requestData? }
//   server → RequestResponse (op 7): d = { requestType, requestId, requestStatus,
//                                          responseData }
//   server → Event (op 5):      d = { eventType, eventIntent, eventData }
// Auth string = base64( sha256( base64( sha256(password + salt) ) + challenge ) ).
//
// This adapter is intentionally generic: `request(type, data)` covers any OBS
// request, and `onEvent` surfaces every event — so future OBS features (scene
// switching, streaming control, …) need no protocol work. Node 24+ has a global
// WebSocket so there is no runtime dependency.

import { createHash } from "node:crypto";

/** op codes used by obs-websocket v5. */
const OP_HELLO = 0;
const OP_IDENTIFY = 1;
const OP_IDENTIFIED = 2;
const OP_EVENT = 5;
const OP_REQUEST = 6;
const OP_REQUEST_RESPONSE = 7;

// EventSubscription bitmask. `Outputs` (1 << 6) covers RecordStateChanged,
// StreamStateChanged and VirtualcamStateChanged — all we need. `General` (1 << 0)
// is cheap and harmless to include.
const EVENTSUB_GENERAL = 1 << 0;
const EVENTSUB_OUTPUTS = 1 << 6;
const EVENT_SUBSCRIPTIONS = EVENTSUB_GENERAL | EVENTSUB_OUTPUTS;

const CONNECT_TIMEOUT_MS = 6000;
const REQUEST_TIMEOUT_MS = 5000;

/** One OBS event (op 5). */
export interface ObsEvent {
  eventType: string;
  eventData: Record<string, unknown>;
}

export interface ObsAdapter {
  /** Open the socket, do the Hello/Identify handshake (authenticating if asked). */
  connect(opts: { password?: string | null }): Promise<void>;
  /** Send any OBS request and resolve with its `responseData` (rejects on failure). */
  request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Register an event listener (op-5 events). */
  onEvent(cb: (e: ObsEvent) => void): void;
  /** Register a connection-closed listener (fires once). */
  onClose(cb: () => void): void;
  /** Close the socket (no-op if already closed). */
  close(): void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Compute the obs-websocket v5 authentication string from the password and the
 * server-provided salt + challenge. Pure + exported so it can be unit-tested
 * against the documented example vector.
 */
export function computeAuthString(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export class ObsWebSocketAdapter implements ObsAdapter {
  private ws: WebSocket | null = null;
  private seq = 1;
  private pending = new Map<string, Pending>();
  private eventCbs: ((e: ObsEvent) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  private url(): string {
    return `ws://${this.host}:${this.port}`;
  }

  connect(opts: { password?: string | null }): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url());
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Connection to ${this.host}:${this.port} timed out`));
      }, CONNECT_TIMEOUT_MS);

      const finishOk = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      ws.addEventListener("message", (ev) => {
        let msg: { op?: number; d?: Record<string, unknown> };
        try {
          msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
        } catch {
          return;
        }
        const d = (msg.d ?? {}) as Record<string, unknown>;

        if (msg.op === OP_HELLO) {
          // Build the Identify payload, authenticating if the server asked.
          const identify: Record<string, unknown> = {
            rpcVersion: typeof d.rpcVersion === "number" ? d.rpcVersion : 1,
            eventSubscriptions: EVENT_SUBSCRIPTIONS,
          };
          const authObj = d.authentication as { challenge?: unknown; salt?: unknown } | undefined;
          if (authObj && str(authObj.challenge) && str(authObj.salt)) {
            identify.authentication = computeAuthString(
              opts.password ?? "",
              str(authObj.salt)!,
              str(authObj.challenge)!,
            );
          }
          this.send(OP_IDENTIFY, identify);
          return;
        }

        if (msg.op === OP_IDENTIFIED) {
          // Steady-state handlers take over for requests + events.
          finishOk();
          return;
        }

        // Once identified, route responses/events.
        this.route(msg.op, d);
      });

      ws.addEventListener("error", () => {
        finishErr(new Error(`WebSocket error connecting to ${this.host}:${this.port}`));
      });

      ws.addEventListener("close", (ev) => {
        // A close before Identified almost always means auth failed (code 4009)
        // or the server is unreachable; surface a useful message.
        if (!settled) {
          const code = (ev as CloseEvent).code;
          finishErr(new Error(code === 4009 ? "Authentication failed (wrong password)" : `Connection closed (code ${code})`));
          return;
        }
        this.handleClose();
      });
    });
  }

  private route(op: number | undefined, d: Record<string, unknown>): void {
    if (op === OP_REQUEST_RESPONSE) {
      const requestId = str(d.requestId);
      if (!requestId) return;
      const p = this.pending.get(requestId);
      if (!p) return;
      this.pending.delete(requestId);
      clearTimeout(p.timer);
      const status = (d.requestStatus ?? {}) as Record<string, unknown>;
      if (status.result === true) {
        p.resolve((d.responseData ?? {}) as Record<string, unknown>);
      } else {
        p.reject(new Error(str(status.comment) ?? `OBS request failed (code ${status.code ?? "?"})`));
      }
      return;
    }
    if (op === OP_EVENT) {
      const eventType = str(d.eventType);
      if (!eventType) return;
      const evt: ObsEvent = { eventType, eventData: (d.eventData ?? {}) as Record<string, unknown> };
      for (const cb of this.eventCbs) {
        try {
          cb(evt);
        } catch (err) {
          console.error("[obs] event listener error:", err);
        }
      }
    }
  }

  request(requestType: string, requestData?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("OBS connection not open"));
        return;
      }
      const requestId = String(this.seq++);
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS request "${requestType}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      const d: Record<string, unknown> = { requestType, requestId };
      if (requestData !== undefined) d.requestData = requestData;
      try {
        this.send(OP_REQUEST, d);
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  onEvent(cb: (e: ObsEvent) => void): void {
    this.eventCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  private send(op: number, d: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify({ op, d }));
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("OBS connection closed"));
    }
    this.pending.clear();
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.handleClose();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }
}
