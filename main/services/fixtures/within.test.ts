// until() and within() must keep working in a file that mocks Date and setTimeout
// (messages-service does both): a Date.now() deadline never expires there, and a
// poll on the mocked setTimeout never fires. Both would hang the suite.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { until } from "./within.js";

describe("until", () => {
  it("resolves once the condition holds, with Date and setTimeout mocked", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    let n = 0;
    await until(() => ++n >= 3, "three polls");
    assert.ok(n >= 3);
  });

  it("times out on the real clock and names what it waited for, with Date and setTimeout mocked", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    await assert.rejects(until(() => false, "a thing that never happens", 30), /timed out waiting for a thing that never happens/);
  });

  it("takes a function for the message, read at the moment of failure", async () => {
    let state = "before";
    await assert.rejects(
      until(
        () => {
          state = "after";
          return false;
        },
        () => `state ${state}`,
        20,
      ),
      /timed out waiting for state after/,
    );
  });
});
