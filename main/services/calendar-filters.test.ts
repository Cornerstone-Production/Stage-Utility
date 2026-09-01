// What this file guards.
//
// THE PICKER HAS TO REACH THE REQUEST. A settings control that saves and changes
// nothing is this repository's named failure mode — a "+ row" button once shipped
// adding a row the same code filtered straight back out. So these drive the real
// controller and read the ids it actually asked Planning Center for, rather than
// asserting that the field was stored.
//
// AND EMPTY MEANS EVERYTHING. `where[calendar_ids]=` is a different request from
// no filter at all: one asks PCO to match the empty set. A calendar View is
// created before anyone opens its settings, and one that draws nothing until
// configured reads as broken.
//
// Proven red in the session that wrote them: the controller was changed to pass
// empty lists regardless of the view, and the first two tests failed.
//
// Every id and name below is INVENTED. This is a public repository.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CalendarWindow } from "../types/calendar.js";
import type { View } from "../types/stage.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-calendar-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { stageController } = await import("./stage-controller.js");
const { pcoCalendarService } = await import("./pco-calendar-service.js");
const { gridWindow } = await import("./calendar-grid.js");

type Mutable = {
  state: { views: View[]; [k: string]: unknown };
  broadcast: () => void;
  recomputeResolved: () => void;
};
const ctl = stageController as unknown as Mutable;

/** Every window the controller asked for, in order. */
let asked: CalendarWindow[] = [];

before(() => {
  // The seam the client's own tests use, one level up: nothing here should reach
  // the network, and a test that did would be answering about the internet.
  (pcoCalendarService as unknown as { listEventInstances: unknown }).listEventInstances = async (
    _appId: string,
    _secret: string,
    opts: CalendarWindow,
  ) => {
    asked.push(opts);
    return [];
  };
  stageController.setPcoCredentials("test-app-id", "test-secret");
});

beforeEach(() => {
  asked = [];
  ctl.state = {
    ...ctl.state,
    views: [
      {
        id: "v-filtered",
        name: "Department Calendar",
        kind: "calendar",
        createdAt: "",
        calendarSources: [{ id: "cal-1", name: "Main" }],
        calendarTags: [
          { id: "tag-1", name: "Alpha Ministry" },
          { id: "tag-2", name: "Beta Ministry" },
        ],
      },
      { id: "v-open", name: "Everything", kind: "calendar", createdAt: "" },
    ] as View[],
  };
});

describe("the filters the operator chose reach Planning Center", () => {
  it("asks for exactly the calendars and tags stored on the view", async () => {
    await stageController.getCalendarGrid("v-filtered");
    assert.equal(asked.length, 1);
    assert.deepEqual([...asked[0].calendarIds], ["cal-1"]);
    assert.deepEqual([...asked[0].tagIds], ["tag-1", "tag-2"]);
  });

  it("asks for NO filter when the view has chosen nothing", async () => {
    // Empty, not an empty filter. A calendar View exists before anyone opens its
    // settings, and one that draws nothing until configured looks broken.
    await stageController.getCalendarGrid("v-open");
    assert.deepEqual([...asked[0].calendarIds], []);
    assert.deepEqual([...asked[0].tagIds], []);
  });

  it("asks for no filter when the caller names no view at all", async () => {
    await stageController.getCalendarGrid(null);
    assert.deepEqual([...asked[0].calendarIds], []);
    assert.deepEqual([...asked[0].tagIds], []);
  });

  it("windows the request to a whole six-week grid, not a month", async () => {
    // Compared against gridWindow rather than measured in days. A six-week grid
    // spanning a DST change is 42 days ± an hour, so a `> 41 && < 42` bound is
    // green on a UTC CI box and red on a developer's machine in October — a test
    // failing on the calendar rather than on the code. This still fails if the
    // window is narrowed to a calendar month, which is what it is for.
    await stageController.getCalendarGrid("v-open");
    const expected = gridWindow(new Date().toISOString());
    assert.equal(asked[0].fromIso, expected.fromIso);
    assert.equal(asked[0].toIso, expected.toIso);
  });
});

describe("storing a choice", () => {
  it("keeps the name beside the id, which is what makes a deleted tag readable", async () => {
    // PCO filters by id, and an id is unreadable. Storing only ids would leave a
    // tag deleted in Planning Center showing as a hex string or as nothing at
    // all, and the operator unable to tell what they had picked.
    await stageController.setViewCalendarFilters(
      "v-open",
      [{ id: "cal-9", name: "Facilities" }],
      [{ id: "tag-9", name: "Gamma Ministry" }],
    );
    const v = stageController.getState().views.find((x) => x.id === "v-open");
    assert.deepEqual(v?.calendarSources, [{ id: "cal-9", name: "Facilities" }]);
    assert.deepEqual(v?.calendarTags, [{ id: "tag-9", name: "Gamma Ministry" }]);
  });

  it("does NOT refuse an id Planning Center no longer offers", async () => {
    // The opposite of setViewScriptViewLayout, deliberately. Refusing would make
    // every later save fail once a tag is deleted upstream; the picker marks the
    // stale choice instead and lets the operator remove it.
    await stageController.setViewCalendarFilters("v-open", [], [{ id: "tag-gone", name: "Deleted" }]);
    const v = stageController.getState().views.find((x) => x.id === "v-open");
    assert.deepEqual(v?.calendarTags, [{ id: "tag-gone", name: "Deleted" }]);
  });

  it("drops duplicates and blanks rather than sending them to PCO", async () => {
    await stageController.setViewCalendarFilters(
      "v-open",
      [{ id: "cal-1", name: "Main" }, { id: "cal-1", name: "Main" }, { id: "  ", name: "x" }],
      [],
    );
    assert.deepEqual(
      stageController.getState().views.find((x) => x.id === "v-open")?.calendarSources,
      [{ id: "cal-1", name: "Main" }],
    );
  });

  it("refuses a view that does not exist rather than storing nothing quietly", async () => {
    await assert.rejects(() => stageController.setViewCalendarFilters("nope", [], []), /not found/);
  });
});
