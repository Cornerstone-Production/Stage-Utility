// public-mode.ts — is this page the public ServiceCue viewer?
//
// The same ServiceCue pages are served two ways: from the church's own server, to
// people in the building, and from a Cloudflare Worker, to anyone with the link
// (publish/servicecue/). The second is built from the same code, and what it does
// differently is small and all of it a refusal to reach for something that is not
// there: no writes of any kind, no operator links, and its live frames arrive on
// one WebSocket instead of the server's event stream (see public-live.ts).
//
// The flag is an attribute on the page's own <html>, written into servicecue.html
// and into no other document. It is read where it is used, never held: nothing has
// to be imported or called first, so no order of module loading can leave a page
// half in one mode, and the operator app, whose documents do not carry it, cannot
// come to be in the other by accident.

/** The attribute servicecue.html carries on <html>. */
export const PUBLIC_VIEWER_ATTRIBUTE = "data-servicecue-public";

export function isPublicMode(): boolean {
  return typeof document !== "undefined" && document.documentElement?.hasAttribute(PUBLIC_VIEWER_ATTRIBUTE) === true;
}

/**
 * Was this read answered "not published"? On the public page a 404 is the Worker
 * holding no copy of that document: the church has not sent it yet, which a visitor
 * is told plainly rather than shown as a failure. Never true in the building, where a
 * 404 is a real one.
 */
export function notPublishedYet(err: unknown): boolean {
  return isPublicMode() && typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404;
}

/** What a visitor reads while the church has sent no service types. */
export const SERVICES_NOT_SENT = "The church hasn't sent its services yet. Check back soon.";
/** What a visitor reads for a rundown the church has not sent. */
export const RUNDOWN_NOT_SENT = "This service hasn't been sent yet. Check back soon.";
