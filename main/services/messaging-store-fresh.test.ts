// What a install that has never opened Settings -> Messages holds: no groups,
// and the stock quick lists. Its own file because the answer is the state of a
// data directory nothing has written to, and the module's state is per process.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messaging-fresh-"));
process.env.STAGE_UTILITY_DATA = DATA;

const { messagingStore } = await import("./messaging-store.js");
const { DEFAULT_QUICK_MESSAGES, DEFAULT_QUICK_REPLIES } = await import("../types/messages.js");

test("a fresh install has no groups and the stock quick lists", async () => {
  await messagingStore.init();
  assert.deepEqual(messagingStore.get(), {
    groups: [],
    quickMessages: [...DEFAULT_QUICK_MESSAGES],
    quickReplies: [...DEFAULT_QUICK_REPLIES],
  });
  assert.deepEqual(
    [...DEFAULT_QUICK_MESSAGES],
    ["Walk now", "You're on after this song", "2 minutes", "Wrap it up", "Band back on stage", "Running 5 min late"],
  );
  assert.deepEqual([...DEFAULT_QUICK_REPLIES], ["Copy", "Walking now", "Need 2 min"]);
});

test("reading it writes nothing: the file appears with the first save, not before", async () => {
  await messagingStore.init();
  assert.equal(fs.existsSync(path.join(DATA, "messaging.json")), false);
});
