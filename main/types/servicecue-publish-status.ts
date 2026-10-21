// servicecue-publish-status.ts — what the server tells the settings card about web
// publishing: the settings, and how it is going.
//
// The app's own side of the feature. What the sender and the public page share is in
// servicecue-publish.ts; this is only what GET /api/servicecue/publish answers.

/** Off: not publishing, by choice. Problem: switched on and not getting through. */
export type PublishState = "off" | "publishing" | "problem";

/**
 * Why publishing is not getting through, as far as the sender can tell.
 *
 *  auth         401: the page did not accept the token. Held until the token or the address changes
 *  blocked      403: a Cloudflare rule (WAF, Access) in front of the page. The Worker itself says 401. Held
 *  limited      429: the page is rate limiting this server
 *  no-token     503 to the lightest request: the page has no token of its own set, or one under 32 characters
 *  server       another 5xx, or a 503 to a request the page had been answering
 *  rejected     the address answered, but not as the ServiceCue page does. Held
 *  redirect     the address answered with a redirect, which is never followed
 *  unreachable  no answer: DNS, a refused connection, a TLS failure other than the certificate, a timeout
 *  intercepted  a certificate this server would not trust: a firewall or web filter swapping in its own
 *  protocol     the page speaks another protocol version than this server. Held
 *  config       nothing was sent: no address or token, or one the rules refuse. Held
 */
export type PublishProblemKind =
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
  | "config";

export interface PublishProblem {
  kind: PublishProblemKind;
  /** The HTTP status the page answered, when it answered one. */
  status?: number;
  /** A plain sentence, for the log and for a client with no wording of its own. */
  message: string;
}

/**
 * Why what is published cannot be brought up to date from Planning Center: a read of the service
 * types, the plan list or a rundown failed. The page is still reached; it keeps what it last received.
 */
export interface SourceProblem {
  /** Why the read failed, as the server logs it. */
  message: string;
}

export interface PublisherStatus {
  enabled: boolean;
  state: PublishState;
  /** Epoch ms of the last request the page accepted, a heartbeat included. */
  lastSentAt: number | null;
  /** The problem, while `state` is "problem"; null otherwise. */
  lastError: PublishProblem | null;
  /** Planning Center could not be read, while publishing is on and Planning Center is set up; null otherwise.
   *  Apart from `state`: it never makes the page unreachable, and a page problem does not clear it. */
  sourceProblem: SourceProblem | null;
  /** What the page was last sent: landing page service types, the plans in their
   *  switchers that have not gone by, and layouts. */
  counts: { types: number; plans: number; layouts: number };
  /** The server's clock when this was built. `lastSentAt` is on the same clock, so the
   *  age is `now - lastSentAt` whatever the browser's own clock says. */
  now: number;
}

/** What GET and POST /api/servicecue/publish answer. */
export interface PublishSettingsDTO {
  enabled: boolean;
  /** The page's origin, or "" before one is set. */
  url: string;
  /** The mask when a token is stored for this address, "" when none is. The token itself never leaves. */
  token: string;
  status: PublisherStatus;
  /**
   * Set only on the answer to a request that switched publishing off or moved it to another
   * address: whether the old page was asked to drop its copy and agreed. A failure here means
   * that page may still show the last rundown it was sent.
   */
  dropped?: { ok: true } | { ok: false; message: string };
}

/** What POST /api/servicecue/publish/test answers (always a 200). */
export type PublishTestResult =
  | { ok: true; message: string }
  | { ok: false; kind: PublishProblemKind; status?: number; message: string };
