import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { linkBaptisms, baptismStats } from "./link-baptisms.js";

const svc = (over: Partial<ServiceTimeline> = {}) =>
  ({
    serviceKey: "st1:plan1:t9",
    startedAt: "2026-07-26T09:00:00.000Z",
    endedAt: "2026-07-26T10:15:00.000Z",
    ...over,
  }) as ServiceTimeline;

const bap = (over: Partial<BaptismSession> = {}) =>
  ({
    id: "b1",
    startedAt: "2026-07-26T09:30:00.000Z",
    finishedAt: "2026-07-26T09:45:00.000Z",
    people: [{ testimonyMs: 60_000, baptizeMs: 30_000 }],
    title: null,
    serviceTypeId: "st1",
    planId: "plan1",
    ...over,
  }) as BaptismSession;

describe("linkBaptisms", () => {
  test("a session recorded against this service is matched by key", () => {
    const out = linkBaptisms([bap({ serviceKey: "st1:plan1:t9" })], svc());
    assert.equal(out.length, 1);
  });

  test("a session from the other service that day is not", () => {
    // Same date, same plan — only the occurrence differs. This is the case a plan
    // id cannot distinguish, and the whole reason the key exists.
    const out = linkBaptisms([bap({ serviceKey: "st1:plan1:t11" })], svc());
    assert.deepEqual(out, []);
  });

  test("a keyed session is never rescued by overlapping in time", () => {
    // Two services running long could otherwise put the 9am's baptism on the 11am.
    const other = bap({ serviceKey: "st1:plan1:t11", startedAt: "2026-07-26T09:30:00.000Z", finishedAt: "2026-07-26T09:45:00.000Z" });
    assert.deepEqual(linkBaptisms([other], svc()), []);
  });

  test("a session recorded before keys existed still matches by overlap", () => {
    assert.equal(linkBaptisms([bap()], svc()).length, 1, "older records must keep working");
  });

  test("an unkeyed session outside the window is left alone", () => {
    const later = bap({ startedAt: "2026-07-26T11:30:00.000Z", finishedAt: "2026-07-26T11:45:00.000Z" });
    assert.deepEqual(linkBaptisms([later], svc()), []);
  });

  test("a service that never ended assumes a window rather than matching everything", () => {
    const open = svc({ endedAt: null });
    assert.equal(linkBaptisms([bap()], open).length, 1, "within the assumed window");
    const wayLater = bap({ startedAt: "2026-07-26T20:00:00.000Z", finishedAt: "2026-07-26T20:10:00.000Z" });
    assert.deepEqual(linkBaptisms([wayLater], open), [], "past it");
  });

  test("keyed and legacy sessions can both land on one service", () => {
    const out = linkBaptisms([bap({ id: "a", serviceKey: "st1:plan1:t9" }), bap({ id: "b" })], svc());
    assert.deepEqual(out.map((b) => b.id), ["a", "b"]);
  });

  test("unparseable timestamps are skipped rather than throwing", () => {
    assert.deepEqual(linkBaptisms([bap({ startedAt: "nope", finishedAt: "nope" })], svc()), []);
  });
});

describe("baptismStats", () => {
  const people = (...pairs: [number, number][]) =>
    bap({ people: pairs.map(([t, b]) => ({ testimonyMs: t * 1000, baptizeMs: b * 1000 })) as never });

  test("totals split testimony from baptism, and add up to the total", () => {
    const out = baptismStats([people([90, 30], [60, 20]), people([45, 15])]);
    assert.equal(out.people, 3);
    assert.equal(out.testimonySec, 195);
    assert.equal(out.baptismSec, 65);
    assert.equal(out.totalSec, 260);
    assert.equal(out.totalSec, out.testimonySec + out.baptismSec);
  });

  test("averages are per person, not per session", () => {
    // Two sessions, three people. Per session would give 130s; per person is what
    // can be compared week to week.
    const out = baptismStats([people([90, 30], [60, 20]), people([45, 15])]);
    assert.equal(out.avgTestimonySec, 65);
    assert.equal(out.avgBaptismSec, 65 / 3);
  });

  test("no people is zero, never NaN", () => {
    assert.deepEqual(baptismStats([]), {
      people: 0, totalSec: 0, testimonySec: 0, baptismSec: 0, avgTestimonySec: 0, avgBaptismSec: 0,
    });
    // A session that was started and finished without timing anyone.
    assert.equal(baptismStats([people()]).avgTestimonySec, 0);
  });

  test("one long testimony pulls the average up, which is the point of showing it", () => {
    const out = baptismStats([people([90, 30], [95, 30], [240, 30], [70, 30])]);
    assert.equal(out.people, 4);
    assert.ok(out.avgTestimonySec > 120, `got ${out.avgTestimonySec}`);
  });
});
