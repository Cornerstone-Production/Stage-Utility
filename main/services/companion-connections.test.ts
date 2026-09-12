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
    assert.deepEqual(h.problems, [{ moduleId: "obs-studio", level: "Slow", count: 1 }]);
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
    assert.deepEqual(h.problems, [
      { moduleId: "red-rcp2", level: "Connecting", count: 2 },
      { moduleId: "red-rcp2", level: "Connection Failure", count: 1 },
    ]);
  });

  test("errors sort ahead of unknowns however many of each there are", () => {
    const h = summariseConnections(
      parseConnections([
        ...Array.from({ length: 9 }, (_, i) => entry(`p${i}`, "tplink-kasasmartplug", true, null)),
        entry("t", "vizio-smartcast", true, failure),
      ]),
    );
    assert.deepEqual(h.problems, [
      { moduleId: "vizio-smartcast", level: "Connection Failure", count: 1 },
      { moduleId: "tplink-kasasmartplug", level: "", count: 9 },
    ]);
  });
});

describe("the live install", () => {
  /** 84 connections: 30 good, 12 error, 10 enabled with no status, 32 disabled. */
  const live = parseConnections([
    ...Array.from({ length: 30 }, (_, i) => entry(`ok${i}`, "generic-pjlink", true, good)),
    ...Array.from({ length: 6 }, (_, i) => entry(`bulb${i}`, "tplink-kasasmartbulb", true, connecting)),
    ...Array.from({ length: 5 }, (_, i) => entry(`cam${i}`, "red-rcp2", true, connecting)),
    entry("tv", "vizio-smartcast", true, failure),
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

  test("the log line names the modules, worst first, commonest first", () => {
    assert.equal(
      connectionDetail(summariseConnections(live)),
      "12 of 52 connection(s) in error, 10 not reporting: " +
        "6 tplink-kasasmartbulb (Connecting), 5 red-rcp2 (Connecting), " +
        "1 vizio-smartcast (Connection Failure), 10 tplink-kasasmartplug",
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
