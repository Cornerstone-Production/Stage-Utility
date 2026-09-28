// video-proxy-routes.ts — WHEP, WHIP and HLS, forwarded to the relay's
// loopback-only HTTP listeners on Stage Utility's own origin.
//
// mediamtx-config.ts binds every relay HTTP listener to 127.0.0.1, so this is
// the only way a browser or OBS ever reaches them: `/video/<feedId>/whep[/<session>]`,
// `/video/<feedId>/whip[/<session>]` and `/video/<feedId>/<file>.m3u8|.mp4|.m4s`,
// each forwarded to 127.0.0.1:<port> for that feed and that kind (videoService's
// relayTarget()).
//
// Runs in EARLY_ROUTE_MODULES (remote-server.ts): none of these paths start
// with /api/, so if this ran after static serving the SPA fallback would
// swallow every one of them before this module ever saw the request.
//
// Every route must finish responding before it returns (see RouteCtx) — the
// upstream call is always awaited, never fired and left to reply later.

import * as http from "node:http";

import { errorMessage } from "../errors.js";
import { OutageLog } from "../repeat-log.js";
import { scrub } from "../scrub.js";
import { videoService } from "../video/video-service.js";
import { type RouteCtx, error, readRawBody } from "./context.js";

/** WHEP/WHIP signalling is a handful of round trips over an SDP offer/answer
 *  — long enough to survive a slow network, short enough that a hung relay
 *  is reported rather than left to hold the request open indefinitely. */
const WHEP_WHIP_TIMEOUT_MS = 10_000;
/** LL-HLS's blocking playlist reload holds the request open until the next
 *  part is ready — the relay-facts fixture models 2 s of that. 30 s covers a
 *  real stall without the client waiting forever on a relay that has hung. */
const HLS_TIMEOUT_MS = 30_000;
/** A WHEP/WHIP body is an SDP offer/answer, at most a few KB. 64 KB is
 *  headroom for that, not an invitation to send more — see context.ts's own
 *  MAX_* constants for the reasoning: an unauthenticated LAN POST must never
 *  accumulate without bound. */
const MAX_PROXY_BODY_BYTES = 64 * 1024;

/** MediaMTX's WHEP/WHIP session ids are UUIDs. Constrained so a malformed
 *  Location this proxy did not expect is dropped rather than forwarded, and
 *  so a `/whep/<session>` request whose session carries a `/` cannot smuggle
 *  a second path segment into the upstream request. */
const SESSION_PATTERN = /^[A-Za-z0-9-]+$/;
/** The three extensions MediaMTX's HLS server answers — see decisions.md's
 *  proxy-routes row. No `/` in the class, so a percent-encoded traversal
 *  attempt (`..%2Fsecret.m3u8`) fails this outright: the `%` is not in it. */
const HLS_FILE_PATTERN = /^[A-Za-z0-9_.-]+\.(m3u8|mp4|m4s)$/;

const PREFIX = "/video/";

type Parsed =
  | { feedId: string; kind: "whep" | "whip"; session: string | null }
  | { feedId: string; kind: "hls"; file: string };

/**
 * Split `/video/<feedId>/<rest>` into a feed id and what it is asking for.
 *
 * Three outcomes, not two, because "not ours" and "ours, but garbage" answer
 * differently:
 *
 *   - "unclaimed" — the path is not this module's shape at all (no `/video/`
 *     prefix, or nothing after the feed id). Falls through to the next
 *     module and, past static serving, the app's own SPA shell — the normal
 *     "not handled" contract every route module shares (see RouteCtx).
 *   - "invalid" — the path HAS the `/video/<feedId>/<tail>` shape but the
 *     tail names no real kind (a `whep`/`whip` session id outside
 *     SESSION_PATTERN, or a file outside HLS_FILE_PATTERN). Left as
 *     "unclaimed" this would fall through past static serving into the SPA
 *     shell, which answers 200 with the whole app rather than a 404 — the
 *     path IS this module's territory and this module says so.
 *   - a Parsed request — refused or forwarded from here, by relayTarget().
 *
 * A `..` segment can never reach either "ours" outcome: the WHATWG URL
 * parser that built `pathname` already collapsed it before this ever ran
 * (confirmed against Node's URL — `/video/cam/../../v3/paths/list` arrives
 * here as `/v3/paths/list`, "unclaimed" by construction), so there is no
 * separate traversal case to parse for.
 */
function parseRequest(pathname: string): Parsed | "unclaimed" | "invalid" {
  if (!pathname.startsWith(PREFIX)) return "unclaimed";
  const rest = pathname.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return "unclaimed"; // no feed id, or no sub-path at all
  const feedId = rest.slice(0, slash);
  const tail = rest.slice(slash + 1);
  if (tail === "") return "unclaimed";

  for (const kind of ["whep", "whip"] as const) {
    if (tail === kind) return { feedId, kind, session: null };
    if (tail.startsWith(`${kind}/`)) {
      const session = tail.slice(kind.length + 1);
      return SESSION_PATTERN.test(session) ? { feedId, kind, session } : "invalid";
    }
  }
  return HLS_FILE_PATTERN.test(tail) ? { feedId, kind: "hls", file: tail } : "invalid";
}

/** The upstream request path a target's base is extended into, for one
 *  parsed request. */
function upstreamPath(target: { path: string }, parsed: Parsed, search: string): string {
  if (parsed.kind === "hls") return `${target.path}/${parsed.file}${search}`;
  return parsed.session ? `${target.path}/${parsed.session}` : target.path;
}

/**
 * A `Location` MediaMTX itself sends is relative to ITS OWN root — WHEP/WHIP
 * creation answers `Location: /<path>/whep/<uuid>` (relay-facts.md), and the
 * HLS listener answers its OWN redirect the same way: a plain
 * `GET /<path>/index.m3u8` comes back `302` to `/<path>/index.m3u8?cookieCheck=1`
 * with a `Set-Cookie` — undocumented anywhere until this proxy's own drive
 * against the real v1.21.1 binary hit it (task-13-report.md); the WHEP
 * answer's Location was the only one relay-facts.md had actually probed.
 * Either shape must read back on Stage Utility's own origin: the WHEP
 * player resolves its DELETE against whatever URL it POSTed to, and a
 * browser resolves a redirect against the CURRENT origin, which is Stage
 * Utility's, not the relay's loopback port it can never reach directly.
 *
 * Only a Location that actually starts with this feed's own relay-root
 * prefix is rewritten; anything else is dropped rather than forwarded
 * verbatim onto a browser.
 */
function rewriteLocation(location: string, feedId: string): string | null {
  const prefix = `/${feedId}/`;
  return location.startsWith(prefix) ? `/video/${location.slice(1)}` : null;
}

/** One shared log, keyed per feed: a relay outage touching five feeds is five
 *  independent facts (a viewer of feed A gets no news about feed B), and a
 *  flapping relay for one feed still collapses to one line per outage rather
 *  than one per request — the same shape video-service.ts's own pollOutage
 *  uses for the relay-status poll. */
const proxyOutage = new OutageLog();

function reportProxyFailure(feedId: string, err: unknown): void {
  const message = errorMessage(err);
  const decision = proxyOutage.fail(feedId, message, Date.now());
  if (decision.log) {
    console.warn(`[video] proxy to relay failed for ${scrub(feedId)}: ${scrub(message)}${scrub(decision.note)}`);
  }
}

function reportProxyRecovered(feedId: string): void {
  const decision = proxyOutage.ok(feedId, Date.now());
  if (decision.log) {
    console.log(`[video] proxy to the relay for ${scrub(feedId)} is answering again${scrub(decision.note)}`);
  }
}

/** Headers this proxy forwards to the relay, and nothing else — a WHEP/WHIP
 *  body's Content-Type, OBS's WHIP Authorization Bearer token, and whatever
 *  cookie the relay's own HLS listener set on an earlier request (its
 *  cookie-check redirect and per-session cookie both round-trip through
 *  this — see rewriteLocation's own comment). */
function forwardedHeaders(req: http.IncomingMessage, bodyLength: number | null): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const contentType = req.headers["content-type"];
  if (contentType) headers["content-type"] = contentType;
  const authorization = req.headers["authorization"];
  if (authorization) headers["authorization"] = authorization;
  const cookie = req.headers.cookie;
  if (cookie) headers.cookie = cookie;
  if (bodyLength !== null) headers["content-length"] = String(bodyLength);
  return headers;
}

/**
 * Forward one request to the relay and stream its answer straight back —
 * `upstreamRes.pipe(res)` with no buffering in between, which is what lets
 * an LL-HLS blocking-reload response sit open for seconds without this
 * holding the whole body in memory first.
 *
 * An upstream error before any header has reached the client is a 502 with
 * the message; once headers are sent, the status line is already committed
 * and the only honest move left is to tear the response down.
 */
function forwardToUpstream(
  c: RouteCtx,
  target: { host: "127.0.0.1"; port: number },
  path: string,
  timeoutMs: number,
  body: Buffer | null,
  feedId: string,
  kind: "whep" | "whip" | "hls",
): Promise<void> {
  return new Promise((resolve) => {
    const { req, res, method } = c;
    const upstreamReq = http.request(
      {
        host: target.host,
        port: target.port,
        path,
        method,
        headers: forwardedHeaders(req, body ? body.length : null),
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        reportProxyRecovered(feedId);
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const h of ["content-type", "content-length", "etag", "set-cookie"]) {
          const v = upstreamRes.headers[h];
          if (v !== undefined) outHeaders[h] = v;
        }
        const location = upstreamRes.headers.location;
        const rewritten = typeof location === "string" ? rewriteLocation(location, feedId) : null;
        if (rewritten) outHeaders.location = rewritten;
        // A playlist or segment must never be cached: LL-HLS advances the
        // same file names across a stream's lifetime (relay-facts.md).
        if (kind === "hls") outHeaders["cache-control"] = "no-store";
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => {
          res.destroy();
          resolve();
        });
        res.on("finish", resolve);
        res.on("close", resolve);
      },
    );
    upstreamReq.on("timeout", () => {
      upstreamReq.destroy(new Error("The video relay did not answer in time"));
    });
    upstreamReq.on("error", (err) => {
      reportProxyFailure(feedId, err);
      // "with the message" (task-13-brief.md) only while the status line is
      // still ours to write: once headers are sent, or the client itself is
      // already gone (the close handler below reaches here too, by
      // destroying this same request), the answer is no longer this proxy's
      // to give and the only honest move left is to tear it down.
      if (res.headersSent || res.writableEnded || res.destroyed) res.destroy();
      else error(res, errorMessage(err), 502);
      resolve();
    });
    // A client that goes away mid-stream — a screen navigating off, a
    // held LL-HLS reload the browser gave up on — must not leave the
    // upstream half of the pipe running. Harmless once the exchange has
    // already finished normally: destroying an ended request is a no-op.
    res.on("close", () => upstreamReq.destroy());
    if (body) upstreamReq.end(body);
    else upstreamReq.end();
  });
}

export async function videoProxyRoutes(c: RouteCtx): Promise<void> {
  const { req, res, pathname, url } = c;
  const parsed = parseRequest(pathname);
  if (parsed === "unclaimed") return;
  if (parsed === "invalid") {
    error(res, "Not found", 404);
    return;
  }

  const target = videoService.relayTarget(parsed.feedId, parsed.kind);
  if ("refuse" in target) {
    error(res, target.refuse === 503 ? "The video relay is not running" : "Not found", target.refuse);
    return;
  }

  // Told on every WHEP POST (a viewer asking to watch) and every playlist
  // GET (the fallback HLS player asking) — never on a session DELETE/PATCH
  // or a segment fetch, which say nothing new about demand. Bookkeeping
  // only: a failure here must never stand between a viewer and the stream,
  // so it is reported through the same outage log as a forwarding failure
  // rather than left to reject unnoticed.
  if ((parsed.kind === "whep" && parsed.session === null) || (parsed.kind === "hls" && parsed.file.endsWith(".m3u8"))) {
    void videoService.noteRequested(parsed.feedId).catch((err) => reportProxyFailure(parsed.feedId, err));
  }

  // Buffered, not piped: the only way to guarantee an over-cap body "never
  // reaches upstream" (task-13-brief.md) is to finish reading it before the
  // upstream connection even opens. Safe to buffer at this size — an SDP
  // offer/answer is a few KB — unlike the HLS response path below, which
  // streams because a held blocking-reload response can run to seconds.
  const body = parsed.kind === "hls" ? null : Buffer.from(await readRawBody(req, MAX_PROXY_BODY_BYTES));

  const path = upstreamPath(target, parsed, url.search);
  const timeoutMs = parsed.kind === "hls" ? HLS_TIMEOUT_MS : WHEP_WHIP_TIMEOUT_MS;
  await forwardToUpstream(c, target, path, timeoutMs, body, parsed.feedId, parsed.kind);
}
