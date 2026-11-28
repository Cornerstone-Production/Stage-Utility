// Two patch saves whose followers overlap. A save whose follower fails remembers the patch it
// replaced, so the next save hands it to the followers again (a stage plot point still gets the
// name of a device that save removed). That memory was one field, read before the followers
// ran and written after: a save that started before another's failure, and succeeded after
// it, wrote "nothing owed" over the failure, and the removed device's name was never stamped.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "patch-overlap-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { patchStore, PatchLinksNotUpdated } = await import("./patch-store.js");
type PatchFile = import("../types/patch.js").PatchFile;

const quiet = console.error;
console.error = () => undefined;
after(async () => {
  console.error = quiet;
  await fs.rm(TMP, { recursive: true, force: true });
});

const file = (name: string): PatchFile => ({
  updatedAt: "",
  sheets: [{ id: "main", name, kind: "analog", devices: [], endpoints: [], variants: [], assignments: { byServiceType: {}, byPlan: {} } }],
});
const names = (files: readonly PatchFile[]) => files.map((f) => f.sheets[0]?.name);

/** A follower held until the test lets it finish, failing or not. */
type Held = { befores: readonly PatchFile[]; finish: (fail: boolean) => void };
const queue: ((h: Held) => void)[] = [];
const next = () => new Promise<Held>((resolve) => queue.push(resolve));
let holding = false;
patchStore.onSaved(async (befores) => {
  if (!holding) return;
  await new Promise<void>((resolve, reject) => {
    queue.shift()!({ befores, finish: (fail) => (fail ? reject(new Error("stageplots.json is damaged")) : resolve()) });
  });
});

test("a save that fails while another is following keeps its failure when the other succeeds", { timeout: 10_000 }, async () => {
  await patchStore.save(file("first"));
  holding = true;

  const heldA = next();
  const a = patchStore.save(file("A"));
  const ha = await heldA;
  const heldB = next();
  const b = patchStore.save(file("B"));
  const hb = await heldB;

  // A's follower fails first; B's, started before that failure, then succeeds.
  ha.finish(true);
  await assert.rejects(a, PatchLinksNotUpdated);
  hb.finish(false);
  await b;

  const heldC = next();
  const c = patchStore.save(file("C"));
  const hc = await heldC;
  hc.finish(false);
  await c;
  holding = false;

  assert.deepEqual(
    names(hc.befores),
    ["first", "B"],
    "the next save was not handed the patch the failed save replaced, so the devices it removed are never stamped",
  );
});
