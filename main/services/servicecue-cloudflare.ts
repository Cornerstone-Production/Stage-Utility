// servicecue-cloudflare.ts — the public ServiceCue page, put on Cloudflare by plain `fetch`.
//
// What `wrangler deploy` (4.150) does for the Worker in publish/servicecue/, from the folder every
// build prepares (build/servicecue/, see scripts/servicecue-bundle.ts): no SDK, no wrangler, no
// login. Every request and field is wrangler's; the places that are not say so. Nothing here
// decides WHEN to deploy: that is servicecue-deployer.ts.
//
//   1. GET  /user/tokens/verify                        is the token still good
//   2. POST /accounts/:id/workers/scripts/:name/assets-upload-session
//                                                      the manifest; Cloudflare answers with the
//                                                      files it does not hold, in buckets
//   3. POST /accounts/:id/workers/assets/upload?base64=true
//                                                      one request per bucket; the last answer is
//                                                      the completion token (the session's own,
//                                                      when there was nothing to upload)
//   4. PUT  /accounts/:id/workers/scripts/:name        the module, its bindings and the assets token
//
// Cloudflare swaps a Worker's version atomically, so a deploy that fails at any step leaves the
// page as it was.
//
// THE TOKEN is an API token with the Workers Scripts edit permission on this one Worker. It goes
// out only as an `Authorization: Bearer` header, through `cloudflareFetch`, which pins every URL
// onto Cloudflare's own origin, and a redirect is an error and not a hop. Nothing here puts a
// token, or a token Cloudflare handed back, in an error: `CloudflareError` is what a caller logs.

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { errorMessage, fetchFailureMessage, isNotFound } from "./errors.js";
import { readCapped } from "./capped-download.js";
import { isRecord, isStringList } from "./is-record.js";
import { pinToOrigin } from "./pinned-origin.js";
import { parseTag } from "./release-tags.js";
import { isViewerBuildId } from "../types/servicecue-publish.js";
import type { DeployBinding, DeployManifest } from "../types/servicecue-deploy.js";

// ── Where Cloudflare is ──────────────────────────────────────────────────────

export const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";

declare const CLOUDFLARE_ORIGIN: unique symbol;
/** An origin the API token may be sent to. Made only by `cloudflareOrigin`. */
export type CloudflareOrigin = string & { readonly [CLOUDFLARE_ORIGIN]: true };

/**
 * Cloudflare's API, or this machine standing in for it: plain http to a loopback address is
 * accepted so a test (and a developer's fake) can be dialled, and nothing else is. Whether the
 * server may be pointed at one is the caller's: servicecue-publisher-instance.ts reads it from the
 * environment only while publishing to this machine is already allowed.
 */
export function cloudflareOrigin(text: string = CLOUDFLARE_API_ORIGIN): CloudflareOrigin {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("the Cloudflare API address could not be read");
  }
  const loopback = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.origin !== CLOUDFLARE_API_ORIGIN && !loopback) throw new Error(`the Cloudflare API address has to be ${CLOUDFLARE_API_ORIGIN}`);
  return url.origin as CloudflareOrigin;
}

declare const CLOUDFLARE_URL: unique symbol;
/** A request URL on a `CloudflareOrigin`. Made only by `cloudflareUrl`; a plain string does not type-check at the fetch. */
export type CloudflareUrl = string & { readonly [CLOUDFLARE_URL]: true };

export function cloudflareUrl(origin: CloudflareOrigin, apiPath: string): CloudflareUrl {
  return `${origin}/client/v4${apiPath}` as CloudflareUrl;
}

/** The ONLY request that carries the API token or one of its descendants. The URL is re-pinned onto `origin` here. */
export function cloudflareFetch(origin: CloudflareOrigin, url: CloudflareUrl, init: RequestInit): Promise<Response> {
  return fetch(pinToOrigin(origin, url, "servicecue-deploy"), init);
}

// ── What a failure says ──────────────────────────────────────────────────────

/** One request's failure: the HTTP status and Cloudflare's own code and words, when it gave them. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    /** The HTTP status, null when there was no answer. */
    readonly status: number | null,
    /** The first error code in Cloudflare's answer. */
    readonly code: number | null,
    /** Which request, for the log: "verify the token", "register the files" and so on. */
    readonly step: string,
  ) {
    super(message);
    this.name = "CloudflareError";
  }

  /** 401 or 403: the token is not accepted, or not allowed to do this. Waiting does not change that. */
  get refused(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** For the log and the terminal: `at "upload the files" (HTTP 500, code 10013): <Cloudflare's words>`. */
  describe(): string {
    const answer = this.status === null ? "no answer" : `HTTP ${this.status}`;
    return `at "${this.step}" (${answer}${this.code === null ? "" : `, code ${this.code}`}): ${this.message}`;
  }
}

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 60_000;
/** Longest part of Cloudflare's words that is kept: they reach the log and the card. */
const MAX_MESSAGE = 400;
/** The largest answer read: every one is a small JSON document. */
const MAX_ANSWER_BYTES = 1024 * 1024;

interface Envelope {
  success?: unknown;
  errors?: unknown;
  result?: unknown;
}

// ── The files ────────────────────────────────────────────────────────────────

/** wrangler's own size ceiling for one asset. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** What wrangler never uploads as an asset, found at the root of the folder. `_headers` is config: see DeployManifest. */
const NOT_ASSETS = new Set(["/.assetsignore", "/_redirects", "/_headers"]);

/** wrangler's content types for what a page build writes (its bundled `mime`); an unknown type has none, and text gets a charset. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  css: "text/css",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain",
  wasm: "application/wasm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
};

/** The Content-Type the asset service will answer a file with, or null for none. */
export function contentTypeOf(file: string): string | null {
  const type = CONTENT_TYPES[path.extname(file).slice(1).toLowerCase()];
  if (!type) return null;
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
}

/** What Cloudflare calls a file: 32 hex digits of the BLAKE3 hash of its base64 text and extension, as wrangler computes it (the direct-upload docs say SHA-256). */
export function assetHash(bytes: Uint8Array, file: string): string {
  const base64 = Buffer.from(bytes).toString("base64");
  return bytesToHex(blake3(utf8ToBytes(base64 + path.extname(file).slice(1)))).slice(0, 32);
}

export interface BundleFile {
  /** The path the page serves it at: "/assets/index-ab12.js". */
  path: string;
  bytes: Buffer;
  hash: string;
  contentType: string | null;
}

export interface LoadedBundle {
  manifest: DeployManifest;
  worker: Buffer;
  files: BundleFile[];
}

/** There is nothing to deploy from: no folder, a failed build, a manifest this server cannot read. Says why, for the card and the log. */
export class BundleUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleUnavailable";
  }
}

/** `<folder>.failed`, the marker a failed build leaves (failureMarker in scripts/servicecue-bundle.ts): the commit, then why. */
export function failureMarkerOf(dir: string): string {
  return `${dir}.failed`;
}

/** A Cloudflare account ID: 32 lower-case hex digits. */
export const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const isVersion = (text: string): boolean => parseTag(`v${text}`) !== null;
const WORKER_NAME = /^[A-Za-z0-9_-]{1,63}$/;
const BINDING_TYPES: Readonly<Record<string, readonly string[]>> = {
  assets: ["name"],
  durable_object_namespace: ["name", "class_name"],
  json: ["name"],
  plain_text: ["name", "text"],
};


/** deploy.json, checked field by field: what is in it goes to Cloudflare as it stands. */
export function parseManifest(raw: unknown): DeployManifest {
  const bad = (what: string): never => {
    throw new BundleUnavailable(`deploy.json ${what}`);
  };
  if (!isRecord(raw)) return bad("is not an object");
  const { name, build, version, mainModule, compatibilityDate, compatibilityFlags, protocol, assets, bindings, keep_bindings: keep, exports } = raw;
  if (typeof name !== "string" || !WORKER_NAME.test(name)) bad("has no usable Worker name");
  if (!isViewerBuildId(build)) bad("has no build id");
  if (typeof version !== "string" || !isVersion(version)) bad("has no version");
  if (typeof mainModule !== "string" || !/^[A-Za-z0-9._-]+$/.test(mainModule)) bad("has no usable main module");
  if (typeof compatibilityDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) bad("has no compatibility date");
  if (!isStringList(compatibilityFlags)) bad("has compatibility flags that are not a list of names");
  if (typeof protocol !== "number") bad("has no protocol");
  if (!isRecord(assets) || typeof assets._headers !== "string") bad("has no assets config with the headers text");
  if (!Array.isArray(bindings)) bad("has no bindings list");
  for (const b of bindings as unknown[]) {
    const fields = isRecord(b) && typeof b.type === "string" ? BINDING_TYPES[b.type] : undefined;
    if (!isRecord(b) || !fields || !fields.every((f) => typeof b[f] === "string")) bad(`has a binding it cannot read: ${JSON.stringify(b)?.slice(0, 80)}`);
  }
  if (!isStringList(keep) || !keep.includes("secret_text")) bad("does not keep secret_text bindings, which would delete the publishing token");
  if (!isRecord(exports)) bad("has no exports");
  return raw as unknown as DeployManifest;
}

/**
 * The manifest of the folder, or why there is none. A build that failed softly says so beside the
 * folder, and that reason is worth more to the operator than "not found".
 */
export function readManifest(dir: string): DeployManifest {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "deploy.json"), "utf8");
  } catch (err) {
    if (!isNotFound(err)) throw new BundleUnavailable(`deploy.json could not be read: ${errorMessage(err)}`);
    let marker: string | null = null;
    try {
      marker = fs.readFileSync(failureMarkerOf(dir), "utf8");
    } catch {
      // No marker: the folder was never made, which is what the message says.
    }
    if (marker !== null) {
      const why = marker.split("\n")[1]?.trim();
      throw new BundleUnavailable(`this build has no copy of the page: its bundle failed${why ? ` (${why})` : ""}`);
    }
    throw new BundleUnavailable("this build has no copy of the page: it has no build/servicecue/deploy.json");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BundleUnavailable("deploy.json is not JSON");
  }
  return parseManifest(raw);
}

/** Every file under `dir`, as the path the page serves it at. Links are not followed. */
function walk(dir: string, rel = ""): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const here = `${rel}/${entry.name}`;
    if (entry.isDirectory()) return walk(dir, here);
    return entry.isFile() ? [here] : [];
  });
}

/** The whole folder: manifest (read here unless the caller has), Worker module and every page file, hashed. */
export function readBundle(dir: string, manifest: DeployManifest = readManifest(dir)): LoadedBundle {
  try {
    const worker = fs.readFileSync(path.join(dir, manifest.mainModule));
    const publicDir = path.join(dir, "public");
    const files = walk(publicDir)
      .filter((p) => !NOT_ASSETS.has(p))
      .sort()
      .map((p): BundleFile => {
        const bytes = fs.readFileSync(path.join(publicDir, p));
        if (bytes.byteLength > MAX_ASSET_BYTES) throw new BundleUnavailable(`${p} is over Cloudflare's ${MAX_ASSET_BYTES / 1024 / 1024} MiB limit for one file`);
        return { path: p, bytes, hash: assetHash(bytes, p), contentType: contentTypeOf(p) };
      });
    if (files.length === 0) throw new BundleUnavailable("the page's public/ folder has no files");
    return { manifest, worker, files };
  } catch (err) {
    if (err instanceof BundleUnavailable) throw err;
    throw new BundleUnavailable(`the bundle could not be read: ${errorMessage(err)}`);
  }
}

// ── The client ───────────────────────────────────────────────────────────────

export interface CloudflareOptions {
  origin: CloudflareOrigin;
  accountId: string;
  token: string;
  /** The Worker's name. */
  script: string;
}

/** What Cloudflare holds of the page's last deploy: the build and version this server annotated it with. */
export interface DeployedPage {
  build: string | null;
  version: string | null;
  /** Epoch ms the deployment went live. */
  at: number | null;
}

/** How many files a deploy uploaded, and how many Cloudflare already had. */
export interface DeployedFiles {
  uploaded: number;
  held: number;
}

/** wrangler's default for a Worker with Durable Object classes. */
const DURABLE_OBJECT_UPDATES = { mode: "deferred", max_delay: 300 } as const;

/** "Stage Utility 1.28.0": the message this server puts on the version it uploads, and reads the version back from. */
export const DEPLOY_MESSAGE_PREFIX = "Stage Utility ";

/** The version in a message this server wrote, or null. */
export function versionOfMessage(message: unknown): string | null {
  if (typeof message !== "string" || !message.startsWith(DEPLOY_MESSAGE_PREFIX)) return null;
  const version = message.slice(DEPLOY_MESSAGE_PREFIX.length);
  return isVersion(version) ? version : null;
}

/**
 * The clear failures for a Worker this token cannot use. Creating it is the manual
 * first-time step, never an upload's side effect. These reads come after the token
 * itself was accepted, so a 403 here is a token with no role on this one Worker:
 * Cloudflare answers so for a Worker that is missing as well, and does not say which.
 */
function missingWorker(err: unknown, script: string): unknown {
  if (!(err instanceof CloudflareError)) return err;
  if (err.status === 404) {
    return new CloudflareError(`the Worker '${script}' does not exist on this account: create it once by hand (docs/ops/servicecue-on-the-web.md)`, 404, err.code, "check the Worker exists");
  }
  if (err.status === 403) {
    return new CloudflareError(`this token has no access to the Worker '${script}': it may not exist, or the token is not given Editor on it (docs/ops/servicecue-on-the-web.md)`, 403, err.code, "check the Worker exists");
  }
  return err;
}

export interface CloudflareClient {
  verifyToken(): Promise<void>;
  deployedPage(): Promise<DeployedPage>;
  /** `version` is the RUNNING server's: what is recorded with the page, to be read back by the next server that looks. */
  deploy(bundle: LoadedBundle, version: string, onPlan?: (plan: DeployedFiles) => void): Promise<DeployedFiles>;
}

/** The payload of a JWT, for the one flag wrangler reads from it. Never throws. */
function jwtPayload(jwt: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createCloudflare(opts: CloudflareOptions): CloudflareClient {
  const { origin, accountId, token, script } = opts;
  if (!ACCOUNT_ID_PATTERN.test(accountId)) throw new Error("the Cloudflare account ID is 32 letters and digits");
  if (!WORKER_NAME.test(script)) throw new Error("the Worker's name is not one Cloudflare takes");
  const account = `/accounts/${accountId}`;
  const scriptPath = `${account}/workers/scripts/${encodeURIComponent(script)}`;

  /** Secrets this client has handled, taken out of anything it says about a failure. */
  const secrets = new Set<string>([token]);
  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[removed]");
    return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}...` : out;
  };

  /** One request. The result is the answer's `result`; anything else throws a CloudflareError. */
  async function call(step: string, method: string, apiPath: string, init: { bearer?: string; body?: BodyInit; contentType?: string; query?: Record<string, string> } = {}): Promise<unknown> {
    const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await cloudflareFetch(origin, cloudflareUrl(origin, `${apiPath}${query}`), {
        method,
        headers: { Authorization: `Bearer ${init.bearer ?? token}`, ...(init.contentType ? { "Content-Type": init.contentType } : {}) },
        body: init.body,
        // Never followed: a redirect would carry the token where the answer pointed.
        redirect: "error",
        signal: timeout,
      });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "TimeoutError") throw new CloudflareError(`Cloudflare did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`, null, null, step);
      throw new CloudflareError(redact(fetchFailureMessage(err, origin)), null, null, step);
    }
    let body: Envelope | undefined;
    try {
      const bytes = await readCapped(res, MAX_ANSWER_BYTES);
      const parsed: unknown = bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
      body = isRecord(parsed) ? parsed : undefined;
    } catch {
      body = undefined;
    }
    if (res.ok && body?.success === true) return body.result;
    const errors = Array.isArray(body?.errors) ? (body.errors as unknown[]).filter(isRecord) : [];
    const code = typeof errors[0]?.code === "number" ? errors[0].code : null;
    const words = errors.map((e) => (typeof e.message === "string" ? e.message : "")).filter((m) => m !== "").join("; ");
    const said = words || (body ? "no reason given" : "an answer that is not Cloudflare's API");
    throw new CloudflareError(redact(said), res.status, code, step);
  }

  async function verifyToken(): Promise<void> {
    const active = (result: unknown): void => {
      const status = isRecord(result) ? result.status : undefined;
      if (status !== "active") throw new CloudflareError(`the token is ${typeof status === "string" ? status : "not active"}`, 401, null, "verify the token");
    };
    try {
      active(await call("verify the token", "GET", "/user/tokens/verify"));
    } catch (err) {
      // A token made under the account (rather than under a person) is verified at its own address, and is refused at the first.
      if (!(err instanceof CloudflareError) || !err.refused) throw err;
      try {
        active(await call("verify the token", "GET", `${account}/tokens/verify`));
      } catch {
        // Neither accepts it: the first refusal is the one that says why.
        throw err;
      }
    }
  }

  async function deployedPage(): Promise<DeployedPage> {
    const step = "read the deployed version";
    const listed = await call(step, "GET", `${scriptPath}/deployments`).catch((err: unknown) => {
      throw missingWorker(err, script);
    });
    const deployments = isRecord(listed) && Array.isArray(listed.deployments) ? listed.deployments.filter(isRecord) : [];
    const latest = deployments[0];
    if (!latest) return { build: null, version: null, at: null };
    const at = typeof latest.created_on === "string" && Number.isFinite(Date.parse(latest.created_on)) ? Date.parse(latest.created_on) : null;
    // The version that has most of the traffic: the one the page serves.
    const versions = Array.isArray(latest.versions) ? latest.versions.filter(isRecord) : [];
    versions.sort((a, b) => (typeof b.percentage === "number" ? b.percentage : 0) - (typeof a.percentage === "number" ? a.percentage : 0));
    const id = versions[0]?.version_id;
    if (typeof id !== "string") return { build: null, version: null, at };
    const detail = await call(step, "GET", `${scriptPath}/versions/${encodeURIComponent(id)}`);
    const notes = [isRecord(detail) ? detail.annotations : undefined, latest.annotations].filter(isRecord);
    const tag = notes.map((n) => n["workers/tag"]).find((t) => typeof t === "string");
    const version = notes.map((n) => versionOfMessage(n["workers/message"])).find((v) => v !== null) ?? null;
    return { build: isViewerBuildId(tag) ? tag : null, version, at };
  }

  /** Register the files, upload the ones Cloudflare lacks, and answer with the token that attaches them to the Worker. */
  async function syncAssets(bundle: LoadedBundle, onPlan?: (plan: DeployedFiles) => void): Promise<{ jwt: string } & DeployedFiles> {
    const manifest: Record<string, { hash: string; size: number }> = {};
    for (const f of bundle.files) manifest[f.path] = { hash: f.hash, size: f.bytes.byteLength };
    const session = await call("register the files", "POST", `${scriptPath}/assets-upload-session`, { body: JSON.stringify({ manifest }), contentType: "application/json" });
    const sessionJwt = isRecord(session) ? session.jwt : undefined;
    if (typeof sessionJwt !== "string" || sessionJwt === "") throw new CloudflareError("Cloudflare's answer to the file list carried no token", null, null, "register the files");
    secrets.add(sessionJwt);
    const rawBuckets = isRecord(session) && Array.isArray(session.buckets) ? session.buckets : [];
    const buckets = rawBuckets.map((b) => (isStringList(b) ? b : []));
    const wanted = buckets.flat();
    const plan = { uploaded: wanted.length, held: bundle.files.length - wanted.length };
    onPlan?.(plan);
    if (wanted.length === 0) return { jwt: sessionJwt, ...plan };

    const byHash = new Map<string, BundleFile>();
    for (const f of bundle.files) if (!byHash.has(f.hash)) byHash.set(f.hash, f);
    const find = (hash: string): BundleFile => {
      const file = byHash.get(hash);
      if (!file) throw new CloudflareError("Cloudflare asked for a file that is not in the bundle", null, null, "upload the files");
      return file;
    };
    // The session's token says which way this account is uploaded: a file to a request, or a bucket to one.
    const single = jwtPayload(sessionJwt).wrangler_single_asset_uploads === true;
    let completion = "";
    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      const files = bucket.map(find);
      const requests: { path: string; init: { body: BodyInit; contentType?: string; query?: Record<string, string> } }[] = single
        ? files.map((f) => ({ path: `${account}/workers/assets/upload/${f.hash}`, init: { body: new Uint8Array(f.bytes), contentType: f.contentType ?? "application/null" } }))
        : [{ path: `${account}/workers/assets/upload`, init: { body: bucketForm(files), query: { base64: "true" } } }];
      for (const r of requests) {
        const answer = await call("upload the files", "POST", r.path, { bearer: sessionJwt, ...r.init });
        const jwt = isRecord(answer) ? answer.jwt : undefined;
        if (typeof jwt === "string" && jwt !== "") {
          secrets.add(jwt);
          completion = jwt;
        }
      }
    }
    if (completion === "") throw new CloudflareError("Cloudflare did not finish the file upload: no completion token came back", null, null, "upload the files");
    return { jwt: completion, ...plan };
  }

  async function deploy(bundle: LoadedBundle, version: string, onPlan?: (plan: DeployedFiles) => void): Promise<DeployedFiles> {
    const { manifest } = bundle;
    // The PUT creates a Worker that is not there: that must be somebody's choice, made once, by hand.
    await call("check the Worker exists", "GET", `${scriptPath}/settings`).catch((err: unknown) => {
      throw missingWorker(err, script);
    });
    const assets = await syncAssets(bundle, onPlan);
    const metadata = {
      main_module: manifest.mainModule,
      bindings: manifest.bindings satisfies DeployBinding[],
      compatibility_date: manifest.compatibilityDate,
      ...(manifest.compatibilityFlags.length > 0 ? { compatibility_flags: manifest.compatibilityFlags } : {}),
      ...(Object.values(manifest.exports).some((e) => isRecord(e) && e.type === "durable-object") ? { code_update_strategy: DURABLE_OBJECT_UPDATES } : {}),
      ...(Object.keys(manifest.exports).length > 0 ? { exports: manifest.exports } : {}),
      keep_bindings: manifest.keep_bindings,
      annotations: { "workers/message": `${DEPLOY_MESSAGE_PREFIX}${version}`, "workers/tag": manifest.build },
      assets: { jwt: assets.jwt, config: manifest.assets },
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set(manifest.mainModule, new File([new Uint8Array(bundle.worker)], manifest.mainModule, { type: "application/javascript+module" }));
    // excludeScript keeps the whole module out of the answer; bindings_inherit=strict is wrangler's, for a Worker that already has secrets.
    await call("upload the Worker", "PUT", scriptPath, { body: form, query: { excludeScript: "true", bindings_inherit: "strict" } });
    return { uploaded: assets.uploaded, held: assets.held };
  }

  return { verifyToken, deployedPage, deploy };
}

/** One bucket as the upload takes it: a part named for each file's hash, holding its base64 text, typed as the file is to be served. */
function bucketForm(files: BundleFile[]): FormData {
  const form = new FormData();
  for (const f of files) {
    // "application/null" is how a file with no type says so: a form encoder would make it octet-stream otherwise.
    form.append(f.hash, new File([f.bytes.toString("base64")], f.hash, { type: f.contentType ?? "application/null" }), f.hash);
  }
  return form;
}
