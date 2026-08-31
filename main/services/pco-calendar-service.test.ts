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
import { CALENDAR_API_VERSION, pcoCalendarService } from "./pco-calendar-service.js";
import { PCO_API_VERSION, pcoService } from "./pco-service.js";
import { CALENDAR_REFRESH_MS } from "../types/calendar.js";

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

// ── Pagination ──────────────────────────────────────────────────────────────
//
// The stub above answers the SAME payload however many times it is asked and
// advertises no `links`, so the paging loop ran exactly once in every test in
// this file and six separate mutations of it stayed green — the page bound, the
// strictly-forward rule, the dedupe, the offset carried out of the body, and the
// warning on truncation all had zero coverage.
//
// These drive the real reader with a stub KEYED ON THE OFFSET in the url it is
// asked for, so the loop actually walks. The loop itself is readPcoPages in
// pco-service.ts, shared with the two /services/v2 readers that used to carry
// verbatim copies of it; there is one loop to guard, and this is it.
describe("pagination", () => {
  /** The `offset` the client asked for, or 0 when it asked for the first page. */
  function offsetOf(url: string): number {
    return Number(new URL(url).searchParams.get("offset") ?? 0);
  }

  /**
   * Serve one page per entry in `pages`, keyed on the requested offset.
   *
   * `nextOf` builds the `links.next` a page carries; returning undefined ends
   * the collection. Offsets advance by 100 (PER_PAGE) so the urls look like
   * PCO's own.
   */
  function stubPaged(pages: unknown[][], nextOf: (page: number) => string | undefined): void {
    urls = [];
    svc.request = async (url: string) => {
      urls.push(url);
      const page = offsetOf(url) / 100;
      const data = pages[page] ?? [];
      const next = nextOf(page);
      return { data, included: [TAG_TEAL, TAG_AMBER], ...(next ? { links: { next } } : {}) };
    };
  }

  /** A next-link on PCO's own origin at `offset`. */
  const pcoNext = (offset: number) =>
    `https://api.planningcenteronline.com/calendar/v2/event_instances?per_page=100&offset=${offset}`;

  /** Run `body` with console.warn captured. */
  async function warnings(body: () => Promise<unknown>): Promise<string[]> {
    const real = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    try {
      await body();
    } finally {
      console.warn = real;
    }
    return seen;
  }

  beforeEach(() => pcoCalendarService.clearCache());

  it("concatenates every page, following the offset out of links.next", async () => {
    // Three pages of two. A loop that runs once returns 2; one that ignores the
    // dedupe on a repeated id returns more than 6.
    stubPaged(
      [
        [instance("e1", {}), instance("e2", {})],
        [instance("e3", {}), instance("e4", {})],
        [instance("e5", {}), instance("e6", {})],
      ],
      (page) => (page < 2 ? pcoNext((page + 1) * 100) : undefined),
    );
    const events = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(urls.length, 3, `expected exactly 3 requests, made ${urls.length}`);
    assert.deepEqual(events.map((e) => e.id), ["e1", "e2", "e3", "e4", "e5", "e6"]);
  });

  it("drops a row a later page repeats, rather than listing it twice", async () => {
    stubPaged(
      [
        [instance("e1", {}), instance("e2", {})],
        [instance("e2", {}), instance("e3", {})],
      ],
      (page) => (page < 1 ? pcoNext(100) : undefined),
    );
    const events = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.deepEqual(events.map((e) => e.id), ["e1", "e2", "e3"]);
  });

  it("STOPS on a next-link that does not move forward, instead of looping for ever", async () => {
    // PCO does not do this, which is exactly why nothing would catch it if it
    // started: the offset is not larger than the one already asked for, so the
    // second page is the last request made.
    stubPaged(
      [[instance("e1", {})], [instance("e2", {})], [instance("e3", {})]],
      (page) => (page === 0 ? pcoNext(100) : pcoNext(100)),
    );
    const events = await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(urls.length, 2, `a non-advancing offset made ${urls.length} requests`);
    assert.deepEqual(events.map((e) => e.id), ["e1", "e2"]);
  });

  it("stops at the page bound, and SAYS SO", async () => {
    // 13 pages on offer, MAX_PAGES is 12. Exiting on the bound is otherwise
    // indistinguishable from having read everything, so the operator gets a line
    // in /log rather than a month that is quietly missing its last week.
    const pages = Array.from({ length: 13 }, (_, i) => [instance(`e${i}`, {})]);
    stubPaged(pages, (page) => (page < 12 ? pcoNext((page + 1) * 100) : undefined));
    const seen = await warnings(() => pcoCalendarService.listEventInstances("app", "secret", WINDOW));
    assert.equal(urls.length, 12, `the page bound let ${urls.length} requests through`);
    assert.equal(seen.length, 1, `expected one truncation warning, got ${seen.length}`);
    assert.match(seen[0], /page limit reached/);
    assert.match(seen[0], /\[pco-calendar\]/);
  });

  it("carries an OFFSET out of links.next, never the url — even one naming another host", async () => {
    // The credentials go on every request this makes. `links.next` arrives in a
    // response BODY, so an integer is the only thing safe to take from it: it
    // cannot carry a host, a path or a scheme.
    stubPaged(
      [[instance("e1", {})], [instance("e2", {})]],
      (page) => (page === 0 ? "https://evil.example/calendar/v2/event_instances?per_page=100&offset=100" : undefined),
    );
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(urls.length, 2);
    const second = new URL(urls[1]);
    assert.equal(second.origin, "https://api.planningcenteronline.com", `page two went to ${second.origin}`);
    assert.equal(second.searchParams.get("offset"), "100", "the offset from links.next was not applied");
    assert.equal(second.pathname, new URL(urls[0]).pathname, "page two changed path");
  });

  it("asks for a full page, not one row at a time", async () => {
    stubPaged([[instance("e1", {})]], () => undefined);
    await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
    assert.equal(new URL(urls[0]).searchParams.get("per_page"), "100");
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

  // The three tests above pinned only hit-versus-miss KEYING, so every number
  // this cache is built out of was free: TTL_EMPTY_MS could equal
  // TTL_METADATA_MS, MAX_CACHE_ENTRIES could be 1, and TTL_EVENTS_MS could be 0,
  // all with the file green. TTL_EMPTY_MS in particular carried a six-line
  // docstring nothing checked.
  //
  // These drive the real cache with the clock moved on, which is the only way to
  // see a TTL at all.
  describe("holds an answer for as long as it says it does", () => {
    /** Run `body` with Date.now advanced by `ms` for its whole duration. */
    async function at(ms: number, body: () => Promise<unknown>): Promise<void> {
      const real = Date.now;
      const base = real();
      Date.now = () => base + ms;
      try {
        await body();
      } finally {
        Date.now = real;
      }
    }

    it("re-reads an EMPTY calendar list quickly, and a real one slowly", async () => {
      // An empty answer is far more likely to be a blip than an org with no
      // calendars, and holding it for the metadata TTL would make one blip look
      // permanent. TTL_EMPTY_MS is 30s; TTL_METADATA_MS is 15 minutes.
      stub([]);
      await pcoCalendarService.listCalendars("app", "secret");
      await at(45_000, () => pcoCalendarService.listCalendars("app", "secret"));
      assert.equal(urls.length, 2, "an empty calendar list was held past its 30s TTL");

      pcoCalendarService.clearCache();
      stub([{ id: "cal-1", type: "Calendar", attributes: { name: "Sample Calendar" } }]);
      await pcoCalendarService.listCalendars("app", "secret");
      await at(45_000, () => pcoCalendarService.listCalendars("app", "secret"));
      assert.equal(urls.length, 1, "a real calendar list was re-fetched 45s later");
    });

    it("holds a window for minutes, not for one tick", async () => {
      // TTL_EVENTS_MS is 3 minutes: an operator moves an event and expects to
      // see it move, but a grid that re-fetched on every render would hammer PCO.
      stub([instance("e1", {})]);
      await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
      await at(60_000, () => pcoCalendarService.listEventInstances("app", "secret", WINDOW));
      assert.equal(urls.length, 1, "the window was re-fetched a minute later");
      await at(4 * 60_000, () => pcoCalendarService.listEventInstances("app", "secret", WINDOW));
      assert.equal(urls.length, 2, "the window was still being served four minutes later");
    });

    it("keeps more than one window at a time", async () => {
      // MAX_CACHE_ENTRIES is 200 precisely so a month grid browsed back and
      // forth keeps its neighbours. At 1, every step forward evicts the month
      // the operator is about to step back to.
      const MARCH = WINDOW;
      const APRIL = { ...WINDOW, fromIso: "2026-04-01T05:00:00Z", toIso: "2026-05-01T04:59:59Z" };
      stub([instance("e1", {})]);
      await pcoCalendarService.listEventInstances("app", "secret", MARCH);
      await pcoCalendarService.listEventInstances("app", "secret", APRIL);
      await pcoCalendarService.listEventInstances("app", "secret", MARCH);
      assert.equal(urls.length, 2, "stepping to the next month evicted the one before it");
    });
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
      CALENDAR_API_VERSION,
      "unpinned: the version is then whatever a developer console outside this repo says",
    );
    assert.match(CALENDAR_API_VERSION, /^\d{4}-\d{2}-\d{2}$/, "PCO versions each product by DATE");
  });

  it("pins a /services/v2 request from the Services constant, not from this argument", async () => {
    // INVERTED, exactly as the note that stood here predicted. This used to
    // assert that a /services/v2 request grew NO version header: the pin arrived
    // as an optional argument so the live-service path would keep the header set
    // it already had, and the note said "when fix/pco-freshness lands it pins
    // /services/v2 too, and this expectation inverts with it". It landed.
    //
    // What is left to check is that each product's request carries ITS OWN
    // constant. The Services path takes the Services constant, and the
    // calendar's argument is an override for one product rather than the thing
    // that decides this header. That the override actually reaches the wire is
    // the other half, and lives in pco-api-version.test.ts, where a version
    // unlike either constant can be asked for and looked for.
    //
    // Against the IMPORTED constant, not against the literal. This block used to
    // claim it pinned the two products INDEPENDENTLY while comparing both to the
    // same hardcoded "2018-11-01" — which is what both constants happen to say
    // today, so the claim was untrue and moving either constant left this
    // assertion passing on a date the app no longer sends.
    const seen = await captureHeaders(() => pcoService.listServiceTypes("app", "secret"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].get("X-PCO-API-Version"), PCO_API_VERSION, "a /services/v2 request lost the pin");
    assert.ok(seen[0].get("Authorization")?.startsWith("Basic "), "the auth header is still built the same way");
  });
});

describe("the event-instance cache against the server's own refresh", () => {
  beforeEach(() => pcoCalendarService.clearCache());

  it("THE GUARD: a refresh at the server's own period is a REAL read", async () => {
    // The bug: the broadcaster's timer and this cache were both written as three
    // minutes, and an entry is stamped when its read COMPLETES — so the tick
    // three minutes later fell inside the entry and was served it. Every other
    // tick did a real read and the true interval was six minutes, while both
    // files and the docs said three.
    //
    // Driven through the real cache at exactly the broadcaster's period, which
    // is the instant the timer wakes. The clock is moved rather than waited on.
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => fake;
    try {
      stub([]);
      await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
      assert.equal(urls.length, 1, "the first read did not reach Planning Center");

      fake += CALENDAR_REFRESH_MS;
      await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
      assert.equal(
        urls.length,
        2,
        `the refresh at ${CALENDAR_REFRESH_MS / 60_000} minutes was served the cache, so the real interval is ${(2 * CALENDAR_REFRESH_MS) / 60_000} minutes`,
      );
    } finally {
      Date.now = realNow;
    }
  });

  it("still absorbs the ad-hoc reads it exists for", async () => {
    // The other half. A second view with the same filters, or a browser opening
    // the calendar between refreshes, must not each cost a request.
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => fake;
    try {
      stub([]);
      await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
      fake += CALENDAR_REFRESH_MS - 61_000;
      await pcoCalendarService.listEventInstances("app", "secret", WINDOW);
      assert.equal(urls.length, 1, "a read a minute inside the TTL went to Planning Center anyway");
    } finally {
      Date.now = realNow;
    }
  });
});

// Put the real requester back. node:test gives each file its own process, so
// this is belt-and-braces rather than load-bearing — but the stub is a module
// singleton, and leaving one installed is not a thing to rely on a runner for.
process.on("exit", () => {
  svc.request = realRequest;
});
