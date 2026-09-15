// The live DTO's title and length, after `include=items` was dropped.
//
// getLive() runs once a second while an item is live. Its request used to carry
// `include=items` — a whole plan's items, 20 times per 20-second window — and the
// payload was read for exactly two values: the current item's `title` and its
// `length`. The rundown from listPlanItems is fetched on the very next line,
// cached, and carries both under the same names (`title`, and `lengthSec` from
// PCO's `length`). So the include was paying for a second copy of two fields.
//
// It also made two fields disagree. `label` came off the include (fresh every
// second) and `currentItemTitle` off the cache (up to 45s old), so renaming an
// item mid-service left two fields describing the same item contradicting each
// other until the cache turned over.
//
// These drive the REAL client with a URL-routing fetch stub rather than reading
// the source. A source scan would be satisfied by the constant `planItem` existing;
// the bug this guards is a DTO field that ends up null because nothing fills it.

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { pcoService } from "./pco-service.js";
import { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } from "./service-window.js";

const LIVE_START = "2026-03-01T14:05:00.000Z";
const SERVICE_START = "2026-03-01T14:00:00.000Z";

/** The two ids the fixtures use: the ItemTime, and the Item it points at. */
const ITEM_TIME_ID = "it-77";
const LIVE_ITEM_ID = "item-2";

let urls: string[] = [];
let itemTitle = "Opener";
let itemLengthSec = 420;
/** Which Item the live session claims to be on. Changed to test the ownership guard. */
let liveItemId = LIVE_ITEM_ID;

const realFetch = globalThis.fetch;

function body(url: string): unknown {
  if (url.includes("/live")) {
    return {
      data: {
        id: "live-1",
        type: "Live",
        attributes: {},
        relationships: { current_item_time: { data: { id: ITEM_TIME_ID, type: "ItemTime" } } },
      },
      // `current_item_time` only. `items` is the include this file exists to keep
      // gone: if a future edit puts it back, the assertion on the URL fires.
      included: [
        {
          id: ITEM_TIME_ID,
          type: "ItemTime",
          attributes: { live_start_at: LIVE_START, length_offset: 60 },
          relationships: { item: { data: { id: liveItemId, type: "Item" } } },
        },
      ],
    };
  }
  if (url.includes("/plan_times")) {
    return {
      data: [
        {
          id: "pt-1",
          type: "PlanTime",
          attributes: { time_type: "service", starts_at: SERVICE_START, ends_at: null },
        },
      ],
    };
  }
  if (url.includes("/items")) {
    return {
      data: [
        {
          id: "item-1",
          type: "Item",
          attributes: { title: "Walk-in", item_type: "item", length: 300, sequence: 0 },
        },
        {
          id: LIVE_ITEM_ID,
          type: "Item",
          attributes: { title: itemTitle, item_type: "song", length: itemLengthSec, sequence: 1 },
        },
        {
          id: "item-3",
          type: "Item",
          attributes: { title: "Message", item_type: "item", length: 1800, sequence: 2 },
        },
      ],
      included: [],
    };
  }
  return { data: [], included: [] };
}

function stubFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => body(url),
      text: async () => JSON.stringify(body(url)),
    } as unknown as Response;
  }) as typeof fetch;
}

describe("the live DTO keeps its title and length without include=items", () => {
  beforeEach(() => {
    urls = [];
    itemTitle = "Opener";
    itemLengthSec = 420;
    liveItemId = LIVE_ITEM_ID;
    // No service window: the MEDIUM cache tier's length is irrelevant here and a
    // stale window from another file would only make the rundown cache shorter.
    serviceWindow.setWindows([]);
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    pcoService.clearCache();
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    serviceWindow.setWindows([]);
    pcoService.clearCache();
  });

  test("THE GUARD: the DTO carries the live item's title", async () => {
    const live = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(live.mode, "item");
    assert.equal(
      live.label,
      "Opener",
      "the live item's title now comes from the cached rundown, not from an `include=items` on the " +
        "1 Hz live request. A null here means the include was dropped and nothing replaced it — the " +
        "countdown block goes blank while an item is live.",
    );
  });

  test("THE GUARD: the DTO carries the live item's length", async () => {
    const live = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(
      live.lengthSec,
      itemLengthSec + 60,
      "lengthSec is the rundown's lengthSec (PCO's `length`) plus the ItemTime length_offset. A null " +
        "or a bare offset here means the rundown lookup stopped supplying the plan length, and the " +
        "green timer counts down from the wrong number.",
    );
  });

  test("the live request does not ask for the items include", async () => {
    await pcoService.getLive("app", "sec", "st", "plan");
    const liveUrl = urls.find((u) => u.includes("/live"));
    assert.ok(liveUrl, "no /live request was made");
    assert.ok(
      liveUrl.includes("include=current_item_time"),
      `current_item_time carries live_start_at and length_offset and must stay: ${liveUrl}`,
    );
    assert.ok(
      !/\bitems\b/.test(new URL(liveUrl).searchParams.get("include") ?? ""),
      `the items include costs a whole plan's items once a second for two values: ${liveUrl}`,
    );
  });

  test("label and currentItemTitle agree, because they share one source", async () => {
    const live = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(live.label, live.currentItemTitle);
    assert.equal(live.currentItemTitle, "Opener");
    assert.equal(live.nextItemTitle, "Message");
  });

  test("a rename moves BOTH fields together", async () => {
    const first = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(first.label, "Opener");

    // The rename, and a cache clear standing in for the TTL turning over. With
    // the include in place only `label` moved here and the two fields disagreed
    // for up to 45 seconds.
    itemTitle = "Opener (reprise)";
    pcoService.clearCache();

    const second = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(second.label, "Opener (reprise)");
    assert.equal(second.currentItemTitle, "Opener (reprise)");
    assert.equal(second.label, second.currentItemTitle);
  });

  test("itemType comes from the rundown too", async () => {
    const live = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(live.itemType, "song");
  });

  test("the ownership guard still holds: an item not in this plan is not ours", async () => {
    // What `include=items` used to prove by the item's presence in the payload.
    // Checking the id against the cached rundown is the same check.
    liveItemId = "item-from-another-plan";
    const live = await pcoService.getLive("app", "sec", "st", "plan");
    assert.equal(live.mode, "preservice", "a live session on an item this plan does not have is not ours");
    assert.equal(live.label, "Service starts");
  });

  test("the rundown is cached, so a second tick costs one request", async () => {
    await pcoService.getLive("app", "sec", "st", "plan");
    const firstCount = urls.length;
    urls = [];
    await pcoService.getLive("app", "sec", "st", "plan");
    assert.ok(firstCount >= 3, `cold tick should read live + items + plan_times, saw ${firstCount}`);
    assert.equal(
      urls.length,
      1,
      `a warm tick must be the /live request alone — the rundown and plan times are cached. Saw: ${urls.join(", ")}`,
    );
    assert.ok(urls[0].includes("/live"));
  });
});
