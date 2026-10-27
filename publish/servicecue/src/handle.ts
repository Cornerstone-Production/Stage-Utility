// handle.ts — the whole of what the Worker does with a request, except storing.
//
// Routing, the token, body limits, validation, headers and every refusal live here
// and in the modules it calls; what is kept and what is sent to viewers is the
// hub's (hub.ts). Written against HubApi and a plain `assets` function, with no
// Workers API in it, so the root test suite runs this exact code with an in-memory
// hub. worker.ts is the thin part that wires it to the runtime.

import {
  ASSET_CONTENT_TYPES,
  PUBLISH_MAX_BODY_BYTES,
  VIEWER_HTML,
  assetContentType,
} from "../../../main/types/servicecue-publish.js";
import { authorize } from "./auth.js";
import { BodyTooLarge, readCappedBody } from "./body.js";
import { viewerBuild } from "./build.js";
import { SVG_CSP, htmlCsp, json, jsonText, noContent, secured } from "./headers.js";
import type { HubApi } from "./hub-api.js";
import { isPublishArea, routePublic, routePublish, type Rejection } from "./routes.js";
import { docText, frameBody, heartbeatBody, manifestBody, parseJson, type Parsed } from "./validate.js";

export interface HandlerDeps {
  hub: HubApi;
  /** A viewer's WebSocket handshake, given to the object with the id of the page this deployment serves (null when it carries none). */
  upgrade: (request: Request, build: string | null) => Promise<Response>;
  /** Serves a built file from the static assets. Answers 404 for one that is not there. */
  assets: (request: Request) => Promise<Response>;
  /** The PUBLISH_TOKEN secret, if the deploy has one. Whatever it is bound as, it is only a token if it is a long enough string. */
  token: unknown;
  /** The edge's clock, in milliseconds. */
  now: () => number;
}

/** `wrangler dev` and the tests serve plain http on the loopback; nothing else may. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A plain-http request, which reaches the Worker only if the zone's Always Use HTTPS
 * is off. A visitor is sent to the same address over https. A publish is refused
 * without its token being looked at: the token has already crossed the wire in the
 * clear, and a publisher that sent it so is told loudly rather than kept working.
 */
function plainHttp(url: URL): Response | null {
  if (url.protocol !== "http:" || LOOPBACK.has(url.hostname)) return null;
  if (isPublishArea(url.pathname)) return json({ error: "Publishing needs https" }, 403);
  const to = new URL(url);
  to.protocol = "https:";
  return new Response(null, { status: 301, headers: { Location: to.href } });
}

/** Answer a request. Every response carries the base headers. */
export async function handle(request: Request, deps: HandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const insecure = plainHttp(url);
  if (insecure) return secured(insecure);
  try {
    return secured(isPublishArea(url.pathname) ? await publish(request, url, deps) : await serve(request, url, deps));
  } catch (err) {
    // A storage or runtime failure is neither swallowed nor shown: the caller is told
    // it was a failure and not a refusal (a publisher retries a 500 and gives up on a
    // 4xx), and the reason is on the Worker's log for whoever runs `wrangler tail`. The
    // body says nothing about it: this answer reaches anonymous visitors too.
    console.error(`[servicecue-worker] ${request.method} ${url.pathname} failed:`, err);
    return secured(json({ error: "The Worker could not answer that" }, 500));
  }
}

const rejection = (r: Rejection): Response => json({ error: r.error }, r.status, r.allow ? { Allow: r.allow } : {});

/** A HEAD gets the headers its GET would, and no body. */
const forMethod = (request: Request, response: Response): Response =>
  request.method === "HEAD" ? new Response(null, response) : response;

/** Did the static assets have the file: a 200, or a 304 to the conditional request a browser sends for one it holds. */
const found = (res: Response): boolean => res.ok || res.status === 304;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

type Body<T> = { ok: true; value: T } | { ok: false; response: Response };

/** The request's body, capped, as it came. */
async function readBytes(request: Request): Promise<Body<Uint8Array>> {
  try {
    return { ok: true, value: await readCappedBody(request, PUBLISH_MAX_BODY_BYTES) };
  } catch (err) {
    if (err instanceof BodyTooLarge) {
      return { ok: false, response: json({ error: `The body is over ${PUBLISH_MAX_BODY_BYTES} bytes` }, 413) };
    }
    throw err;
  }
}

/** The request's body, capped, parsed as JSON and put to `validate` (which is given the value and the exact text). What is refused is the response. */
async function readValidated<T>(request: Request, validate: (json: unknown, text: string) => Parsed<T>): Promise<Body<T>> {
  const bytes = await readBytes(request);
  if (!bytes.ok) return bytes;
  const parsed = parseJson(bytes.value);
  const valid: Parsed<T> = parsed.ok ? validate(parsed.value.json, parsed.value.text) : parsed;
  return valid.ok ? { ok: true, value: valid.value } : { ok: false, response: json({ error: valid.error }, valid.status) };
}

// ── The publisher's side ──────────────────────────────────────────────────────

async function publish(request: Request, url: URL, deps: HandlerDeps): Promise<Response> {
  // The token before anything else, so a caller without one learns nothing about
  // which paths and methods exist.
  const auth = await authorize(request.headers.get("Authorization"), deps.token);
  if (!auth.ok) return json({ error: auth.error }, auth.status, auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});

  const r = routePublish(request.method, url);
  switch (r.kind) {
    case "reject":
      return rejection(r);

    case "putDoc": {
      const body = await readValidated(request, (value, text) => docText(r.key, text, value));
      if (!body.ok) return body.response;
      await deps.hub.putDoc(r.key, body.value);
      return noContent();
    }

    case "deleteDoc":
      await deps.hub.deleteDoc(r.key);
      return noContent();

    case "postFrame": {
      // A frame is a write of the doc its channel is stored as.
      const body = await readValidated(request, frameBody);
      if (!body.ok) return body.response;
      await deps.hub.putDoc(body.value.docKey, body.value.text);
      return noContent();
    }

    case "putAsset": {
      const type = assetContentType(request.headers.get("Content-Type"));
      if (type === null) {
        return json({ error: `The Content-Type must be one of ${ASSET_CONTENT_TYPES.join(", ")}` }, 415);
      }
      const bytes = await readBytes(request);
      if (!bytes.ok) return bytes.response;
      if (bytes.value.byteLength === 0) return json({ error: "The image is empty" }, 400);
      await deps.hub.putAsset(r.name, type, toArrayBuffer(bytes.value));
      return noContent();
    }

    case "postHeartbeat": {
      const body = await readValidated(request, heartbeatBody);
      if (!body.ok) return body.response;
      await deps.hub.heartbeat(body.value.sentAt, body.value.version, await servedBuild(deps.assets, url, "the heartbeat"));
      return noContent();
    }

    case "putManifest": {
      const body = await readValidated(request, manifestBody);
      if (!body.ok) return body.response;
      return json(await deps.hub.applyManifest(body.value.docs, body.value.assets));
    }

    case "getStatus":
      return forMethod(request, json({ ...(await deps.hub.status()), build: await servedBuild(deps.assets, url, "the status") }));
  }
}

/**
 * The build id for an answer that carries one, which is worth having and not worth failing
 * for: the publisher's status and heartbeat and a viewer's handshake each ask for it on the
 * way to something that matters more (what is stored and whether the token works, a recorded
 * heartbeat, a connected viewer), and an asset service that threw must not turn any of them
 * into a 500. The answer says no build, and the Worker's log says which one and why.
 */
async function servedBuild(assets: HandlerDeps["assets"], url: URL, forWhat: string): Promise<string | null> {
  try {
    return await viewerBuild(assets, url);
  } catch (err) {
    console.error(`[servicecue-worker] ${forWhat} could not read the page's build id, and says none:`, err);
    return null;
  }
}

// ── The public side ───────────────────────────────────────────────────────────

/** Is this `Origin` the page's own? A handshake from another site is not served: it would spend this deploy's free quota on someone else's page. */
function sameOrigin(origin: string, url: URL): boolean {
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function serve(request: Request, url: URL, deps: HandlerDeps): Promise<Response> {
  const r = routePublic(request.method, url);
  switch (r.kind) {
    case "reject":
      return rejection(r);

    case "home":
      // A domain of its own opens on the landing page. Temporary, so a browser asks
      // again if the page ever moves.
      return new Response(null, { status: 302, headers: { Location: "/servicecue" } });

    case "doc": {
      const text = await deps.hub.getDoc(r.key);
      if (text === null) {
        return json({ error: r.key.startsWith("rundown-") ? "That plan is not published" : "That is not published" }, 404);
      }
      return forMethod(request, jsonText(text));
    }

    case "asset": {
      const asset = await deps.hub.getAsset(r.name);
      if (asset === null) return json({ error: "That image is not published" }, 404);
      const headers: Record<string, string> = {
        "Content-Type": asset.type,
        // A name stands for the picture it was made from, but it is the publisher's to
        // reuse, so a browser asks again after a day.
        "Cache-Control": "public, max-age=86400",
      };
      if (asset.type === "image/svg+xml") headers["Content-Security-Policy"] = SVG_CSP;
      return forMethod(request, new Response(asset.body, { headers }));
    }

    case "heartbeat":
      return forMethod(request, json({ at: await deps.hub.getHeartbeat(), now: deps.now() }));

    case "live": {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "This is a WebSocket address" }, 426, { Upgrade: "websocket" });
      }
      const origin = request.headers.get("Origin");
      if (origin !== null && !sameOrigin(origin, url)) return json({ error: "Another site's page cannot open this socket" }, 403);
      return deps.upgrade(request, await servedBuild(deps.assets, url, "the viewer handshake"));
    }

    case "viewer": {
      const res = await deps.assets(new Request(new URL(VIEWER_HTML, url), request));
      // Not found is a deploy without the page in it, not a visitor's mistake.
      if (!found(res)) return json({ error: "The page is not part of this deployment" }, 503);
      const out = new Response(res.body, res);
      out.headers.set("Content-Security-Policy", htmlCsp(url));
      out.headers.set("Cache-Control", "no-cache");
      return out;
    }
  }
}
