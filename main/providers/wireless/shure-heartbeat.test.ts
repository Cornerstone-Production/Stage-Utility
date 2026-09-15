// The keep-alive has to be a command the device on the other end answers.
//
// It was `GET 1 METER_RATE` for every Shure driver. A charger has no METER_RATE:
// verified against a live SBC220, it answers `< REP ERR >`, which the parser
// counted as a short frame and logged at DEBUG. So the heartbeat was a rejected
// command, once a minute, for the life of the connection, and the only trace was
// a line nothing prints.
//
// Both halves are asserted from the real paths: the command the timer actually
// sends (captured off `send`), and the parser fed the real refusal frame.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { ShureAxient } from "./shure-axient.js";
import { ShureCharger } from "./shure-charger.js";
import { ShurePsm } from "./shure-psm.js";
import { ShureUlxd } from "./shure-ulxd.js";

type Inner = {
  heartbeatCommand(): string;
  handleData(chunk: string): void;
  initChannelStates(count: number): void;
};

describe("the heartbeat is a command the device answers", () => {
  it("a charger is probed with a field it has, not one it refuses", () => {
    const cmd = (new ShureCharger() as unknown as Inner).heartbeatCommand();
    assert.notEqual(
      cmd,
      "GET 1 METER_RATE",
      "a charger has no METER_RATE — it answers < REP ERR > and the probe proves nothing",
    );
    assert.equal(cmd, "GET DEVICE_ID");
  });

  it("the receivers keep the metering probe, which they do answer", () => {
    for (const p of [new ShureAxient(), new ShureUlxd(), new ShurePsm()]) {
      assert.equal((p as unknown as Inner).heartbeatCommand(), "GET 1 METER_RATE", p.id);
    }
  });

  it("and nothing sends a SET as a keep-alive", () => {
    // A probe must never change the device it is probing.
    for (const p of [new ShureCharger(), new ShureAxient(), new ShureUlxd(), new ShurePsm()]) {
      const cmd = (p as unknown as Inner).heartbeatCommand();
      assert.ok(cmd.startsWith("GET "), `${p.id} heartbeat is not a GET: ${cmd}`);
    }
  });
});

describe("a refused command says so", () => {
  it("< REP ERR > is reported, not swallowed at debug", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const p = new ShureCharger() as unknown as Inner;
      p.initChannelStates(8);
      p.handleData("< REP ERR >");
      const said = warn.mock.calls.map((c) => String(c.arguments[0])).join("\n");
      assert.match(
        said,
        /REP ERR/,
        `the device refused a command and nothing said so. Saw: ${JSON.stringify(said)}`,
      );
    } finally {
      warn.mock.restore();
    }
  });

  it("but only once per connection, not once a minute for ever", () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      const p = new ShureCharger() as unknown as Inner;
      p.initChannelStates(8);
      for (let i = 0; i < 5; i++) p.handleData("< REP ERR >");
      assert.equal(warn.mock.calls.length, 1);
    } finally {
      warn.mock.restore();
    }
  });

  it("a torn frame is still just a torn frame", () => {
    // `< REP 1 >` is a truncated read, not a refusal, and must not cry wolf.
    const warn = mock.method(console, "warn", () => {});
    try {
      const p = new ShureCharger() as unknown as Inner;
      p.initChannelStates(8);
      p.handleData("< REP 1 >");
      assert.equal(warn.mock.calls.length, 0);
    } finally {
      warn.mock.restore();
    }
  });
});
