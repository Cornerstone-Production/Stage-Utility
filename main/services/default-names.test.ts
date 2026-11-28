// Default names for a new OSC target, RossTalk target and wireless connection: add
// three, delete the second, add one more, and the new one must not repeat a name that
// is still there. They used to count the list, so the fourth was "… 3" again.
//
// Drives the real managers over an empty data dir; nothing is enabled, so nothing
// dials out.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-default-names-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { oscManager } = await import("./osc-manager.js");
const { rosstalkManager } = await import("./rosstalk-manager.js");
const { wirelessManager } = await import("./wireless-manager.js");

after(async () => {
  rosstalkManager.stopAll();
  oscManager.stop();
  await fs.rm(TMP, { recursive: true, force: true });
});

type Named = { id: string; name: string };

async function check(
  label: string,
  list: () => Named[],
  add: () => Promise<unknown>,
  remove: (id: string) => Promise<unknown>,
  first: string,
) {
  await add();
  await add();
  await add();
  assert.deepEqual(list().map((t) => t.name), [`${first} 1`, `${first} 2`, `${first} 3`], label);
  await remove(list()[1].id);
  await add();
  const names = list().map((t) => t.name);
  assert.equal(new Set(names).size, names.length, `${label}: a default name repeated in ${JSON.stringify(names)}`);
}

test("OSC targets never repeat a default name after a delete", async () => {
  await check("osc", () => oscManager.listTargets(), () => oscManager.addTarget({}), (id) => oscManager.removeTarget({ id }), "OSC target");
});

test("RossTalk targets never repeat a default name after a delete", async () => {
  await check("rosstalk", () => rosstalkManager.listTargets(), () => rosstalkManager.addTarget({}), (id) => rosstalkManager.removeTarget({ id }), "RossTalk target");
});

test("wireless connections never repeat a default name after a delete", async () => {
  await check("wireless", () => wirelessManager.listConnections(), () => wirelessManager.addConnection({}), (id) => wirelessManager.removeConnection({ id }), "Connection");
});
