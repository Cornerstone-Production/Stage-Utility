// hub.ts — the one Durable Object that holds everything.
//
// Docs and assets live in its SQLite storage, the last heartbeat in its key-value
// storage, and the viewers' sockets on it too, through the WebSocket Hibernation API,
// so a quiet deploy with viewers connected costs nothing while it waits. There is
// exactly one: the Worker asks for it by the name "main".
//
// Everything a Worker does to it is an RPC method (HubApi); the one thing that cannot
// be is a viewer's handshake, which arrives as fetch().

import { DurableObject } from "cloudflare:workers";

import {
  FRAME_DOCS,
  PUBLISH_PROTOCOL_VERSION,
  assetContentType,
  type AssetContentType,
  type FrameChannel,
  type LastHeartbeat,
  type HubStatus,
} from "../../../main/types/servicecue-publish.js";
import { buildOf } from "./build.js";
import { admit, limitsFrom, type Held } from "./capacity.js";
import type { Env } from "./env.js";
import { json } from "./headers.js";
import type { HubApi } from "./hub-api.js";
import { docsMessage, echoableCloseCode, frameMessage, heartbeatMessage } from "./messages.js";

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, type TEXT NOT NULL, body BLOB NOT NULL)",
];

/** What a socket carries: where it came from, and when it arrived. */
interface Attachment {
  address: string | null;
  at: number;
}

/** The frame channel a doc is stored as, for the three that are. */
const CHANNEL_BY_DOC: ReadonlyMap<string, FrameChannel> = new Map([...FRAME_DOCS].map(([channel, key]) => [key, channel]));

/** WebSocket.readyState while a close is under way. */
const CLOSING = 2;

export class PublishHub extends DurableObject<Env> implements HubApi {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
    // A viewer's "ping" is answered by the runtime without waking this object, so a
    // page can tell a dead connection from a quiet church for the cost of nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ── Docs ────────────────────────────────────────────────────────────────────

  async putDoc(key: string, text: string): Promise<void> {
    const channel = CHANNEL_BY_DOC.get(key);
    const before = channel === undefined ? this.readDoc(key) : null;
    this.sql.exec("INSERT INTO docs (key, body) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body", key, text);
    // A frame is told as it is, every time: a viewer follows it. Any other doc is named
    // only when it changed, because the church publishes the same ones again and again.
    if (channel !== undefined) this.broadcast(frameMessage(channel, text));
    else if (before !== text) this.broadcast(docsMessage([key]));
  }

  async deleteDoc(key: string): Promise<void> {
    if (this.sql.exec("DELETE FROM docs WHERE key = ? RETURNING key", key).toArray().length > 0) this.broadcast(docsMessage([key]));
  }

  async getDoc(key: string): Promise<string | null> {
    return this.readDoc(key);
  }

  private readDoc(key: string): string | null {
    return this.sql.exec<{ body: string }>("SELECT body FROM docs WHERE key = ?", key).toArray()[0]?.body ?? null;
  }

  // ── Assets ──────────────────────────────────────────────────────────────────

  async putAsset(name: string, type: AssetContentType, body: ArrayBuffer): Promise<void> {
    this.sql.exec(
      "INSERT INTO assets (name, type, body) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET type = excluded.type, body = excluded.body",
      name,
      type,
      body,
    );
  }

  async getAsset(name: string): Promise<{ type: AssetContentType; body: ArrayBuffer } | null> {
    const row = this.sql.exec<{ type: string; body: ArrayBuffer }>("SELECT type, body FROM assets WHERE name = ?", name).toArray()[0];
    if (!row) return null;
    const type = assetContentType(row.type);
    // Only this object writes an asset, and only after checking its type: this is
    // storage that no longer says what it was given, and serving it would be a guess.
    if (type === null) throw new Error(`the stored asset ${name} has the type ${row.type}`);
    return { type, body: row.body };
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  async heartbeat(sentAt: number, version: string, build: string | null): Promise<number> {
    const at = Date.now();
    this.ctx.storage.kv.put("heartbeat", { at, sentAt, version } satisfies LastHeartbeat);
    // The version stays here. A viewer is told when, and which build of the page is
    // being served, never what the church runs.
    this.broadcast(heartbeatMessage(at, build));
    return at;
  }

  async getHeartbeat(): Promise<number | null> {
    return this.readHeartbeat()?.at ?? null;
  }

  private readHeartbeat(): LastHeartbeat | null {
    return this.ctx.storage.kv.get<LastHeartbeat>("heartbeat") ?? null;
  }

  // ── Manifest and status ─────────────────────────────────────────────────────

  async applyManifest(docs: string[], assets: string[]): Promise<{ removedDocs: string[]; removedAssets: string[] }> {
    const keepDocs = new Set(docs);
    const keepAssets = new Set(assets);
    const removed = this.ctx.storage.transactionSync(() => {
      const removedDocs = this.docKeys().filter((key) => !keepDocs.has(key));
      const removedAssets = this.assetNames().filter((name) => !keepAssets.has(name));
      for (const key of removedDocs) this.sql.exec("DELETE FROM docs WHERE key = ?", key);
      for (const name of removedAssets) this.sql.exec("DELETE FROM assets WHERE name = ?", name);
      return { removedDocs, removedAssets };
    });
    // A decision worth a line: what the publisher no longer lists is gone from the page.
    if (removed.removedDocs.length > 0 || removed.removedAssets.length > 0) {
      console.log(
        `[servicecue-hub] the manifest removed ${removed.removedDocs.length} doc(s) and ${removed.removedAssets.length} asset(s)`,
      );
    }
    if (removed.removedDocs.length > 0) this.broadcast(docsMessage(removed.removedDocs));
    return removed;
  }

  async status(): Promise<HubStatus> {
    return {
      protocol: PUBLISH_PROTOCOL_VERSION,
      docs: this.docKeys(),
      assets: this.assetNames(),
      lastHeartbeat: this.readHeartbeat(),
      viewers: this.ctx.getWebSockets().length,
    };
  }

  private docKeys(): string[] {
    return this.sql.exec<{ key: string }>("SELECT key FROM docs ORDER BY key").toArray().map((row) => row.key);
  }

  private assetNames(): string[] {
    return this.sql.exec<{ name: string }>("SELECT name FROM assets ORDER BY name").toArray().map((row) => row.name);
  }

  // ── Viewers ─────────────────────────────────────────────────────────────────

  /**
   * A viewer's handshake. Whether it may be held is capacity.ts's to say, from the
   * sockets held now. Its first messages are the docs that are frames, marked as
   * replays, and the last heartbeat, which carries the build id the Worker put on the
   * request (see build.ts).
   */
  async fetch(request: Request): Promise<Response> {
    const address = request.headers.get("CF-Connecting-IP");
    const now = Date.now();
    const sockets = this.ctx.getWebSockets();
    const held: Held[] = sockets.map((ws) => {
      const attached = ws.deserializeAttachment() as Attachment | null;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      return { address: attached?.address ?? null, lastHeardAt: Math.max(pinged, attached?.at ?? 0) };
    });
    const limits = limitsFrom(this.env);
    const verdict = admit(held, address, now, limits);
    if (!verdict.admit) {
      console.warn(
        verdict.why === "address"
          ? `[servicecue-hub] ${address ?? "an unknown address"} holds ${limits.perAddress} sockets already: refusing another`
          : `[servicecue-hub] ${limits.max} viewers are connected and none is idle: refusing another`,
      );
      return verdict.why === "address"
        ? json({ error: "Too many pages are open from this address" }, 429, { "Retry-After": "30" })
        : json({ error: "The page is full; try again in a moment" }, 503, { "Retry-After": "30" });
    }
    for (const i of verdict.evict) sockets[i]!.close(1001, "idle");
    if (verdict.evict.length > 0) console.log(`[servicecue-hub] closed ${verdict.evict.length} idle socket(s) to make room`);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ address, at: now } satisfies Attachment);

    for (const [channel, key] of FRAME_DOCS) {
      const text = this.readDoc(key);
      if (text !== null) server.send(frameMessage(channel, text, true));
    }
    // Always sent, null before the first: a page that has been told "never" knows it, rather than waiting.
    server.send(heartbeatMessage(this.readHeartbeat()?.at ?? null, buildOf(request), now));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A viewer sent something. The runtime answers "ping" itself, without waking this
   * object, so whatever reaches here is not that: the page sends nothing else. It is
   * closed, so that a client that sends frames as fast as it can wakes the object
   * once and not twenty thousand times.
   */
  webSocketMessage(ws: WebSocket): void {
    ws.close(1008, "this page sends nothing but ping");
  }

  webSocketClose(ws: WebSocket, code: number): void {
    // Finish the handshake the viewer began, with a code that can be sent. The runtime
    // does it itself on a recent compatibility date, in which case the socket is no
    // longer closing.
    if (ws.readyState === CLOSING) ws.close(echoableCloseCode(code), "closing");
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    // The error itself, not its message: the runtime's own are objects worth printing whole.
    console.warn("[servicecue-hub] a viewer's socket failed:", error);
    if (ws.readyState === CLOSING) ws.close(1011, "error");
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  /** Send a message to every open viewer. A viewer it could not reach is said so. */
  private broadcast(message: string): void {
    let sent = 0;
    let failed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
        sent++;
      } catch {
        failed++;
      }
    }
    if (failed > 0) console.warn(`[servicecue-hub] ${failed} viewer socket(s) would not take a frame; ${sent} did`);
  }
}
