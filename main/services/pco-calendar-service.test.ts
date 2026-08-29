// What this file guards, and why each one is here.
//
// 1. THE WINDOW QUERY ASKS FOR OVERLAP. `starts_at <= windowEnd AND ends_at >=
//    windowStart`, not a range on `starts_at`. A range asks "which events BEGIN
//    inside the grid", so a multi-day event already running on day one is
//    absent — a retreat that started Thursday vanishes from a grid beginning
//    Saturday. Nothing errors and nothing logs; the failure is pure absence,
//    which is the kind nobody reports.
//
// 2. THE MAPPER FALLS BACK. `published_starts_at` is a real ISO instant and is
//    sometimes null on real events (verified against the live API during
//    planning). Reading only the published field renders a blank row.
//
// Both were proven red in the session that wrote them: the query was changed to
// a `starts_at` range and the overlap test failed; the fallback was removed and
// the fallback test failed.
//
// Every id, name and colour below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { pcoCalendarService } from "./pco-calendar-service.js";
import { pcoService } from "./pco-service.js";

type Requester = { request: (url: string, appId: string, secret: string) => Promise<unknown> };
const svc = pcoCalendarService as unknown as Requester;
const realRequest = svc.request;

const FROM = "2026-03-01T06:00:00Z";
const TO = "2026-04-01T05:59:59Z";
const WINDOW = { fromIso: FROM, toIso: TO, calendarIds: [] as string[], tagIds: [] as string[] };

const TAG_TEAL = { id: "tag-1", type: "Tag", attributes: { name: "Alpha Ministry", color: "#1D9A8C" } };
const TAG_AMBER = { id: "tag-2", type: "Tag", attributes: { name: "Beta Ministry", color: "#F2A93B" } };

/** One event instance as PCO returns it; `attributes` are merged over the base. */
function instance(id: string, attributes: Record<string, unknown>, tagIds: string[] = []) {
  return {
    id,
    type: "EventInstance",
    attributes: {
      name: "Sample Gathering",
      starts_at: "2026-03-12T18:00:00Z",
      ends_at: "2026-03-12T20:00:00Z",
      published_starts_at: null,
      published_ends_at: null,
      all_day_event: false,
      location: "Room One",
      church_center_url: null,
      ...attributes,
    },
    relationships: { tags: { data: tagIds.map((id) => ({ id, type: "Tag" })) } },
  };
}

let urls: string[] = [];

/** Stub PCO with a fixed payload; records every url it was asked for. */
function stub(data: unknown[], included: unknown[] = [TAG_TEAL, TAG_AMBER]) {
  urls = [];
  svc.request = async (url: string) => {
    urls.push(url);
    return { data, included };
  };
}

/** The url the client actually asked for, with its percent-encoding undone —
 *  PCO's filter keys carry brackets, and URL() encodes them on the way out. */
function askedFor(): string {
  assert.ok(urls.length > 0, "the client made no request at all");
  return decodeURIComponent(urls[0]);
}

describe("the window query", () => {
  beforeEach(() => pcoCalendarService.clearCache());

  it("asks for OVERLAP, not a start range", async () => {
    // THE GUARD. Both clauses, ANDed: an event that starts before the grid and
    // ends inside it must come back. A `starts_at` range satisfies the first
    // assertion and fails the second, which is exactly the shape of the bug.
    stub([]);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    const url = askedFor();
    assert.ok(url.includes(`where[starts_at][lte]=${TO}`), `no starts_at<=windowEnd clause: ${url}`);
    assert.ok(url.includes(`where[ends_at][gte]=${FROM}`), `no ends_at>=windowStart clause: ${url}`);
    assert.ok(
      !url.includes("where[starts_at][gte]"),
      `a starts_at RANGE drops events already in progress on day one: ${url}`,
    );
  });

  it("passes explicit ISO instants, never bare dates", async () => {
    // A bare date is read in PCO's org zone, which is not necessarily the app's,
    // and the error is a silent one-day shift of the whole grid.
    stub([]);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    const url = askedFor();
    assert.ok(url.includes("T06:00:00Z"), `the window start lost its time of day: ${url}`);
    assert.ok(url.includes("T05:59:59Z"), `the window end lost its time of day: ${url}`);

    for (const bare of ["2026-03-01", "2026-03-01T06:00:00"]) {
      await assert.rejects(
        () => pcoCalendarService.listEventInstances("app", "secret", { ...WINDOW, fromIso: bare }),
        /explicit ISO instant/,
        `"${bare}" was accepted as a window bound`,
      );
    }
  });

  it("filters calendars and tags server-side when asked", async () => {
    stub([]);
    await pcoCalendarService.listEventInstances("app", "secret", {
      ...WINDOW,
      calendarIds: ["cal-1", "cal-2"],
      tagIds: ["tag-1"],
    });
    const url = askedFor();
    assert.ok(url.includes("where[calendar_ids]=cal-1,cal-2"), `calendars not filtered by PCO: ${url}`);
    assert.ok(url.includes("where[tag_ids]=tag-1"), `tags not filtered by PCO: ${url}`);
  });

  it("asks for NO calendar filter when none is chosen", async () => {
    // An empty filter VALUE is not the same request as no filter: it asks PCO to
    // match the empty set, and a month that should be full comes back blank.
    stub([]);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    const url = askedFor();
    assert.ok(!url.includes("where[calendar_ids]"), `an empty calendar filter was sent: ${url}`);
    assert.ok(!url.includes("where[tag_ids]"), `an empty tag filter was sent: ${url}`);
  });

  it("does not filter on kind, which separates nothing", async () => {
    // `kind` is "standard" for events, vans, rooms and childcare alike, so a
    // filter on it looks like it is narrowing and is not.
    stub([]);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.ok(!askedFor().includes("kind"), "a kind filter was sent");
  });
});

describe("mapping an instance", () => {
  beforeEach(() => pcoCalendarService.clearCache());

  it("prefers published_starts_at when present", async () => {
    stub([
      instance("e1", {
        starts_at: "2026-03-12T18:00:00Z",
        ends_at: "2026-03-12T20:00:00Z",
        published_starts_at: "2026-03-12T18:30:00Z",
        published_ends_at: "2026-03-12T19:45:00Z",
      }),
    ]);
    const [event] = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(event.startsAt, "2026-03-12T18:30:00Z");
    assert.equal(event.endsAt, "2026-03-12T19:45:00Z");
  });

  it("FALLS BACK to starts_at when published is null", async () => {
    // THE GUARD. Verified live: published_* is null on real events. Assuming it
    // is always present renders a blank row.
    stub([
      instance("e1", {
        starts_at: "2026-03-12T18:00:00Z",
        ends_at: "2026-03-12T20:00:00Z",
        published_starts_at: null,
        published_ends_at: null,
      }),
    ]);
    const [event] = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(event.startsAt, "2026-03-12T18:00:00Z", "a null published start blanked the row");
    assert.equal(event.endsAt, "2026-03-12T20:00:00Z");
  });

  it("carries a tag's real hex colour through", async () => {
    // The Calendar's own `color` is an enum of names; the TAG colour is the only
    // one with a value behind it.
    stub([instance("e1", {}, ["tag-1"])]);
    const [event] = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.deepEqual(event.tags, [{ id: "tag-1", name: "Alpha Ministry", color: "#1d9a8c" }]);
  });

  it("keeps an event with no tags rather than dropping it", async () => {
    // Filtering is the operator's job, expressed in the tag filter. A client
    // that drops the untagged ones has made that choice for them, invisibly.
    stub([instance("e1", {}, []), instance("e2", {}, ["tag-2"])]);
    const events = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.deepEqual(events.map((e) => e.id), ["e1", "e2"]);
    assert.deepEqual(events[0].tags, []);
  });

  it("reads the flags and links a grid draws", async () => {
    stub([
      instance("e1", {
        name: "All Day Sample",
        all_day_event: true,
        location: "",
        church_center_url: "https://example.church.center/events/1",
      }),
    ]);
    const [event] = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(event.name, "All Day Sample");
    assert.equal(event.allDay, true);
    assert.equal(event.location, null, "an empty location must be null, not an empty label");
    assert.equal(event.churchCenterUrl, "https://example.church.center/events/1");
  });

  it("drops an instance with no start rather than drawing a blank square", async () => {
    stub([instance("e1", { starts_at: null, published_starts_at: null }), instance("e2", {})]);
    const events = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.deepEqual(events.map((e) => e.id), ["e2"]);
  });
});

describe("the pickers", () => {
  beforeEach(() => pcoCalendarService.clearCache());

  it("lists calendars by name", async () => {
    stub(
      [
        { id: "c2", type: "Calendar", attributes: { name: "Second Calendar" } },
        { id: "c1", type: "Calendar", attributes: { name: "First Calendar" } },
      ],
      [],
    );
    const calendars = await pcoCalendarService.listCalendars("app", "secret");
    assert.deepEqual(calendars, [
      { id: "c1", name: "First Calendar" },
      { id: "c2", name: "Second Calendar" },
    ]);
  });

  it("names a tag's group, and buckets an ungrouped one", async () => {
    stub(
      [
        {
          id: "tag-1",
          type: "Tag",
          attributes: { name: "Alpha Ministry", color: "#1D9A8C" },
          relationships: { tag_group: { data: { id: "g1", type: "TagGroup" } } },
        },
        { id: "tag-9", type: "Tag", attributes: { name: "Loose Tag", color: null }, relationships: {} },
      ],
      [{ id: "g1", type: "TagGroup", attributes: { name: "Sample Group" } }],
    );
    const tags = await pcoCalendarService.listCalendarTags("app", "secret");
    assert.deepEqual(tags, [
      { id: "tag-1", name: "Alpha Ministry", color: "#1d9a8c", groupName: "Sample Group" },
      { id: "tag-9", name: "Loose Tag", color: null, groupName: "Individual Tags" },
    ]);
  });
});

describe("the cache", () => {
  beforeEach(() => pcoCalendarService.clearCache());

  it("serves a repeat reader of the same window from cache", async () => {
    stub([instance("e1", {})]);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(urls.length, 1, `the window was fetched ${urls.length} times`);
  });

  it("keys by credentials as well as window", async () => {
    // Two orgs must not share an entry: a window is not unique across installs,
    // and a shared cache would serve one church another's calendar.
    stub([instance("e1", {})]);
    await pcoCalendarService.listEventInstances("appA", "secret", WINDOW);
    stub([instance("e2", {})]);
    const second = await pcoCalendarService.listEventInstances("appB", "secret", WINDOW);
    assert.deepEqual(second.map((e) => e.id), ["e2"], "the second org was served the first org's calendar");
  });

  it("keys by filter, so narrowing the tags is a different request", async () => {
    stub([instance("e1", {})]);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    stub([instance("e2", {})]);
    const filtered = await pcoCalendarService.listEventInstances("app", "secret", { ...WINDOW, tagIds: ["tag-1"] });
    assert.deepEqual(filtered.map((e) => e.id), ["e2"], "a filtered read was served the unfiltered answer");
  });
});

// Drives the REAL request path with fetch stubbed, rather than reading the
// source for a constant. A version pin that is declared and never sent is
// exactly the shape of guard this repository has shipped green nine times.
describe("the API version pin", () => {
  /** Run `body` with fetch stubbed; returns the headers each request carried. */
  async function captureHeaders(body: () => Promise<unknown>): Promise<Headers[]> {
    const realFetch = globalThis.fetch;
    const realStub = svc.request;
    svc.request = realRequest; // the real transport, not the stub above
    const seen: Headers[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await body();
    } finally {
      globalThis.fetch = realFetch;
      svc.request = realStub;
    }
    return seen;
  }

  beforeEach(() => {
    pcoCalendarService.clearCache();
    pcoService.clearCache();
  });

  it("sends X-PCO-API-Version on a calendar request", async () => {
    const seen = await captureHeaders(() => pcoCalendarService.listCalendars("app", "secret"));
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].get("X-PCO-API-Version"),
      "2018-11-01",
      "unpinned: the version is then whatever a developer console outside this repo says",
    );
  });

  it("does not put the pin on a /services/v2 request", async () => {
    // Named for what it checks. The pin is threaded as an OPTIONAL argument so
    // the live-service path keeps the header set it had, and this is the
    // regression that would show if the argument ever became mandatory or got a
    // default — one endpoint, one absent header. It is NOT a proof that every
    // /services/v2 request is byte-identical; that comes from the argument being
    // absent at all fifteen call sites, which the type checker enforces, plus
    // the existing suites for those endpoints.
    //
    // When fix/pco-freshness lands it pins /services/v2 too, and this
    // expectation inverts with it.
    const seen = await captureHeaders(() => pcoService.listServiceTypes("app", "secret"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].get("X-PCO-API-Version"), null, "a /services/v2 request grew the pin");
    assert.ok(seen[0].get("Authorization")?.startsWith("Basic "), "the auth header is still built the same way");
  });
});

// Put the real requester back. node:test gives each file its own process, so
// this is belt-and-braces rather than load-bearing — but the stub is a module
// singleton, and leaving one installed is not a thing to rely on a runner for.
process.on("exit", () => {
  svc.request = realRequest;
});
