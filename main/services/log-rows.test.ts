// What the /log viewer draws, tested by running the function the viewer runs.
//
// The page inlines decorateLogLines via toString(), so these assertions are over
// the same source text the browser executes. That is the whole reason the logic
// lives in a module: the alternative — grepping the page's template string for a
// hoped-for substring — is the shape of source-reading guard that has repeatedly
// gone green on the exact defect it was added for.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decorateLogLines as moduleFn, type DecoratedLogRow, type RawLogLine } from "./log-rows.js";
import { renderLogPage } from "./log-page.js";

const CHICAGO = "America/Chicago";

/**
 * The function AS THE BROWSER GETS IT: re-evaluated from its emitted source in an
 * empty scope, with no module bindings reachable.
 *
 * Importing the module directly is not good enough and this is not theoretical.
 * The bundler rewrote a nested `function formatter()` into a trailing
 * `__name(formatter, "formatter")`; in Node that helper sits in module scope and
 * every test passed, while the page threw `__name is not defined` on load and
 * rendered nothing at all. Running the emitted text in a bare Function scope is
 * the only version of this check that can fail on that.
 */
const decorateLogLines = new Function(`return (${moduleFn.toString()})`)() as (
  lines: RawLogLine[],
  timeZone: string,
) => DecoratedLogRow[];

let n = 0;
function line(t: string, msg: string, level = "log"): RawLogLine {
  return { seq: ++n, t, level, msg };
}

describe("decorateLogLines", () => {
  test("reads the [tag] a line opens with, and tolerates one that has none", () => {
    const rows = decorateLogLines(
      [
        line("2026-08-30T15:00:00.000Z", "[sensource] polling every 60s"),
        line("2026-08-30T15:00:01.000Z", "no tag on this one"),
        line("2026-08-30T15:00:02.000Z", "[last-update] pull complete"),
      ],
      CHICAGO,
    );
    assert.deepEqual(
      rows.map((r) => r.tag),
      ["sensource", "", "last-update"],
    );
  });

  test("a bracket that is not a leading tag is not read as one", () => {
    const rows = decorateLogLines([line("2026-08-30T15:00:00.000Z", "took [3 s] to answer")], CHICAGO);
    assert.equal(rows[0].tag, "", "a bracket containing a space is prose, not a source tag");
  });

  test("day and time are the APP zone, not UTC", () => {
    // 01:30 UTC is still the previous EVENING in Chicago. This is the case the
    // whole zone rule exists for: a UTC host rolls its date at 19:00 local, so a
    // page that dated lines by the raw stamp would file a Saturday-night service
    // under Sunday.
    const rows = decorateLogLines([line("2026-08-30T01:30:00.000Z", "[pco] refresh")], CHICAGO);
    assert.equal(rows[0].day, "2026-08-29");
    assert.equal(rows[0].time, "20:30:00");
  });

  test("the first line always opens a day, and a later line on the same day does not", () => {
    const rows = decorateLogLines(
      [
        line("2026-08-30T15:00:00.000Z", "a"),
        line("2026-08-30T15:00:01.000Z", "b"),
        line("2026-08-31T15:00:00.000Z", "c"),
      ],
      CHICAGO,
    );
    assert.deepEqual(
      rows.map((r) => r.newDay),
      [true, false, true],
    );
  });

  test("a line stamped EARLIER than the one above it is marked", () => {
    // Exactly the shape of the boot sequence: server.log's tail is replayed, then
    // update.log's tail is replayed BEHIND it with its own older timestamps, and
    // only then do live lines start. Rendered flat as HH:MM:SS with no date, the
    // clock appears to run backwards mid-page.
    const rows = decorateLogLines(
      [
        line("2026-08-30T15:00:00.000Z", "---- restarted ----"),
        line("2026-08-30T14:12:00.000Z", "[last-update] apply start"),
        line("2026-08-30T14:12:05.000Z", "[last-update] pull complete"),
        line("2026-08-30T15:00:01.000Z", "[server] ready"),
      ],
      CHICAGO,
    );
    assert.deepEqual(
      rows.map((r) => r.backwards),
      [false, true, false, false],
      "only the line at the jump is marked — the replayed block ascends within itself",
    );
  });

  test("an unreadable timestamp neither opens a day nor counts as a jump", () => {
    // log-persist hands back t:"" for a hand-edited or pre-format line. Inventing
    // a time for it would drop a date heading into a continuous run, or claim a
    // backwards jump that never happened.
    const rows = decorateLogLines(
      [
        line("2026-08-30T15:00:00.000Z", "a"),
        line("", "a line with no usable timestamp"),
        line("2026-08-30T15:00:01.000Z", "b"),
      ],
      CHICAGO,
    );
    assert.deepEqual(
      rows.map((r) => r.newDay),
      [true, false, false],
    );
    assert.deepEqual(
      rows.map((r) => r.backwards),
      [false, false, false],
    );
    assert.equal(rows[1].time, "--:--:--");
  });

  test("an unusable zone still renders rather than throwing", () => {
    const rows = decorateLogLines([line("2026-08-30T15:00:00.000Z", "a")], "Not/AZone");
    assert.equal(rows.length, 1);
    assert.match(rows[0].time, /^\d\d:\d\d:\d\d$/);
  });
});

describe("the page runs this function rather than a copy of it", () => {
  test("renderLogPage inlines decorateLogLines verbatim", () => {
    // Structural, not a prose match: if somebody re-implements day grouping inside
    // the template string, the tests above stop describing what ships.
    assert.ok(
      renderLogPage(CHICAGO).includes(moduleFn.toString()),
      "the page must embed the function's own source, so the browser and the tests run one implementation",
    );
  });

  test("the emitted source needs nothing but itself", () => {
    // A bundler helper reaches the browser as an undefined identifier and the
    // whole viewer dies on load. Named explicitly as well as caught by every test
    // above running through the re-evaluated copy, because the failure is silent
    // in Node and total in a browser.
    const src = moduleFn.toString();
    for (const helper of ["__name", "__spread", "__assign", "__rest", "__decorate", "require(", "import("]) {
      assert.ok(!src.includes(helper), `the inlined source calls ${helper}, which does not exist in the page`);
    }
  });

  test("the page is told the app time zone", () => {
    assert.ok(renderLogPage(CHICAGO).includes(JSON.stringify(CHICAGO)));
  });
});

describe("the page's own escaping", () => {
  // Lifted out of the rendered page and re-evaluated, for the same reason
  // decorateLogLines is: this asserts the escaping that SHIPS, not a copy of it.
  const src = /^function esc\(s\)\{.*\}$/m.exec(renderLogPage(CHICAGO));
  const esc = new Function(`${src?.[0] ?? "function esc(){throw new Error('esc not found in the page')}"} return esc`)() as (
    s: string,
  ) => string;

  test("angle brackets and ampersands cannot open a tag", () => {
    assert.equal(esc('<img src=x onerror=alert(1)>&'), "&lt;img src=x onerror=alert(1)&gt;&amp;");
  });

  test("quotes cannot close an attribute", () => {
    // Not everything is a text node. An integration's message is written into a
    // title="…" and a source tag into a value="…", and both come from log lines,
    // which carry outside data by definition — a device name, a plan title, an
    // error a box sent back. Escaping only &<> leaves a quote free to break out.
    assert.equal(esc('a"b'), "a&quot;b");
    assert.equal(esc("a'b"), "a&#39;b");
    for (const ch of ['"', "'", "<", ">", "&"]) {
      assert.doesNotMatch(esc(`x${ch}y`), new RegExp(ch === "&" ? "&(?!amp;)" : ch), `${ch} survived escaping`);
    }
  });

  test("ordinary text is left alone", () => {
    assert.equal(esc("[pco] refresh (targeted) — 12 items"), "[pco] refresh (targeted) — 12 items");
  });
});
