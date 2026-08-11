// A plan's times are fetched once, for everyone who needs them.
//
// Three copies of the same request lived in pco-service, under three cache keys:
// the ScriptView projected clock, the reconnect scheduler, and the internal
// countdown/rollover path each pulled `plan_times` separately. That is three
// round trips to PCO for one static list, on an integration where request volume
// is the thing that gets an install rate-limited.
//
// Worse, they disagreed on page size. The internal one asks for per_page=100 and
// carries a comment explaining why: a plan routinely holds rehearsal, call,
// review and several service times, and a short page quietly clips the tail. The
// other two asked for 50 — so on a busy plan the ScriptView clock and the
// reconnect scheduler were reading a truncated list, silently.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { pcoService } from "./pco-service.js";

/** One plan time as PCO returns it. */
function planTime(id: string, timeType: string, startsAt: string, endsAt: string | null = null) {
  return { id, attributes: { name: `${timeType} ${id}`, time_type: timeType, starts_at: startsAt, ends_at: endsAt } };
}

const TIMES = [
  planTime("t1", "rehearsal", "2026-08-09T13:00:00Z", "2026-08-09T14:00:00Z"),
  planTime("t2", "service", "2026-08-09T16:00:00Z", "2026-08-09T17:00:00Z"),
  planTime("t3", "service", "2026-08-09T14:30:00Z", null),
  planTime("t4", "call", "2026-08-09T12:00:00Z", null),
  planTime("t5", "service", "2026-08-09T99:99:99Z", null), // unparseable, kept as-is
];

type Requester = { request: (url: string, appId: string, secret: string) => Promise<unknown> };
const svc = pcoService as unknown as Requester;
const realRequest = svc.request;

let urls: string[] = [];

function stubRequests() {
  urls = [];
  svc.request = async (url: string) => {
    urls.push(url);
    return { data: TIMES };
  };
}

function planTimeUrls(): string[] {
  return urls.filter((u) => u.includes("/plan_times"));
}

describe("plan_times is fetched once", () => {
  beforeEach(() => {
    pcoService.clearCache();
    stubRequests();
  });

  it("serves both public readers from a single request", () => {
    // Not "fewer than three" — exactly one. A floor would go on passing if a
    // fourth caller added its own fetch, which is how this started.
    return (async () => {
      await pcoService.listPlanServiceTimes("app", "secret", "st1", "p1");
      await pcoService.listPlanTimes("app", "secret", "st1", "p1");
      assert.equal(planTimeUrls().length, 1, `plan_times was requested ${planTimeUrls().length} times`);
    })();
  });

  it("asks for a page big enough to hold a real plan's times", async () => {
    await pcoService.listPlanServiceTimes("app", "secret", "st1", "p1");
    const url = planTimeUrls()[0];
    const perPage = Number(new URL(url).searchParams.get("per_page"));
    assert.ok(perPage >= 100, `per_page=${perPage} clips the tail of a busy plan`);
  });

  it("keys the cache by credentials as well as plan", async () => {
    // Two orgs' credentials must not share an entry — the plan id alone is not
    // unique across installs.
    await pcoService.listPlanServiceTimes("app-a", "secret", "st1", "p1");
    await pcoService.listPlanServiceTimes("app-b", "secret", "st1", "p1");
    assert.equal(planTimeUrls().length, 2, "a second org read the first org's cached times");
  });

  it("returns service start times, earliest first", async () => {
    const got = await pcoService.listPlanServiceTimes("app", "secret", "st1", "p1");
    assert.deepEqual(got, ["2026-08-09T14:30:00Z", "2026-08-09T16:00:00Z", "2026-08-09T99:99:99Z"]);
  });

  it("returns rehearsal and service times with their ends, and nothing else", async () => {
    const got = await pcoService.listPlanTimes("app", "secret", "st1", "p1");
    assert.deepEqual(got, [
      { type: "rehearsal", startsAt: "2026-08-09T13:00:00Z", endsAt: "2026-08-09T14:00:00Z" },
      { type: "service", startsAt: "2026-08-09T16:00:00Z", endsAt: "2026-08-09T17:00:00Z" },
      { type: "service", startsAt: "2026-08-09T14:30:00Z", endsAt: null },
      { type: "service", startsAt: "2026-08-09T99:99:99Z", endsAt: null },
    ]);
    assert.ok(!got.some((t) => t.type === "call"), "a call time is not a service or a rehearsal");
  });

  it("drops a time with no start rather than carrying a null through", async () => {
    svc.request = async (url: string) => {
      urls.push(url);
      return { data: [...TIMES, { id: "t6", attributes: { name: "x", time_type: "service", starts_at: null, ends_at: null } }] };
    };
    const got = await pcoService.listPlanTimes("app", "secret", "st1", "p1");
    assert.ok(!got.some((t) => t.startsAt == null));
  });
});

// Put the real requester back, so this file cannot poison anything importing
// the same singleton later in the run.
process.on("exit", () => {
  svc.request = realRequest;
});
