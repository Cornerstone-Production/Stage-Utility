// A messaging.json whose fields are the wrong SHAPE (not a list) is named on /log
// like an entry that breaks a rule, instead of being dropped without a word. A
// field that is simply absent is what a file written before the field existed
// holds, and is not named. Its own file because the file has to exist before the
// module loads.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messaging-shape-"));
process.env.STAGE_UTILITY_DATA = DATA;

fs.writeFileSync(
  path.join(DATA, "messaging.json"),
  // quickReplies is absent on purpose.
  JSON.stringify({ version: 3, groups: "Green room", quickMessages: { 0: "Walk now" } }),
);

const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warned.push(args.map(String).join(" "));
};
const { messagingStore } = await import("./messaging-store.js");
await messagingStore.init();
console.warn = realWarn;

test("a field that is not a list is named, one that is absent is not, and the read is not clean", () => {
  const lines = warned.filter((l) => l.startsWith("[messages] messaging.json"));
  assert.equal(lines.length, 1, JSON.stringify(warned));
  assert.match(lines[0], /left out 2 entries/);
  assert.match(lines[0], /groups: not a list/);
  assert.match(lines[0], /quickMessages: not a list/);
  assert.doesNotMatch(lines[0], /quickReplies/);
  assert.equal(messagingStore.readCleanly(), false);
  assert.deepEqual(messagingStore.get().groups, []);
});
