import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PcoLiveDTO } from "../types/stage.js";
import { setAppTimeZone } from "./app-timezone.js";
import {
  SERVICE_START_WINDOW_MS,
  isServiceNearNow,
  serviceDateKey,
  shouldRecordLive,
} from "./live-service-gate.js";

/** A live tick for a service that starts at `startsAt`, with an item running. */
function live(startsAt: string | null, over: Partial<PcoLiveDTO> = {}): PcoLiveDTO {
  return {
    mode: "item",
    currentItemId: "item-1",
    label: "Prayer",
    lengthSec: 300,
    liveStartAt: startsAt,
    targetAt: null,
    serverNow: new Date().toISOString(),
    currentItemTitle: "Prayer",
    nextItemTitle: null,
    serviceTimeId: "st-1",
    serviceTimeStartsAt: startsAt,
    ...over,
  } as PcoLiveDTO;
}

// The outage this file exists to prevent: a Sunday-evening service in Chicago,
// running across midnight UTC on a server whose clock is UTC.
const SERVICE_START = Date.parse("2026-08-02T23:30:00Z"); // 18:30 America/Chicago
const BEFORE_UTC_MIDNIGHT = Date.parse("2026-08-02T23:58:00Z"); // 18:58 local
const AFTER_UTC_MIDNIGHT = Date.parse("2026-08-03T00:00:01Z"); // 19:00 local

describe("shouldRecordLive", () => {
  it("NEVER stops a recording in progress when the UTC date rolls mid-service", () => {
    // This is the whole point. The previous gate compared the service's date to
    // the server's date; at 00:00Z that went false and closed every recorder
    // mid-item, 40 minutes into the back half of a live service.
    const tick = live(new Date(SERVICE_START).toISOString());
    assert.equal(shouldRecordLive(tick, true, BEFORE_UTC_MIDNIGHT), true);
    assert.equal(shouldRecordLive(tick, true, AFTER_UTC_MIDNIGHT), true, "must not stop at midnight UTC");
  });

  it("keeps recording no matter how far the wall clock has moved, once latched", () => {
    // "If PCO is live, nothing can stop it." An open record plus a live item is
    // unconditional — a date test must not even be consulted.
    const tick = live(new Date(SERVICE_START).toISOString());
    const daysLater = SERVICE_START + 5 * 24 * 60 * 60_000;
    assert.equal(shouldRecordLive(tick, true, daysLater), true);
  });

  it("starts a record for a service happening now", () => {
    const tick = live(new Date(SERVICE_START).toISOString());
    assert.equal(shouldRecordLive(tick, false, SERVICE_START + 60_000), true);
  });

  it("still starts once the UTC date has rolled but the service is running", () => {
    // The self-heal: even entering this state mid-service with a closed record,
    // the next tick re-opens it rather than staying dead for the night.
    const tick = live(new Date(SERVICE_START).toISOString());
    assert.equal(shouldRecordLive(tick, false, AFTER_UTC_MIDNIGHT), true);
  });

  it("does NOT start a record for next week's plan being stepped through", () => {
    // The one thing the old date test was really for: rehearsing an upcoming
    // plan in PCO Live during the week must not create a record.
    const nextSunday = new Date(SERVICE_START + 7 * 24 * 60 * 60_000).toISOString();
    assert.equal(shouldRecordLive(live(nextSunday), false, SERVICE_START), false);
  });

  it("does not record without a live plan item", () => {
    const iso = new Date(SERVICE_START).toISOString();
    assert.equal(shouldRecordLive(live(iso, { mode: "preservice" }), true, SERVICE_START), false);
    assert.equal(shouldRecordLive(live(iso, { currentItemId: null }), true, SERVICE_START), false);
  });
});

describe("isServiceNearNow", () => {
  it("fails OPEN when PCO gave no usable time signal", () => {
    // A missing plan time is a cache miss, not evidence nothing is happening.
    // Refusing to record a real service is worse than one stray record.
    assert.equal(isServiceNearNow(live(null), SERVICE_START), true);
    assert.equal(isServiceNearNow(live("not-a-date"), SERVICE_START), true);
  });

  it("accepts a service either side of now, and rejects one beyond the window", () => {
    const iso = new Date(SERVICE_START).toISOString();
    assert.equal(isServiceNearNow(live(iso), SERVICE_START + SERVICE_START_WINDOW_MS - 1), true);
    assert.equal(isServiceNearNow(live(iso), SERVICE_START - SERVICE_START_WINDOW_MS + 1), true);
    assert.equal(isServiceNearNow(live(iso), SERVICE_START + SERVICE_START_WINDOW_MS + 1), false);
  });
});

describe("serviceDateKey", () => {
  it("files an evening service under its own local date, either side of midnight UTC", () => {
    setAppTimeZone("America/Chicago");
    const tick = live(new Date(SERVICE_START).toISOString());
    // Same answer before and after 00:00Z — the record cannot change which day it
    // belongs to partway through the night.
    assert.equal(serviceDateKey(tick, BEFORE_UTC_MIDNIGHT), "2026-08-02");
    assert.equal(serviceDateKey(tick, AFTER_UTC_MIDNIGHT), "2026-08-02");
    setAppTimeZone(null);
  });

  it("derives the date from the service, not from when the tick arrived", () => {
    setAppTimeZone("America/Chicago");
    const tick = live(new Date(SERVICE_START).toISOString());
    assert.equal(serviceDateKey(tick, SERVICE_START + 6 * 60 * 60_000), "2026-08-02");
    setAppTimeZone(null);
  });
});
