// fake-cloudflare.ts — a stand-in for Cloudflare's Workers API, as a real HTTP server.
//
// The deployer talks to it over a real socket, so what a test sees is what Cloudflare would:
// the verb, the path, the Authorization header and the body, in order. It checks what the real
// API checks that a deploy depends on: the token on every request, the upload token on an
// upload, the completion token on the script PUT, and that every file the session asked for
// arrived. It keeps what it was sent, so a test reads the exact upload metadata back.
//
// A test that needs a failure sets `respond`, which sees each request first and may answer it.

import * as http from "node:http";

import { errorMessage } from "../errors.js";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
/** Long enough to look like a token; never in any log, answer or status a test reads. */
export const API_TOKEN = "cf-token-canary-0123456789abcdefABCDEF_-0123";

export interface Seen {
  method: string;
  /** The path under /client/v4, query included. */
  path: string;
  authorization: string | undefined;
  contentType: string | undefined;
  bytes: Buffer;
  /** What the request body says, for a JSON one. */
  json?: unknown;
}

export interface FakeAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** An error in Cloudflare's own envelope. */
export function failure(status: number, code: number, message: string): FakeAnswer {
  return { status, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
}

/** The script PUT, as the Worker would be told. */
export interface ScriptPut {
  query: string;
  metadata: Record<string, unknown>;
  parts: { name: string; type: string; bytes: Buffer }[];
}

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwtFor = (claims: Record<string, unknown>, tag: string): string => `${b64url({ alg: "none" })}.${b64url({ ...claims, tag })}.sig`;

export class FakeCloudflare {
  readonly requests: Seen[] = [];
  /** The hashes Cloudflare holds already: a deploy uploads only what is not here. */
  readonly held = new Set<string>();
  /** Every file uploaded, by hash: its base64 text and the type it was sent with. */
  readonly uploaded = new Map<string, { base64: string; type: string }>();
  /** Every script PUT, in order. */
  readonly puts: ScriptPut[] = [];
  /** Files per upload request. */
  bucketSize = 2;
  /** Answer uploads one file to a request, the way a session token with the flag asks for. */
  singleUploads = false;
  /** The token that is accepted. */
  token: string = API_TOKEN;
  /** Is the token one made under the account, verified at the account's address and refused at the user's. */
  accountToken = false;
  /** What the Worker's last deploy was annotated with, as the deployments and versions answers say it. null: no deployment. */
  deployed: { tag?: string; message?: string; at: string } | null = null;
  /** Put annotations on the version answer. false: a version from before this server's deploys. */
  serveAnnotations = true;
  /** Sees each request first. Returning an answer sends it; undefined carries on. */
  respond: (req: Seen) => FakeAnswer | undefined | Promise<FakeAnswer | undefined> = () => undefined;

  private sessionJwt = "";
  private completionJwt = "";
  private wanted = new Set<string>();
  private nextSession = 0;

  private constructor(private readonly server: http.Server) {}

  static async start(): Promise<FakeCloudflare> {
    const holder: { fake?: FakeCloudflare } = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void holder.fake!.handle(req, Buffer.concat(chunks)).then((a) => {
          res.writeHead(a.status, { "Content-Type": "application/json", ...a.headers });
          res.end(JSON.stringify(a.body));
        });
      });
    });
    holder.fake = new FakeCloudflare(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return holder.fake;
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Forget every request, upload and put, and hold nothing: a fresh account. */
  reset(): void {
    this.requests.length = 0;
    this.held.clear();
    this.uploaded.clear();
    this.puts.length = 0;
    this.deployed = null;
    this.respond = () => undefined;
    this.singleUploads = false;
    this.accountToken = false;
    this.serveAnnotations = true;
    this.token = API_TOKEN;
  }

  /** What the requests to a step were, by path prefix. */
  to(method: string, prefix: string): Seen[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  private ok(result: unknown): FakeAnswer {
    return { status: 200, body: { success: true, errors: [], messages: [], result } };
  }

  private async handle(req: http.IncomingMessage, bytes: Buffer): Promise<FakeAnswer> {
    const url = new URL(req.url ?? "/", "http://fake");
    const contentType = req.headers["content-type"];
    const seen: Seen = { method: req.method ?? "GET", path: `${url.pathname.replace(/^\/client\/v4/, "")}${url.search}`, authorization: req.headers.authorization, contentType, bytes };
    if (contentType?.startsWith("application/json") && bytes.length > 0) seen.json = JSON.parse(bytes.toString("utf8"));
    this.requests.push(seen);
    const forced = await this.respond(seen);
    if (forced) return forced;
    try {
      return await this.route(seen, url.pathname.replace(/^\/client\/v4/, ""), url.searchParams);
    } catch (err) {
      return failure(500, 9999, `the fake could not read the request: ${errorMessage(err)}`);
    }
  }

  private bearer(req: Seen): string {
    return (req.authorization ?? "").replace(/^Bearer /, "");
  }

  private async route(req: Seen, p: string, query: URLSearchParams): Promise<FakeAnswer> {
    const refuse = () => failure(401, 10000, "Authentication error");
    if (req.method === "GET" && p === "/user/tokens/verify") {
      return this.accountToken || this.bearer(req) !== this.token ? failure(401, 1000, "Invalid API Token") : this.ok({ id: "t", status: "active" });
    }
    const account = /^\/accounts\/([^/]+)(\/.*)$/.exec(p);
    if (!account) return failure(404, 7003, "no route");
    const [, id, rest] = account;
    if (id !== ACCOUNT_ID) return failure(403, 10000, "Authentication error");
    if (req.method === "GET" && rest === "/tokens/verify") {
      return !this.accountToken || this.bearer(req) !== this.token ? failure(401, 1000, "Invalid API Token") : this.ok({ id: "t", status: "active" });
    }

    // The upload token, not the API token, is what an upload carries.
    if (rest === "/workers/assets/upload") {
      if (this.bearer(req) !== this.sessionJwt) return refuse();
      const form = await new Response(new Uint8Array(req.bytes), { headers: { "content-type": req.contentType ?? "" } }).formData();
      if (query.get("base64") !== "true") return failure(400, 10001, "base64=true is required");
      for (const [hash, value] of form.entries()) {
        const file = value as File;
        this.uploaded.set(hash, { base64: await file.text(), type: file.type });
        this.held.add(hash);
      }
      return this.ok(this.complete());
    }
    const single = /^\/workers\/assets\/upload\/([0-9a-f]{32})$/.exec(rest);
    if (req.method === "POST" && single) {
      if (this.bearer(req) !== this.sessionJwt) return refuse();
      this.uploaded.set(single[1], { base64: req.bytes.toString("base64"), type: req.contentType ?? "" });
      this.held.add(single[1]);
      return this.ok(this.complete());
    }

    // Everything else is the API token's.
    if (this.bearer(req) !== this.token) return refuse();
    const script = /^\/workers\/scripts\/([^/]+)(\/.*)?$/.exec(rest);
    if (!script) return failure(404, 7003, "no route");
    const [, , tail = ""] = script;

    if (req.method === "POST" && tail === "/assets-upload-session") {
      const manifest = (req.json as { manifest: Record<string, { hash: string; size: number }> }).manifest;
      const hashes = new Set(Object.values(manifest).map((f) => f.hash));
      this.wanted = new Set([...hashes].filter((h) => !this.held.has(h)));
      const session = ++this.nextSession;
      this.sessionJwt = jwtFor({ wrangler_single_asset_uploads: this.singleUploads, kind: "upload" }, `session-${session}`);
      this.completionJwt = this.wanted.size === 0 ? this.sessionJwt : jwtFor({ kind: "completion" }, `completion-${session}`);
      const list = [...this.wanted];
      const buckets: string[][] = [];
      for (let i = 0; i < list.length; i += this.bucketSize) buckets.push(list.slice(i, i + this.bucketSize));
      return this.ok({ jwt: this.sessionJwt, buckets });
    }

    if (req.method === "PUT" && tail === "") {
      const form = await new Response(new Uint8Array(req.bytes), { headers: { "content-type": req.contentType ?? "" } }).formData();
      const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
      const assets = metadata.assets as { jwt?: string } | undefined;
      if (assets && assets.jwt !== this.completionJwt) return failure(400, 10021, "the assets token is not the completion token of the upload");
      const parts: ScriptPut["parts"] = [];
      for (const [name, value] of form.entries()) {
        if (name === "metadata") continue;
        const file = value as File;
        parts.push({ name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
      }
      this.puts.push({ query: query.toString(), metadata, parts });
      const annotations = metadata.annotations as Record<string, string> | undefined;
      this.deployed = { tag: annotations?.["workers/tag"], message: annotations?.["workers/message"], at: new Date().toISOString() };
      return this.ok({ id: `version-${this.puts.length}` });
    }

    if (req.method === "GET" && tail === "/deployments") {
      if (!this.deployed) return this.ok({ deployments: [] });
      return this.ok({ deployments: [{ id: "d1", created_on: this.deployed.at, versions: [{ version_id: "stale", percentage: 0 }, { version_id: "live", percentage: 100 }], annotations: {} }] });
    }
    const version = /^\/versions\/([^/]+)$/.exec(tail);
    if (req.method === "GET" && version) {
      if (version[1] !== "live" || !this.deployed) return failure(404, 10007, "version not found");
      const annotations: Record<string, string> = {};
      if (this.serveAnnotations && this.deployed.tag) annotations["workers/tag"] = this.deployed.tag;
      if (this.serveAnnotations && this.deployed.message) annotations["workers/message"] = this.deployed.message;
      return this.ok({ id: "live", annotations });
    }
    return failure(404, 7003, "no route");
  }

  /** The upload's answer: the completion token once everything wanted is held, nothing before. */
  private complete(): { jwt?: string } {
    return [...this.wanted].every((h) => this.held.has(h)) ? { jwt: this.completionJwt } : {};
  }
}
