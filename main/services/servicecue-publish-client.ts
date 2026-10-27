// servicecue-publish-client.ts — the sender's HTTP half.
//
// One small client per (page address, token), speaking the `/_publish/v1/…` protocol
// (main/types/servicecue-publish.ts) and nothing else: no scheduling, no retries, no
// logging. Every call answers with a PushResult and never throws, so the publisher decides
// what a failure means and nothing a page does can reach into the rest of the app.
//
// The page is somebody else's server and the token is a credential, so:
//   - the token travels only as an `Authorization: Bearer` header, through `publishFetch`,
//     the one fetch in this file, which re-pins every URL onto the origin it was built for;
//   - a redirect is an ERROR, not a hop: following one would send the token wherever the
//     answer pointed;
//   - a response is read for its STATUS, except two answers worth reading, the status
//     request's lists and the manifest's removal lists, each capped and checked field by
//     field. Any other body is cancelled unread so the socket is released.

import { readCapped } from "./capped-download.js";
import { fetchFailureMessage, untrustedCertificateCode } from "./errors.js";
import { isStringList } from "./is-record.js";
import { pinToOrigin } from "./pinned-origin.js";
import type { PublishOrigin } from "./servicecue-publish-rules.js";
import type { PublishProblem } from "../types/servicecue-publish-status.js";
import { PUBLISH_BASE_PATH, PUBLISH_MAX_BODY_BYTES, PUBLISH_MAX_VERSION_LENGTH, PUBLISH_PROTOCOL_VERSION, isViewerBuildId, type PublishStatus } from "../types/servicecue-publish.js";

/** How long a request with no body may take. A body adds to it: see ceilingMs. */
export const PUBLISH_REQUEST_TIMEOUT_MS = 10_000;
/** The longest any request may take, a large upload included. */
const MAX_REQUEST_MS = 60_000;
/** A body earns another second for each this many bytes: a 1.5 MB logo on a busy uplink is not a failure. */
const BYTES_PER_EXTRA_SECOND = 100_000;

/** The most a status answer is read for (5,000 documents and images). */
const MAX_ANSWER_BYTES = 1024 * 1024;

// ── The one fetch ────────────────────────────────────────────────────────────

declare const PUBLISH_URL: unique symbol;
/** A request URL on a `PublishOrigin`. Made only by `publishUrl`; a plain string does not type-check at the fetch. */
export type PublishUrl = string & { readonly [PUBLISH_URL]: true };

export function publishUrl(origin: PublishOrigin, path: string): PublishUrl {
  return `${origin}${path}` as PublishUrl;
}

/**
 * The ONLY request to the operator's page: it carries the publishing token. `url` is
 * re-pinned onto `origin` here, so a path beginning `//` cannot move the token to
 * another host.
 */
export function publishFetch(origin: PublishOrigin, url: PublishUrl, init: RequestInit): Promise<Response> {
  return fetch(pinToOrigin(origin, url, "publish"), init);
}

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * Why a request did not succeed. The first nine are about the PAGE; `refused` is about
 * one document, image or frame (the message says which way: too large, unknown key, bad
 * body) and says nothing against the page or the token; `aborted` is this side stopping.
 */
export type PushFailureKind =
  | "auth"
  | "blocked"
  | "limited"
  | "no-token"
  | "server"
  | "rejected"
  | "redirect"
  | "unreachable"
  | "intercepted"
  | "protocol"
  | "refused"
  | "aborted";

export interface PushFailure {
  ok: false;
  kind: PushFailureKind;
  /** The HTTP status, when the page answered one. */
  status?: number;
  /** A plain sentence. Never contains the token. */
  message: string;
  /** What Node said, for the log when `message` is the operator's words for it. */
  detail?: string;
}

/** A failure as the problem the card shows. `refused` and `aborted` are never one; they read as the address not being the page. */
export function problemOf(f: PushFailure): PublishProblem {
  const kind = f.kind === "refused" || f.kind === "aborted" ? "rejected" : f.kind;
  return { kind, ...(f.status !== undefined ? { status: f.status } : {}), message: f.message };
}

/** What the page says it holds: the document keys and image names of its status answer, parsed field by field (the answer is untrusted). */
export type PageHolds = Pick<PublishStatus, "docs" | "assets">;

/** What a request that worked may carry back: the status answer, or the manifest's removals. */
export interface PushOk {
  ok: true;
  page?: PageStatus;
  /** From the manifest: what the page deleted because the manifest did not name it. */
  removed?: { docs: string[]; assets: string[] };
}

export type PushResult = PushOk | PushFailure;
/** What the page's status answer says about itself: what it holds, and which build of the page it serves (null from a Worker too old to say). */
export type PageStatus = PageHolds & Pick<PublishStatus, "build">;
export type StatusResult = (PushOk & { page: PageStatus }) | PushFailure;

export interface PushClient {
  putDoc(key: string, json: string): Promise<PushResult>;
  postFrame(channel: string, data: unknown): Promise<PushResult>;
  putAsset(name: string, bytes: Uint8Array, mime: string): Promise<PushResult>;
  heartbeat(at: number, version: string): Promise<PushResult>;
  putManifest(docs: readonly string[], assets: readonly string[]): Promise<PushResult>;
  status(): Promise<StatusResult>;
}

export interface PushClientOptions {
  origin: PublishOrigin;
  token: string;
  /** Stops every request in flight and refuses new ones. */
  signal?: AbortSignal;
  /** The ceiling for a request with no body. */
  timeoutMs?: number;
}

function failureOf(err: unknown, origin: string, ceilingMs: number): PushFailure {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError") return { ok: false, kind: "aborted", message: "Stopped." };
  if (name === "TimeoutError") {
    return { ok: false, kind: "unreachable", message: `No answer from ${origin} within ${ceilingMs / 1000} seconds.` };
  }
  const cause = err instanceof Error ? err.cause : undefined;
  // Node reports a refused redirect as a failed fetch whose cause says so.
  if (cause instanceof Error && /unexpected redirect/i.test(cause.message)) {
    return {
      ok: false,
      kind: "redirect",
      message: "The address answered with a redirect, which is never followed. Use the address the page was deployed at.",
    };
  }
  // Node's own words for this ("self-signed certificate; … try running Node.js with --use-system-ca") are advice to a developer, not to the operator.
  const code = untrustedCertificateCode(err);
  if (code !== null) {
    const host = new URL(origin).host;
    return {
      ok: false,
      kind: "intercepted",
      message: `Something on this network is intercepting the connection to ${host}, usually a firewall or web filter blocking the address. Ask whoever runs the firewall to allow ${host}.`,
      detail: `${code}: ${fetchFailureMessage(err, origin)}`,
    };
  }
  return { ok: false, kind: "unreachable", message: fetchFailureMessage(err, origin) };
}

/** A failure as the log says it: the plain sentence, and what Node said when that is not it. Scrubbed at the log line, to FAILURE_LOG_MAX. */
export function failureForLog(message: string, detail?: string): string {
  return detail ? `${message} (${detail})` : message;
}

/** Room for the sentence and Node's words beside it: scrub's usual 200 would cut off the code. */
export const FAILURE_LOG_MAX = 600;

/**
 * A status the page answered, as the failure it is.
 *
 * `scope` is what the request was ABOUT. A request about the page itself (the status and the
 * heartbeat, the lightest there are) that gets a 4xx other than the token's has reached an
 * address that is not the page, and a 503 to it is the Worker saying it has no token of its
 * own. A request about one thing the page holds that gets a 4xx has been refused THAT: the
 * page is there and took the token, and every other request is unaffected.
 */
function failureOfStatus(status: number, scope: "page" | "item"): PushFailure {
  const said = (kind: PushFailureKind, message: string): PushFailure => ({ ok: false, kind, status, message });
  if (status === 401) return said("auth", "The page answered 401: it did not accept the publishing token.");
  if (status === 403) {
    // The Worker itself only answers 401, so a 403 is a rule in front of it.
    return said("blocked", "The page answered 403: a Cloudflare rule in front of it (Access or the firewall) blocked this server.");
  }
  if (status === 429) return said("limited", "The page answered 429: it is limiting how often this server may send.");
  if (status >= 500) {
    return scope === "page" && status === 503
      ? said("no-token", "The page answered 503: it has no publishing token set yet (or one under 32 characters), or had a problem of its own.")
      : said("server", `The page answered ${status}: it had a problem of its own.`);
  }
  if (scope === "page") return said("rejected", `The page answered ${status}, which is not what the ServiceCue page says.`);
  return said("refused", status === 413 ? "The page refused it as too large (413)." : `The page refused it (${status}).`);
}


/** The status answer, if it has the shape the protocol promises. */
function parsePageStatus(raw: unknown): (PageStatus & { protocol: number }) | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.protocol !== "number" || !isStringList(o.docs) || !isStringList(o.assets)) return null;
  // A Worker from before `build` leaves it out, and one with something else in it has no build to name.
  return { protocol: o.protocol, docs: o.docs, assets: o.assets, build: isViewerBuildId(o.build) ? o.build : null };
}

/** The manifest's answer, if it has the shape the protocol promises. */
function parseRemoved(raw: unknown): { docs: string[]; assets: string[] } | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  return isStringList(o.removedDocs) && isStringList(o.removedAssets) ? { docs: o.removedDocs, assets: o.removedAssets } : undefined;
}

/** A response's JSON, or undefined when it is over the cap or not JSON. A body cut off by the ceiling or a stop throws. */
async function readJson(res: Response): Promise<unknown> {
  const bytes = await readCapped(res, MAX_ANSWER_BYTES);
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The ceiling for a request carrying `bytes`. */
function ceilingMs(baseMs: number, bytes: number): number {
  return Math.min(MAX_REQUEST_MS, baseMs + Math.floor(bytes / BYTES_PER_EXTRA_SECOND) * 1000);
}

export function createPushClient(opts: PushClientOptions): PushClient {
  const { origin, token, signal, timeoutMs = PUBLISH_REQUEST_TIMEOUT_MS } = opts;

  /** One request. Never throws; hands back the Response only for the caller that reads it. */
  async function request(
    method: string,
    path: string,
    body?: { data: string | Uint8Array; contentType: string },
  ): Promise<Response | PushFailure> {
    const size = body ? (typeof body.data === "string" ? Buffer.byteLength(body.data) : body.data.byteLength) : 0;
    // Counted here, before anything is sent: the page would only answer 413, after taking the whole body.
    if (size > PUBLISH_MAX_BODY_BYTES) {
      return { ok: false, kind: "refused", message: `It is ${size} bytes, over the page's limit of ${PUBLISH_MAX_BODY_BYTES}.` };
    }
    const ceiling = ceilingMs(timeoutMs, size);
    const timeout = AbortSignal.timeout(ceiling);
    try {
      return await publishFetch(origin, publishUrl(origin, `${PUBLISH_BASE_PATH}${path}`), {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": body.contentType } : {}) },
        body: body ? (body.data as BodyInit) : undefined,
        // Never follow: see the header. A refused redirect throws, and failureOf names it.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      return failureOf(err, origin, ceiling);
    }
  }

  /** The answer's status as a result, with its body cancelled unread: the page's words are not trusted, and an unread body holds the socket. */
  async function statusOnly(res: Response | PushFailure, scope: "page" | "item"): Promise<PushResult> {
    if (!(res instanceof Response)) return res;
    await res.body?.cancel().catch(() => undefined);
    return res.ok ? { ok: true } : failureOfStatus(res.status, scope);
  }

  const json = (data: string) => ({ data, contentType: "application/json" });

  return {
    async putDoc(key, text) {
      return statusOnly(await request("PUT", `/doc/${encodeURIComponent(key)}`, json(text)), "item");
    },

    async postFrame(channel, data) {
      // `data` is required, and JSON.stringify drops a key whose value is undefined: a frame with nothing in it says null.
      return statusOnly(await request("POST", "/frame", json(JSON.stringify({ channel, data: data === undefined ? null : data }))), "item");
    },

    async putAsset(name, bytes, mime) {
      return statusOnly(await request("PUT", `/asset/${encodeURIComponent(name)}`, { data: bytes, contentType: mime }), "item");
    },

    async heartbeat(at, version) {
      // The page answers 400 to a version that is empty or over 64 characters, and a 400 to the heartbeat reads as an address that is not the page.
      const body = { at, version: version.slice(0, PUBLISH_MAX_VERSION_LENGTH) || "unknown" };
      return statusOnly(await request("POST", "/heartbeat", json(JSON.stringify(body))), "page");
    },

    async putManifest(docs, assets) {
      const res = await request("PUT", "/manifest", json(JSON.stringify({ docs, assets })));
      if (!(res instanceof Response)) return res;
      if (!res.ok) return statusOnly(res, "item");
      // The answer says what the page deleted. One that cannot be read is a manifest that was accepted all the same.
      const removed = await readJson(res).then(parseRemoved, () => undefined);
      return removed ? { ok: true, removed } : { ok: true };
    },

    async status() {
      const res = await request("GET", "/status");
      if (!(res instanceof Response)) return res;
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return failureOfStatus(res.status, "page");
      }
      let page: (PageStatus & { protocol: number }) | null;
      try {
        page = parsePageStatus(await readJson(res));
      } catch (err) {
        // A body cut off by the ceiling or a stop is the page not answering; one that is not JSON, or is too big, is not the page.
        const name = (err as { name?: string } | null)?.name;
        if (name === "AbortError" || name === "TimeoutError") return failureOf(err, origin, timeoutMs);
        page = null;
      }
      if (!page) {
        return { ok: false, kind: "rejected", status: res.status, message: "The address answered, but not like the ServiceCue page. Check it." };
      }
      if (page.protocol !== PUBLISH_PROTOCOL_VERSION) {
        return {
          ok: false,
          kind: "protocol",
          message: `The page speaks protocol ${page.protocol} and this server speaks ${PUBLISH_PROTOCOL_VERSION}. Update whichever is older.`,
        };
      }
      return { ok: true, page: { docs: page.docs, assets: page.assets, build: page.build } };
    },
  };
}
