// servicecue:lists, driven through every path that writes the ServiceCue layouts or the
// category roles, against the real controller and stores in a temp data directory.
//
// What is under test: an open ServiceCue screen hears about EVERY save, whichever path made
// it, and re-reads on it instead of waiting for its timer. The frame comes from each
// store's after-save hook, so the guard is the exact list below of the paths that were
// heard: a write path that bypassed the stores would drop out of it.
//
// Every id and name is invented.

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-servicecue-lists-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { serviceCueRoutes } = await import("./servicecue-routes.js");
const { callRoute } = await import("./route-harness.js");
const { serviceCueLayoutsStore } = await import("../servicecue-layouts-store.js");
const { serviceCueRolesStore } = await import("../servicecue-roles-store.js");
const { serviceCueListsState } = await import("../servicecue-lists-changed.js");
const { addBroadcastListener, setSubscriberCheck } = await import("../broadcaster.js");
const { writeHelloBurst } = await import("../remote-server.js");
const { SERVICECUE_LISTS_CHANNEL } = await import("../../types/servicecue-lists.js");
import type { ServiceCueListsChanged } from "../../types/servicecue-lists.js";
import type { ServiceCueLayout } from "../../types/stage.js";

const frames: ServiceCueListsChanged[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === SERVICECUE_LISTS_CHANNEL) frames.push(payload as ServiceCueListsChanged);
});

const layout = (id: string, name: string): ServiceCueLayout =>
  ({ id, name, order: 0, columnRoles: [], columns: [] }) as unknown as ServiceCueLayout;

async function call(p: string, body: unknown) {
  const r = await callRoute(serviceCueRoutes, p, { method: "POST", body });
  assert.ok(r.status !== null && r.status < 300, `POST ${p} answered ${r.status}: ${r.body}`);
  return r;
}

after(() => {
  setSubscriberCheck(() => true);
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});
before(() => setSubscriberCheck(() => true));

/** Every path that saves either list. */
const PATHS: { name: string; run: () => Promise<unknown> }[] = [
  { name: "POST /api/servicecue/layouts", run: () => call("/api/servicecue/layouts", { layouts: [layout("svl-a", "Audio")] }) },
  { name: "POST /api/servicecue/roles", run: () => call("/api/servicecue/roles", { roles: [{ id: "r1", name: "Sound", members: ["Audio"] }] }) },
  { name: "a layout import (views/import)", run: () => serviceCueLayoutsStore.importLayouts([layout("svl-imported", "Imported")]) },
  { name: "the role seed (roles/seed, saved through the roles store)", run: () => serviceCueRolesStore.save([{ id: "role-seeded", name: "Seeded", members: ["Seeded"] }]) },
];

describe("servicecue:lists", () => {
  it("is heard from every path that saves the layouts or the roles", async () => {
    const heard: string[] = [];
    for (const p of PATHS) {
      frames.length = 0;
      await p.run();
      if (frames.length > 0) heard.push(p.name);
    }
    assert.deepEqual(heard, [
      "POST /api/servicecue/layouts",
      "POST /api/servicecue/roles",
      "a layout import (views/import)",
      "the role seed (roles/seed, saved through the roles store)",
    ]);
  });

  it("numbers every write, one after the last, and the connect burst re-sends the last", async () => {
    frames.length = 0;
    await call("/api/servicecue/roles", { roles: [{ id: "r1", name: "One", members: [] }] });
    await call("/api/servicecue/roles", { roles: [{ id: "r1", name: "Two", members: [] }] });
    assert.equal(frames.length, 2);
    assert.equal(frames[1]!.seq, frames[0]!.seq + 1);
    assert.equal(frames[1]!.epoch, frames[0]!.epoch);
    const sink = { collected: [] as { channel: string; serialized: string }[] };
    writeHelloBurst(sink);
    const burst = sink.collected.find((f) => f.channel === SERVICECUE_LISTS_CHANNEL);
    assert.ok(burst, `the burst did not hydrate ${SERVICECUE_LISTS_CHANNEL}: ${sink.collected.map((f) => f.channel).join(", ")}`);
    assert.deepEqual(JSON.parse(burst.serialized), frames[1]);
  });

  it("carries no layout or role contents", async () => {
    frames.length = 0;
    await call("/api/servicecue/layouts", { layouts: [layout("svl-p", "Private Department Name")] });
    assert.equal(JSON.stringify(frames).includes("Private Department Name"), false);
    assert.deepEqual(Object.keys(frames[0]!).sort(), ["epoch", "seq"]);
  });

  it("still counts a save nobody is listening for, and sends no frame", async () => {
    setSubscriberCheck(() => false);
    try {
      const before = serviceCueListsState().seq;
      frames.length = 0;
      await call("/api/servicecue/roles", { roles: [{ id: "r1", name: "Quiet", members: [] }] });
      assert.deepEqual(frames, []);
      assert.equal(serviceCueListsState().seq, before + 1);
    } finally {
      setSubscriberCheck(() => true);
    }
  });
});
