// live-dto.ts — a PcoLiveDTO for tests, and the tick every live consumer gets.
//
// makeLive: the base is `satisfies PcoLiveDTO`, so a field added to the type as
// required breaks compilation HERE, once, instead of being silently absent from
// forty hand-built objects cast `as PcoLiveDTO`.
//
// feedLiveTick: hands one tick to the same four consumers live-poller.ts's act()
// does, in the same order. Services are imported inside the call, not at the top:
// tests set STAGE_UTILITY_DATA before their first service import, and a fixture
// that pulled a store in first would point it at the real data dir.
// live-dto.test.ts drives the real poller and fails if the two orders differ.

import type { PcoLiveDTO } from "../../types/stage.js";

const BASE = {
  mode: "none",
  currentItemId: null,
  label: null,
  lengthSec: null,
  liveStartAt: null,
  targetAt: null,
  serverNow: "2026-01-01T00:00:00.000Z",
  currentItemTitle: null,
  nextItemTitle: null,
  serviceTimeId: null,
  serviceTimeStartsAt: null,
} satisfies PcoLiveDTO;

/** A live reading with nothing live; `over` says what the test cares about. */
export function makeLive(over: Partial<PcoLiveDTO> = {}): PcoLiveDTO {
  return { ...BASE, ...over };
}

/** The consumers, in the order live-poller.ts act() feeds them. The order is
 *  load-bearing (a recorder's split decides what the next reads), so this list is
 *  not sorted. */
export const LIVE_TICK_ORDER = [
  "spl-recorder",
  "attendance-recorder",
  "service-timeline-recorder",
  "baptism-timer",
] as const;

async function consumers(): Promise<Record<(typeof LIVE_TICK_ORDER)[number], { onLiveTick(live: PcoLiveDTO): Promise<void> }>> {
  const [spl, attendance, timeline, baptism] = await Promise.all([
    import("../spl-recorder.js"),
    import("../attendance-recorder.js"),
    import("../service-timeline-recorder.js"),
    import("../baptism-timer-service.js"),
  ]);
  return {
    "spl-recorder": spl.splRecorder,
    "attendance-recorder": attendance.attendanceRecorder,
    "service-timeline-recorder": timeline.serviceTimelineRecorder,
    "baptism-timer": baptism.baptismTimerService,
  };
}

/** One tick to every consumer, each settled separately so a rejection shows
 *  which consumer threw. Results are in LIVE_TICK_ORDER. */
export async function feedLiveTickSettled(live: PcoLiveDTO): Promise<PromiseSettledResult<void>[]> {
  const by = await consumers();
  return Promise.allSettled(LIVE_TICK_ORDER.map((name) => by[name].onLiveTick(live)));
}

/** One tick to every consumer; throws the first failure, naming nothing the
 *  consumer's own error does not. */
export async function feedLiveTick(live: PcoLiveDTO): Promise<void> {
  for (const r of await feedLiveTickSettled(live)) if (r.status === "rejected") throw r.reason;
}
