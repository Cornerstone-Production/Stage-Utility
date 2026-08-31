// What this file guards.
//
// 1. THE PANEL DOES NOT ANNOUNCE A FAILURE IT HAS NOT HAD. `sources` was a
//    `Sources | null` where null meant both "not read yet" and "the read
//    failed", so the very first render of Plan settings said "Could not read
//    the categories from Planning Center." for the length of the round trip.
//    The calendar picker documents this exact bug and fixes it with a
//    three-state union; this one shipped without it in the same release.
//
// 2. A CHOICE PCO NO LONGER OFFERS STAYS IN THE PICKER, MARKED. Dropping it
//    would silently unselect the operator's choice and leave the checklist
//    empty with nothing on screen to explain it.
//
// 3. TICKING A CATEGORY REACHES THE HANDLER with BOTH lists. A control that
//    renders and does nothing is this repo's named scar.
//
// Every category, team and service-type id below is INVENTED. This is a public
// repository.

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { installDom } from "../../test-dom.js";
import type { SectionProps } from "../types";

const teardown = installDom();

/** What the fake `checklist:sources` route answers. */
let sourcesReply: () => Promise<unknown> = async () => ({ categories: [], teams: [] });
let resolveSources: (() => void) | null = null;

(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  const payload = url.includes("checklist") ? await sourcesReply() : {};
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

// After installDom(), never before: a static import evaluates first and React
// would come up with no document.
const { render, screen, cleanup, fireEvent, within } = await import("@testing-library/react");
const React = (await import("react")).default;
const { ChecklistSources } = await import("./checklist-sources.js");

const settle = () => new Promise((r) => setTimeout(r, 0));

after(async () => {
  await settle();
  teardown();
});
beforeEach(() => {
  cleanup();
  resolveSources = null;
  sourcesReply = async () => ({
    categories: ["Production Notes", "Band Notes"],
    teams: ["Audio Team"],
  });
});
afterEach(async () => {
  cleanup();
  await settle();
});

/** The two props ChecklistSources reads, and a handler that records its call. */
function props(over: {
  serviceTypeId?: string | null;
  categories?: string[];
  teams?: string[];
}): { node: React.ReactElement; calls: [string[], string[]][] } {
  const calls: [string[], string[]][] = [];
  const stageState = {
    serviceTypeId: over.serviceTypeId === undefined ? "st-invented-1" : over.serviceTypeId,
    planId: "plan-invented-1",
    checklistNoteCategories: over.categories ?? [],
    checklistNoteTeams: over.teams ?? [],
  } as SectionProps["stageState"];
  const handlers = {
    handleSetChecklistSources: async (categories: string[], teams: string[]) => {
      calls.push([categories, teams]);
    },
  } as SectionProps["handlers"];
  return { node: React.createElement(ChecklistSources, { stageState, handlers }), calls };
}

describe("what the panel says while it is reading", () => {
  it("says it is reading rather than claiming the read failed", async () => {
    // null was both "not fetched yet" and "fetch failed", so every open of Plan
    // settings announced a failure before the read had been attempted.
    sourcesReply = () =>
      new Promise((r) => {
        resolveSources = () => r({ categories: ["Production Notes"], teams: [] });
      });
    render(props({}).node);

    assert.ok(
      screen.queryByText(/could not read the categories/i) === null,
      "the panel reported a failure before the read had been attempted",
    );
    assert.ok(screen.getByText(/reading the categories/i));

    resolveSources?.();
    await settle();
    await settle();
    assert.ok(
      screen.queryByText(/reading the categories/i) === null,
      "still claiming to be loading after the read landed",
    );
  });

  it("does not call a stored choice missing before it knows", async () => {
    // "(not in Planning Center)" is a CLAIM, and only a landed read can make it.
    // With `offered` empty during the round trip, every stored name went through
    // optionsFor's missing branch, so opening the picker mid-read showed every
    // choice the operator made marked as gone — under a line saying the read is
    // still happening. It has to be OPENED to see: with nothing offered, options
    // and chosen are the same list and the trigger takes MultiSelect's
    // "All (N)" branch, which is why a closed-picker assertion passes on the bug.
    sourcesReply = () =>
      new Promise((r) => {
        resolveSources = () => r({ categories: ["Production Notes"], teams: [] });
      });
    render(props({ categories: ["Production Notes"] }).node);

    assert.ok(screen.getByText(/reading the categories/i), "not in the state this is about");
    open("categories");
    assert.equal(
      /not in Planning Center/.test(rows().textContent ?? ""),
      false,
      "a stored choice was marked missing while the read was still in flight",
    );
    assert.ok(
      within(rows()).getByText("Production Notes"),
      "the stored choice is not listed at all while the read is in flight",
    );

    resolveSources?.();
    await settle();
    await settle();
  });

  it("says the read failed when it did", async () => {
    sourcesReply = () => Promise.reject(new Error("nope"));
    render(props({}).node);
    await settle();
    await settle();
    assert.ok(screen.getByText(/could not read the categories/i));
  });

  it("says nothing about reading once the categories are in", async () => {
    render(props({}).node);
    await settle();
    assert.ok(screen.queryByText(/reading the categories/i) === null);
    assert.ok(screen.queryByText(/could not read the categories/i) === null);
  });

  it("asks for a service type instead, when there is none", async () => {
    render(props({ serviceTypeId: null }).node);
    await settle();
    assert.ok(screen.getByText(/choose a service type first/i));
    assert.ok(
      screen.queryByText(/could not read the categories/i) === null,
      "no service type is not a failed read",
    );
  });
});

/**
 * Open one of the two pickers.
 *
 * Anchored on the field's data-field, not on the trigger's text: the trigger
 * shows a SUMMARY of the current selection ("All (2)", "3 selected"), so
 * matching on it makes the test depend on how many options happened to load.
 */
const open = (field: string) => {
  const panel = document.querySelector(`[data-field="${field}"]`);
  assert.ok(panel, `no picker named ${field}`);
  fireEvent.click(within(panel as HTMLElement).getByRole("button"));
};

/**
 * The open popover's rows.
 *
 * Scoped, not read off `screen`: the collapsed trigger summarises the selection
 * by joining the chosen LABELS, so a one-item selection puts the very same text
 * on screen twice and an unscoped query cannot tell the list from the summary.
 */
const rows = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
  assert.ok(el, "no picker is open");
  return el;
};

describe("a category Planning Center no longer offers", () => {
  it("stays in the picker, marked", async () => {
    render(props({ categories: ["Retired Notes"] }).node);
    await settle();
    open("categories");
    assert.equal(
      within(rows()).queryAllByText("Retired Notes (not in Planning Center)").length,
      1,
      "the operator's stored choice vanished from the picker",
    );
  });

  it("does not double up a choice PCO still offers", async () => {
    render(props({ categories: ["Production Notes"] }).node);
    await settle();
    open("categories");
    assert.equal(
      within(rows()).queryAllByText("Production Notes").length,
      1,
      "the live option and the stored choice were both listed",
    );
  });
});

describe("ticking a category reaches the handler", () => {
  it("sends BOTH lists, so the other picker is not wiped", async () => {
    const { node, calls } = props({ teams: ["Audio Team"] });
    render(node);
    await settle();

    open("categories");
    fireEvent.click(within(rows()).getByText("Band Notes"));

    assert.equal(calls.length, 1, `the picker rendered and did nothing. Saw: ${JSON.stringify(calls)}`);
    assert.deepEqual(calls[0], [["Band Notes"], ["Audio Team"]]);
  });
});
