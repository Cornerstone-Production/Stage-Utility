// Which service OCCURRENCE something belongs to.
//
// `${serviceTypeId}:${planId}:${serviceTimeId ?? YYYY-MM-DD}`
//
// The occurrence is the part that matters and the part most easily lost: two
// services on one Sunday share a service type AND a plan, so a plan id cannot tell
// the 9am from the 11am. Only the service-time id can.

import type { PcoLiveDTO } from "../types/stage.js";
import { recordOccurrence } from "./service-recorder.js";
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
 *
 * "Open" means `endedAt == null`, not merely "a record exists". The recorder holds
 * its last record indefinitely — deliberately, since the taper and the resume path
 * both need it after the service closes — so testing for the record's presence
 * returned Sunday's key for the rest of the week. A baptism run on the Wednesday
 * was stamped with the 11am's identity and linked onto that service in History.
 */
export function currentServiceKey(): string | null {
  return serviceTimelineRecorder.getOpenRecord()?.serviceKey ?? null;
}

/**
 * Which occurrence a live tick belongs to, as the recorders file it: the
 * service-time id, or the service's date when PCO names none — the last
 * segment of the key above, the part that tells the 9am from the 11am.
 *
 * For once-per-service automation, which must agree with the recorders about
 * where one service ends and the next begins. The live id alone does not: it
 * rolls on to the 11am once the 9am passes its planned end, while the 9am is
 * still running, so a cue run in the overrun was filed under the 11am and
 * refused there as already run. This answers what the timeline recorder will
 * file the tick under (see occurrenceFor), which holds across that roll-over.
 *
 * The segment rather than the whole key: the whole key needs the selected
 * service type and plan, which a countdown before the service has no record
 * to read from, and a cue run in the countdown has to match the same service
 * once its record opens.
 *
 * With no snapshot at all, the open record's occurrence, else null: no key,
 * rather than a guessed one.
 */
export function serviceOccurrence(live: PcoLiveDTO | null): string | null {
  if (live) return serviceTimelineRecorder.occurrenceFor(live);
  const open = serviceTimelineRecorder.getOpenRecord();
  return open ? recordOccurrence(open) : null;
}
