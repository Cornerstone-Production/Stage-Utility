// service-activity.ts — is a service under way, so that nothing restarts or reloads under it?
//
// The one answer every "may we restart or deploy now" question asks: the server's
// own update (Update now, a track switch, the scheduled auto-update), the Mac
// helpers' and Windows kiosks' updates, and the ServiceCue page's deploy.
//
// Active while Planning Center is in one of the plan's items, or while any
// recorder holds a record it has not closed. A recorder still open after Planning
// Center leaves its item keeps it active: its last samples are not yet saved.
//
// Planning Center's "preservice" mode is NOT a service under way. It is the
// countdown every plan with a service time reports, days ahead, whenever no item
// is live (pco-service.ts getLive). Counting it held every update all week.
//
// What this does not decide: whether to RECORD. The recorders' gate is
// live-service-gate.ts, and is independent of this on purpose.

import type { PcoLiveDTO } from "../types/live.js";
import { attendanceRecorder } from "./attendance-recorder.js";
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
  spl: Recording;
  attendance: Recording;
  timeline: Recording;
}

const open = (r: Recording): boolean => r !== null && !r.endedAt;

/** The rule, over the readings. */
export function serviceActivityOf(r: ActivityReadings): ServiceActivity {
  const reasons: string[] = [];
  if (r.live?.mode === "item") reasons.push("A PCO service is live");
  if (open(r.spl)) reasons.push("SPL is recording");
  if (open(r.attendance)) reasons.push("Attendance is recording");
  if (open(r.timeline)) reasons.push("Service history is recording");
  return { active: reasons.length > 0, reasons };
}

/** The rule, over what this server holds now. */
export function serviceActivity(): ServiceActivity {
  return serviceActivityOf({
    live: stageController.getLastLive(),
    spl: splRecorder.getCurrent(),
    attendance: attendanceRecorder.getCurrent(),
    timeline: serviceTimelineRecorder.getCurrent(),
  });
}

// The stage controller's own auto-update asks the same question. It is handed the
// answer rather than importing this module: every recorder imports the controller
// (through service-recorder.ts), so an import the other way would be a cycle.
stageController.setServiceActivitySource(serviceActivity);
