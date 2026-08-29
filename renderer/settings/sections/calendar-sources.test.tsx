// What this file guards.
//
// 1. A CHOICE PCO NO LONGER OFFERS STAYS IN THE PICKER, MARKED. Dropping it
//    would silently unselect the operator's choice and widen the filter to
//    everything, with nothing on screen to explain it — and because Planning
//    Center filters by ID, the stored NAME is the only thing that makes such a
//    choice readable at all. Without it a deleted tag shows as a hex string.
//
// 2. CHOOSING A TAG REACHES THE SERVER, with both lists in the body. A control
//    that renders and does nothing is this repo's named scar — a "+ row" button
//    once shipped adding a row the same code filtered straight back out. The
//    pure functions below cannot see that link, so the last suite renders the
//    real component, fires a real selection and reads the outgoing request.
//
// Both proven red in the session that wrote them: the `missing` branch was
// removed from optionsFor, and the request body was narrowed to one list.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { installDom } from "../../test-dom.js";
import type { CalendarSelection } from "@main/types/calendar";
import type { View } from "@main/types/stage";

const teardown = installDom();

/** Every request the component made, in order. */
let sent: { url: string; method: string; body: unknown }[] = [];
let sourcesReply: () => Promise<unknown> = async () => ({ calendars: [], tags: [] });

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  sent.push({ url, method, body });
  const payload = url.includes("calendar-sources") ? await sourcesReply() : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { CalendarSources, optionsFor, toSelections } = await import("./calendar-sources.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
after(async () => {
  await settle();
  teardown();
});
beforeEach(() => {
  cleanup();
  sent = [];
  sourcesReply = async () => ({
    calendars: [{ id: "cal-1", name: "Main" }],
    tags: [{ id: "tag-1", name: "Alpha Ministry", color: "#1d9a8c", groupName: "Departments" }],
  });
});
afterEach(async () => {
  cleanup();
  await settle();
});

const OFFERED = [
  { id: "tag-1", name: "Alpha Ministry", groupName: "Departments" },
  { id: "tag-2", name: "Beta Ministry", groupName: "Departments" },
];

describe("a choice Planning Center no longer offers", () => {
  it("stays in the list rather than disappearing", () => {
    const chosen: CalendarSelection[] = [{ id: "tag-gone", name: "Gamma Ministry" }];
    const values = optionsFor(OFFERED, chosen).map((o) => o.value);
    assert.ok(values.includes("tag-gone"), "the operator's choice vanished from the picker");
  });

  it("is labelled with the name it had, and marked", () => {
    // The id is what PCO filters on and is unreadable. The stored name is the
    // only reason this row says anything at all.
    const chosen: CalendarSelection[] = [{ id: "tag-gone", name: "Gamma Ministry" }];
    const row = optionsFor(OFFERED, chosen).find((o) => o.value === "tag-gone");
    assert.equal(row?.label, "Gamma Ministry (not in Planning Center)");
  });

  it("falls back to the id when even the name was never stored", () => {
    const row = optionsFor(OFFERED, [{ id: "tag-gone", name: "" }]).find((o) => o.value === "tag-gone");
    assert.equal(row?.label, "tag-gone (not in Planning Center)");
  });

  it("does not double up a choice PCO still offers", () => {
    const values = optionsFor(OFFERED, [{ id: "tag-1", name: "Alpha Ministry" }]).map((o) => o.value);
    assert.deepEqual(values, ["tag-1", "tag-2"]);
  });
});

describe("what the picker offers", () => {
  it("names the tag group, because PCO's ANDing across groups is invisible otherwise", () => {
    assert.equal(optionsFor(OFFERED, []).find((o) => o.value === "tag-1")?.label, "Departments · Alpha Ministry");
  });

  it("leaves a calendar, which has no group, as its bare name", () => {
    assert.equal(optionsFor([{ id: "cal-1", name: "Main" }], [])[0].label, "Main");
  });
});

describe("choosing a tag reaches the server", () => {
  const view = {
    id: "v-1",
    name: "Office Calendar",
    kind: "calendar",
    createdAt: "",
    calendarSources: [],
    calendarTags: [{ id: "tag-gone", name: "Gamma Ministry" }],
  } as View;

  const draw = () =>
    render(React.createElement(CalendarSources, { view, pcoConfigured: true }));

  /**
   * Open one of the two pickers and click one of its rows.
   *
   * Anchored on the field's data-field, not on the trigger's text: the trigger
   * shows a SUMMARY of the current selection ("All (1)", "2 selected"), so
   * matching on it makes the test depend on how many options happened to load.
   */
  const choose = (field: string, option: string | RegExp) => {
    const panel = document.querySelector(`[data-field="${field}"]`);
    assert.ok(panel, `no picker named ${field}`);
    const trigger = within(panel as HTMLElement).getByRole("button");
    fireEvent.click(trigger);
    // The popover portals to document.body, so the rows are found on `screen`
    // rather than inside the field.
    fireEvent.click(screen.getByText(option));
  };

  it("PATCHes the view when a tag is ticked", async () => {
    draw();
    await settle();
    sent = [];
    choose("tags", /Departments · Alpha Ministry/);
    const patch = sent.find((r) => r.method === "PATCH");
    assert.ok(patch, `nothing was sent — the picker rendered and did nothing. Saw: ${JSON.stringify(sent)}`);
    assert.match(patch.url, /\/api\/views\/v-1$/);
  });

  it("sends BOTH lists, which is the only shape the server accepts", async () => {
    // view-routes refuses a body carrying one list and not the other, so a
    // picker that sent only the one it changed would fail every save.
    draw();
    await settle();
    sent = [];
    choose("tags", /Departments · Alpha Ministry/);
    const body = sent.find((r) => r.method === "PATCH")?.body as Record<string, unknown>;
    assert.ok(Array.isArray(body.calendarSources), "calendarSources missing from the body");
    assert.ok(Array.isArray(body.calendarTags), "calendarTags missing from the body");
  });

  it("sends the id AND the name, and keeps the choice PCO no longer offers", async () => {
    draw();
    await settle();
    sent = [];
    choose("tags", /Departments · Alpha Ministry/);
    const body = sent.find((r) => r.method === "PATCH")?.body as { calendarTags: CalendarSelection[] };
    assert.deepEqual(body.calendarTags, [
      { id: "tag-gone", name: "Gamma Ministry" },
      { id: "tag-1", name: "Alpha Ministry" },
    ]);
  });

  it("says it is reading rather than claiming the read failed", async () => {
    // null was both "not fetched yet" and "fetch failed", so every page load
    // announced a failure for the length of a round trip.
    draw();
    assert.ok(screen.getByText(/reading the calendars/i));
    await settle();
    assert.equal(screen.queryByText(/reading the calendars/i), null);
  });

  it("says the read failed when it did", async () => {
    sourcesReply = () => Promise.reject(new Error("nope"));
    draw();
    await settle();
    await settle();
    assert.ok(screen.getByText(/could not read the calendars/i));
  });

  it("says Planning Center is not connected rather than showing two empty pickers", async () => {
    // An unconfigured install answers with two empty lists, not an error, so
    // without this the panel is silently blank.
    sourcesReply = async () => ({ calendars: [], tags: [] });
    render(React.createElement(CalendarSources, { view, pcoConfigured: false }));
    await settle();
    assert.ok(screen.getByText(/planning center is not connected/i));
  });
});

describe("turning the picker's ids back into stored choices", () => {
  it("takes the CURRENT name from PCO, so a rename is picked up on the next save", () => {
    const stored: CalendarSelection[] = [{ id: "tag-1", name: "Old Name" }];
    assert.deepEqual(toSelections(["tag-1"], OFFERED, stored), [{ id: "tag-1", name: "Alpha Ministry" }]);
  });

  it("keeps the stored name for a choice PCO no longer offers", () => {
    // Otherwise the label degrades to an id the moment anything else on the view
    // is saved — the choice survives one round trip and then stops being
    // readable, which is worse than dropping it outright.
    const stored: CalendarSelection[] = [{ id: "tag-gone", name: "Gamma Ministry" }];
    assert.deepEqual(toSelections(["tag-gone"], OFFERED, stored), [{ id: "tag-gone", name: "Gamma Ministry" }]);
  });

  it("preserves the order the picker gave", () => {
    assert.deepEqual(
      toSelections(["tag-2", "tag-1"], OFFERED, []).map((s) => s.id),
      ["tag-2", "tag-1"],
    );
  });
});
