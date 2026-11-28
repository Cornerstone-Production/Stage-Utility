// The Rebuild from raw message says what the boot repair's rule did afterwards
// to a length a crash left out (RebuildOutcome.gapRepair), and says nothing
// when there was no such gap.

import { strict as assert } from "node:assert";
import { after, test } from "node:test";

import { installRenderDom } from "../../test-dom.js";

after(installRenderDom());
const { describeRebuild } = await import("./service-history-section.js");

const leg = (rebuilt: boolean, items: number) => ({ rebuilt, items, missing: false });
const outcome = (gapRepair?: "none" | "repaired" | "left" | "waiting" | "failed") => ({
  timeline: leg(true, 12),
  spl: leg(false, 0),
  attendance: leg(true, 40),
  baptism: { rebuilt: false, items: 0, missing: true },
  failed: [],
  gapRepair,
});

test("a rebuild names what became of a length a crash left out", () => {
  assert.doesNotMatch(describeRebuild(outcome("none")), /crash/);
  assert.doesNotMatch(describeRebuild(outcome()), /crash/);
  assert.match(describeRebuild(outcome("repaired")), /filled in the length a crash left out/);
  assert.match(describeRebuild(outcome("left")), /stays unknown/);
  assert.match(describeRebuild(outcome("waiting")), /at the next start/);
  assert.match(describeRebuild(outcome("failed")), /could not fill in/);
});
