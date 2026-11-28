// publish-receiver.ts — a stand-in for the public page, as a real HTTP server.
//
// The sender talks to it over a real socket, so what a test sees is what a page
// would: the verb, the path, the Authorization header and the body bytes, in order.
// Nothing here is a stub of fetch.
//
// By default it IS the page: every request is answered by the Worker's own request
// handler (publish/servicecue/src/handle.ts), over the in-memory hub its tests use, so
// routing, the token, validation, limits and what is stored are the real ones and not a
// second reading of docs/reference/servicecue-publishing.md. A test that needs a failure
// sets `respond`, and can fall back to `worker()`.

import assert from "node:assert/strict";
import type * as http from "node:http";
import { startHttpFixture, type HttpFixture } from "./http-fixture.js";

// A page on this machine is plain http, which the address rules accept only under this switch (development).
process.env.STAGE_UTILITY_PUBLISH_ALLOW_LOCAL = "1";

import type { PublishStatus } from "../../types/servicecue-publish.js";
import { handle } from "../../../publish/servicecue/src/handle.js";
import { MemoryHub } from "../../../publish/servicecue/src/memory-hub-harness.js";

export interface Received {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  bytes: Buffer;
  /** performance.now() when the request arrived. */
  at: number;
}

export interface Answer {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Send the headers and the first of the body, then never finish: a sender that
   *  waits for the whole body waits until its own ceiling. */
  open?: boolean;
  /** Wait this long before answering, so two requests can be seen overlapping. */
  delayMs?: number;
}

/** No answer: never one, or the connection closed instead. */
export type Lost = "hang" | "drop";

/** A status answer with nothing stored and no heartbeat yet, for a test that needs a fixed one. */
export const PAGE_STATUS = { protocol: 1, docs: [] as string[], assets: [] as string[], lastHeartbeat: null, viewers: 0, build: null } satisfies PublishStatus;

const DOC = /^\/_publish\/v1\/doc\/([^/]+)$/;
const ASSET = "/_publish/v1/asset/";
const STATUS = "/_publish/v1/status";
const FRAME = "/_publish/v1/frame";
const HEARTBEAT = "/_publish/v1/heartbeat";
const MANIFEST = "/_publish/v1/manifest";

export class FakeReceiver {
  readonly requests: Received[] = [];
  /** Requests whose connection the sender closed before they were answered. */
  dropped = 0;
  /** What the page holds, in the hub the real handler stores into. A test may empty it, as a lost store would. */
  readonly hub = new MemoryHub();
  /** Document text by key. */
  get docs(): Map<string, string> {
    return this.hub.docs;
  }
  /** Image names, as a set a test can add to and empty. */
  readonly assetNames = {
    add: (name: string): void => void this.hub.assets.set(name, { type: "image/png", body: new ArrayBuffer(1) }),
    clear: (): void => this.hub.assets.clear(),
    has: (name: string): boolean => this.hub.assets.has(name),
    [Symbol.iterator]: (): Iterator<string> => [...this.hub.assets.keys()].sort()[Symbol.iterator](),
  };
  /** The token the page was set up with. null: whatever a request carries is it (the handler still refuses one under 32 characters). */
  token: string | null = null;
  /** The page's document, which the Worker reads its build id from. null: the deploy has none. */
  document: string | null = null;
  /**
   * How to answer. `"hang"` never does: the sender's own ceiling is what ends it. `"drop"` closes the
   * connection with no answer at all. After `worker()`, either is a request the page applied whose
   * answer was lost.
   */
  respond: (req: Received) => Answer | Lost | Promise<Answer | Lost> = (req) => this.worker(req);

  private constructor(private readonly shell: HttpFixture) {}

  /** The page as it behaves when nothing is wrong: the Worker's handler, with `extra` laid over its answer (a delay, say). */
  async worker(req: Received, extra: Partial<Answer> = {}): Promise<Answer> {
    const bearer = /^Bearer[ \t]+(\S+)/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const request = new Request(`${this.origin}${req.path}`, {
      method: req.method,
      headers: Object.fromEntries(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))),
      body: req.method === "GET" || req.method === "HEAD" ? null : new Uint8Array(req.bytes),
    });
    const response = await handle(request, {
      hub: this.hub,
      upgrade: async () => new Response("no sockets here", { status: 501 }),
      assets: async () => (this.document === null ? new Response("missing", { status: 404 }) : new Response(this.document, { headers: { "Content-Type": "text/html" } })),
      token: this.token ?? bearer ?? "",
      now: () => Date.now(),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => (headers[k] = v));
    return { status: response.status, body: await response.text(), headers, ...extra };
  }

  static async start(): Promise<FakeReceiver> {
    let self!: FakeReceiver;
    const shell = await startHttpFixture((req, res, bytes) => {
      const got: Received = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: bytes.toString("utf8"),
        bytes,
        at: performance.now(),
      };
      self.requests.push(got);
      res.on("close", () => {
        if (!res.writableEnded) self.dropped++;
      });
      void Promise.resolve(self.respond(got)).then((answer) => {
        if (answer === "hang") return;
        if (answer === "drop") {
          res.socket?.destroy();
          return;
        }
        const reply = () => {
          if (res.destroyed) return;
          res.writeHead(answer.status, answer.headers ?? {});
          if (answer.open) {
            res.write(answer.body ?? "x");
            return;
          }
          res.end(answer.body ?? "");
        };
        if (answer.delayMs) setTimeout(reply, answer.delayMs);
        else reply();
      });
    });
    self = new FakeReceiver(shell);
    return self;
  }

  get origin(): string {
    return this.shell.origin;
  }

  /** Every document PUT, as [key, body], in order. */
  puts(): { key: string; body: string }[] {
    return this.requests
      .filter((r) => r.method === "PUT" && DOC.test(r.path))
      .map((r) => ({ key: decodeURIComponent(DOC.exec(r.path)![1]!), body: r.body }));
  }

  /** The keys PUT, sorted: what a cycle sent. */
  putKeys(): string[] {
    return this.puts().map((p) => p.key).sort();
  }

  frames(): { channel: string; data: unknown }[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === FRAME).map((r) => JSON.parse(r.body));
  }

  manifests(): { docs: string[]; assets: string[] }[] {
    return this.requests.filter((r) => r.method === "PUT" && r.path === MANIFEST).map((r) => JSON.parse(r.body));
  }

  heartbeats(): { at: number; version: string }[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === HEARTBEAT).map((r) => JSON.parse(r.body));
  }

  /** How many times the page was asked what it holds. */
  statusRequests(): number {
    return this.requests.filter((r) => r.method === "GET" && r.path === STATUS).length;
  }

  assets(): { name: string; mime: string | undefined; bytes: Buffer }[] {
    return this.requests
      .filter((r) => r.method === "PUT" && r.path.startsWith(ASSET))
      .map((r) => ({
        name: decodeURIComponent(r.path.slice(ASSET.length)),
        mime: r.headers["content-type"],
        bytes: r.bytes,
      }));
  }

  async close(): Promise<void> {
    await this.shell.close();
  }
}

/**
 * The page does every request, as the Worker does, and the answer to each one `pick` chooses is lost:
 * never sent ("hang"), the connection closed instead ("drop"), or another answer in its place (a 5xx
 * from a page that stored it first).
 */
export function applyThenLose(page: FakeReceiver, answer: Lost | Answer, pick: (req: Received) => boolean): void {
  page.respond = async (req) => {
    const applied = await page.worker(req);
    return pick(req) ? answer : applied;
  };
}

/** That the page did take what it was sent, before its answer was lost: without it, a test of a lost answer tests nothing. */
export function assertTook(took: boolean, what: string): void {
  assert.ok(took, `the page did not take ${what}; the test is not testing a lost answer`);
}

/** Poll until `check` holds, or fail naming `what`. For a sender that works on its own timers. */
export async function waitFor(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`still waiting after ${ms} ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
