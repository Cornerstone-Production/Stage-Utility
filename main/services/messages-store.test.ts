// What messages-store.ts keeps of a messages.json it reads: the file is a hand
// edit or the leftovers of another build, and what it yields goes to every
// screen, so each rule is asserted with an entry that breaks THAT rule and no
// other. An entry that is also malformed some other way proves nothing about the
// rule it is meant to pin: a bad id on a message with no `to` is dropped for the
// `to`, and the id check could be deleted without a test noticing.
//
// Its own file because the file has to exist before the module loads.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messages-store-"));
process.env.STAGE_UTILITY_DATA = DATA;

const hex = (n: number) => n.toString(16).padStart(16, "0");
const GROUP = "g-0a0a0a0a";

const message = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  at: 1000,
  to: ["everyone"],
  text: "hello",
  alert: false,
  alertUntil: null,
  clearedAt: null,
  from: "Operator",
  replies: [],
  ...over,
});
const reply = (id: string, over: Record<string, unknown> = {}) => ({ id, at: 2000, from: "Stage", text: "Copy", ...over });

const FIXTURE = [
  message(hex(1)), // fine
  message("not-a-hex-id"), // only the id is wrong
  // Sixteen digits, but a number: a regex coerces it to text and matches, so only
  // the check that it IS text refuses it.
  message(1234567890123456 as unknown as string),
  message(hex(2), { to: [GROUP, "everyone"] }), // fine: a group and Everyone
  message(hex(3), { to: [] }), // only `to`: empty
  message(hex(4), { to: ["g-xyz"] }), // only `to`: not a group id
  // Only `to`: an entry that is not text but reads as a group id once coerced.
  message(hex(5), { to: [[GROUP]] }),
  message(hex(6), { text: 5 }), // only the text
  message(hex(7), { from: null }), // only the sender
  message(hex(8), { at: "noon" }), // only the time
  message(hex(9), { alert: false, alertUntil: 123456 }), // not an alert, but carries an end: kept, end dropped
  message(hex(10), { alert: true, alertUntil: 123456 }), // an alert: its end is kept
  message(hex(11), { alert: true, alertUntil: "soon" }), // an alert whose end is junk: null
  message(hex(12), { alert: "yes" }), // only truthy, not `true`: not an alert
  message(hex(13), { clearedAt: 5 }),
  message(hex(14), { clearedAt: "5" }), // junk: null
  message(hex(15), {
    replies: [
      reply(hex(101)), // fine
      reply("zz"), // only the id
      reply(hex(102), { id: 1234567890123456 }), // only the id again: digits, but a number
      reply(hex(103), { at: "late" }), // only the time
      reply(hex(104), { from: 1 }), // only the sender
      reply(hex(105), { text: null }), // only the text
      null,
    ],
  }),
  message(hex(16), { replies: "none" }), // not a list: no replies
];

fs.writeFileSync(path.join(DATA, "messages.json"), JSON.stringify({ lastClearedDate: "2026-10-07", messages: FIXTURE }));

const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warned.push(args.map(String).join(" "));
};
const { messagesStore } = await import("./messages-store.js");
const file = await messagesStore.load();
console.warn = realWarn;

const byId = new Map(file.messages.map((m) => [m.id, m]));

describe("reading a messages.json", () => {
  test("keeps the messages that satisfy every rule, in file order, and only those", () => {
    assert.deepEqual(
      file.messages.map((m) => m.id),
      [1, 2, 9, 10, 11, 12, 13, 14, 15, 16].map(hex),
    );
  });

  test("a message whose id is not sixteen hex digits, or is not text, is dropped, though nothing else is wrong with it", () => {
    assert.equal(byId.has("not-a-hex-id"), false);
    assert.equal(file.messages.some((m) => typeof m.id !== "string"), false, "a numeric id was served to every screen");
  });

  test("a to that is empty, holds a non-group id, or holds an entry that is not text drops the message", () => {
    for (const n of [3, 4, 5]) assert.equal(byId.has(hex(n)), false, `message ${n} was kept`);
    assert.deepEqual(byId.get(hex(2))?.to, [GROUP, "everyone"]);
  });

  test("a text, sender or time of the wrong type drops the message", () => {
    for (const n of [6, 7, 8]) assert.equal(byId.has(hex(n)), false, `message ${n} was kept`);
  });

  test("only an alert keeps its alertUntil: a message that is not one carries none", () => {
    assert.equal(byId.get(hex(9))?.alert, false);
    assert.equal(byId.get(hex(9))?.alertUntil, null, "a message that is not an alert kept an end time");
    assert.equal(byId.get(hex(10))?.alertUntil, 123456);
    assert.equal(byId.get(hex(11))?.alertUntil, null, "an end time that is not a number was kept");
  });

  test("alert is true only for true", () => {
    assert.equal(byId.get(hex(12))?.alert, false);
  });

  test("clearedAt is a number or null", () => {
    assert.equal(byId.get(hex(13))?.clearedAt, 5);
    assert.equal(byId.get(hex(14))?.clearedAt, null);
  });

  test("a reply keeps only if its id is hex and its time, sender and text are the right type", () => {
    assert.deepEqual(byId.get(hex(15))?.replies.map((r) => r.id), [hex(101)]);
    assert.deepEqual(byId.get(hex(15))?.replies[0], { id: hex(101), at: 2000, from: "Stage", text: "Copy" });
  });

  test("replies that are not a list read as none", () => {
    assert.deepEqual(byId.get(hex(16))?.replies, []);
  });

  test("says once how many messages it left out", () => {
    const lines = warned.filter((l) => l.startsWith("[messages] messages.json"));
    assert.deepEqual(lines, ["[messages] messages.json: left out 8 message(s) that could not be read"]);
  });

  test("keeps the date the thread was last cleared", () => {
    assert.equal(file.lastClearedDate, "2026-10-07");
  });
});
