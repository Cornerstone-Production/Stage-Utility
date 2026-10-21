// build.ts — which build of the page this deployment serves.
//
// The build stamps servicecue.html with an id (see VIEWER_BUILD_META in the contract).
// A page that is open across a deploy is the old build, and it learns so from the
// heartbeat: the Worker reads the id out of the document it is serving and gives it to
// the Durable Object, which puts it on the heartbeat it replays on connect and on every
// one it broadcasts. Plain functions with no Workers API in them, so the root suite
// runs them.

import { VIEWER_HTML, isViewerBuildId, viewerBuildFromHtml } from "../../../main/types/servicecue-publish.js";

/**
 * How the Worker hands the id to the object on a viewer's handshake, which cannot be
 * an argument: the handshake is a fetch. Only the Worker sets it (see forObject), so
 * the object can trust it.
 */
export const BUILD_HEADER = "X-Servicecue-Build";

/**
 * What has been said already, so a heartbeat every 30 seconds does not say it every 30
 * seconds. Per isolate, which a deploy replaces: a fixed deploy says nothing, and a
 * broken one says it once.
 */
const said = new Set<string>();
function sayOnce(message: string): void {
  if (said.has(message)) return;
  said.add(message);
  console.warn(`[servicecue-worker] ${message}`);
}

/** Test seam: forget what has been said. */
export function __resetBuildNoticesForTests(): void {
  said.clear();
}

/**
 * The build id of the page this deployment serves, read out of the document it holds,
 * or null when it holds none, or one that carries no id (a build from before ids).
 * One read of a small file from the static assets, so asked for when a viewer connects
 * and when the church sends a heartbeat, and not on every request.
 *
 * Null is not an error to the caller: the heartbeat goes out without a build and every
 * page carries on. It is said on the Worker's log, once, because it is also the reason
 * no open page will reload after a deploy, and nothing else would say so.
 */
export async function viewerBuild(assets: (request: Request) => Promise<Response>, origin: URL): Promise<string | null> {
  const res = await assets(new Request(new URL(VIEWER_HTML, origin)));
  if (!res.ok) {
    sayOnce(`${VIEWER_HTML} is not in this deploy (HTTP ${res.status}), so no page is told which build is current`);
    return null;
  }
  const build = viewerBuildFromHtml(await res.text());
  if (build === null) sayOnce(`${VIEWER_HTML} carries no build id, so a page left open will not reload after a deploy`);
  return build;
}

/**
 * `request`, ready for the object: any build header a visitor sent is thrown away, and
 * the Worker's own is set. A page could otherwise tell its own socket what build it was
 * on, which would be a lie told to nobody but itself, but the header is the Worker's
 * word to the object and it should not be possible to speak in it from outside.
 */
export function forObject(request: Request, build: string | null): Request {
  const headers = new Headers(request.headers);
  headers.delete(BUILD_HEADER);
  if (build !== null) headers.set(BUILD_HEADER, build);
  return new Request(request, { headers });
}

/** The build id a request to the object carries, or null when it carries none or one that is not an id. */
export function buildOf(request: Request): string | null {
  const value = request.headers.get(BUILD_HEADER);
  return isViewerBuildId(value) ? value : null;
}
