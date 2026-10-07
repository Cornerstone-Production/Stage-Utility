// A messaging.json that was edited by hand, or restored from a build with other
// limits. An entry that breaks a limit is left out of the live config and NAMED
// on /log; one that is fine beside it is kept. Its own file because the file has
// to exist before the module loads, which is the path such an entry arrives on.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messaging-file-"));
process.env.STAGE_UTILITY_DATA = DATA;

fs.writeFileSync(
  path.join(DATA, "messaging.json"),
  JSON.stringify({
    groups: [
      { id: "g-0a0a0a0a", name: "Green room" },
      { id: "g-0b0b0b0b", name: "green ROOM" },
      { id: "not-an-id", name: "Bo\noth" },
      { id: "g-0c0c0c0c", name: "Everyone" },
      { id: "g-0d0d0d0d", name: "Lobby" },
      { id: "g-0e0e0e0e", name: "x".repeat(41) },
      { id: "g-0f0f0f0f", name: "Stage" },
    ],
    quickMessages: ["Walk now", "", "y".repeat(281), 7],
    // quickReplies absent: the stock list is used.
  }),
);

const warned: string[] = [];
const realWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warned.push(args.map(String).join(" "));
};
const { messagingStore } = await import("./messaging-store.js");
await messagingStore.init();
console.warn = realWarn;

describe("reading a hand-edited file", () => {
  test("keeps the groups that satisfy the limits, and only those", () => {
    assert.deepEqual(messagingStore.get().groups, [
      { id: "g-0a0a0a0a", name: "Green room" },
      { id: "g-0d0d0d0d", name: "Lobby" },
      { id: "g-0f0f0f0f", name: "Stage" },
    ]);
  });

  test("keeps the quick messages that satisfy the limits", () => {
    assert.deepEqual(messagingStore.get().quickMessages, ["Walk now"]);
  });

  test("a list the file does not have falls back to the stock one", () => {
    assert.deepEqual(messagingStore.get().quickReplies, ["Copy", "Walking now", "Need 2 min"]);
  });

  test("says what it left out, on one line, with a newline in a name escaped", () => {
    const lines = warned.filter((l) => l.startsWith("[messages] messaging.json"));
    assert.equal(lines.length, 1, `expected one line, got ${JSON.stringify(warned)}`);
    assert.match(lines[0], /left out 7 entries/);
    assert.match(lines[0], /group green ROOM/);
    assert.ok(lines[0].includes("group Bo\\noth"), `the newline in a name was not escaped: ${lines[0]}`);
    assert.ok(!lines[0].includes("\n"), "a newline in a stored name forged a log line");
  });
});
