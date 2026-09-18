// The operator's dates worth marking on the Trends chart.
//
// The rule that matters is what happens to an entry whose date cannot be drawn.
// It is SKIPPED and LOGGED, not deleted: the row stays in the file where the
// operator put it, and `/log` says which one could not be read. A store that
// quietly dropped it would leave somebody looking for a mark that never appears
// with nothing to read at 9am on a Sunday.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "history-milestones-"));
process.env.STAGE_UTILITY_DATA = DATA;

// Written BEFORE the module loads: init() reads it, which is the path a bad
// date actually arrives on — a hand-edited file or a restored backup.
fs.writeFileSync(
  path.join(DATA, "history-milestones.json"),
  JSON.stringify([
    { id: "a", date: "2026-03-01", label: "New building", serviceTypeId: null },
    // Parses in JavaScript and lands on 2 or 3 March. The round trip is what
    // catches it.
    { id: "b", date: "2026-02-31", label: "Two services", serviceTypeId: null },
    { id: "c", date: "sometime in the spring", label: "Kickoff", serviceTypeId: "salt" },
    { id: "d", date: "2026-05-10", label: "Summer\nseries", serviceTypeId: "weekend" },
  ]),
);

const logged: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  logged.push(args.map(String).join(" "));
};

const { historyMilestonesStore, partitionMilestones, isCalendarDate } = await import("./history-milestones-store.js");
await historyMilestonesStore.init();
console.log = realLog;

describe("reading the list", () => {
  test("an entry with a date that cannot be drawn is skipped", () => {
    assert.deepEqual(
      historyMilestonesStore.all().map((m) => m.id).sort(),
      ["a", "d"],
      "only the entries with real calendar dates are drawable",
    );
  });

  test("each skipped entry is logged, by label, on the [history] tag", () => {
    const lines = logged.filter((l) => l.startsWith("[history] milestone")).sort();
    assert.deepEqual(
      lines,
      [
        '[history] milestone "Kickoff" has no valid date, skipped',
        '[history] milestone "Two services" has no valid date, skipped',
      ],
      "an operator looking for a mark that never appeared must have something to read",
    );
  });

  test("a label is scrubbed before it reaches the log", () => {
    // `/log` is one record per line and a label is operator input. A newline in
    // one forges an entry indistinguishable from the server's own.
    const { skipped } = partitionMilestones([{ id: "x", date: "nope", label: "Two\nservices" }]);
    assert.deepEqual(skipped, ["Two\nservices"], "the RAW label comes back — scrubbing is the logger's job");
    // And the store's own log line carried no raw newline, for the entry above
    // whose label has one. (That entry has a valid date, so it is drawn; this
    // asserts the logger is the only place scrubbing has to happen.)
    assert.equal(logged.filter((l) => l.includes("Summer\nseries")).length, 0);
  });

  test("the newest milestone is first", () => {
    assert.deepEqual(historyMilestonesStore.all().map((m) => m.date), ["2026-05-10", "2026-03-01"]);
  });
});

describe("a calendar date", () => {
  test("is a real day, not merely something Date can parse", () => {
    // One case per line, so two branches adding different cases merge cleanly.
    assert.deepEqual(
      ["2026-03-01", "2026-02-29", "2024-02-29", "2026-02-31", "2026-13-01", "2026-3-1", "March 1", ""].map(
        (d) => [d, isCalendarDate(d)],
      ),
      [
        ["2026-03-01", true],
        // 2026 is not a leap year; 2024 is.
        ["2026-02-29", false],
        ["2024-02-29", true],
        ["2026-02-31", false],
        ["2026-13-01", false],
        // A shape the chart's date arithmetic cannot use, however readable.
        ["2026-3-1", false],
        ["March 1", false],
        ["", false],
      ],
    );
  });
});

describe("writing one", () => {
  test("a date that cannot be drawn is REFUSED, not stored and logged later", async () => {
    // The log line above is for a file that already contains one. A form that
    // accepted a bad date would leave the operator with a row they can see in
    // Settings and a mark that never appears on the chart.
    await assert.rejects(
      () => historyMilestonesStore.save({ date: "2026-02-31", label: "Two services", serviceTypeId: null }),
      /not a date/,
    );
    assert.equal(historyMilestonesStore.all().some((m) => m.label === "Two services"), false);
  });

  test("saving with an existing id replaces that entry rather than adding a second", async () => {
    await historyMilestonesStore.save({ id: "a", date: "2026-03-08", label: "New building", serviceTypeId: null });
    const a = historyMilestonesStore.all().filter((m) => m.id === "a");
    assert.equal(a.length, 1);
    assert.equal(a[0].date, "2026-03-08");
  });

  test("a saved entry survives a restart", async () => {
    await historyMilestonesStore.save({ date: "2026-06-07", label: "Camp", serviceTypeId: null });
    const fresh = await import(`./history-milestones-store.js?restart=${Date.now()}`);
    await fresh.historyMilestonesStore.init();
    assert.ok(fresh.historyMilestonesStore.all().some((m: { label: string }) => m.label === "Camp"));
  });

  test("removing one leaves the rest", async () => {
    const before = historyMilestonesStore.all().length;
    const after = await historyMilestonesStore.remove("a");
    assert.equal(after.length, before - 1);
    assert.equal(after.some((m) => m.id === "a"), false);
  });
});
