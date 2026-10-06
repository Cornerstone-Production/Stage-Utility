// A song's time signature, read off the Arrangement PCO includes with the item.
//
// listPlanItems already pulled `bpm` and the arrangement's name out of the
// included Arrangement nodes; `meter` ("4/4", "6/8") is the same record's other
// attribute. PCO documents it as a string drawn from a fixed list (2/2 ... 12/8).
//
// The stub answers the real client's request with a JSON:API payload, so what is
// asserted is the DTO the rundown would receive. Matching on the source text for
// `attributes.meter` would pass with the DTO line deleted.

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { pcoService } from "./pco-service.js";

type Requester = { request: (url: string, appId: string, secret: string) => Promise<unknown> };
const svc = pcoService as unknown as Requester;
const realRequest = svc.request;

/** An Item as PCO returns it, pointing at an arrangement (or at none). */
function itemNode(id: string, sequence: number, arrangementId: string | null) {
  return {
    id,
    type: "Item",
    attributes: { title: `Item ${id}`, item_type: "song", sequence, length: 300, key_name: "E" },
    relationships: {
      item_notes: { data: [] },
      arrangement: { data: arrangementId ? { type: "Arrangement", id: arrangementId } : null },
    },
  };
}

const arrangement = (id: string, attributes: Record<string, unknown>) => ({ id, type: "Arrangement", attributes });

let urls: string[] = [];

function stub(data: unknown[], included: unknown[]) {
  urls = [];
  svc.request = async (url: string) => {
    urls.push(url);
    return { data, included };
  };
}

describe("a plan item's meter", () => {
  beforeEach(() => {
    pcoService.clearCache();
    svc.request = realRequest;
  });

  it("is the included arrangement's meter, beside its bpm and name", async () => {
    stub(
      [itemNode("a", 0, "arr-1"), itemNode("b", 1, "arr-2")],
      [
        arrangement("arr-1", { bpm: 128, meter: "4/4", name: "Elevation Rhythm" }),
        arrangement("arr-2", { bpm: 72, meter: "6/8", name: "Elevation Worship" }),
      ],
    );
    const items = await pcoService.listPlanItems("app", "secret", "11", "21");
    assert.deepEqual(
      items.map((i) => [i.id, i.bpm, i.meter, i.arrangementName]),
      [["a", 128, "4/4", "Elevation Rhythm"], ["b", 72, "6/8", "Elevation Worship"]],
    );
    // The request already includes the arrangement; no second call is needed for the meter.
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /include=item_notes,arrangement/);
  });

  it("is null when the arrangement has no meter, an empty one, or a non-string", async () => {
    stub(
      [itemNode("a", 0, "arr-1"), itemNode("b", 1, "arr-2"), itemNode("c", 2, "arr-3")],
      [
        arrangement("arr-1", { bpm: 100, name: "No meter" }),
        arrangement("arr-2", { bpm: 100, meter: "", name: "Blank" }),
        arrangement("arr-3", { bpm: 100, meter: 4, name: "Wrong type" }),
      ],
    );
    const items = await pcoService.listPlanItems("app", "secret", "11", "21");
    assert.deepEqual(items.map((i) => i.meter), [null, null, null]);
    assert.deepEqual(items.map((i) => i.bpm), [100, 100, 100], "bpm must not depend on meter");
  });

  it("is null for an item with no arrangement", async () => {
    stub([itemNode("a", 0, null)], []);
    const [item] = await pcoService.listPlanItems("app", "secret", "11", "21");
    assert.equal(item!.meter, null);
    assert.equal(item!.bpm, null);
  });
});
