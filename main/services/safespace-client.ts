// safespace-client.ts — SenSource SafeSpace live occupancy, one number per space.
//
// Part of the SenSource integration, not a second one for the same vendor. Vea
// gives attendance, occupancy, zones, day aggregates and history; SafeSpace gives
// ONE number, fresher. So this layers a better occupancy reading onto the Vea
// payload and changes nothing else — see sensource-service.ts for where it lands.
//
// The endpoint, measured against the live service:
//
//   GET https://app.safespace.io/api/raw-data/live-occupancy/<spaceId>
//   → HTTP 200, body is a BARE INTEGER as text, sub-second, no authentication.
//
// (display.safespace.io/value/live/<spaceId> serves the same value and is what
// their UI suggests embedding in a page. Same contract, one host.)
//
// THREE things about it drive everything here.
//
// 1. EMPTY IS NOT ZERO. One sample in six comes back with no body at all rather
//    than with a number. `Number("")` is 0, so a naive parser reports an empty
//    building — which for a threshold trigger is worse than stale data, because
//    stale data looks stale and a confident 0 does not. An empty body is UNKNOWN
//    and the last good value stands, the same shape the Vea day aggregates
//    already use.
//
// 2. IT IS RATE LIMITED, and the limit is the server's to state. Responses carry
//    `X-RateLimit-Limit: 40` and a request spends 2, refilling in about twenty
//    seconds — but those are observations of one afternoon, not a contract, and
//    hard-coding an observed quota is the mistake the Planning Center client just
//    had fixed out of it (see pco-rate-limit.ts). So the cost per request is
//    MEASURED from consecutive `X-RateLimit-Remaining` values rather than assumed,
//    the hold-off comes from `X-RateLimit-Reset`, and a 429 honours `Retry-After`.
//    Nothing here decides it knows the quota.
//
// 3. THE SPACE ID IS THE ENTIRE CREDENTIAL. There is no key, no token and no
//    account check: whoever holds the id can read the occupancy. It therefore
//    never reaches a log line — not in a URL, not inside a fetch error, not in a
//    response body echo. `redact()` below is the single choke point, and
//    everything this module can put in front of an operator goes through it.

import { scrub } from "./scrub.js";

/** Host serving the raw live-occupancy value. */
const BASE = "https://app.safespace.io/api/raw-data/live-occupancy";
/** SafeSpace answers sub-second; anything past this is a fault, not slowness. */
const REQUEST_TIMEOUT_MS = 8_000;
/**
 * How long to hold off when the server says the bucket is empty but not when it
 * refills. The measured refill was about twenty seconds; this is the fallback for
 * a response that omits `X-RateLimit-Reset`, not a belief about the quota.
 */
const DEFAULT_RESET_MS = 20_000;
/** Ceiling on a hold-off, however long the server asks for. A quota reading that
 *  is wrong, or a Retry-After from a box with a bad clock, must not take the
 *  occupancy off the air for the rest of a service. */
const MAX_HOLD_MS = 5 * 60_000;
/** Headers, spelled as they appear on the wire. `Headers.get` is case-insensitive. */
const LIMIT_HEADER = "X-RateLimit-Limit";
const REMAINING_HEADER = "X-RateLimit-Remaining";
const RESET_HEADER = "X-RateLimit-Reset";

/** A header as a finite non-negative number, or null. */
function num(raw: string | null): number | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A `X-RateLimit-Reset` or `Retry-After` value as a delay in ms.
 *
 * Both forms are in the wild and neither header says which it is using, so the
 * magnitude decides: anything that looks like a Unix timestamp is treated as an
 * instant, anything smaller as a delta. Clamped to MAX_HOLD_MS either way.
 */
export function resetDelayMs(raw: string | null, now: number): number | null {
  const n = num(raw);
  if (n === null) {
    // Not a number — it may still be the HTTP-date form Retry-After allows.
    if (raw === null) return null;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? clampHold(at - now) : null;
  }
  // Three forms, told apart by magnitude, because no header says which it uses:
  // 10^12 is already past in MILLISECONDS, 10^9 is an epoch in SECONDS (10^9s is
  // 2001, which no sane delta reaches), and anything smaller is a delta in
  // seconds. Without the first branch a millisecond epoch was multiplied by a
  // thousand again and every hold went to the clamp.
  if (n >= 1e12) return clampHold(n - now);
  return clampHold(n >= 1e9 ? n * 1000 - now : n * 1000);
}

function clampHold(ms: number): number {
  return Math.min(Math.max(0, ms), MAX_HOLD_MS);
}

/** What the server last said about the quota. All fields optional: a response
 *  carrying none of the headers must not be read as a quota of zero. */
export interface SafeSpaceQuota {
  limit: number | null;
  remaining: number | null;
  /** Requests spent by the last call, MEASURED from consecutive remainings — null
   *  until two responses have carried the header. */
  cost: number | null;
}

/** One reading, or the reason there is not one. */
export type SafeSpaceReading =
  /** A number the endpoint actually returned. */
  | { kind: "ok"; occupancy: number }
  /**
   * The endpoint answered 200 with nothing usable — an empty body, or text that
   * is not an integer. UNKNOWN, never zero, and expected about one time in six,
   * so a caller must not treat one of these as a fault.
   */
  | { kind: "empty"; why: string }
  /** The request was refused or never completed. `kind` groups it for the log. */
  | { kind: "failed"; why: string; status: number | null }
  /** Nothing was asked, because the quota the SERVER reported says not to. */
  | { kind: "held"; why: string; untilMs: number };

/**
 * Remove `spaceId` from anything about to be shown to a human.
 *
 * The id is a bearer capability, and the two ways it escapes are a URL inside a
 * fetch error and a message this module builds itself. Applied AFTER `scrub`, so
 * a value cannot smuggle the id past it with an escape sequence: scrub has
 * already flattened those to literal text by the time the id is matched.
 *
 * Exported because sensource-service logs SafeSpace failures too and must use the
 * same choke point rather than a second copy of it.
 */
export function redact(text: string, spaceId: string | null): string {
  if (!spaceId) return scrub(text, 160);
  // BEFORE scrub, not after. scrub truncates at its limit, so redacting second
  // meant a message long enough to be cut mid-id left the surviving prefix in
  // the line — the id partially published rather than replaced. Ordering it this
  // way smuggles nothing: scrub only ESCAPES control characters, it never decodes,
  // so nothing can reassemble an id that has already been replaced.
  const out = text.split(spaceId).join(PLACEHOLDER);
  // The URL carries the ENCODED id and a fetch error quotes the URL, so an id
  // holding a space, a slash or a non-ASCII character survives a raw split
  // untouched — `caf\u00e9-space` reaches the log as `caf%C3%A9-space`. Real ids look
  // alphanumeric and this is belt and braces, but the header above promises the
  // id never reaches a log line "not in a URL", and that has to be true of the
  // form the URL actually carries.
  const encoded = encodeURIComponent(spaceId);
  return scrub(encoded === spaceId ? out : out.split(encoded).join(PLACEHOLDER), 160);
}

/** What a redacted id reads as. Not an empty string: an operator has to be able
 *  to see that something was removed rather than that nothing was there. */
const PLACEHOLDER = "<space id>";

/**
 * The live-occupancy endpoint for one space, with the quota the server reports.
 *
 * Stateful only about the quota — the last good VALUE is the caller's business,
 * because the caller is the one that knows what to fall back to.
 */
export class SafeSpaceClient {
  private limit: number | null = null;
  private remaining: number | null = null;
  private cost: number | null = null;
  /** No request before this instant, from a 429 or an exhausted bucket. */
  private holdUntil = 0;

  /** What the server last said. For the caller's diagnostics, not a decision. */
  quota(): SafeSpaceQuota {
    return { limit: this.limit, remaining: this.remaining, cost: this.cost };
  }

  /** Forget the quota. For a reconfigure: a different space may be a different
   *  bucket, and holding off on the old one's exhaustion would be wrong. */
  forget(): void {
    this.limit = null;
    this.remaining = null;
    this.cost = null;
    this.holdUntil = 0;
  }

  /**
   * Read the live occupancy of `spaceId`.
   *
   * Never throws: every outcome is a `SafeSpaceReading` the caller decides about,
   * because "the endpoint is empty" and "the endpoint is broken" want different
   * responses and a thrown error collapses them. Nothing is swallowed — each
   * failure is returned with its reason and its status.
   */
  async read(spaceId: string, now = Date.now()): Promise<SafeSpaceReading> {
    if (now < this.holdUntil) {
      // The bucket is empty by the SERVER's own account — see observe(). Not a
      // rate this app invented: the hold-off came out of the headers.
      return {
        kind: "held",
        why:
          `SafeSpace reported ${this.remaining ?? "?"} of ${this.limit ?? "?"} left, less than a ` +
          `request costs; waiting ${Math.round((this.holdUntil - now) / 1000)}s`,
        untilMs: this.holdUntil,
      };
    }
    let res: Response;
    try {
      res = await fetch(`${BASE}/${encodeURIComponent(spaceId)}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // The URL carries the space id and fetch errors quote causes, so this
      // message is redacted before it can reach anyone.
      return { kind: "failed", why: redact(String(err), spaceId), status: null };
    }

    this.observe(res.headers, now);

    if (res.status === 429) {
      // The LONGER of the two. observe() has already run and may have taken a
      // hold from X-RateLimit-Reset; overwriting it with Retry-After meant a 429
      // carrying `X-RateLimit-Reset: 120` and no Retry-After got twenty seconds.
      const after = resetDelayMs(res.headers.get("retry-after"), now) ?? DEFAULT_RESET_MS;
      const wait = Math.max(after, this.holdUntil - now);
      this.holdUntil = now + wait;
      return {
        kind: "failed",
        why: `HTTP 429 — waiting ${Math.round(wait / 1000)}s`,
        status: 429,
      };
    }
    if (!res.ok) return { kind: "failed", why: `HTTP ${res.status}`, status: res.status };

    let body: string;
    try {
      body = await res.text();
    } catch (err) {
      return { kind: "failed", why: redact(String(err), spaceId), status: res.status };
    }

    const text = body.trim();
    // THE parse. `Number("")` is 0 and `parseInt("")` is NaN, and the difference
    // between them is a threshold rule reporting an empty building.
    if (text === "") return { kind: "empty", why: "the response body was empty" };
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) {
      return { kind: "empty", why: `the response was not a count (${redact(text, spaceId)})` };
    }
    return { kind: "ok", occupancy: Math.round(n) };
  }

  /**
   * Record what one response said about the quota, and measure the cost.
   *
   * The cost is a DIFFERENCE between consecutive remainings, not a constant. A
   * bucket that refilled between two calls makes the difference negative or zero,
   * which is not a cost measurement and is ignored rather than recorded as free.
   */
  private observe(headers: { get(name: string): string | null }, now: number): void {
    const limit = num(headers.get(LIMIT_HEADER));
    if (limit !== null) this.limit = limit;
    const remaining = num(headers.get(REMAINING_HEADER));
    if (remaining !== null) {
      if (this.remaining !== null && this.remaining > remaining) {
        this.cost = this.remaining - remaining;
      }
      this.remaining = remaining;
      // The server says the bucket cannot pay for another request, and it also
      // says when it refills. Believe both.
      if (remaining < (this.cost ?? 1)) {
        this.holdUntil = now + (resetDelayMs(headers.get(RESET_HEADER), now) ?? DEFAULT_RESET_MS);
      }
    }
  }
}
