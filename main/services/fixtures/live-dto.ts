// live-dto.ts — a PcoLiveDTO for tests, and the tick every live consumer gets.
//
// makeLive: the base is `satisfies PcoLiveDTO`, so a field added to the type as
// required breaks compilation HERE, once, instead of being silently absent from
// hand-built objects cast `as PcoLiveDTO`.
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

type Consumers = Record<(typeof LIVE_TICK_ORDER)[number], { onLiveTick(live: PcoLiveDTO): Promise<void> }>;
let loaded: Consumers | null = null;

/** Import the four consumers. Call once, after the test has set its data dir and
 *  before the first tick: feedLiveTick starts every consumer synchronously, as
 *  live-poller.ts does, and an import hop first would let a test that acts on the
 *  line after `tick()` run before any consumer has started. */
export async function loadLiveConsumers(): Promise<void> {
  const [spl, attendance, timeline, baptism] = await Promise.all([
    import("../spl-recorder.js"),
    import("../attendance-recorder.js"),
    import("../service-timeline-recorder.js"),
    import("../baptism-timer-service.js"),
  ]);
  loaded = {
    "spl-recorder": spl.splRecorder,
    "attendance-recorder": attendance.attendanceRecorder,
    "service-timeline-recorder": timeline.serviceTimelineRecorder,
    "baptism-timer": baptism.baptismTimerService,
  };
}

/** One tick to every consumer, started synchronously in LIVE_TICK_ORDER and
 *  settled separately so a rejection shows which consumer threw. */
export function feedLiveTickSettled(live: PcoLiveDTO): Promise<PromiseSettledResult<void>[]> {
  if (!loaded) throw new Error("call loadLiveConsumers() before feeding a tick");
  const by = loaded;
  return Promise.allSettled(LIVE_TICK_ORDER.map((name) => by[name].onLiveTick(live)));
}

/** One tick to every consumer; rethrows the first rejection. */
export async function feedLiveTick(live: PcoLiveDTO): Promise<void> {
  for (const r of await feedLiveTickSettled(live)) if (r.status === "rejected") throw r.reason;
}
