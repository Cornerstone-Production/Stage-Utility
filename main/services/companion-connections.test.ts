// Adding up what Companion says about its own connections.
//
// Every shape asserted here was read off a live Companion 5.0.3+9703 with 84
// connections, and the numbers in the "the live install" case are that read:
// 84 total, 52 enabled, 30 good, 12 error, 10 enabled with `status: null`.
//
// The one that is easy to get wrong, and the reason this file exists: an ENABLED
// connection with NO status at all. Ten of the fifty-two on that install are
// smart plugs sitting there, and both of the obvious readings are wrong —
// counting them ok reports a healthy install whose switches all read unknown,
// and counting them errors reports twenty-two faults when there are twelve.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type CompanionConnection,
  connectionDetail,
  connectionSentence,
  healthReport,
  parseConnections,
  summariseConnections,
} from "./companion-connections.js";

/** One entry as Companion writes it, with only the interesting field named. */
const entry = (
  id: string,
  moduleId: string,
  enabled: boolean,
  status: CompanionConnection["status"],
): unknown => ({ id, label: `${id}-label`, moduleId, enabled, status });

const good = { category: "good", level: "ok", message: null };
const connecting = { category: "error", level: "Connecting", message: null };
const failure = { category: "error", level: "Connection Failure", message: null };

describe("parseConnections", () => {
  test("reads the five fields off Companion's own shape", () => {
    const [c] = parseConnections([
      { id: "abc123", label: "MA_HL_Projector", moduleId: "generic-pjlink", enabled: true, status: good },
    ]);
    assert.deepEqual(c, {
      id: "abc123",
      label: "MA_HL_Projector",
      moduleId: "generic-pjlink",
      enabled: true,
      status: { category: "good", level: "ok", message: null },
    });
  });

  test("a null status stays null rather than becoming an empty object", () => {
    const [c] = parseConnections([{ id: "x", label: "L", moduleId: "m", enabled: true, status: null }]);
    assert.equal(c!.status, null);
  });

  test("a status whose category is null keeps its message — the live disabled Dante row", () => {
    const [c] = parseConnections([
      {
        id: "x",
        label: "MA-Dante",
        moduleId: "audinate-dantecontroller",
        enabled: false,
        status: { category: null, level: null, message: "Disabled" },
      },
    ]);
    assert.deepEqual(c!.status, { category: null, level: null, message: "Disabled" });
  });

  test("a body that is not an array is an empty list, never a throw", () => {
    assert.deepEqual(parseConnections({ connections: [] }), []);
    assert.deepEqual(parseConnections(null), []);
    assert.deepEqual(parseConnections("nope"), []);
  });

  test("an entry with no id is dropped — there is nothing to report on", () => {
    assert.equal(parseConnections([{ label: "L", moduleId: "m", enabled: true }]).length, 0);
  });

  test("a missing `enabled` reads as switched ON, not as an install with nothing in it", () => {
    const [c] = parseConnections([{ id: "x", moduleId: "m" }]);
    assert.equal(c!.enabled, true);
    assert.equal(c!.label, "");
    assert.equal(c!.status, null);
  });
});

describe("summariseConnections", () => {
  test("an enabled connection with NO status is unknown — not ok, and not an error", () => {
    const h = summariseConnections(
      parseConnections([entry("a", "tplink-kasasmartplug", true, null)]),
    );
    assert.equal(h.ok, 0);
    assert.equal(h.error, 0);
    assert.equal(h.unknown, 1);
    assert.equal(h.worst, "unknown");
  });

  test("a DISABLED connection is not counted at all, whatever its status says", () => {
    const h = summariseConnections(
      parseConnections([
        entry("on", "generic-pjlink", true, good),
        entry("off1", "vizio-smartcast", false, null),
        entry("off2", "audinate-dantecontroller", false, {
          category: null,
          level: null,
          message: "Disabled",
        }),
        entry("off3", "obs-studio", false, failure),
      ]),
    );
    assert.equal(h.total, 4);
    assert.equal(h.enabled, 1);
    assert.equal(h.ok, 1);
    assert.equal(h.unknown, 0);
    assert.equal(h.error, 0);
    assert.equal(h.worst, "ok");
  });

  test("a category Companion has that this has not verified is unknown, never ok", () => {
    // `warning` is in Companion's vocabulary and was never observed on the
    // install this was built against. Given a meaning it might not have, a
    // warning would read as a healthy connection.
    const h = summariseConnections(
      parseConnections([entry("a", "obs-studio", true, { category: "warning", level: "Slow", message: null })]),
    );
    assert.equal(h.unknown, 1);
    assert.equal(h.ok, 0);
    assert.deepEqual(h.problems, [
      { moduleId: "obs-studio", level: "Slow", count: 1, bucket: "unknown", labels: ["a-label"] },
    ]);
    // And the line says which bucket, so it does not read the same as an
    // `error/Slow` on the same module would.
    assert.equal(connectionDetail(h), "1 of 1 connection(s) not reporting: a-label (Slow, not reporting)");
  });

  test("the category is matched case-insensitively, and trimmed", () => {
    const h = summariseConnections(
      parseConnections([entry("a", "m", true, { category: " Good ", level: "ok", message: null })]),
    );
    assert.equal(h.ok, 1);
  });

  test("worst is error over unknown over ok", () => {
    const of = (...cs: unknown[]) => summariseConnections(parseConnections(cs)).worst;
    assert.equal(of(entry("a", "m", true, good)), "ok");
    assert.equal(of(entry("a", "m", true, good), entry("b", "m", true, null)), "unknown");
    assert.equal(
      of(entry("a", "m", true, good), entry("b", "m", true, null), entry("c", "m", true, failure)),
      "error",
    );
  });

  test("nothing enabled is `ok` with a zero denominator, and says so", () => {
    const h = summariseConnections(parseConnections([entry("a", "m", false, null)]));
    assert.equal(h.enabled, 0);
    assert.equal(h.worst, "ok");
    assert.equal(connectionSentence(h), "no connections enabled in Companion");
  });

  test("problems group by module AND level — one module in two states is two rows", () => {
    const h = summariseConnections(
      parseConnections([
        entry("a", "red-rcp2", true, connecting),
        entry("b", "red-rcp2", true, connecting),
        entry("c", "red-rcp2", true, failure),
      ]),
    );
    assert.deepEqual(
      h.problems.map((x) => `${x.moduleId}/${x.level}/${x.count}`),
      ["red-rcp2/Connecting/2", "red-rcp2/Connection Failure/1"],
    );
  });

  // Companion's own level words contain spaces — `Connection Failure` is one —
  // so a key joined on any single character can be forged by a value carrying
  // it, and two different states add up as one row with the wrong count.
  test("a module id and a level that could be joined the other way stay two rows", () => {
    const h = summariseConnections(
      parseConnections([
        entry("a", "vendor", true, { category: "error", level: "b Connection Failure", message: null }),
        entry("b", "vendor b", true, { category: "error", level: "Connection Failure", message: null }),
      ]),
    );
    assert.equal(h.problems.length, 2);
    assert.deepEqual(
      h.problems.map((p) => `${p.moduleId}/${p.level}/${p.count}`).sort(),
      ["vendor b/Connection Failure/1", "vendor/b Connection Failure/1"],
    );
  });

  // The label is the whole reason it is parsed. It is also the join key a cue's
  // binding uses — `<label>:<variable>` — so naming it is what connects "the
  // projector cue reads unknown" to "the projector's connection is down".
  test("a small group is NAMED and a large one is counted", () => {
    const detail = (n: number) =>
      connectionDetail(
        summariseConnections(
          parseConnections(Array.from({ length: n }, (_, i) => entry(`dev${i}`, "vizio-smartcast", true, failure))),
        ),
      );
    assert.match(detail(1), /: dev0-label \(Connection Failure\)$/);
    assert.match(detail(3), /: dev0-label, dev1-label, dev2-label \(Connection Failure\)$/);
    assert.match(detail(4), /: 4 vizio-smartcast \(Connection Failure\)$/);
  });

  // A connection Companion never labelled cannot be named, and "" , "" , "" in
  // a log line is worse than a count.
  test("a group of unlabelled connections falls back to the count", () => {
    const h = summariseConnections(
      parseConnections([{ id: "x", moduleId: "vizio-smartcast", enabled: true, status: failure }]),
    );
    assert.match(connectionDetail(h), /: 1 vizio-smartcast \(Connection Failure\)$/);
  });

  test("errors sort ahead of unknowns however many of each there are", () => {
    const h = summariseConnections(
      parseConnections([
        ...Array.from({ length: 9 }, (_, i) => entry(`p${i}`, "tplink-kasasmartplug", true, null)),
        entry("t", "vizio-smartcast", true, failure),
      ]),
    );
    assert.deepEqual(
      h.problems.map((x) => `${x.moduleId}/${x.level}/${x.count}/${x.bucket}`),
      ["vizio-smartcast/Connection Failure/1/error", "tplink-kasasmartplug//9/unknown"],
    );
  });
});

describe("the live install", () => {
  /** 84 connections: 30 good, 12 error, 10 enabled with no status, 32 disabled. */
  const live = parseConnections([
    ...Array.from({ length: 30 }, (_, i) => entry(`ok${i}`, "generic-pjlink", true, good)),
    ...Array.from({ length: 6 }, (_, i) => entry(`bulb${i}`, "tplink-kasasmartbulb", true, connecting)),
    ...Array.from({ length: 5 }, (_, i) => entry(`cam${i}`, "red-rcp2", true, connecting)),
    { id: "tv", label: "SA-HL-Stage-TV", moduleId: "vizio-smartcast", enabled: true, status: failure },
    ...Array.from({ length: 10 }, (_, i) => entry(`plug${i}`, "tplink-kasasmartplug", true, null)),
    ...Array.from({ length: 32 }, (_, i) => entry(`off${i}`, "vizio-smartcast", false, null)),
  ]);

  test("adds up to what Companion reported", () => {
    const h = summariseConnections(live);
    assert.deepEqual(
      { total: h.total, enabled: h.enabled, ok: h.ok, unknown: h.unknown, error: h.error, worst: h.worst },
      { total: 84, enabled: 52, ok: 30, unknown: 10, error: 12, worst: "error" },
    );
  });

  test("the row's sentence carries BOTH numbers", () => {
    assert.equal(
      connectionSentence(summariseConnections(live)),
      "12 of 52 connection(s) in error, 10 not reporting",
    );
  });

  // Worst first, commonest first, and the group of ONE is named. "1
  // vizio-smartcast" sends an operator to a list of twelve televisions;
  // "SA-HL-Stage-TV" sends them to the one that is actually down. Six bulbs stay
  // a module and a count, because six device names on an hourly line is the
  // noise the grouping exists to avoid.
  test("the log line, worst first, commonest first, naming a group of one", () => {
    assert.equal(
      connectionDetail(summariseConnections(live)),
      "12 of 52 connection(s) in error, 10 not reporting: " +
        "6 tplink-kasasmartbulb (Connecting), 5 red-rcp2 (Connecting), " +
        "SA-HL-Stage-TV (Connection Failure), 10 tplink-kasasmartplug (not reporting)",
    );
  });
});

describe("connectionSentence", () => {
  const of = (...cs: unknown[]) => connectionSentence(summariseConnections(parseConnections(cs)));

  test("a clean install says the count and nothing else", () => {
    assert.equal(of(entry("a", "m", true, good), entry("b", "m", true, good)), "2 connection(s) ok");
  });

  test("unknowns alone are `not reporting`, never `in error`", () => {
    assert.equal(of(entry("a", "m", true, good), entry("b", "m", true, null)), "1 of 2 connection(s) not reporting");
  });

  test("errors alone omit the second half rather than saying `0 not reporting`", () => {
    assert.equal(of(entry("a", "m", true, good), entry("b", "m", true, failure)), "1 of 2 connection(s) in error");
  });
});

describe("healthReport", () => {
  const okResult = (...cs: unknown[]) => ({
    ok: true as const,
    health: summariseConnections(parseConnections(cs)),
    cachedAt: 0,
  });

  // The hourly pass writes to the same /log page an operator reads on a Sunday
  // morning. "52 connection(s) ok" twenty-four times a day is what buries the
  // pass that found twelve in error.
  test("a clean read logs NOTHING, and still says so on the row", () => {
    const r = healthReport(okResult(entry("a", "generic-pjlink", true, good)));
    assert.equal(r.log, null);
    assert.equal(r.sentence, "1 connection(s) ok");
  });

  test("a read with errors logs the detail, modules and all", () => {
    const r = healthReport(
      okResult(entry("a", "generic-pjlink", true, good), entry("b", "red-rcp2", true, connecting)),
    );
    assert.equal(r.sentence, "1 of 2 connection(s) in error");
    assert.equal(r.log, "1 of 2 connection(s) in error: b-label (Connecting)");
  });

  // Not a fault, and not silence-worthy either: a connection that is not
  // reporting is why a switch bound to it reads unknown.
  test("unknowns alone are logged too", () => {
    const r = healthReport(okResult(entry("a", "tplink-kasasmartplug", true, null)));
    assert.equal(r.log, "1 of 1 connection(s) not reporting: a-label (not reporting)");
  });

  // A 4.x Companion never had the endpoint. "unavailable" on every one of them
  // is a red sentence about a diagnostic that was not coming.
  test("an unsupported build says nothing anywhere", () => {
    assert.deepEqual(healthReport({ ok: false, unsupported: true, reason: "old" }), {
      sentence: null,
      log: null,
    });
  });

  // The caller has ALREADY read the export off the same Companion, so this is a
  // new fact and not the box being off — and the export's own failure line does
  // not cover it.
  test("any other failure is said on the row AND in the log", () => {
    const r = healthReport({ ok: false, unsupported: false, reason: "Companion answered HTTP 500" });
    assert.equal(r.sentence, "connection status unavailable: Companion answered HTTP 500");
    assert.equal(r.log, r.sentence);
  });
});
