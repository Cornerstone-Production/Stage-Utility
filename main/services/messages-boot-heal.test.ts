// What start() does about a group id a screen holds that messaging.json does not
// mention, depending on how messaging.json READ.
//
// Healed when the file read cleanly: the operator's own config says the group is
// gone. Left alone, and said so on /log, when it did not: a truncated file, a
// file that is not an object, or no file at all reads as an empty config, and
// stripping against it deletes every screen's membership, which restoring the
// file afterwards does not bring back. A save of the groups is the operator's
// deliberate act and strips regardless; that is covered in messages-service.test.ts.
//
// Every id and name below is INVENTED. This is a public repository.

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "messages-boot-heal-"));
process.env.STAGE_UTILITY_DATA = DATA;
process.env.HOME = path.join(DATA, "home");

const { MessagesService } = await import("./messages-service.js");
const { messagingStore } = await import("./messaging-store.js");
const { stageController } = await import("./stage-controller.js");

const FILE = path.join(DATA, "messaging.json");
const GREEN = "g-0a0a0a0a";
const STAGE = "g-0b0b0b0b";
const GONE = "g-deadbeef";

type Ctl = { state: { outputs: Output[]; [k: string]: unknown }; broadcast: () => void };
const ctl = stageController as unknown as Ctl;
ctl.broadcast = () => {};

const lines: string[] = [];
const real = { log: console.log, warn: console.warn, error: console.error };
const services: InstanceType<typeof MessagesService>[] = [];

beforeEach(() => {
  lines.length = 0;
  const grab = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.log = grab;
  console.warn = grab;
  console.error = grab;
});
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
  Object.assign(console, real);
  for (const f of fs.readdirSync(DATA).filter((n) => n.startsWith("messaging.json"))) fs.rmSync(path.join(DATA, f), { force: true });
});

const logged = (prefix: string) => lines.filter((l) => l.startsWith(prefix));
const held = () => ctl.state.outputs.map((o) => [o.id, o.groups]);

/** Screens that hold `groups`, then messaging.json as `content` (null: no file), read fresh, then start(). */
async function bootWith(content: string | null, groups: string[][]) {
  ctl.state = {
    ...ctl.state,
    outputs: groups.map((g, i) => ({ id: `screen-${i}`, name: `Screen ${i}`, viewId: null, ...(g.length > 0 ? { groups: g } : {}) })) as Output[],
  };
  if (content !== null) fs.writeFileSync(FILE, content);
  await messagingStore.reload();
  const svc = new MessagesService();
  services.push(svc);
  const failures = await svc.start();
  assert.deepEqual(failures, [], "start() failed");
  return svc;
}

const config = (groups: { id: string; name: string }[]) =>
  JSON.stringify({ version: 2, groups, quickMessages: ["Walk now"], quickReplies: ["Copy"] });

describe("start() when messaging.json did not read cleanly leaves every screen's groups alone, and says so", () => {
  const skip = "[messages] taking unknown groups off the screens was skipped at start-up";
  // The last is what the skip line says: how many groups the screens hold that the
  // file, as read, does not have (both, except where the file still names Green room).
  const cases: [string, string | null, string][] = [
    ["a truncated file", '{"version":2,"groups":[{"id":"g-0a0a0a0a","na', "2 groups on the screens were left alone"],
    ["a file that is not an object", "[]", "2 groups on the screens were left alone"],
    ["a file whose groups is not a list", '{"version":2,"groups":"Green room","quickMessages":[],"quickReplies":[]}', "2 groups on the screens were left alone"],
    ["a file with no groups at all", '{"version":2,"quickMessages":[],"quickReplies":[]}', "2 groups on the screens were left alone"],
    ["a file that lost an entry", config([{ id: GREEN, name: "Green room" }, { id: "not-an-id", name: "Broken" }]), "1 group on the screens was left alone"],
    ["no file", null, "2 groups on the screens were left alone"],
  ];
  for (const [what, content, said] of cases) {
    test(what, async () => {
      await bootWith(content, [[GREEN], [GREEN, STAGE], []]);
      assert.deepEqual(held(), [["screen-0", [GREEN]], ["screen-1", [GREEN, STAGE]], ["screen-2", undefined]], "a screen lost its groups");
      assert.equal(logged(skip).length, 1, `expected one skip line, got ${JSON.stringify(lines)}`);
      assert.ok(logged(skip)[0].includes(said), `expected ${said} in ${logged(skip)[0]}`);
      assert.deepEqual(logged("[messages] group"), [], "something was taken off a screen");
    });
  }

  test("a clean read earlier in the process does not carry over to the file read next", async () => {
    await bootWith(config([{ id: GREEN, name: "Green room" }]), [[GREEN]]);
    lines.length = 0;
    await bootWith('{"version":3,"groups":[{"id":"g-0a0a0a0a","na', [[GREEN]]);
    assert.deepEqual(held(), [["screen-0", [GREEN]]]);
    assert.equal(logged(skip).length, 1);
  });

  test("with nothing on any screen there is nothing to protect, so nothing is said", async () => {
    await bootWith(null, [[], []]);
    assert.deepEqual(logged(skip), []);
    await bootWith('{"nope', [[]]);
    assert.deepEqual(logged(skip), []);
  });
});

describe("start() when messaging.json read cleanly", () => {
  test("takes off the screens a group the file does not have, and names it", async () => {
    await bootWith(config([{ id: GREEN, name: "Green room" }]), [[GREEN, GONE], [GONE], [GREEN]]);
    assert.deepEqual(held(), [["screen-0", [GREEN]], ["screen-1", []], ["screen-2", [GREEN]]]);
    assert.deepEqual(logged("[messages] group"), [`[messages] group ${GONE} is not in the config; taken off 2 screens`]);
    assert.deepEqual(logged("[messages] taking unknown"), []);
  });

  test("a file whose groups list is empty, written by a save, is a clean read: those groups really are gone", async () => {
    await bootWith(config([]), [[GREEN]]);
    assert.deepEqual(held(), [["screen-0", []]]);
  });
});
