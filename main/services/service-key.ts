// Which service OCCURRENCE something belongs to.
//
// `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`
//
// The occurrence is the part that matters and the part most easily lost: two
// services on one Sunday share a service type AND a plan, so a plan id cannot tell
// the 9am from the 11am. Only the service-time id can.

import { serviceTimelineRecorder } from "./service-timeline-recorder.js";

/**
 * The occurrence currently being recorded, or null when no service is open.
 *
 * This asks the timeline recorder rather than deriving the key from the live
 * snapshot, and the difference is not cosmetic. When a service runs past its
 * planned end, PCO rolls its "current service time" on to the NEXT occurrence — so
 * a key computed from the live id would stamp anything happening in the last
 * stretch of a long 9am with the 11am's identity. The recorders already hold their
 * key across that roll-over; reading the open record inherits that instead of
 * reimplementing it, and keeps everything recorded against one service agreeing on
 * what that service is.
 *
 * Null when nothing is open — the caller records no key rather than a guessed one.
 */
export function currentServiceKey(): string | null {
  return serviceTimelineRecorder.getCurrent()?.serviceKey ?? null;
}
