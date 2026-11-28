// appZoneOf: which zone a page dates things in. Every page that prints a plan's
// date or a day asks it, so a wrong order here is wrong everywhere at once.

import assert from "node:assert/strict";
import { test } from "node:test";

import { hostTimeZone } from "@main/services/app-timezone";

import { appZoneOf } from "./app-zone.js";

test("the zone comes off stage state in the SERVER's order, the browser last", () => {
  // The near miss: `state.timezone ?? <this browser's zone>`. With nothing
  // configured the server falls back to ITS host, not the viewer's, so a UTC
  // box read from a laptop in Chicago had the page ending Sunday five hours
  // before the server did. One case per line.
  assert.deepEqual(
    [
      appZoneOf({ timezone: "America/Denver", hostTimezone: "UTC" }, "America/Chicago"),
      appZoneOf({ timezone: null, hostTimezone: "UTC" }, "America/Chicago"),
      appZoneOf({ timezone: null, hostTimezone: null }, "America/Chicago"),
      appZoneOf(null, "America/Chicago"),
      appZoneOf(undefined, "America/Chicago"),
    ],
    [
      "America/Denver",
      "UTC",
      "America/Chicago",
      "America/Chicago",
      "America/Chicago",
    ],
  );
});

test("the last resort, left out, is the zone of the browser running it", () => {
  assert.equal(appZoneOf(null), hostTimeZone());
  assert.equal(appZoneOf({ timezone: null, hostTimezone: "UTC" }), "UTC");
});
