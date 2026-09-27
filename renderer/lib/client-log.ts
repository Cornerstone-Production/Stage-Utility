// client-log.ts — get a browser-side failure onto /log.
//
// `console.warn` in the renderer reaches the browser's own console, which nobody
// has open. An operator debugging at 9am on a Sunday reads /log, and a failure
// that only ever reached devtools is a failure with no evidence at all.
//
// For FAILURES, not for tracing. Every call site should be something an operator
// would want to find while wondering why a figure is missing.

import { errorMessage } from "@main/services/errors";

/** One line, on the server's log, tagged the way the server's own lines are.
 *
 *  Fire and forget: it is a diagnostic, and a page must not change behaviour
 *  because a diagnostic did not send. It still writes to the browser console, so
 *  a developer with devtools open sees it immediately and without a round trip.
 *
 *  Never throws, and never rejects — a caller in a `catch` must not acquire a
 *  second failure to handle. */
export function logToServer(tag: string, message: string): void {
  console.warn(`[${tag}] ${message}`);
  try {
    void fetch("/api/log/client", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, message }),
      // The page may be navigating away as this fires; a keepalive request
      // still gets sent. The body is tiny, well inside the 64KB keepalive cap.
      keepalive: true,
    }).catch(() => {
      // The server being unreachable is the most likely reason a renderer call
      // failed in the first place. Saying so here would be a second line about
      // the same outage, sent to the thing that is down.
    });
  } catch {
    // `fetch` itself missing, or a synchronous throw from a hostile profile.
  }
}

/** A read that failed, in the one wording every such line uses:
 *  "could not read {what}: {reason}". A component that tracks which of its
 *  reads failed wants useFailedReads, which calls this. */
export function logReadFailure(tag: string, what: string, err: unknown): void {
  logToServer(tag, `could not read ${what}: ${errorMessage(err)}`);
}
