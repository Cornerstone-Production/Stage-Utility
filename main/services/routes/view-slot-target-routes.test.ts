// The slot-target routes, driven through the real handler.
//
// These are LAN-facing and two of them DELETE or overwrite an operator's board,
// so what matters is not only that the happy path works but that a malformed
// target is refused rather than guessed at — a `target` the server half-
// understood would rewrite a service type's standing board with one week's swap.
//
// The route modules are the least-covered code in the project. callRoute hands
// the handler fakes and reads back exactly what a client would have received.

import assert from "node:assert/strict";
import { describe, it, before, beforeEach, after } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-slot-routes-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { viewRoutes } = await import("./view-routes.js");
const { presetRoutes } = await import("./preset-routes.js");
const { callRoute } = await import("./route-harness.js");
const { stageController } = await import("../stage-controller.js");
const { slotsStore } = await import("../slots-store.js");

const VIEW = "v-route";
const OBJECT = "obj-route";
const TYPE = "st-route";
const PLAN = "plan-route";

type Mutable = {
  state: Record<string, unknown>;
  broadcast: () => void;
  currentPlanSortDate: string | null;
  loadAllViewRawSlots: (serviceTypeId: string | null, planId: string | null) => Promise<void>;
};
const ctl = stageController as unknown as Mutable;

function slot(id: string, channel = "01"): Slot {
  return {
    id,
    channel,
    order: 0,
    link: { kind: "pco", matchBy: "position", positions: [{ name: "Vocals" }] },
    deviceBinding: null,
    displayName: null,
    photoUrl: null,
    device: { status: "none", rf: null, battery: null, freq: null, audioLevel: null, charge: null, iemCharge: null, label: null, iemLabel: null },
  } as unknown as Slot;
}

/**
 * A custom view carrying ONE inline slots-grid, so OBJECT is an object id the
 * controller can actually find.
 *
 * The routes 404 an id that names nothing, and an inline board only exists
 * because some layout draws it — a fixture that skipped the layout was asserting
 * against a key no operator could ever have created.
 */
const HOST_VIEW = {
  id: "v-host",
  name: "Wall",
  kind: "custom",
  ndiSource: null,
  createdAt: "",
  surface: "display",
  layout: {
    version: 1,
    canvas: { width: 1920, height: 1080, background: null },
    objects: [
      {
        id: OBJECT,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        z: 1,
        config: { type: "slots-grid", source: "inline", sourceViewId: null },
      },
    ],
  },
} as unknown as View;

before(() => {
  ctl.broadcast = () => {};
});

after(() => {
  fs.rm(TMP, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  ctl.state = {
    ...ctl.state,
    serviceTypeId: TYPE,
    serviceTypeName: "Sunday",
    planId: PLAN,
    planDates: "September 13, 2026",
    views: [
      { id: VIEW, name: "Mic Slots", kind: "slots", ndiSource: null, createdAt: "", surface: "display" },
      HOST_VIEW,
    ],
    outputs: [{ id: "o1", name: "Stage", viewId: VIEW }],
  };
  ctl.currentPlanSortDate = "2026-09-13T14:00:00Z";
  for (const key of [VIEW, OBJECT]) {
    await slotsStore.setDefault(key, TYPE, []);
    for (const planId of Object.keys((await slotsStore.allOverrides())[key] ?? {})) {
      await slotsStore.clearOverride(key, planId);
    }
  }
  await ctl.loadAllViewRawSlots(TYPE, PLAN);
});

describe("POST /api/views/:id/slots — target", () => {
  it("with no target lands on the current plan", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots`, {
      method: "POST",
      body: { slots: [slot("s1")] },
    });
    assert.equal(r.status, 200);
    assert.equal((await slotsStore.getOverride(VIEW, PLAN))?.slots[0]?.id, "s1");
    assert.deepEqual(await slotsStore.getDefault(VIEW, TYPE), []);
  });

  it('with target {kind:"default"} lands on the default', async () => {
    await callRoute(viewRoutes, `/api/views/${VIEW}/slots`, {
      method: "POST",
      body: { slots: [slot("s1")], target: { kind: "default", serviceTypeId: TYPE } },
    });
    assert.equal((await slotsStore.getDefault(VIEW, TYPE))[0]?.id, "s1");
    assert.equal(await slotsStore.getOverride(VIEW, PLAN), null);
  });

  it('with target {kind:"plan"} lands on that plan', async () => {
    await callRoute(viewRoutes, `/api/views/${VIEW}/slots`, {
      method: "POST",
      body: { slots: [slot("s1")], target: { kind: "plan", planId: "plan-other", serviceTypeId: TYPE } },
    });
    assert.equal((await slotsStore.getOverride(VIEW, "plan-other"))?.slots[0]?.id, "s1");
    assert.equal(await slotsStore.getOverride(VIEW, PLAN), null);
  });

  it("refuses a malformed target rather than falling back to a default", async () => {
    for (const target of [
      { kind: "default" },
      { kind: "plan", serviceTypeId: TYPE },
      { kind: "plan", planId: "", serviceTypeId: TYPE },
      { kind: "banana", serviceTypeId: TYPE },
      "default",
    ]) {
      const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots`, {
        method: "POST",
        body: { slots: [slot("s1")], target },
      });
      assert.equal(r.status, 400, `target ${JSON.stringify(target)} must be a client error`);
      assert.match(String((r.json as { error?: string }).error), /body\.target must be/);
    }
    assert.equal(
      await slotsStore.getOverride(VIEW, PLAN),
      null,
      "a refused request writes nothing — half-understanding a target is how the wrong board gets overwritten",
    );
  });

  it("the layout-object route takes the same target", async () => {
    await callRoute(viewRoutes, `/api/layout-objects/${OBJECT}/slots`, {
      method: "POST",
      body: { slots: [slot("s1")], target: { kind: "default", serviceTypeId: TYPE } },
    });
    assert.equal((await slotsStore.getDefault(OBJECT, TYPE))[0]?.id, "s1");

    const bad = await callRoute(viewRoutes, `/api/layout-objects/${OBJECT}/slots`, {
      method: "POST",
      body: { slots: [], target: { kind: "plan", serviceTypeId: TYPE } },
    });
    assert.equal(bad.status, 400, "the object route validates its target too — it used to be the copy that drifted");
  });
});

describe("DELETE /api/views/:id/slots/override/:planId", () => {
  it("drops the override and answers with the new state", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing")]);
    await slotsStore.setOverride(VIEW, PLAN, TYPE, [slot("week")], null);

    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots/override/${PLAN}`, { method: "DELETE" });

    assert.equal(r.status, 200);
    assert.equal(await slotsStore.getOverride(VIEW, PLAN), null);
    const state = r.json as { slotsByView?: Record<string, Slot[]> };
    assert.equal(
      state.slotsByView?.[VIEW]?.[0]?.id,
      "standing",
      "the reply carries the board the screens went back to, so the editor does not have to re-fetch",
    );
  });

  it("404s when there was no override to drop", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots/override/${PLAN}`, { method: "DELETE" });
    assert.equal(r.status, 404);
    assert.match(String((r.json as { error?: string }).error), /nothing to revert/);
  });

  it("works for a layout object too", async () => {
    await slotsStore.setOverride(OBJECT, PLAN, TYPE, [slot("week")], null);
    const r = await callRoute(viewRoutes, `/api/layout-objects/${OBJECT}/slots/override/${PLAN}`, {
      method: "DELETE",
    });
    assert.equal(r.status, 200);
    assert.equal(await slotsStore.getOverride(OBJECT, PLAN), null);
  });
});

describe("POST /api/views/:id/slots/promote", () => {
  it("copies the override onto the default and clears it", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing")]);
    await slotsStore.setOverride(VIEW, PLAN, TYPE, [slot("week")], null);

    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots/promote`, {
      method: "POST",
      body: { planId: PLAN },
    });

    assert.equal(r.status, 200);
    assert.equal((await slotsStore.getDefault(VIEW, TYPE))[0]?.id, "week");
    assert.equal(await slotsStore.getOverride(VIEW, PLAN), null);
  });

  it("requires a planId", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots/promote`, { method: "POST", body: {} });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string }).error), /body\.planId/);
  });

  it("404s when that plan has no override", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots/promote`, {
      method: "POST",
      body: { planId: "nope" },
    });
    assert.equal(r.status, 404);
    assert.match(String((r.json as { error?: string }).error), /nothing to promote/);
  });
});

describe("GET /api/views/:id/slot-targets", () => {
  it("returns both boards and the plan they belong to", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("standing")]);
    await slotsStore.setOverride(VIEW, PLAN, TYPE, [slot("week")], null);

    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slot-targets`);
    assert.equal(r.status, 200);
    const dto = r.json as SlotTargetsDTO;
    assert.equal(dto.scope, "view");
    assert.equal(dto.planId, PLAN);
    assert.equal(dto.planDates, "September 13, 2026");
    assert.equal(dto.defaultSlots[0]?.id, "standing");
    assert.equal(dto.overrideSlots?.[0]?.id, "week");
  });

  it("reports a null override when the plan has none", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slot-targets`);
    assert.equal((r.json as SlotTargetsDTO).overrideSlots, null);
  });

  it("scopes a layout object as an object", async () => {
    const r = await callRoute(viewRoutes, `/api/layout-objects/${OBJECT}/slot-targets`);
    assert.equal((r.json as SlotTargetsDTO).scope, "object");
  });
});

// Recalling an arrangement is a slot WRITE, and it went through a route that
// dropped the target on the floor: the editor sent one, the server ignored it,
// and an arrangement recalled while looking at this week rewrote the service
// type's standing board under a success toast. Exactly the shape the /slots
// route was built to avoid, missed in the second copy.
describe("POST /api/presets/:id/apply — target", () => {
  it("lands on the board the caller names, not always the default", async () => {
    const list = await stageController.importPreset("Route P", [slot("p1"), slot("p2")]);
    const preset = list.at(-1)!;

    const r = await callRoute(presetRoutes, `/api/presets/${preset.id}/apply`, {
      method: "POST",
      body: { viewId: VIEW, target: { kind: "default", serviceTypeId: TYPE } },
    });

    assert.equal(r.status, 200);
    assert.equal((await slotsStore.getDefault(VIEW, TYPE)).length, 2);
    assert.equal(
      await slotsStore.getOverride(VIEW, PLAN),
      null,
      "a recall onto the Default side must not leave an exception behind on the current plan",
    );
  });

  it("with no target lands on the current plan", async () => {
    const list = await stageController.importPreset("Route P2", [slot("p1")]);
    await callRoute(presetRoutes, `/api/presets/${list.at(-1)!.id}/apply`, {
      method: "POST",
      body: { viewId: VIEW },
    });
    assert.equal((await slotsStore.getOverride(VIEW, PLAN))?.slots.length, 1);
    assert.deepEqual(await slotsStore.getDefault(VIEW, TYPE), []);
  });

  it("refuses a malformed target", async () => {
    const list = await stageController.importPreset("Route P3", [slot("p1")]);
    const r = await callRoute(presetRoutes, `/api/presets/${list.at(-1)!.id}/apply`, {
      method: "POST",
      body: { viewId: VIEW, target: { kind: "plan", serviceTypeId: TYPE } },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string }).error), /body\.target must be/);
  });
});

// Every failure on revert and promote used to become a 404: the route wrapped
// the whole controller call in `catch → error(res, …, 404)`. So a store write
// that failed for any other reason read to the operator as "there was nothing to
// revert", and no 500 ever reached the log to find afterwards.
//
// The route now answers only SlotsNotFoundError, which carries the status it
// deserves. Anything else propagates. callRoute stops at the route — the mapping
// from an unlabelled throw to a 500 lives in remote-server.ts's dispatcher — so
// what is asserted here is that the route did NOT swallow it, which is the half
// that was broken.
describe("an error that is not a not-found", () => {
  it("is not turned into a 404 by the revert route", async () => {
    const ctlAny = stageController as unknown as { clearSlotsOverride: unknown };
    const real = ctlAny.clearSlotsOverride;
    ctlAny.clearSlotsOverride = async () => {
      throw new Error("boom: the disk is full");
    };
    try {
      await assert.rejects(
        () => callRoute(viewRoutes, `/api/views/${VIEW}/slots/override/${PLAN}`, { method: "DELETE" }),
        /boom: the disk is full/,
        "a 404 here tells the operator there was nothing to revert, and hides a real fault",
      );
    } finally {
      ctlAny.clearSlotsOverride = real;
    }
  });

  it("is not turned into a 404 by the promote route", async () => {
    const ctlAny = stageController as unknown as { promoteSlotsOverride: unknown };
    const real = ctlAny.promoteSlotsOverride;
    ctlAny.promoteSlotsOverride = async () => {
      throw new Error("boom: the disk is full");
    };
    try {
      await assert.rejects(
        () =>
          callRoute(viewRoutes, `/api/views/${VIEW}/slots/promote`, {
            method: "POST",
            body: { planId: PLAN },
          }),
        /boom: the disk is full/,
      );
    } finally {
      ctlAny.promoteSlotsOverride = real;
    }
  });

  it("still answers 404 for the one case that IS a not-found", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots/override/${PLAN}`, { method: "DELETE" });
    assert.equal(r.status, 404);
    assert.match(String((r.json as { error?: string }).error), /nothing to revert/);
  });
});

// Both routes answered 200 for an id that names nothing, so a typo wrote a board
// under a key no screen would ever read and reported success.
describe("a view or object id that does not exist", () => {
  it("404s on GET slot-targets", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v-typo/slot-targets");
    assert.equal(r.status, 404);
    assert.match(String((r.json as { error?: string }).error), /no view v-typo/);
  });

  it("404s on POST slots", async () => {
    const r = await callRoute(viewRoutes, "/api/views/v-typo/slots", {
      method: "POST",
      body: { slots: [slot("s1")] },
    });
    assert.equal(r.status, 404);
    assert.equal(
      (await slotsStore.getOverride("v-typo", PLAN)),
      null,
      "and it wrote nothing on the way to answering",
    );
  });

  it("404s on an inline object that is on no layout", async () => {
    const r = await callRoute(viewRoutes, "/api/layout-objects/obj-nowhere/slots", {
      method: "POST",
      body: { slots: [slot("s1")] },
    });
    assert.equal(r.status, 404);
    assert.match(String((r.json as { error?: string }).error), /no inline mic-slots object/);
  });
});

// A plan target whose serviceTypeId is not the plan's own type is accepted by
// the shape validator and then honoured by nothing: resolve() only ever reads an
// override back for the type it was saved against, and pruning dates it by
// asking PCO about the wrong service type, so it never ages out either.
describe("a plan target naming another service type", () => {
  it("is a 400, not an invisible board", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/slots`, {
      method: "POST",
      body: { slots: [slot("s1")], target: { kind: "plan", planId: PLAN, serviceTypeId: "st-other" } },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string }).error), /belongs to service type/);
    assert.equal(await slotsStore.getOverride(VIEW, PLAN), null);
  });
});

// Copy-slots is a slot write and takes the same optional target, read through
// the same validator. Without it, it wrote the source's default over the
// destination's default whichever side the editor was on, and deleted the
// destination's board for the current plan on the way past — unconfirmed and
// unlogged, next to a Revert action that confirms and logs the same deletion.
describe("POST /api/views/:id/copy-slots — target", () => {
  const SRC = "v-src-route";
  beforeEach(async () => {
    ctl.state = {
      ...ctl.state,
      views: [
        ...(ctl.state.views as unknown[]),
        { id: SRC, name: "Other", kind: "slots", ndiSource: null, createdAt: "", surface: "display" },
      ],
    };
    await slotsStore.setDefault(SRC, TYPE, [slot("src-standing", "07")]);
    for (const planId of Object.keys((await slotsStore.allOverrides())[SRC] ?? {})) {
      await slotsStore.clearOverride(SRC, planId);
    }
  });

  it("copies onto the named board and leaves the other one alone", async () => {
    await slotsStore.setDefault(VIEW, TYPE, [slot("dst-standing", "02")]);
    await slotsStore.setOverride(VIEW, PLAN, TYPE, [slot("dst-week", "03")], null);

    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/copy-slots`, {
      method: "POST",
      body: { fromViewId: SRC, target: { kind: "default", serviceTypeId: TYPE } },
    });

    assert.equal(r.status, 200);
    assert.equal(
      (await slotsStore.getDefault(VIEW, TYPE))[0]?.channel,
      "07",
      "the source's default is what the Default side copies",
    );
    assert.equal(
      (await slotsStore.getOverride(VIEW, PLAN))?.slots[0]?.channel,
      "03",
      "the destination's board for this week is not the copy's business, and deleting it was silent",
    );
  });

  it("refuses a malformed target", async () => {
    const r = await callRoute(viewRoutes, `/api/views/${VIEW}/copy-slots`, {
      method: "POST",
      body: { fromViewId: SRC, target: { kind: "plan", serviceTypeId: TYPE } },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error?: string }).error), /body\.target must be/);
  });
});
