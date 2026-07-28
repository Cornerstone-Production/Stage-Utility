// Tests for the hand-rolled OSC 1.0 codec.
//
// This is binary wire format with 4-byte padding rules — the classic place for an
// off-by-one that only shows up against one specific console. Encoding is checked
// against byte layout, and decode(encode(x)) === x is asserted across the argument
// types the app actually sends.

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import type { OscArg } from "../types/osc.js";
import { encodeMessage, decodePacket } from "./osc-codec.js";

const roundTrip = (address: string, args: OscArg[] = []) => decodePacket(encodeMessage(address, args));

describe("encodeMessage", () => {
  test("every encoded message is a multiple of 4 bytes", () => {
    // OSC requires 4-byte alignment throughout; addresses of each length mod 4
    // exercise all padding branches.
    for (const address of ["/a", "/ab", "/abc", "/abcd", "/abcde", "/ch/01/mix/on"]) {
      const buf = encodeMessage(address, [{ type: "i", value: 1 }]);
      assert.equal(buf.length % 4, 0, `${address} produced ${buf.length} bytes`);
    }
  });

  test("a NUL terminator is always present after the address", () => {
    // "/abcd" is exactly 4 chars + slash = 5; padding must still leave a terminator.
    const buf = encodeMessage("/abcd");
    assert.equal(buf.subarray(0, 5).toString("ascii"), "/abcd");
    assert.equal(buf[5], 0, "an address filling the boundary still needs a NUL");
  });

  test("a message with no arguments still carries a type-tag string", () => {
    const buf = encodeMessage("/go");
    assert.ok(buf.includes(Buffer.from(",")), "the ',' type-tag string is mandatory in OSC 1.0");
    assert.equal(buf.length % 4, 0);
  });

  test("int32 arguments are big-endian", () => {
    const buf = encodeMessage("/x", [{ type: "i", value: 1 }]);
    assert.deepEqual([...buf.subarray(buf.length - 4)], [0, 0, 0, 1]);
  });

  test("booleans are encoded as type tags with no payload bytes", () => {
    // T/F carry their value in the tag itself — adding payload bytes is a classic bug.
    const withBools = encodeMessage("/x", [{ type: "T" }, { type: "F" }]);
    const noArgs = encodeMessage("/x");
    assert.equal(withBools.length, noArgs.length, "T/F must not add argument data");
  });
});

describe("round trip", () => {
  test("address with no arguments", () => {
    assert.deepEqual(roundTrip("/ch/01/mix/on"), [{ address: "/ch/01/mix/on", args: [] }]);
  });

  test("integers, including negatives and zero", () => {
    for (const value of [0, 1, -1, 127, -128, 2147483647, -2147483648]) {
      const [msg] = roundTrip("/i", [{ type: "i", value }]);
      assert.deepEqual(msg.args, [value], `int32 ${value} did not survive the round trip`);
    }
  });

  test("floats survive within float32 precision", () => {
    for (const value of [0, 1, -1, 0.5, -0.25]) {
      const [msg] = roundTrip("/f", [{ type: "f", value }]);
      assert.equal(msg.args[0], value);
    }
    const [approx] = roundTrip("/f", [{ type: "f", value: 0.1 }]);
    assert.ok(Math.abs(Number(approx.args[0]) - 0.1) < 1e-6, "0.1 should round trip within float32 error");
  });

  test("strings of every length mod 4", () => {
    for (const value of ["", "a", "ab", "abc", "abcd", "abcde", "hello world"]) {
      const [msg] = roundTrip("/s", [{ type: "s", value }]);
      assert.deepEqual(msg.args, [value], `string "${value}" did not survive the round trip`);
    }
  });

  test("booleans", () => {
    const [msg] = roundTrip("/b", [{ type: "T" }, { type: "F" }]);
    assert.deepEqual(msg.args, [true, false]);
  });

  test("mixed argument types in order", () => {
    const [msg] = roundTrip("/mix", [
      { type: "i", value: 3 },
      { type: "s", value: "on" },
      { type: "f", value: 0.5 },
      { type: "T" },
    ]);
    assert.deepEqual(msg.args, [3, "on", 0.5, true]);
  });

  test("a UTF-8 address and string argument survive", () => {
    const [msg] = roundTrip("/café", [{ type: "s", value: "naïve" }]);
    assert.equal(msg.address, "/café");
    assert.deepEqual(msg.args, ["naïve"]);
  });
});

describe("decodePacket", () => {
  test("malformed input returns no messages instead of throwing", () => {
    for (const buf of [Buffer.alloc(0), Buffer.from([1, 2, 3]), Buffer.from("garbage")]) {
      assert.deepEqual(decodePacket(buf), [], "a bad UDP datagram must not crash the OSC listener");
    }
  });

  test("a truncated but well-formed prefix does not throw", () => {
    const full = encodeMessage("/ch/01/mix/on", [{ type: "f", value: 0.5 }]);
    assert.doesNotThrow(() => decodePacket(full.subarray(0, full.length - 2)));
  });

  test("a bundle unpacks into its component messages", () => {
    const a = encodeMessage("/one", [{ type: "i", value: 1 }]);
    const b = encodeMessage("/two", [{ type: "i", value: 2 }]);

    const size = (buf: Buffer) => {
      const s = Buffer.alloc(4);
      s.writeInt32BE(buf.length, 0);
      return s;
    };
    const bundle = Buffer.concat([
      Buffer.from("#bundle\0", "ascii"),
      Buffer.alloc(8), // timetag
      size(a), a,
      size(b), b,
    ]);

    assert.deepEqual(decodePacket(bundle), [
      { address: "/one", args: [1] },
      { address: "/two", args: [2] },
    ]);
  });

  test("a bundle with a bogus element size stops cleanly", () => {
    const bogusSize = Buffer.alloc(4);
    bogusSize.writeInt32BE(9999, 0);
    const bundle = Buffer.concat([Buffer.from("#bundle\0", "ascii"), Buffer.alloc(8), bogusSize]);
    assert.deepEqual(decodePacket(bundle), []);
  });
});
