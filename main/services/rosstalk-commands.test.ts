// Wire-format tests for the RossTalk command catalogue.
//
// The protocol is SEND-ONLY: a malformed-but-plausible command produces no error
// from the device, it simply does nothing. These formatters are therefore the only
// thing standing between a typo and a silent no-op on a live switcher, so every
// command's exact bytes are pinned here.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  ROSSTALK_COMMANDS,
  commandsForFamily,
  formatCommand,
  sanitiseRaw,
} from "./rosstalk-commands.js";

describe("catalogue shape", () => {
  test("every command id matches its key and has at least one param or none by design", () => {
    for (const [key, cmd] of Object.entries(ROSSTALK_COMMANDS)) {
      assert.equal(cmd.id, key, `id/key mismatch for ${key}`);
      assert.ok(cmd.label.length > 0, `${key} needs a label`);
      assert.ok(cmd.family === "carbonite" || cmd.family === "ultrix", `${key} family`);
    }
  });

  test("commandsForFamily never leaks the other family", () => {
    for (const f of ["carbonite", "ultrix"] as const) {
      for (const c of commandsForFamily(f)) assert.equal(c.family, f);
    }
    assert.ok(commandsForFamily("carbonite").length > 0);
    assert.ok(commandsForFamily("ultrix").length > 0);
  });

  test("no formatter emits a line terminator itself", () => {
    // The transport appends exactly one CR/LF; a formatter that also emitted one
    // would send an empty second command.
    for (const [key, cmd] of Object.entries(ROSSTALK_COMMANDS)) {
      const values: Record<string, string | number> = {};
      for (const p of cmd.params) values[p.key] = p.type === "number" ? 1 : (p.options?.[0] ?? "x");
      const line = cmd.format(values);
      assert.ok(!/[\r\n]/.test(line), `${key} emitted a terminator: ${JSON.stringify(line)}`);
    }
  });
});

describe("Carbonite commands", () => {
  test("custom control zero-pads the cc number", () => {
    assert.equal(formatCommand("cc", { bank: 1, cc: 5 }), "CC 1:05");
    assert.equal(formatCommand("cc", { bank: 2, cc: 15 }), "CC 2:15");
  });

  test("GPI zero-pads to two digits", () => {
    assert.equal(formatCommand("gpi-carbonite", { gpi: 4 }), "GPI 04");
  });

  test("fade to black takes no parameters", () => {
    assert.equal(formatCommand("ftb", {}), "FTB");
  });

  test("ME cut and auto", () => {
    assert.equal(formatCommand("mecut", { meSource: "ME", meNumber: 1 }), "MECUT ME:1");
    assert.equal(formatCommand("meauto", { meSource: "ME", meNumber: 2 }), "MEAUTO ME:2");
  });

  test("key cut and auto, with the optional ON/OFF", () => {
    assert.equal(formatCommand("keycut", { meSource: "ME", meNumber: 1, keyer: 2 }), "KEYCUT ME:1:2");
    assert.equal(
      formatCommand("keycut", { meSource: "ME", meNumber: 1, keyer: 2, state: "ON" }),
      "KEYCUT ME:1:2:ON",
    );
  });

  test("memory recall and save", () => {
    assert.equal(formatCommand("mem", { bank: 1, memory: 3, meSource: "ME", meNumber: 1 }), "MEM 1:3:ME:1");
    assert.equal(formatCommand("memsave", { bank: 1, memory: 3, meSource: "ME", meNumber: 1 }), "MEMSAVE 1:3:ME:1");
  });

  test("transition rate and type", () => {
    assert.equal(formatCommand("transrate", { meSource: "ME", meNumber: 1, rate: 30 }), "TRANSRATE ME:1:30");
    assert.equal(formatCommand("transtype", { meSource: "ME", meNumber: 1, type: "DISS" }), "TRANSTYPE ME:1:DISS");
  });

  test("Carbonite crosspoint uses dest:source", () => {
    assert.equal(formatCommand("xpt-carbonite", { dest: 3, source: 7 }), "XPT 3:7");
  });

  test("clip load and sequencer", () => {
    assert.equal(formatCommand("clipload", { clip: "bumper" }), "CLIPLOAD bumper");
    assert.equal(formatCommand("seqi", { sequencer: 1, seq: 4 }), "SEQI 1:4");
  });
});

describe("Ultrix commands", () => {
  test("crosspoint uses the D/S/I/L form", () => {
    assert.equal(
      formatCommand("xpt-ultrix", { dest: 5, source: 16, userId: 7, levels: "1,6,10-13" }),
      "XPT D:5 S:16 I:7 L:1,6,10-13",
    );
  });

  test("optional levels are omitted cleanly, with no trailing space", () => {
    const line = formatCommand("xpt-ultrix", { dest: 5, source: 16, userId: 7 });
    assert.equal(line, "XPT D:5 S:16 I:7");
    assert.ok(!line.endsWith(" "), "a trailing space would be sent verbatim");
  });

  test("GPI fires a salvo", () => {
    assert.equal(formatCommand("gpi-ultrix", { salvo: 23 }), "GPI 23");
  });

  test("timer actions", () => {
    assert.equal(formatCommand("timer", { clock: 3, action: "RUN" }), "TIMER 3:RUN");
    assert.equal(formatCommand("timer", { clock: 4, action: "END" }), "TIMER 4:END");
  });
});

describe("the two families are not interchangeable", () => {
  test("XPT produces different syntax per family", () => {
    const c = formatCommand("xpt-carbonite", { dest: 5, source: 16 });
    const u = formatCommand("xpt-ultrix", { dest: 5, source: 16, userId: 7 });
    assert.notEqual(c, u);
    assert.equal(c, "XPT 5:16");
    assert.match(u, /^XPT D:/);
  });

  test("GPI exists in both but as distinct entries with distinct labels", () => {
    // Same wire syntax, different MEANING: a GPI output vs a salvo. An operator
    // must never be offered "fire salvo" for a switcher.
    assert.equal(ROSSTALK_COMMANDS["gpi-carbonite"].family, "carbonite");
    assert.equal(ROSSTALK_COMMANDS["gpi-ultrix"].family, "ultrix");
    assert.notEqual(ROSSTALK_COMMANDS["gpi-carbonite"].label, ROSSTALK_COMMANDS["gpi-ultrix"].label);
  });
});

describe("validation", () => {
  test("an unknown command id throws", () => {
    assert.throws(() => formatCommand("nope", {}), /unknown command/i);
  });

  test("a missing required param throws", () => {
    assert.throws(() => formatCommand("cc", { bank: 1 }), /cc/i);
  });

  test("a number outside its range throws", () => {
    assert.throws(() => formatCommand("gpi-carbonite", { gpi: 999 }), /range/i);
    assert.throws(() => formatCommand("cc", { bank: 0, cc: 1 }), /range/i);
  });

  test("a non-numeric value for a number param throws", () => {
    assert.throws(() => formatCommand("cc", { bank: "abc", cc: 1 }), /number/i);
  });

  test("an enum value outside its options throws", () => {
    assert.throws(() => formatCommand("timer", { clock: 1, action: "SPIN" }), /one of/i);
  });
});

describe("sanitiseRaw", () => {
  test("strips line terminators so one entry is one command", () => {
    assert.equal(sanitiseRaw("FTB\r\nMECUT ME:1"), "FTBMECUT ME:1");
    assert.equal(sanitiseRaw("FTB\n"), "FTB");
  });

  test("trims surrounding whitespace", () => {
    assert.equal(sanitiseRaw("  FTB  "), "FTB");
  });

  test("rejects an empty or terminator-only string", () => {
    for (const bad of ["", "   ", "\r\n", "\n\n"]) {
      assert.throws(() => sanitiseRaw(bad), /empty/i);
    }
  });
});
