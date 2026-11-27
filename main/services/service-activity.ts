// service-activity.ts — is a service under way, so that nothing restarts or reloads under it?
//
// The one answer every "may we restart or deploy now" question asks: the server's
// own update (Update now, a track switch, the scheduled auto-update), the Mac
// helpers' and Windows kiosks' updates, and the ServiceCue page's deploy.
//
// Active while Planning Center reports the service RUNNING, or while any recorder
// holds a record it has not closed.
//
// Running is live-service-gate.ts serviceRunning, the gate the recorders and the
// plan rollover already ask, so "under way" means one thing to all of them: in
// one of the plan's items, and not parked past its SERVICE END header. Parking on
// a trailing item below SERVICE END is how every service ends, and Live stays in
// that item; counting it held every update for as long as nobody stopped Live.
//
// A reading kept from before Planning Center stopped answering counts only while
// its service is near now (SERVICE_START_WINDOW_MS from its start): a failing read
// is not evidence the service stopped, and neither is it evidence of one hours
// old. An open record is held to the same bound. Recorders close their record on
// the first live tick after the service stops running, so with a current reading
// an open record is a service just ending and its last samples not yet saved; with
// no current reading no tick comes to close it, and without the bound it would
// hold every update for as long as the outage lasted.
//
// Planning Center's "preservice" mode is NOT a service under way. It is the
// countdown every plan with a service time reports, days ahead, whenever no item
// is live (pco-service.ts getLive). Counting it held every update all week.
//
// What this does not decide: whether to RECORD. The recorders' gate is
// live-service-gate.ts, and is independent of this on purpose.

import type { PcoLiveDTO } from "../types/live.js";
import { attendanceRecorder } from "./attendance-recorder.js";
import { isServiceNearNow, serviceRunning } from "./live-service-gate.js";
import { serviceTimelineRecorder } from "./service-timeline-recorder.js";
import { splRecorder } from "./spl-recorder.js";
import { stageController } from "./stage-controller.js";

export interface ServiceActivity {
  active: boolean;
  /** What would be interrupted, one phrase each, in a fixed order: "A PCO service is live". Empty when not active. */
  reasons: string[];
}

/** A recorder's current record, as far as this needs it: open until it has an end. */
type Recording = { endedAt?: string | null } | null;

export interface ActivityReadings {
  live: PcoLiveDTO | null;
  /** `live` is the last good reading, kept while Planning Center's reads fail (or before the first). */
  stale: boolean;
  nowMs: number;
  spl: Recording;
  attendance: Recording;
  timeline: Recording;
}

const open = (r: Recording): boolean => r !== null && !r.endedAt;

/** The rule, over the readings. */
export function serviceActivityOf(r: ActivityReadings): ServiceActivity {
  const reasons: string[] = [];
  if (r.live && serviceRunning(r.live, { stale: r.stale, nowMs: r.nowMs })) reasons.push("A PCO service is live");
  // An open record counts while the reading is current, or a kept one is of a service near now.
  const recordsCount = !r.stale || (r.live !== null && isServiceNearNow(r.live, r.nowMs));
  if (recordsCount && open(r.spl)) reasons.push("SPL is recording");
  if (recordsCount && open(r.attendance)) reasons.push("Attendance is recording");
  if (recordsCount && open(r.timeline)) reasons.push("Service history is recording");
  return { active: reasons.length > 0, reasons };
}

/** The rule, over what this server holds now. */
export function serviceActivity(): ServiceActivity {
  return serviceActivityOf({
    live: stageController.getLastLive(),
    stale: !stageController.liveKnown(),
    nowMs: Date.now(),
    spl: splRecorder.getCurrent(),
    attendance: attendanceRecorder.getCurrent(),
    timeline: serviceTimelineRecorder.getCurrent(),
  });
}

// The stage controller's own auto-update asks the same question. It is handed the
// answer rather than importing this module: every recorder imports the controller
// (through service-recorder.ts), so an import the other way would be a cycle.
stageController.setServiceActivitySource(serviceActivity);
